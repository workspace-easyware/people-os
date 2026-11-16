// S4 M4 — 평가 실행기. 설계: S4-OBSERVABILITY-EVAL-PLAN.md §6.4.
//
// POST /api/obs/evals/runs → startRun(): 가드 → eval_runs(queued, config_json 고정) →
//   항목마다 PIPELINE.send({type:'eval-item'}) → 202.
// queue() (M6-β가 분기) → processEvalItem(): runAsk(origin='eval', 공백·캐시·세션 없음) →
//   규칙표 → verdict → judge → eval_results (UNIQUE(run_id,item_id), 재전달 멱등) → trace_scores.
//   items_done은 eval_results 행 수를 다시 세서 넣는다(증가가 아니라 재계산) — 같은 메시지가
//   두 번 와도 이중 증가가 없다.
// 마지막 항목 → finalizeRun(): 집계 + base_run_id + 회귀 목록 + improvement_actions 검증 갱신.
//   상태 전환은 "queued/running일 때만" 조건부 UPDATE라 동시에 두 번 불려도 한 번만 마감한다.
//
// 점수를 지어내지 않는다 (§C.4): 호출·파싱 실패는 error로 남기고 통과율 분모에서 뺀다.
import {
  EMBED_MODEL, KEYWORD_GATE_MIN, LLM_MODEL, SCORE_FLOOR, getKnowledgeEpoch,
  type AskEnv, type AskHooks, type AskInput, type AskOptions, type AskRunResult, type Source,
} from "../ask-pipeline";
import { boolToInt, intToBool, newId, obsSchemaReady, parseJson } from "./db";
import {
  ITEM_GAP_MS, EST_TOKENS, acquireLock, bumpDaily, dailyCount, estimateCallUsd, estimateRunUsd, evalEnabled, loadGuardConfig,
  releaseLock, secondsUntilKstMidnight, shouldSkipCron, stableHash, SAMPLE_JUDGE_PER_DAY, STALE_RUN_MINUTES, TRACE_JUDGE_PER_DAY,
} from "./guards";
import {
  JUDGE_JSON_MODE, JUDGE_MODEL, JUDGE_VERSION, PASS_THRESHOLD, computeRetrievalHit, decidePass, judgeAnswer, noEvidenceCorrect, planByRule,
  type JudgeEvidence, type KeptSource, type SystemStatus,
} from "./judge";
import { getActivePrompt } from "./prompts";
import { classifyVerdict, detectVerdictEngine, VERDICT_FALLBACK_MODEL, VERDICT_MODEL_CLEF, type VerdictEngine } from "./verdict";
import { verifyActionsForRun } from "./gaps";
import type { EvalItem, EvalItemMessage, EvalRun, EvalRunStatus, ExpectedSource, JudgeResult, ObsEnv, TraceSink, Verdict } from "./types";

export type EvalEnv = ObsEnv & AskEnv;

export type RunAskFn = (env: AskEnv, input: AskInput, opts?: AskOptions, hooks?: AskHooks) => Promise<AskRunResult>;

