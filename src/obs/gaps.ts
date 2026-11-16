// S4 M4 — 개선 루프: 통합 공백 목록 + 개선 동작 + 검증 갱신. 설계: §3.3, §4.
//
// 공백 키 = `<kind>:<ref>`
//   no_evidence:<gapId> / downvote:<gapId>   ← knowledge_gaps (기존 C5-b 큐)
//   low_score:<resultId>                     ← 최신 완료 실행의 eval_results.judge_score < 0.6
//   low_score:<eventId>                      ← user 트레이스의 trace_scores.judge_score < 0.6
//   hallucination_risk:<eventId>             ← grounded=1 인데 verdict ∈ {ungrounded, off_topic}
//   regression:<resultId>                    ← 최신 완료 실행 vs base_run_id: 직전 통과 → 이번 실패
// low_score·regression·hallucination_risk는 저장된 행이 아니라 실행·점수에서 계산한 뷰다
// (finalizeRun이 base_run_id를 고정하면 그 시점부터 회귀 공백이 보인다).
//
// 동작 상태: applied → (다음 평가에서 연결 항목 통과) verified / (실패) regressed. dismiss → dismissed.
// §4 규칙 1: 고친 공백은 반드시 골든 항목이 된다 — publish_tacit·fix_document·adjust_prompt는
// 연결 항목(itemId)이 없으면 409 promote_required로 돌려보내 승격 대화상자를 먼저 띄우게 한다.
import { newId } from "./db";
import { LOW_SCORE_THRESHOLD } from "./guards";
import type { ExpectedSource, ExpectedVerdict, GapKind, GapRow, ImprovementAction, ImprovementActionType, ObsEnv } from "./types";

export const GAP_KINDS: readonly GapKind[] = ["no_evidence", "downvote", "low_score", "hallucination_risk", "regression"];
export const ACTIONS: readonly ImprovementActionType[] = ["publish_tacit", "fix_document", "adjust_prompt", "promote", "dismiss"];
const DEFAULT_DATASET_ID = "ds_core_v1";
const GAP_LIST_MAX = 200;
// 집계 시 "가장 관련 있는 상태": 다시 열린 것 > 지금 열린 것 > 적용됨(검증 대기) > 검증됨 > 기각.
const STATUS_RANK: Record<string, number> = { regressed: 0, open: 1, applied: 2, verified: 3, dismissed: 4 };

type DB = Pick<ObsEnv, "DB">;

export function parseGapKey(key: string): { kind: GapKind; ref: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i) as GapKind;
  const ref = key.slice(i + 1);
  if (!GAP_KINDS.includes(kind) || !ref) return null;
  return { kind, ref };
}

type ActionRow = {
  id: string; gap_key: string; kind: string; action: string; status: string; question: string | null; gap_id: string | null; event_id: string | null;
  result_id: string | null; item_id: string | null; doc_id: string | null; prompt_version_id: string | null; note: string | null; created_at: string;
  verified_run_id: string | null; verified_at: string | null;
};

function mapAction(r: ActionRow): ImprovementAction {
  return {
    id: r.id, gapKey: r.gap_key, kind: r.kind as GapKind, action: r.action as ImprovementActionType, status: r.status as ImprovementAction["status"],
    question: r.question, gapId: r.gap_id, eventId: r.event_id, resultId: r.result_id, itemId: r.item_id, docId: r.doc_id,
    promptVersionId: r.prompt_version_id, note: r.note, createdAt: r.created_at, verifiedRunId: r.verified_run_id, verifiedAt: r.verified_at,
  };
}

function kgStatus(s: string): string {
  return s === "answered" ? "applied" : s === "resolved" ? "verified" : "open";
}

/** 최신 완료(done/partial) 실행 — 데이터셋마다 1개. */
async function latestFinishedRuns(env: DB): Promise<Array<{ id: string; base_run_id: string | null; finished_at: string | null }>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.base_run_id, r.finished_at FROM eval_runs r
     WHERE r.status IN ('done','partial') AND r.id = (
       SELECT r2.id FROM eval_runs r2 WHERE r2.dataset_id = r.dataset_id AND r2.status IN ('done','partial') ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)`
  ).all<{ id: string; base_run_id: string | null; finished_at: string | null }>();
  return results || [];
}

/** 통합 공백 목록. status 필터는 동작 상태를 반영한 최종 상태 기준. */
/** GapRow(M1 계약) + 화면용 부가 필드 (judge 사유 요약, 회귀 기준 실행). */
export type GapListRow = GapRow & { judgeScore?: number; judgeReason?: string | null; judgeComment?: string | null; baseRunId?: string };

/** 0021: 질문자 표시 이름. 기록된 사용자가 없으면 "익명" (기존 행은 모두 NULL). */
function userLabel(userId: string | null, name: string | null): string {
  if (!userId) return "익명";
  return name || "알 수 없는 사용자";
}

export async function listGaps(env: DB, filter: { status?: string; kind?: string } = {}): Promise<GapListRow[]> {
  const rows: GapListRow[] = [];
  const want = (k: GapKind) => !filter.kind || filter.kind === k;

  if (want("no_evidence") || want("downvote")) {
    const { results } = await env.DB.prepare(
      // 0021: 질문자 이름 (user_id NULL → "익명").
      "SELECT g.id, g.question, g.asked_at, g.status, g.doc_id, g.count, g.source, g.user_id, u.name AS user_name FROM knowledge_gaps g LEFT JOIN users u ON u.id = g.user_id ORDER BY g.asked_at DESC LIMIT ?"
    ).bind(GAP_LIST_MAX).all<{ id: string; question: string; asked_at: number; status: string; doc_id: string | null; count: number; source: string; user_id: string | null; user_name: string | null }>();
    for (const g of results || []) {
      const kind: GapKind | null = g.source === "downvote" ? "downvote" : g.source === "no-evidence" ? "no_evidence" : null;
      if (!kind || !want(kind)) continue; // low-score/regression에서 게시용으로 만든 행은 원래 키로 보인다
      rows.push({ key: `${kind}:${g.id}`, kind, question: g.question, status: kgStatus(g.status), count: g.count || 1, gapId: g.id, docId: g.doc_id ?? undefined, lastSeenAt: new Date(g.asked_at).toISOString(), askerName: userLabel(g.user_id, g.user_name) });
    }
  }

  const runs = (want("low_score") || want("regression")) ? await latestFinishedRuns(env) : [];
  if (want("low_score")) {
    for (const run of runs) {
      const { results } = await env.DB.prepare(
        `SELECT r.id, r.item_id, r.event_id, r.judge_score, r.judge_reason, r.judge_comment, r.created_at, i.question FROM eval_results r JOIN eval_items i ON i.id = r.item_id
         WHERE r.run_id = ? AND r.error IS NULL AND r.judge_score IS NOT NULL AND r.judge_score < ?`
      ).bind(run.id, LOW_SCORE_THRESHOLD).all<{ id: string; item_id: string; event_id: string | null; judge_score: number; judge_reason: string | null; judge_comment: string | null; created_at: string; question: string }>();
      for (const r of results || []) {
        rows.push({ key: `low_score:${r.id}`, kind: "low_score", question: r.question, status: "open", count: 1, resultId: r.id, itemId: r.item_id, eventId: r.event_id ?? undefined, lastSeenAt: r.created_at, judgeScore: r.judge_score, judgeReason: r.judge_reason, judgeComment: r.judge_comment, askerName: "평가" });
      }
    }
    // 사용자 트레이스 표본 채점에서 나온 저점수 — 질문자 = 그 트레이스의 사용자.
    const { results: tr } = await env.DB.prepare(
      `SELECT s.event_id, MIN(s.value) AS v, MAX(s.created_at) AS at, e.question, e.user_id, u.name AS user_name FROM trace_scores s JOIN ask_events e ON e.id = s.event_id
       LEFT JOIN users u ON u.id = e.user_id
       WHERE s.name = 'judge_score' AND s.eval_run_id IS NULL AND s.value < ? AND COALESCE(e.origin, 'user') = 'user'
       GROUP BY s.event_id ORDER BY at DESC LIMIT ?`
    ).bind(LOW_SCORE_THRESHOLD, GAP_LIST_MAX).all<{ event_id: string; v: number; at: string; question: string; user_id: string | null; user_name: string | null }>();
    for (const t of tr || []) rows.push({ key: `low_score:${t.event_id}`, kind: "low_score", question: t.question, status: "open", count: 1, eventId: t.event_id, lastSeenAt: t.at, judgeScore: t.v, askerName: userLabel(t.user_id, t.user_name) });
  }

  if (want("hallucination_risk")) {
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.question, MAX(s.created_at) AS at, e.user_id, u.name AS user_name FROM ask_events e JOIN trace_scores s ON s.event_id = e.id AND s.name = 'verdict'
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.grounded = 1 AND s.label IN ('ungrounded','off_topic') AND COALESCE(e.origin, 'user') = 'user'
       GROUP BY e.id ORDER BY at DESC LIMIT ?`
    ).bind(GAP_LIST_MAX).all<{ id: string; question: string; at: string; user_id: string | null; user_name: string | null }>();
    for (const e of results || []) rows.push({ key: `hallucination_risk:${e.id}`, kind: "hallucination_risk", question: e.question, status: "open", count: 1, eventId: e.id, lastSeenAt: e.at, askerName: userLabel(e.user_id, e.user_name) });
  }

  if (want("regression")) {
    for (const run of runs) {
      if (!run.base_run_id) continue;
      const { results } = await env.DB.prepare(
        `SELECT cur.id, cur.item_id, cur.event_id, cur.judge_reason, cur.judge_comment, cur.created_at, i.question FROM eval_results cur
         JOIN eval_results prev ON prev.item_id = cur.item_id AND prev.run_id = ?
         JOIN eval_items i ON i.id = cur.item_id
         WHERE cur.run_id = ? AND cur.error IS NULL AND cur.passed = 0 AND prev.error IS NULL AND prev.passed = 1`
      ).bind(run.base_run_id, run.id).all<{ id: string; item_id: string; event_id: string | null; judge_reason: string | null; judge_comment: string | null; created_at: string; question: string }>();
      for (const r of results || []) rows.push({ key: `regression:${r.id}`, kind: "regression", question: r.question, status: "open", count: 1, resultId: r.id, itemId: r.item_id, eventId: r.event_id ?? undefined, lastSeenAt: r.created_at, judgeReason: r.judge_reason, judgeComment: r.judge_comment, baseRunId: run.base_run_id ?? undefined, askerName: "평가" });
    }
  }

  // 동작 이력 붙이기 + 최종 상태 = 최신 동작 상태(있으면).
  if (rows.length) {
    const keys = rows.map((r) => r.key);
    const byKey = new Map<string, ImprovementAction[]>();
    for (let i = 0; i < keys.length; i += 80) {
      const part = keys.slice(i, i + 80);
      const { results } = await env.DB.prepare(`SELECT * FROM improvement_actions WHERE gap_key IN (${part.map(() => "?").join(",")}) ORDER BY created_at ASC, id ASC`).bind(...part).all<ActionRow>();
      for (const a of results || []) {
        const list = byKey.get(a.gap_key) ?? [];
        list.push(mapAction(a));
        byKey.set(a.gap_key, list);
      }
    }
    for (const r of rows) {
      const acts = byKey.get(r.key);
      if (!acts?.length) continue;
      r.actions = acts;
      const last = acts[acts.length - 1];
      // regressed = 고쳤는데 다음 평가에서 실패 → 다시 열린 공백 (§3.3 "아니면 open으로 되돌리고").
      r.status = last.status === "regressed" ? "regressed" : last.status;
      if (!r.itemId) r.itemId = [...acts].reverse().find((a) => a.itemId)?.itemId ?? undefined;
    }
  }
  // (질문, 종류)가 같은 행은 한 줄로 합친다 — knowledge_gaps 원본 행은 그대로 두고 목록 질의에서만 집계.
  // 개수는 합산, 상태는 가장 관련 있는 것(STATUS_RANK 낮을수록), 대표 행 = 그 상태를 가진 가장 최근 행. 동작 이력은 합친다.
  // 집계는 상태 필터 앞에서 하므로 openGapCount도 집계된 목록과 같은 수를 센다.
  const merged = new Map<string, GapListRow[]>();
  for (const r of rows) {
    const k = `${r.kind}\u0000${normQ(r.question)}`;
    const g = merged.get(k);
    if (g) g.push(r); else merged.set(k, [r]);
  }
  const aggregated: GapListRow[] = [];
  for (const group of merged.values()) {
    if (group.length === 1) { aggregated.push(group[0]); continue; }
    const rank = (r: GapListRow) => STATUS_RANK[r.status] ?? 9;
    const rep = { ...[...group].sort((a, b) => rank(a) - rank(b) || (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""))[0] };
    rep.count = group.reduce((n, r) => n + (r.count || 1), 0);
    rep.lastSeenAt = group.map((r) => r.lastSeenAt || "").sort().pop() || rep.lastSeenAt;
    rep.docId = rep.docId ?? group.find((r) => r.docId)?.docId;
    rep.itemId = rep.itemId ?? group.find((r) => r.itemId)?.itemId;
    const acts = group.flatMap((r) => r.actions ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (acts.length) rep.actions = acts;
    aggregated.push(rep);
  }

  const out = aggregated.filter((r) => !filter.status || r.status === filter.status || (filter.status === "open" && r.status === "regressed"));
  out.sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  return out.slice(0, GAP_LIST_MAX);
}