export type EvalDeps = {
  runAsk: RunAskFn;
  traceSink?: TraceSink;
  ctx?: ExecutionContext;
  /** 항목 사이 간격(Workers AI 분당 한도 보호). 테스트에서 0으로 바꾼다. */
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_DATASET_ID = "ds_core_v1";

/** eval_runs.config_json — 실행 시작 시 고정. 추이 차트의 "무엇을 바꿨나" 표식 근거. */
export type RunConfig = {
  llm_model: string;
  embed_model: string;
  judge_model: string;
  judge_version: string;
  judge_json_mode: string;
  verdict_engine: VerdictEngine;
  verdict_engine_reason: string;
  verdict_model: string;
  prompt_version_id: string;
  prompt_version: number;
  score_floor: number;
  keyword_gate_min: number;
  knowledge_epoch: number;
  dataset_version: number;
  pass_threshold: number;
  max_items: number;
  truncated: boolean;
  items_available: number;
  item_ids: string[];
  cost_cap_usd: number;
  cost_estimate_pre_usd: number;
  trigger: EvalRun["trigger"];
};

// ---- 행 매핑 ----------------------------------------------------------------------------

type ItemRow = {
  id: string; dataset_id: string; question: string; expected_answer: string | null; expected_sources: string;
  expected_verdict: string; tags: string; source: string; origin_ref: string | null; prereq: string | null;
  active: number; created_at: string; updated_at: string;
};

export function mapItem(r: ItemRow): EvalItem {
  return {
    id: r.id, datasetId: r.dataset_id, question: r.question, expectedAnswer: r.expected_answer,
    expectedSources: parseJson<ExpectedSource[]>(r.expected_sources, []),
    expectedVerdict: r.expected_verdict === "ungrounded" ? "ungrounded" : "grounded",
    tags: parseJson<string[]>(r.tags, []), source: (r.source as EvalItem["source"]) || "seed",
    originRef: r.origin_ref, prereq: r.prereq, active: r.active !== 0, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export type RunRow = {
  id: string; dataset_id: string; dataset_version: number; trigger: string; status: string; config_json: string; config_hash: string | null;
  items_total: number; items_done: number; items_error: number; pass_count: number | null; pass_rate: number | null; avg_judge: number | null;
  retrieval_hit_rate: number | null; no_evidence_accuracy: number | null; verdict_dist_json: string | null; cost_estimate_usd: number | null;
  base_run_id: string | null; started_at: string | null; finished_at: string | null; error: string | null; created_at: string;
};

export function mapRun(r: RunRow): EvalRun {
  return {
    id: r.id, datasetId: r.dataset_id, datasetVersion: r.dataset_version, trigger: r.trigger as EvalRun["trigger"], status: r.status as EvalRunStatus,
    config: parseJson<Record<string, unknown>>(r.config_json, {}), configHash: r.config_hash,
    itemsTotal: r.items_total, itemsDone: r.items_done, itemsError: r.items_error,
    passCount: r.pass_count, passRate: r.pass_rate, avgJudge: r.avg_judge, retrievalHitRate: r.retrieval_hit_rate, noEvidenceAccuracy: r.no_evidence_accuracy,
    verdictDist: parseJson<Partial<Record<Verdict, number>> | null>(r.verdict_dist_json, null), costEstimateUsd: r.cost_estimate_usd,
    baseRunId: r.base_run_id, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error, createdAt: r.created_at,
  };
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "partial", "failed", "aborted", "skipped"]);

// ---- startRun ---------------------------------------------------------------------------

export type StartRunInput = {
  datasetId: string;
  trigger: EvalRun["trigger"];
  limit?: number;
  promptVersionId?: string;
  /** regression: 영향받는 항목을 앞에 둔다 (전체 데이터셋도 함께 돈다, §3.3). */
  priorityItemIds?: string[];
};

export type StartRunResult =
  | { ok: true; status: 202 | 200; runId: string; runStatus: EvalRunStatus; itemsTotal: number; truncated: boolean; skippedBecause?: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 500 | 503; error: string; retryAfter?: number; holder?: string };

export async function startRun(env: EvalEnv, input: StartRunInput): Promise<StartRunResult> {
  if (!(await obsSchemaReady(env.DB))) return { ok: false, status: 503, error: "obs schema not migrated (0013/0014)" };
  const guard = await loadGuardConfig(env);
  if (!guard.enabled) return { ok: false, status: 403, error: "eval disabled (meta.eval_enabled=0)" };
  if (!["manual", "cron", "regression"].includes(input.trigger)) return { ok: false, status: 400, error: "invalid trigger" };

  const ds = await env.DB.prepare("SELECT id, version FROM eval_datasets WHERE id = ?").bind(input.datasetId).first<{ id: string; version: number }>();
  if (!ds) return { ok: false, status: 404, error: "dataset not found" };

  // 수동·회귀 실행 일일 한도 (KST). cron은 별도(1회/일 + config_hash 건너뛰기).
  const userTriggered = input.trigger !== "cron";
  if (userTriggered) {
    const used = await dailyCount(env, "manual");
    if (used >= guard.manualPerDay) {
      return { ok: false, status: 429, error: `daily manual eval limit reached (${guard.manualPerDay}/day KST)`, retryAfter: secondsUntilKstMidnight() };
    }
  }

  const { results: itemRows } = await env.DB.prepare("SELECT * FROM eval_items WHERE dataset_id = ? AND active = 1 ORDER BY created_at, id").bind(ds.id).all<ItemRow>();
  let items = (itemRows || []).map(mapItem);
  if (!items.length) return { ok: false, status: 400, error: "dataset has no active items" };
  if (input.priorityItemIds?.length) {
    const pri = new Set(input.priorityItemIds);
    items = [...items.filter((i) => pri.has(i.id)), ...items.filter((i) => !pri.has(i.id))];
  }
  const requested = input.limit && Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : guard.maxItems;
  const cap = Math.min(requested, guard.maxItems);
  const truncated = items.length > cap;
  const picked = items.slice(0, cap);

  // 프롬프트 버전: 지정(초안 A/B)이면 그 행이 있어야 한다. 없으면 활성 버전.
  let prompt: { id: string; version: number };
  if (input.promptVersionId) {
    const row = await env.DB.prepare("SELECT id, version FROM prompt_versions WHERE id = ? AND name = 'ask-system'").bind(input.promptVersionId).first<{ id: string; version: number }>();
    if (!row) return { ok: false, status: 404, error: "prompt version not found" };
    prompt = row;
  } else {
    const p = await getActivePrompt(env, "ask-system");
    prompt = { id: p.id, version: p.version };
  }

  const engine = await detectVerdictEngine(env);
  const epoch = await getKnowledgeEpoch(env);
  const costPre = estimateRunUsd(picked.length);
  if (costPre > guard.costCapUsd) {
    return { ok: false, status: 400, error: `estimated cost $${costPre.toFixed(3)} exceeds cap $${guard.costCapUsd.toFixed(2)} — lower limit` };
  }
  const config: RunConfig = {
    llm_model: LLM_MODEL, embed_model: EMBED_MODEL, judge_model: JUDGE_MODEL, judge_version: JUDGE_VERSION, judge_json_mode: JUDGE_JSON_MODE,
    verdict_engine: engine.engine, verdict_engine_reason: engine.reason, verdict_model: engine.engine === "clef" ? VERDICT_MODEL_CLEF : VERDICT_FALLBACK_MODEL,
    prompt_version_id: prompt.id, prompt_version: prompt.version, score_floor: SCORE_FLOOR, keyword_gate_min: KEYWORD_GATE_MIN,
    knowledge_epoch: epoch, dataset_version: ds.version, pass_threshold: PASS_THRESHOLD, max_items: guard.maxItems,
    truncated, items_available: items.length, item_ids: picked.map((i) => i.id), cost_cap_usd: guard.costCapUsd, cost_estimate_pre_usd: costPre,
    trigger: input.trigger,
  };
  // 해시 = 결과에 영향을 주는 설정만 (§6.4: 모델·prompt·epoch·데이터셋 버전·judge 버전).
  const configHash = await stableHash({
    llm: config.llm_model, embed: config.embed_model, judge: config.judge_model, judge_version: config.judge_version,
    verdict: config.verdict_engine, prompt: config.prompt_version_id, epoch: config.knowledge_epoch, dataset: ds.id,
    dataset_version: config.dataset_version, score_floor: config.score_floor, gate: config.keyword_gate_min,
  });
  const runId = newId("run");

  if (input.trigger === "cron") {
    const skip = await shouldSkipCron(env, ds.id, configHash);
    if (skip.skip) {
      await env.DB.prepare(
        "INSERT INTO eval_runs (id, dataset_id, dataset_version, trigger, status, config_json, config_hash, items_total, base_run_id, finished_at, error) VALUES (?, ?, ?, 'cron', 'skipped', ?, ?, 0, ?, datetime('now'), ?)"
      ).bind(runId, ds.id, ds.version, JSON.stringify(config), configHash, skip.lastRunId ?? null, `same config_hash as ${skip.lastRunId} within 7 days`).run();
      return { ok: true, status: 200, runId, runStatus: "skipped", itemsTotal: 0, truncated, skippedBecause: `same config_hash as ${skip.lastRunId}` };
    }
  }

  const lock = await acquireLock(env, runId);
  if (!lock.ok) return { ok: false, status: 409, error: "another eval run is in progress", holder: lock.holder };

  try {
    await env.DB.prepare(
      "INSERT INTO eval_runs (id, dataset_id, dataset_version, trigger, status, config_json, config_hash, items_total, cost_estimate_usd) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0)"
    ).bind(runId, ds.id, ds.version, input.trigger, JSON.stringify(config), configHash, picked.length).run();
    const enqueuedAt = new Date().toISOString();
    const msgs = picked.map((it) => ({ body: { type: "eval-item", version: 1, runId, itemId: it.id, enqueuedAt } satisfies EvalItemMessage }));
    for (let i = 0; i < msgs.length; i += 100) await env.PIPELINE.sendBatch(msgs.slice(i, i + 100));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE eval_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?").bind(`enqueue failed: ${msg}`, runId).run().catch(() => {});
    await releaseLock(env, runId);
    return { ok: false, status: 500, error: `enqueue failed: ${msg}` };
  }
  if (userTriggered) await bumpDaily(env, "manual");
  return { ok: true, status: 202, runId, runStatus: "queued", itemsTotal: picked.length, truncated };
}

// ---- processEvalItem --------------------------------------------------------------------

export type ProcessResult =
  | { outcome: "processed"; resultId: string; finalized: boolean }
  | { outcome: "duplicate"; resultId: string; finalized: boolean }
  | { outcome: "ignored"; reason: string };

type ResultDraft = {
  eventId: string | null; answer: string | null; grounded: boolean | null; retrievedIds: string[]; retrievalHit: boolean | null;
  judgeScore: number | null; judgeDims: JudgeResult["dimensions"] | null; judgeReason: string | null; judgeComment: string | null; judgeSnapped: boolean; judgeSkipped: string | null;
  verdict: Verdict | null; verdictEngine: string | null; verdictReason: string | null; passed: boolean | null; error: string | null; latencyMs: number | null;
  costUsd: number; judgeLevel?: string;
};

function emptyDraft(): ResultDraft {
  return {
    eventId: null, answer: null, grounded: null, retrievedIds: [], retrievalHit: null, judgeScore: null, judgeDims: null, judgeReason: null, judgeComment: null,
    judgeSnapped: false, judgeSkipped: null, verdict: null, verdictEngine: null, verdictReason: null, passed: null, error: null, latencyMs: null, costUsd: 0,
  };
}

function toEvidence(sources: Source[]): JudgeEvidence[] {
  return sources.map((s) => ({ title: s.title, section: s.section, snippet: s.snippet }));
}

/** 큐 메시지 1건. 절대 같은 (run,item)에 두 행을 만들지 않는다. throw하면 큐가 재시도한다. */
export async function processEvalItem(env: EvalEnv, msg: EvalItemMessage, deps: EvalDeps): Promise<ProcessResult> {
  if (!msg || msg.type !== "eval-item" || !msg.runId || !msg.itemId) return { outcome: "ignored", reason: "bad message" };
  const runRow = await env.DB.prepare("SELECT * FROM eval_runs WHERE id = ?").bind(msg.runId).first<RunRow>();
  if (!runRow) return { outcome: "ignored", reason: "run not found" };
  if (TERMINAL.has(runRow.status)) return { outcome: "ignored", reason: `run ${runRow.status}` };
  const config = parseJson<Partial<RunConfig>>(runRow.config_json, {});

  // 재전달 빠른 경로: 이미 결과가 있으면 다시 부르지 않는다 (집계 재확인만).
  const existing = await env.DB.prepare("SELECT id FROM eval_results WHERE run_id = ? AND item_id = ?").bind(msg.runId, msg.itemId).first<{ id: string }>();
  if (existing) {
    const fin = await recountAndMaybeFinalize(env, msg.runId, 0);
    return { outcome: "duplicate", resultId: existing.id, finalized: fin };
  }

  await env.DB.prepare("UPDATE eval_runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ? AND status = 'queued'").bind(msg.runId).run();

  const draft = emptyDraft();
  const guard = await loadGuardConfig(env);
  const itemRow = await env.DB.prepare("SELECT * FROM eval_items WHERE id = ?").bind(msg.itemId).first<ItemRow>();
  if (!guard.enabled) draft.error = "eval_disabled";
  else if ((runRow.cost_estimate_usd ?? 0) >= (config.cost_cap_usd ?? guard.costCapUsd)) draft.error = "aborted_cost_cap";
  else if (!itemRow) draft.error = "item_not_found";
  else await evaluateItem(env, msg, mapItem(itemRow), config, deps, draft);

  const resultId = newId("res");
  const ins = await env.DB.prepare(
    `INSERT INTO eval_results (id, run_id, item_id, event_id, answer, grounded, retrieved_ids, retrieval_hit, judge_score, judge_dims_json, judge_reason,
       judge_comment, judge_snapped, judge_skipped, verdict, verdict_engine, passed, error, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, item_id) DO NOTHING`
  ).bind(
    resultId, msg.runId, msg.itemId, draft.eventId, draft.answer, boolToInt(draft.grounded), JSON.stringify(draft.retrievedIds), boolToInt(draft.retrievalHit),
    draft.judgeScore, draft.judgeDims ? JSON.stringify(draft.judgeDims) : null, draft.judgeReason, draft.judgeComment, draft.judgeSnapped ? 1 : 0, draft.judgeSkipped,
    draft.verdict, draft.verdictEngine, boolToInt(draft.passed), draft.error, draft.latencyMs,
  ).run();
  const inserted = (ins.meta?.changes ?? 0) === 1;
  let finalResultId = resultId;
  if (inserted) {
    await writeTraceScores(env, msg.runId, draft);
  } else {
    // 동시 재전달 경합에서 진 쪽 — 이긴 행을 쓴다. 비용은 더하지 않는다.
    const won = await env.DB.prepare("SELECT id FROM eval_results WHERE run_id = ? AND item_id = ?").bind(msg.runId, msg.itemId).first<{ id: string }>();
    finalResultId = won?.id ?? resultId;
  }
  const finalized = await recountAndMaybeFinalize(env, msg.runId, inserted ? draft.costUsd : 0);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!finalized) await sleep(ITEM_GAP_MS);
  return { outcome: inserted ? "processed" : "duplicate", resultId: finalResultId, finalized };
}

async function evaluateItem(env: EvalEnv, msg: EvalItemMessage, item: EvalItem, config: Partial<RunConfig>, deps: EvalDeps, d: ResultDraft): Promise<void> {
  const started = Date.now();
  let res: AskRunResult;
  try {
    res = await deps.runAsk(
      env,
      { question: item.question, sessionId: `eval:${msg.runId}:${item.id}`, startedAt: started },
      {
        origin: "eval", evalRunId: msg.runId, recordGap: false, readCache: false, writeCache: false, persistSession: false,
        gatewaySkipCache: true, ...(config.prompt_version_id ? { promptVersionId: config.prompt_version_id } : {}),
      },
      { traceSink: deps.traceSink, ctx: deps.ctx },
    );
  } catch (e) {
    d.error = `ask_failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    d.latencyMs = Date.now() - started;
    return;
  }
  if (res.cached) {
    d.error = "ask_cached"; // readCache:false라 오면 안 된다 — 측정값이 아니므로 오류로 남긴다
    return;
  }
  const body = res.body;
  const trace = res.trace;
  d.eventId = body.eventId;
  d.answer = body.answer;
  d.grounded = body.grounded;
  d.retrievedIds = body.sources.map((s) => s.id);
  d.latencyMs = body.timings?.total ?? Date.now() - started;

  // traceSink가 없으면 runAsk는 ask_events 9개 컬럼만 쓴다 (origin 기본 'user').
  // 평가 트레이스가 user 목록에 섞이지 않도록 0013 컬럼을 여기서 채운다.
  if (!deps.traceSink) {
    try {
      await env.DB.prepare(
        "UPDATE ask_events SET origin = 'eval', eval_run_id = ?, status = ?, prompt_version = ?, model = ?, latency_ms = ?, knowledge_epoch = ? WHERE id = ?"
      ).bind(msg.runId, trace.status, trace.promptVersion || null, trace.model || null, d.latencyMs, trace.knowledgeEpoch, body.eventId).run();
    } catch (e) {
      console.log("[eval] ask_events origin tag failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // 결정적 지표 — judge와 독립.
  const docIds = new Map<string, string>();
  for (const c of trace.retrieval) if (c.docId) docIds.set(c.chunkId, c.docId);
  const kept: KeptSource[] = body.sources.map((s) => ({ id: s.id, title: s.title, section: s.section, docId: docIds.get(s.id) }));
  d.retrievalHit = body.grounded ? computeRetrievalHit(item.expectedSources, kept) : (item.expectedSources.length ? false : null);

  // 비용 추정 (ask): LLM을 실제로 불렀을 때만.
  if (body.engine === "workers-ai") {
    d.costUsd += estimateCallUsd(trace.usage?.promptTokens ?? EST_TOKENS.ask.in, trace.usage?.completionTokens ?? EST_TOKENS.ask.out);
  }

  const status: SystemStatus = trace.status;
  // 근거는 있는데 LLM이 실패해 템플릿 답이 나왔으면, 그 답은 시스템 답의 측정값이 아니다 → 오류.
  if (status === "grounded" && body.engine !== "workers-ai") {
    d.error = `ask_llm_unavailable (engine=${body.engine})`;
    return;
  }
  const plan = planByRule(item.expectedVerdict, status);
  const engine: VerdictEngine = config.verdict_engine === "clef" ? "clef" : "llm-fallback";
  const evidence = toEvidence(body.sources);

  if (plan.kind === "error") { d.error = "ask_error"; return; }
  if (plan.kind === "rule_pass") {
    d.judgeSkipped = plan.judgeSkipped; d.verdictEngine = "rule"; d.passed = true;
    d.judgeReason = "규칙: 기대 ungrounded + 시스템 no_evidence → 통과 (judge·verdict 생략)";
    return;
  }
  if (plan.kind === "rule_fail_zero") {
    d.judgeSkipped = plan.judgeSkipped; d.judgeScore = plan.judgeScore; d.verdictEngine = "rule"; d.passed = false;
    d.judgeReason = "규칙: 기대 grounded인데 시스템 no_evidence → 실패, 0.0";
    return;
  }
  // verdict (rule_fail_verdict_only, judge 둘 다)
  const v = await classifyVerdict(env, { question: item.question, answer: body.answer, evidence }, engine);
  d.verdictEngine = v.engine;
  d.costUsd += estimateCallUsd(EST_TOKENS.verdict.in, EST_TOKENS.verdict.out);
  if (plan.kind === "rule_fail_verdict_only") {
    d.judgeSkipped = plan.judgeSkipped; d.passed = false;
    d.verdict = v.ok ? v.verdict : null;
    d.judgeReason = `규칙: 기대 ungrounded인데 시스템 grounded → 실패 (지어내기 위험)${v.ok ? "" : ` · verdict 실패: ${v.error}`}`;
    return;
  }
  if (!v.ok) { d.error = `${v.error}: ${v.detail}`.slice(0, 500); return; }
  d.verdict = v.verdict;
  // 앙상블 상세 (2026-11-16): 두 모델의 판정·확신도를 trace_scores comment에
  // 남긴다 (구조 변경 없음 — comment 필드만 채운다).
  d.verdictReason = (v.reason ?? v.engine).slice(0, 500);

  const j = await judgeAnswer(env, { question: item.question, expectedAnswer: item.expectedAnswer, expectedSources: item.expectedSources, answer: body.answer, evidence });
  d.costUsd += estimateCallUsd(
    (j.ok ? j.usage?.promptTokens : undefined) ?? EST_TOKENS.judge.in * (j.ok ? 1 : j.attempts),
    (j.ok ? j.usage?.completionTokens : undefined) ?? EST_TOKENS.judge.out * (j.ok ? 1 : j.attempts),
  );
  if (!j.ok) { d.error = `${j.error}: ${j.detail}`.slice(0, 500); return; }
  d.judgeScore = j.result.score;
  d.judgeDims = j.result.dimensions;
  d.judgeSnapped = j.result.snapped;
  d.judgeLevel = j.result.level;
  d.judgeReason = `${j.jsonMode === "prompt" ? "[json_mode=prompt] " : ""}${j.result.level} — ${j.result.reasoning}`.slice(0, 2000);
  // 개선 코멘트 (judge-v2). 비어 있으면 NULL — 지어내지 않는다.
  d.judgeComment = j.result.improvement ? j.result.improvement.slice(0, 2000) : null;
  d.passed = decidePass(j.result.score, v.verdict);
}

async function writeTraceScores(env: EvalEnv, runId: string, d: ResultDraft): Promise<void> {
  if (!d.eventId) return;
  const stmts: D1PreparedStatement[] = [];
  const add = (name: string, value: number | null, label: string | null, source: string, comment: string | null) =>
    stmts.push(env.DB.prepare("INSERT INTO trace_scores (id, event_id, name, value, label, source, eval_run_id, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId("sc"), d.eventId, name, value, label, source, runId, comment));
  if (d.judgeScore != null) add("judge_score", d.judgeScore, d.judgeLevel ?? null, d.judgeSkipped ? "rule" : "judge", d.judgeReason);
  if (d.verdict) add("verdict", null, d.verdict, "verdict", d.verdictReason ?? d.verdictEngine);
  if (d.retrievalHit != null) add("retrieval_hit", d.retrievalHit ? 1 : 0, null, "rule", null);
  if (!stmts.length) return;
  try { await env.DB.batch(stmts); } catch (e) { console.log("[eval] trace_scores insert failed:", e instanceof Error ? e.message : String(e)); }
}

/** items_done/items_error를 eval_results에서 다시 센다 (멱등). 다 끝났으면 finalizeRun. */
async function recountAndMaybeFinalize(env: EvalEnv, runId: string, addCost: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE eval_runs SET
       items_done = (SELECT COUNT(*) FROM eval_results WHERE run_id = ?1),
       items_error = (SELECT COUNT(*) FROM eval_results WHERE run_id = ?1 AND error IS NOT NULL),
       cost_estimate_usd = COALESCE(cost_estimate_usd, 0) + ?2
     WHERE id = ?1
     RETURNING items_done, items_total, status`
  ).bind(runId, addCost).first<{ items_done: number; items_total: number; status: string }>();
  if (!row || TERMINAL.has(row.status)) return false;
  if (row.items_done >= row.items_total) return (await finalizeRun(env, runId)).finalized;
  return false;
}

// ---- finalizeRun ------------------------------------------------------------------------

export type RunAggregates = {
  passCount: number; passRate: number | null; avgJudge: number | null; retrievalHitRate: number | null; noEvidenceAccuracy: number | null;
  verdictDist: Partial<Record<Verdict, number>>; scored: number; errors: number; abortedByCost: number;
};

type ResultWithItem = {
  id: string; item_id: string; grounded: number | null; retrieval_hit: number | null; judge_score: number | null; verdict: string | null;
  passed: number | null; error: string | null; expected_verdict: string | null;
};

export function aggregate(rows: ResultWithItem[]): RunAggregates {
  const scored = rows.filter((r) => r.error == null);
  const passCount = scored.filter((r) => r.passed === 1).length;
  const judged = scored.filter((r) => r.judge_score != null);
  const hits = scored.filter((r) => r.retrieval_hit != null);
  const neRows = scored.filter((r) => r.grounded != null);
  const verdictDist: Partial<Record<Verdict, number>> = {};
  for (const r of scored) if (r.verdict) verdictDist[r.verdict as Verdict] = (verdictDist[r.verdict as Verdict] ?? 0) + 1;
  const neCorrect = neRows.filter((r) => noEvidenceCorrect(r.expected_verdict === "ungrounded" ? "ungrounded" : "grounded", r.grounded ? "grounded" : "no_evidence") === true).length;
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return {
    passCount,
    passRate: scored.length ? round(passCount / scored.length) : null,
    avgJudge: judged.length ? round(judged.reduce((s, r) => s + (r.judge_score as number), 0) / judged.length) : null,
    retrievalHitRate: hits.length ? round(hits.filter((r) => r.retrieval_hit === 1).length / hits.length) : null,
    noEvidenceAccuracy: neRows.length ? round(neCorrect / neRows.length) : null,
    verdictDist, scored: scored.length, errors: rows.length - scored.length,
    abortedByCost: rows.filter((r) => r.error === "aborted_cost_cap").length,
  };
}

export type FinalizeResult = { finalized: boolean; status?: EvalRunStatus; baseRunId?: string | null; regressions?: string[]; actions?: { verified: number; regressed: number } };

/**
 * 집계 → 조건부 상태 전환(queued/running일 때만, 한 번만 이긴다) → 이긴 쪽만 회귀 목록·동작 검증·잠금 해제.
 * force: 중단(aborted)·정체 청소(partial)에서 남은 항목 없이 마감할 때.
 */
export async function finalizeRun(env: EvalEnv, runId: string, opts: { force?: EvalRunStatus; error?: string } = {}): Promise<FinalizeResult> {
  const run = await env.DB.prepare("SELECT * FROM eval_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run || TERMINAL.has(run.status)) return { finalized: false };
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.item_id, r.grounded, r.retrieval_hit, r.judge_score, r.verdict, r.passed, r.error, i.expected_verdict FROM eval_results r LEFT JOIN eval_items i ON i.id = r.item_id WHERE r.run_id = ?"
  ).bind(runId).all<ResultWithItem>();
  const rows = results || [];
  const agg = aggregate(rows);
  const status: EvalRunStatus = opts.force ?? (agg.abortedByCost > 0 ? "aborted" : agg.errors > 0 ? "partial" : "done");
  // 직전 완료 실행(같은 데이터셋). 항목 비교는 같은 item_id끼리만 한다 (§4 규칙 3).
  const base = await env.DB.prepare(
    "SELECT id FROM eval_runs WHERE dataset_id = ? AND id <> ? AND status = 'done' AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(run.dataset_id, runId, run.created_at).first<{ id: string }>();
  const baseRunId = base?.id ?? null;
  const upd = await env.DB.prepare(
    `UPDATE eval_runs SET status = ?, pass_count = ?, pass_rate = ?, avg_judge = ?, retrieval_hit_rate = ?, no_evidence_accuracy = ?, verdict_dist_json = ?,
       base_run_id = ?, items_done = ?, items_error = ?, finished_at = datetime('now'), started_at = COALESCE(started_at, datetime('now')), error = COALESCE(?, error)
     WHERE id = ? AND status IN ('queued','running')`
  ).bind(
    status, agg.passCount, agg.passRate, agg.avgJudge, agg.retrievalHitRate, agg.noEvidenceAccuracy, JSON.stringify(agg.verdictDist),
    baseRunId, rows.length, agg.errors, opts.error ?? null, runId,
  ).run();
  if ((upd.meta?.changes ?? 0) !== 1) return { finalized: false };

  const regressions = baseRunId ? await regressionResultIds(env, runId, baseRunId) : [];
  let actions = { verified: 0, regressed: 0 };
  try { actions = await verifyActionsForRun(env, runId); } catch (e) { console.log("[eval] verifyActionsForRun failed:", e instanceof Error ? e.message : String(e)); }
  await releaseLock(env, runId);
  return { finalized: true, status, baseRunId, regressions, actions };
}

/** 회귀 = 직전 실행에서 통과, 이번 실행에서 (오류 없이) 실패한 항목. gaps.ts가 regression 공백으로 보여 준다. */
export async function regressionResultIds(env: Pick<ObsEnv, "DB">, runId: string, baseRunId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT cur.id FROM eval_results cur JOIN eval_results prev ON prev.item_id = cur.item_id AND prev.run_id = ?
     WHERE cur.run_id = ? AND cur.error IS NULL AND cur.passed = 0 AND prev.error IS NULL AND prev.passed = 1`
  ).bind(baseRunId, runId).all<{ id: string }>();
  return (results || []).map((r) => r.id);
}

// ---- 중단 · 정체 청소 · cron -----------------------------------------------------------------

export async function abortRun(env: EvalEnv, runId: string): Promise<{ ok: boolean; status?: EvalRunStatus; error?: string }> {
  const r = await finalizeRun(env, runId, { force: "aborted", error: "aborted by admin" });
  if (!r.finalized) return { ok: false, error: "run not found or already finished" };
  return { ok: true, status: r.status };
}

/** 60분 넘게 queued/running인 실행을 partial로 마감하고 잠금을 푼다 (Cron). */
export async function sweepStaleRuns(env: EvalEnv): Promise<{ swept: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM eval_runs WHERE status IN ('queued','running') AND COALESCE(started_at, created_at) < datetime('now', ?)`
  ).bind(`-${STALE_RUN_MINUTES} minutes`).all<{ id: string }>();
  const swept: string[] = [];
  for (const r of results || []) {
    const f = await finalizeRun(env, r.id, { force: "partial", error: `stale: running > ${STALE_RUN_MINUTES} min` });
    if (f.finalized) swept.push(r.id);
  }
  return { swept };
}

/**
 * 03:00 KST cron 본체 (M6-β가 scheduled()에서 event.cron으로 분기해 부른다).
 * 순서: 정체 청소 → (꺼져 있으면 끝) → 기본 데이터셋 cron 실행(config_hash 같으면 skipped).
 * 표본 판정(sampleJudgeUserTraces)은 별도 export — M6-β가 비용 동기화 뒤·평가 전에 부른다.
 */
export async function runScheduledEval(env: EvalEnv, _deps?: Partial<EvalDeps>): Promise<{ swept: string[]; run?: StartRunResult; skipped?: string }> {
  if (!(await obsSchemaReady(env.DB))) return { swept: [], skipped: "obs schema not migrated" };
  const { swept } = await sweepStaleRuns(env);
  if (!(await evalEnabled(env))) return { swept, skipped: "eval disabled" };
  const ds = (await env.DB.prepare(
    "SELECT d.id FROM eval_datasets d WHERE EXISTS (SELECT 1 FROM eval_items i WHERE i.dataset_id = d.id AND i.active = 1) ORDER BY CASE WHEN d.id = ? THEN 0 ELSE 1 END, d.created_at LIMIT 1"
  ).bind(DEFAULT_DATASET_ID).first<{ id: string }>());
  if (!ds) return { swept, skipped: "no dataset with active items" };
  const run = await startRun(env, { datasetId: ds.id, trigger: "cron" });
  return { swept, run };
}

// ---- 트레이스 1건 판정 · 표본 판정 (참조 없는 judge) ------------------------------------------

async function evidenceForEvent(env: Pick<ObsEnv, "DB">, sourceIds: string[]): Promise<JudgeEvidence[]> {
  const out: JudgeEvidence[] = [];
  for (const id of sourceIds.slice(0, 5)) {
    const c = await env.DB.prepare(
      "SELECT c.article, c.text, COALESCE(p.title, d.title, c.doc_id) AS title FROM chunks c LEFT JOIN policies p ON p.id = c.doc_id LEFT JOIN documents d ON d.id = c.doc_id WHERE c.id = ?"
    ).bind(id).first<{ article: string; text: string; title: string }>();
    if (c) { out.push({ title: c.title, section: c.article, snippet: c.text }); continue; }
    const p = await env.DB.prepare("SELECT title, section, body FROM policies WHERE id = ?").bind(id).first<{ title: string; section: string; body: string }>();
    if (p) out.push({ title: p.title, section: p.section, snippet: p.body });
  }
  return out;
}

export type TraceJudgeResult =
  | { ok: true; eventId: string; verdict: Verdict | null; verdictEngine: string; verdictError?: string; judge: JudgeResult | null; judgeError?: string }
  | { ok: false; status: 403 | 404 | 409 | 429 | 503; error: string; retryAfter?: number };

async function judgeOneTrace(env: EvalEnv, eventId: string, engine: VerdictEngine): Promise<TraceJudgeResult> {
  const ev = await env.DB.prepare("SELECT id, question, answer, source_ids, grounded FROM ask_events WHERE id = ?").bind(eventId)
    .first<{ id: string; question: string; answer: string; source_ids: string; grounded: number }>();
  if (!ev) return { ok: false, status: 404, error: "trace not found" };
  if (!ev.grounded) return { ok: false, status: 409, error: "trace has no evidence (no_evidence) — nothing to judge" };
  const evidence = await evidenceForEvent(env, parseJson<string[]>(ev.source_ids, []));
  const v = await classifyVerdict(env, { question: ev.question, answer: ev.answer, evidence }, engine);
  const j = await judgeAnswer(env, { question: ev.question, expectedAnswer: null, answer: ev.answer, evidence });
  const stmts: D1PreparedStatement[] = [];
  if (v.ok) stmts.push(env.DB.prepare("INSERT INTO trace_scores (id, event_id, name, value, label, source, comment) VALUES (?, ?, 'verdict', NULL, ?, 'verdict', ?)").bind(newId("sc"), eventId, v.verdict, (v.reason ?? v.engine).slice(0, 500)));
  // 실패 시도 표지: 'verdict' 점수처럼 보이지 않는 별도 이름. 표본 판정이 같은 트레이스를 (KST 당일) 다시 뽑지 않게 한다.
  if (!v.ok) stmts.push(env.DB.prepare("INSERT INTO trace_scores (id, event_id, name, value, label, source, comment) VALUES (?, ?, 'verdict_attempt', NULL, 'failed', 'verdict', ?)").bind(newId("sc"), eventId, `${v.error}: ${v.detail}`.slice(0, 500)));
  if (j.ok) stmts.push(env.DB.prepare("INSERT INTO trace_scores (id, event_id, name, value, label, source, comment) VALUES (?, ?, 'judge_score', ?, ?, 'judge', ?)").bind(newId("sc"), eventId, j.result.score, j.result.level, `[ref-free ${JUDGE_VERSION}] ${j.result.reasoning}`.slice(0, 2000)));
  if (stmts.length) await env.DB.batch(stmts);
  return {
    ok: true, eventId, verdict: v.ok ? v.verdict : null, verdictEngine: v.engine, ...(v.ok ? {} : { verdictError: `${v.error}: ${v.detail}` }),
    judge: j.ok ? j.result : null, ...(j.ok ? {} : { judgeError: `${j.error}: ${j.detail}` }),
  };
}

/** POST /api/obs/traces/:id/judge — 일일 한도(KST) 안에서 1건 판정. */
export async function judgeTrace(env: EvalEnv, eventId: string): Promise<TraceJudgeResult> {
  if (!(await obsSchemaReady(env.DB))) return { ok: false, status: 503, error: "obs schema not migrated (0013/0014)" };
  if (!(await evalEnabled(env))) return { ok: false, status: 403, error: "eval disabled (meta.eval_enabled=0)" };
  if ((await dailyCount(env, "tracejudge")) >= TRACE_JUDGE_PER_DAY) {
    return { ok: false, status: 429, error: `daily trace judge limit reached (${TRACE_JUDGE_PER_DAY}/day KST)`, retryAfter: secondsUntilKstMidnight() };
  }
  const engine = (await detectVerdictEngine(env)).engine;
  const r = await judgeOneTrace(env, eventId, engine);
  if (r.ok) await bumpDaily(env, "tracejudge");
  return r;
}

/** Cron: 판정 없는 최근 24시간 user 트레이스(근거 있음)에 verdict + 참조 없는 judge. 하루 최대 20건. */
export async function sampleJudgeUserTraces(env: EvalEnv, opts: { limit?: number } = {}): Promise<{ judged: number; skipped?: string }> {
  if (!(await obsSchemaReady(env.DB))) return { judged: 0, skipped: "obs schema not migrated" };
  if (!(await evalEnabled(env))) return { judged: 0, skipped: "eval disabled" };
  const left = SAMPLE_JUDGE_PER_DAY - (await dailyCount(env, "sample"));
  const n = Math.min(left, opts.limit ?? SAMPLE_JUDGE_PER_DAY);
  if (n <= 0) return { judged: 0, skipped: "daily sample limit reached" };
  const { results } = await env.DB.prepare(
    `SELECT e.id FROM ask_events e WHERE COALESCE(e.origin, 'user') = 'user' AND e.grounded = 1 AND e.created_at >= datetime('now', '-1 day')
       AND NOT EXISTS (SELECT 1 FROM trace_scores s WHERE s.event_id = e.id AND s.name = 'verdict')
       AND NOT EXISTS (SELECT 1 FROM trace_scores a WHERE a.event_id = e.id AND a.name = 'verdict_attempt' AND a.created_at >= datetime('now', '+9 hours', 'start of day', '-9 hours'))
     ORDER BY e.created_at DESC LIMIT ?`
  ).bind(n).all<{ id: string }>();
  const engine = (await detectVerdictEngine(env)).engine;
  let judged = 0;
  for (const r of results || []) {
    const out = await judgeOneTrace(env, r.id, engine);
    if (out.ok && out.verdict) judged++; // 판정 실패는 일일 한도(sample)에 세지 않는다
    await new Promise<void>((res) => setTimeout(res, ITEM_GAP_MS));
  }
  if (judged) await bumpDaily(env, "sample", judged);
  return { judged };
}

// ---- 읽기 (routes-evals가 쓴다) -----------------------------------------------------------

export async function listRuns(env: Pick<ObsEnv, "DB">, opts: { datasetId?: string; limit: number; cursor?: { t: string; id: string } | null }): Promise<RunRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.datasetId) { where.push("dataset_id = ?"); binds.push(opts.datasetId); }
  if (opts.cursor) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); binds.push(opts.cursor.t, opts.cursor.t, opts.cursor.id); }
  const sql = `SELECT * FROM eval_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, opts.limit + 1).all<RunRow>();
  return results || [];
}

type ResultDetailRow = {
  id: string; run_id: string; item_id: string; event_id: string | null; answer: string | null; grounded: number | null; retrieved_ids: string;
  retrieval_hit: number | null; judge_score: number | null; judge_dims_json: string | null; judge_reason: string | null; judge_comment: string | null; judge_snapped: number;
  judge_skipped: string | null; verdict: string | null; verdict_engine: string | null; passed: number | null; error: string | null;
  latency_ms: number | null; created_at: string; question: string | null; expected_verdict: string | null; expected_answer: string | null;
};

export type Comparison = "new_fail" | "new_pass" | "same" | "new" | "error";

export async function getRunDetail(env: Pick<ObsEnv, "DB">, runId: string) {
  const run = await env.DB.prepare("SELECT * FROM eval_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run) return null;
  const { results } = await env.DB.prepare(
    "SELECT r.*, i.question, i.expected_verdict, i.expected_answer FROM eval_results r LEFT JOIN eval_items i ON i.id = r.item_id WHERE r.run_id = ? ORDER BY r.created_at, r.id"
  ).bind(runId).all<ResultDetailRow>();
  // 직전 실행: 마감 때 고정된 base_run_id, 아직 진행 중이면 같은 데이터셋의 직전 done 실행.
  const baseId = run.base_run_id ?? (await env.DB.prepare(
    "SELECT id FROM eval_runs WHERE dataset_id = ? AND id <> ? AND status = 'done' AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(run.dataset_id, runId, run.created_at).first<{ id: string }>())?.id ?? null;
  const prev = new Map<string, { passed: number | null; error: string | null }>();
  if (baseId) {
    const { results: pr } = await env.DB.prepare("SELECT item_id, passed, error FROM eval_results WHERE run_id = ?").bind(baseId).all<{ item_id: string; passed: number | null; error: string | null }>();
    for (const p of pr || []) prev.set(p.item_id, p);
  }
  const order: Record<Comparison, number> = { new_fail: 0, error: 1, new_pass: 2, new: 3, same: 4 };
  const items = (results || []).map((r) => {
    const p = prev.get(r.item_id);
    let comparison: Comparison;
    if (r.error) comparison = "error";
    else if (!p || p.error) comparison = "new";
    else if (p.passed === 1 && r.passed === 0) comparison = "new_fail";
    else if (p.passed === 0 && r.passed === 1) comparison = "new_pass";
    else comparison = "same";
    return {
      id: r.id, itemId: r.item_id, eventId: r.event_id, question: r.question, expectedVerdict: r.expected_verdict, expectedAnswer: r.expected_answer,
      answer: r.answer, grounded: intToBool(r.grounded), retrievedIds: parseJson<string[]>(r.retrieved_ids, []), retrievalHit: intToBool(r.retrieval_hit),
      judgeScore: r.judge_score, judgeDims: parseJson<JudgeResult["dimensions"] | null>(r.judge_dims_json, null), judgeReason: r.judge_reason, judgeComment: r.judge_comment ?? null,
      judgeSnapped: r.judge_snapped === 1, judgeSkipped: r.judge_skipped, verdict: r.verdict, verdictEngine: r.verdict_engine,
      passed: intToBool(r.passed), error: r.error, latencyMs: r.latency_ms, createdAt: r.created_at,
      result: r.error ? "error" : r.passed === 1 ? "pass" : "fail", comparison, prevPassed: p ? intToBool(p.passed) : null,
    };
  });
  items.sort((a, b) => order[a.comparison] - order[b.comparison]);
  return { run: mapRun(run), baseRunId: baseId, items };
}

const MARKER_KEYS: Array<[keyof RunConfig, string]> = [
  ["prompt_version_id", "prompt 버전"], ["llm_model", "LLM 모델"], ["knowledge_epoch", "지식 epoch"], ["dataset_version", "데이터셋 버전"],
  ["judge_version", "judge 버전"], ["verdict_engine", "verdict 엔진"], ["embed_model", "임베딩 모델"], ["score_floor", "SCORE_FLOOR"], ["keyword_gate_min", "KEYWORD_GATE_MIN"],
];

/** 추이: 완료(done/partial) 실행을 오래된 순으로 + 직전 실행 대비 설정 변경 표식 + judge 불일치 주석. */
export async function getTrend(env: Pick<ObsEnv, "DB">, datasetId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM eval_runs WHERE dataset_id = ? AND status IN ('done','partial') ORDER BY created_at ASC, id ASC LIMIT 200"
  ).bind(datasetId).all<RunRow>();
  let prevCfg: Partial<RunConfig> | null = null;
  let prevRun: RunRow | null = null;
  return (results || []).map((r) => {
    const cfg = parseJson<Partial<RunConfig>>(r.config_json, {});
    const changes: Array<{ key: string; label: string; from: unknown; to: unknown }> = [];
    if (prevCfg) for (const [k, label] of MARKER_KEYS) if (JSON.stringify(prevCfg[k]) !== JSON.stringify(cfg[k])) changes.push({ key: k, label, from: prevCfg[k], to: cfg[k] });
    // 결정적 지표(적중률)와 judge 평균이 반대로 움직이면 주석.
    let judgeDisagreement = false;
    if (prevRun && prevRun.avg_judge != null && r.avg_judge != null && prevRun.retrieval_hit_rate != null && r.retrieval_hit_rate != null) {
      const dj = r.avg_judge - prevRun.avg_judge;
      const dh = r.retrieval_hit_rate - prevRun.retrieval_hit_rate;
      judgeDisagreement = Math.abs(dj) >= 0.05 && Math.abs(dh) >= 0.05 && Math.sign(dj) !== Math.sign(dh);
    }
    prevCfg = cfg;
    prevRun = r;
    return {
      runId: r.id, createdAt: r.created_at, trigger: r.trigger, status: r.status, passRate: r.pass_rate, avgJudge: r.avg_judge,
      retrievalHitRate: r.retrieval_hit_rate, noEvidenceAccuracy: r.no_evidence_accuracy, itemsDone: r.items_done, itemsError: r.items_error,
      changes, judgeDisagreement,
    };
  });
}