// ---- 공백 문맥 해석 ---------------------------------------------------------------------

type GapContext = { kind: GapKind; question: string; gapId: string | null; eventId: string | null; resultId: string | null; itemId: string | null };

async function resolveGap(env: DB, key: string): Promise<GapContext | null> {
  const p = parseGapKey(key);
  if (!p) return null;
  if (p.kind === "no_evidence" || p.kind === "downvote") {
    const g = await env.DB.prepare("SELECT id, question FROM knowledge_gaps WHERE id = ?").bind(p.ref).first<{ id: string; question: string }>();
    return g ? { kind: p.kind, question: g.question, gapId: g.id, eventId: null, resultId: null, itemId: null } : null;
  }
  const res = await env.DB.prepare("SELECT r.id, r.item_id, r.event_id, i.question FROM eval_results r JOIN eval_items i ON i.id = r.item_id WHERE r.id = ?").bind(p.ref)
    .first<{ id: string; item_id: string; event_id: string | null; question: string }>();
  if (res) return { kind: p.kind, question: res.question, gapId: null, eventId: res.event_id, resultId: res.id, itemId: res.item_id };
  const ev = await env.DB.prepare("SELECT id, question FROM ask_events WHERE id = ?").bind(p.ref).first<{ id: string; question: string }>();
  return ev ? { kind: p.kind, question: ev.question, gapId: null, eventId: ev.id, resultId: null, itemId: null } : null;
}

function normQ(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

/** 같은 질문의 활성 골든 항목 (있으면 연결 항목으로 본다). */
async function findActiveItemByQuestion(env: DB, question: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM eval_items WHERE question = ? AND active = 1 ORDER BY created_at LIMIT 1").bind(normQ(question)).first<{ id: string }>();
  return row?.id ?? null;
}

// ---- 골든 승격 ------------------------------------------------------------------------------
// M3의 promoteGapToItem/promoteTraceToItem(src/obs/seed-golden.ts)이 이 세션 시점에 없어서
// 같은 규칙(같은 질문의 활성 항목이 있으면 그 id, 추가 시 dataset version +1)으로 여기서 만든다.
// M6-β가 M3 구현과 합칠 때 이 함수를 M3 호출로 바꿔도 계약(반환 itemId)은 같다.

export type PromoteInput = { datasetId?: unknown; expectedAnswer?: unknown; expectedSources?: unknown; expectedVerdict?: unknown };

export async function promoteToItem(env: DB, ctx: GapContext, input: PromoteInput): Promise<{ ok: true; itemId: string; existing: boolean } | { ok: false; status: 400 | 404; error: string }> {
  const existing = await findActiveItemByQuestion(env, ctx.question);
  if (existing) return { ok: true, itemId: existing, existing: true };
  const datasetId = typeof input.datasetId === "string" && input.datasetId ? input.datasetId : DEFAULT_DATASET_ID;
  const ds = await env.DB.prepare("SELECT id FROM eval_datasets WHERE id = ?").bind(datasetId).first<{ id: string }>();
  if (!ds) return { ok: false, status: 404, error: `dataset not found: ${datasetId}` };
  const expectedVerdict: ExpectedVerdict = input.expectedVerdict === "ungrounded" ? "ungrounded" : "grounded";
  const expectedAnswer = typeof input.expectedAnswer === "string" && input.expectedAnswer.trim() ? input.expectedAnswer.trim().slice(0, 2000) : null;
  // 기대 답은 사람이 쓴다 (§14 — 모델이 정답을 만들지 않는다). grounded 항목은 기대 답이 있어야 judge가 대조할 수 있다.
  if (expectedVerdict === "grounded" && !expectedAnswer) return { ok: false, status: 400, error: "expectedAnswer required for grounded item (written by a person)" };
  const sources = Array.isArray(input.expectedSources)
    ? (input.expectedSources as ExpectedSource[]).filter((s) => s && typeof s === "object").map((s) => ({
        ...(typeof s.doc_id === "string" ? { doc_id: s.doc_id } : {}), ...(typeof s.title_like === "string" ? { title_like: s.title_like } : {}),
        ...(typeof s.article_like === "string" ? { article_like: s.article_like } : {}),
      }))
    : [];
  const itemId = newId("gi");
  const source = ctx.gapId ? "gap" : ctx.eventId ? "trace" : "manual";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO eval_items (id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(itemId, ds.id, normQ(ctx.question), expectedAnswer, JSON.stringify(sources), expectedVerdict, JSON.stringify(["loop", ctx.kind]), source, ctx.gapId ?? ctx.eventId ?? ctx.resultId),
    env.DB.prepare("UPDATE eval_datasets SET version = version + 1 WHERE id = ?").bind(ds.id),
  ]);
  return { ok: true, itemId, existing: false };
}

// ---- 개선 동작 ------------------------------------------------------------------------------

export type ActionBody = {
  action?: unknown; note?: unknown; docId?: unknown; promptVersionId?: unknown; itemId?: unknown;
  datasetId?: unknown; expectedAnswer?: unknown; expectedSources?: unknown; expectedVerdict?: unknown;
};

export type ActionResult =
  | { ok: true; action: ImprovementAction; affected?: number; itemId?: string; gapId?: string; existingItem?: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string; question?: string };

export async function applyGapAction(env: DB, key: string, body: ActionBody): Promise<ActionResult> {
  const action = body.action as ImprovementActionType;
  if (!ACTIONS.includes(action)) return { ok: false, status: 400, error: `action must be one of ${ACTIONS.join(", ")}` };
  const ctx = await resolveGap(env, key);
  if (!ctx) return { ok: false, status: 404, error: "gap not found" };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  const docId = typeof body.docId === "string" && body.docId ? body.docId : null;
  const promptVersionId = typeof body.promptVersionId === "string" && body.promptVersionId ? body.promptVersionId : null;
  let itemId: string | null = typeof body.itemId === "string" && body.itemId ? body.itemId : ctx.itemId;
  let existingItem: boolean | undefined;

  if (action === "dismiss" && !note) return { ok: false, status: 400, error: "note (reason) required to dismiss" };
  if (action === "adjust_prompt") {
    if (!promptVersionId) return { ok: false, status: 400, error: "promptVersionId required for adjust_prompt" };
    const pv = await env.DB.prepare("SELECT id FROM prompt_versions WHERE id = ?").bind(promptVersionId).first<{ id: string }>();
    if (!pv) return { ok: false, status: 404, error: "prompt version not found" };
  }
  if (itemId) {
    const it = await env.DB.prepare("SELECT id FROM eval_items WHERE id = ?").bind(itemId).first<{ id: string }>();
    if (!it) return { ok: false, status: 404, error: "item not found" };
  }

  if (action === "promote") {
    const p = await promoteToItem(env, ctx, { datasetId: body.datasetId, expectedAnswer: body.expectedAnswer, expectedSources: body.expectedSources, expectedVerdict: body.expectedVerdict });
    if (!p.ok) return p;
    itemId = p.itemId;
    existingItem = p.existing;
  } else if (action !== "dismiss" && !itemId) {
    // §4 규칙 1: 고친 공백은 반드시 골든 항목이 된다.
    itemId = await findActiveItemByQuestion(env, ctx.question);
    if (!itemId) return { ok: false, status: 409, error: "promote_required", question: ctx.question };
  }

  // 암묵지 게시: 프론트가 기존 POST /api/gaps/:id/publish를 부른다. knowledge_gaps 행이 없는
  // low_score·regression·hallucination_risk 건은 여기서 공백 행을 먼저 만들어 gapId를 돌려준다
  // (사용자 동작이라 평가 호출의 "공백 큐 미기록" 원칙과 무관하다).
  let gapId = ctx.gapId;
  if (action === "publish_tacit" && !gapId) {
    const q = normQ(ctx.question);
    const open = await env.DB.prepare("SELECT id FROM knowledge_gaps WHERE question = ? AND status = 'open'").bind(q).first<{ id: string }>();
    if (open) gapId = open.id;
    else {
      gapId = newId("gap");
      // 0021: 질문자 = 원래 질문한 사용자 (트레이스가 있으면 ask_events.user_id). 평가 실행에서
      // 온 건(eval 트레이스·트레이스 없음)은 NULL → 목록에서 "평가"로 보인다.
      const asker = ctx.eventId
        ? await env.DB.prepare("SELECT user_id FROM ask_events WHERE id = ?").bind(ctx.eventId).first<{ user_id: string | null }>().catch(() => null)
        : null;
      await env.DB.prepare("INSERT INTO knowledge_gaps (id, question, asked_at, status, doc_id, count, source, user_id) VALUES (?, ?, ?, 'open', NULL, 1, ?, ?)")
        .bind(gapId, q, Date.now(), ctx.kind.replace("_", "-"), asker?.user_id ?? null).run();
    }
  }

  const status = action === "dismiss" ? "dismissed" : "applied";
  const insertSql =
    `INSERT INTO improvement_actions (id, gap_key, kind, action, status, question, gap_id, event_id, result_id, item_id, doc_id, prompt_version_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  // 같은 (종류, 정규화 질문) 묶음의 knowledge_gaps 행 전부에 같은 동작을 건다 (listGaps가 한 줄로 합친 단위).
  // 대상 행은 항상 포함하고, 나머지 중 이미 끝난(dismissed/verified) 행은 건드리지 않는다.
  const id = newId("act");
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(insertSql).bind(id, key, ctx.kind, action, status, ctx.question, gapId, ctx.eventId, ctx.resultId, itemId, docId, promptVersionId, note || null),
  ];
  const siblings = ctx.gapId ? await groupSiblings(env, ctx, key) : [];
  for (const s of siblings) {
    // publish_tacit는 대표 행의 gapId를 쓰지 않고 행마다 자기 gapId를 기록한다.
    stmts.push(env.DB.prepare(insertSql).bind(newId("act"), s.key, ctx.kind, action, status, s.question, action === "publish_tacit" ? s.gapId : gapId, null, null, itemId, docId, promptVersionId, note || null));
  }
  await env.DB.batch(stmts);
  const row = await env.DB.prepare("SELECT * FROM improvement_actions WHERE id = ?").bind(id).first<ActionRow>();
  return {
    ok: true, action: mapAction(row as ActionRow), affected: 1 + siblings.length,
    ...(itemId ? { itemId } : {}), ...(gapId ? { gapId } : {}), ...(existingItem != null ? { existingItem } : {}),
  };
}

/** 대상 행과 같은 묶음(종류 + 정규화 질문)에 속한, 아직 끝나지 않은 다른 knowledge_gaps 행. */
async function groupSiblings(env: DB, ctx: GapContext, targetKey: string): Promise<Array<{ key: string; gapId: string; question: string }>> {
  const source = ctx.kind === "downvote" ? "downvote" : "no-evidence";
  const { results } = await env.DB.prepare("SELECT id, question, status FROM knowledge_gaps WHERE source = ?").bind(source).all<{ id: string; question: string; status: string }>();
  const nq = normQ(ctx.question);
  const members = (results || []).filter((g) => normQ(g.question) === nq).map((g) => ({ key: `${ctx.kind}:${g.id}`, gapId: g.id, question: g.question, kg: kgStatus(g.status) }))
    .filter((m) => m.key !== targetKey);
  if (!members.length) return [];
  // 동작 이력이 있으면 그 최신 상태가 현재 상태 (listGaps와 같은 규칙).
  const latest = new Map<string, string>();
  for (let i = 0; i < members.length; i += 80) {
    const part = members.slice(i, i + 80);
    const { results: acts } = await env.DB.prepare(
      `SELECT gap_key, status FROM improvement_actions WHERE gap_key IN (${part.map(() => "?").join(",")}) ORDER BY created_at ASC, id ASC`
    ).bind(...part.map((m) => m.key)).all<{ gap_key: string; status: string }>();
    for (const a of acts || []) latest.set(a.gap_key, a.status);
  }
  return members.filter((m) => {
    const st = latest.get(m.key) ?? m.kg;
    return st !== "dismissed" && st !== "verified";
  }).map(({ key, gapId, question }) => ({ key, gapId, question }));
}

/** 회귀 실행 강조용: applied 상태 동작에 연결된 항목 id. */
export async function appliedItemIds(env: DB): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT DISTINCT item_id FROM improvement_actions WHERE status = 'applied' AND item_id IS NOT NULL").all<{ item_id: string }>();
  return (results || []).map((r) => r.item_id);
}

/**
 * finalizeRun이 부른다: 이 실행보다 먼저 적용된(applied) 동작 중 연결 항목이 이번 실행에 있는 것을
 * 통과 → verified, (오류 없이) 실패 → regressed 로 바꾼다. 오류 결과는 판단하지 않는다 (applied 유지).
 */
export async function verifyActionsForRun(env: DB, runId: string): Promise<{ verified: number; regressed: number }> {
  const run = await env.DB.prepare("SELECT created_at FROM eval_runs WHERE id = ?").bind(runId).first<{ created_at: string }>();
  if (!run) return { verified: 0, regressed: 0 };
  const { results } = await env.DB.prepare(
    `SELECT a.id, r.passed FROM improvement_actions a JOIN eval_results r ON r.item_id = a.item_id AND r.run_id = ?
     WHERE a.status = 'applied' AND a.action <> 'dismiss' AND a.created_at <= ? AND r.error IS NULL AND r.passed IS NOT NULL`
  ).bind(runId, run.created_at).all<{ id: string; passed: number }>();
  let verified = 0;
  let regressed = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const a of results || []) {
    const st = a.passed === 1 ? "verified" : "regressed";
    if (st === "verified") verified++; else regressed++;
    stmts.push(env.DB.prepare("UPDATE improvement_actions SET status = ?, verified_run_id = ?, verified_at = datetime('now') WHERE id = ? AND status = 'applied'").bind(st, runId, a.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { verified, regressed };
}

/** 공백 배지 수 (열린 것 + 회귀로 다시 열린 것). */
export async function openGapCount(env: DB): Promise<number> {
  return (await listGaps(env, { status: "open" })).length;
}
