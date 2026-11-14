// S4 M2 — Traces API (Hono 하위 앱, 설계서 §8). M6-β가 `app.route("/api/obs", tracesApp)`로 마운트한다.
//
//   GET  /summary?window=24h                 KPI 띠 (공개)
//   GET  /traces?cursor&limit&status&feedback&origin&risk&q&from&to   목록 (공개, 마스킹)
//   GET  /traces/:id                         상세 (공개, 마스킹. R2 원문 블록은 관리자만 — O5 권장안)
//   POST /traces/:id/scores {value, comment} 사람 점수 (공개, 일일 한도)
//   POST /costs/sync {since?, until?}        게이트웨이 로그 동기화 (관리자)
//
// 공통: {ok:true,...} / {ok:false,error}. obs 스키마(0013/0014)가 없으면 이 하위 앱만 503.
// 마스킹: 질문·답·피드백 코멘트·프롬프트·원 응답 모두 mask.ts. 관리자 + ?unmask=1일 때만 원문.
import { Hono } from "hono";
import type { Context } from "hono";
import { KEYWORD_GATE_MIN, SCORE_FLOOR } from "../ask-pipeline";
import { summarizeEventCost, syncGatewayCosts } from "./costs";
import { clampLimit, decodeCursor, obsSchemaNotReadyBody, obsSchemaReady, paginate, parseJson } from "./db";
import { maskDeep, maskPII } from "./mask";
import { readTraceBlob, recordScore, RETRIEVAL_OUTCOMES } from "./trace";
import { isAdminRequest } from "../auth";
import type { ObsEnv } from "./types";

type Env = { Bindings: ObsEnv };
type Ctx = Context<Env>;

export const tracesApp = new Hono<Env>();

const HUMAN_SCORE_DAILY_LIMIT = 200;
const RISK_VERDICTS = ["ungrounded", "off_topic"];

// 관리자 검사는 auth.ts isAdminRequest(이중 게이트: hr_admin 세션 또는 X-Admin-Secret)로 한다.
// 구 obsAdminAllowed(시크릿 전용)는 제거했다 — 호출부는 아래 isAdminRequest를 쓴다.

// obs 스키마 가드: 이 하위 앱의 모든 경로에만 적용 (앱 전체는 죽이지 않는다).
tracesApp.use("*", async (c, next) => {
  if (!c.env?.DB || !(await obsSchemaReady(c.env.DB))) return c.json(obsSchemaNotReadyBody(), 503);
  await next();
});

tracesApp.onError((err, c) => {
  console.log("[obs/traces] error:", err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: "internal error" }, 500);
});

// SQLite datetime('now') 형식(YYYY-MM-DD HH:MM:SS, UTC)으로 맞춘다. 잘못된 값은 null.
function toSqlTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+09:00` : raw); // 날짜만 오면 KST 자정
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// status NULL(S4 이전 행)은 grounded 컬럼으로 해석한다 (§5.1 주석).
const STATUS_EXPR = "COALESCE(e.status, CASE WHEN e.grounded = 1 THEN 'grounded' ELSE 'no_evidence' END)";
const LATEST_VERDICT_EXPR =
  "(SELECT s.label FROM trace_scores s WHERE s.event_id = e.id AND s.name = 'verdict' ORDER BY s.created_at DESC, s.id DESC LIMIT 1)";

type ListRow = {
  id: string; created_at: string; question: string; status: string; gap_id: string | null; origin: string;
  latency_ms: number | null; timings_json: string; prompt_tokens: number | null; completion_tokens: number | null;
  source_ids: string; engine: string; search_engine: string; feedback: string | null; verdict: string | null;
  top_vector: number | null; top_keyword: number | null; kept_count: number | null; eval_run_id: string | null;
};

tracesApp.get("/traces", async (c) => {
  const q = c.req.query();
  const limit = clampLimit(q.limit, 50, 200);
  const where: string[] = [];
  const binds: unknown[] = [];

  // origin: 기본 user (§3.1). 'all'이면 전체.
  const origin = q.origin || "user";
  if (origin !== "all") {
    if (origin !== "user" && origin !== "eval") return c.json({ ok: false, error: "origin must be user | eval | all" }, 400);
    where.push("e.origin = ?"); binds.push(origin);
  }
  if (q.status) {
    if (!["grounded", "no_evidence", "error"].includes(q.status)) return c.json({ ok: false, error: "status must be grounded | no_evidence | error" }, 400);
    where.push(`${STATUS_EXPR} = ?`); binds.push(q.status);
  }
  if (q.feedback) {
    if (q.feedback === "none") where.push("e.feedback IS NULL");
    else if (q.feedback === "up" || q.feedback === "down") { where.push("e.feedback = ?"); binds.push(q.feedback); }
    else return c.json({ ok: false, error: "feedback must be up | down | none" }, 400);
  }
  if (q.risk === "1" || q.risk === "true") {
    where.push(`${STATUS_EXPR} = 'grounded' AND ${LATEST_VERDICT_EXPR} IN (${RISK_VERDICTS.map(() => "?").join(",")})`);
    binds.push(...RISK_VERDICTS);
  }
  if (q.q) {
    // LIKE 특수문자 이스케이프
    where.push("e.question LIKE ? ESCAPE '\\'");
    binds.push(`%${q.q.slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const from = toSqlTime(q.from), to = toSqlTime(q.to);
  if (q.from && !from) return c.json({ ok: false, error: "invalid from" }, 400);
  if (q.to && !to) return c.json({ ok: false, error: "invalid to" }, 400);
  if (from) { where.push("e.created_at >= ?"); binds.push(from); }
  if (to) { where.push("e.created_at < ?"); binds.push(to); }
  if (q.cursor) {
    const cur = decodeCursor(q.cursor);
    if (!cur) return c.json({ ok: false, error: "invalid cursor" }, 400);
    where.push("(e.created_at < ? OR (e.created_at = ? AND e.id < ?))");
    binds.push(cur.t, cur.t, cur.id);
  }
  const sql = `SELECT e.id, e.created_at, e.question, ${STATUS_EXPR} AS status, e.gap_id, e.origin, e.latency_ms, e.timings_json,
      e.prompt_tokens, e.completion_tokens, e.source_ids, e.engine, e.search_engine, e.feedback, e.eval_run_id,
      ${LATEST_VERDICT_EXPR} AS verdict,
      (SELECT MAX(r.vector_score) FROM trace_retrievals r WHERE r.event_id = e.id AND r.outcome = 'kept') AS top_vector,
      (SELECT MAX(r.keyword_score) FROM trace_retrievals r WHERE r.event_id = e.id AND r.outcome = 'kept') AS top_keyword,
      (SELECT COUNT(*) FROM trace_retrievals r WHERE r.event_id = e.id AND r.outcome = 'kept') AS kept_count
    FROM ask_events e
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?`;
  const rows = (await c.env.DB.prepare(sql).bind(...binds, limit + 1).all<ListRow>()).results || [];
  const { items, nextCursor } = paginate(rows, limit);
  return c.json({
    ok: true,
    filters: { origin, status: q.status || null, feedback: q.feedback || null, risk: q.risk === "1" || q.risk === "true", q: q.q || null, from, to },
    traces: items.map((r) => {
      const sourceIds = parseJson<string[]>(r.source_ids, []);
      const tokens = r.prompt_tokens == null && r.completion_tokens == null ? null : (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
      return {
        id: r.id,
        createdAt: r.created_at,
        question: maskPII(r.question),
        status: r.status,
        gapId: r.gap_id,
        origin: r.origin,
        evalRunId: r.eval_run_id,
        latencyMs: r.latency_ms ?? (parseJson<Record<string, number>>(r.timings_json, {}).total ?? null),
        tokens, // null = 모름 (—)
        sources: { count: sourceIds.length, topScore: r.top_vector ?? r.top_keyword ?? null, topScoreKind: r.top_vector != null ? "vector" : r.top_keyword != null ? "keyword" : null },
        engine: r.engine,
        searchEngine: r.search_engine,
        verdict: r.verdict,
        feedback: r.feedback,
      };
    }),
    nextCursor,
    masked: true,
  });
});

type EventRow = {
  id: string; session_id: string | null; question: string; answer: string; source_ids: string; grounded: number;
  engine: string; search_engine: string; timings_json: string; feedback: string | null; feedback_comment: string | null;
  feedback_at: string | null; created_at: string; origin: string; status: string | null; gap_id: string | null;
  eval_run_id: string | null; prompt_version: string | null; model: string | null; prompt_tokens: number | null;
  completion_tokens: number | null; latency_ms: number | null; knowledge_epoch: number | null; trace_r2_key: string | null;
  aig_log_ids: string;
};

tracesApp.get("/traces/:id", async (c) => {
  const id = c.req.param("id");
  const ev = await c.env.DB.prepare("SELECT * FROM ask_events WHERE id = ?").bind(id).first<EventRow>();
  if (!ev) return c.json({ ok: false, error: "trace not found" }, 404);
  const isAdmin = await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret"));
  const unmask = isAdmin && c.req.query("unmask") === "1";
  const m = <T>(v: T): T => (unmask ? v : maskDeep(v));

  const [spansRes, retRes, scoreRes, costRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, product, start_ms, duration_ms, ok, attrs_json FROM trace_spans WHERE event_id = ? ORDER BY start_ms ASC, id ASC").bind(id),
    c.env.DB.prepare(
      "SELECT id, chunk_id, doc_id, title, article, stage, rank, vector_score, keyword_score, outcome FROM trace_retrievals WHERE event_id = ? ORDER BY CASE stage WHEN 'vectorize' THEN 0 ELSE 1 END, rank ASC, id ASC",
    ).bind(id),
    c.env.DB.prepare("SELECT id, name, value, label, source, eval_run_id, comment, created_at FROM trace_scores WHERE event_id = ? ORDER BY created_at DESC, id DESC").bind(id),
    c.env.DB.prepare("SELECT aig_log_id, model, tag, tokens_in, tokens_out, cost_usd, cached, duration_ms, estimated, synced_at FROM trace_costs WHERE event_id = ? ORDER BY synced_at ASC").bind(id),
  ]);
  type SpanRow = { id: string; name: string; product: string | null; start_ms: number; duration_ms: number; ok: number; attrs_json: string };
  type RetRow = { id: string; chunk_id: string; doc_id: string | null; title: string | null; article: string | null; stage: string; rank: number; vector_score: number | null; keyword_score: number | null; outcome: string };
  type CostRow = { aig_log_id: string; model: string | null; tag: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; cached: number | null; duration_ms: number | null; estimated: number; synced_at: string };
  const spans = ((spansRes.results || []) as SpanRow[]).map((s) => ({
    name: s.name, product: s.product, startMs: s.start_ms, durationMs: s.duration_ms, ok: s.ok === 1, attrs: parseJson<Record<string, unknown>>(s.attrs_json, {}),
  }));
  const retrievals = ((retRes.results || []) as RetRow[]).map((r) => ({
    chunkId: r.chunk_id, docId: r.doc_id, title: r.title, article: r.article, stage: r.stage, rank: r.rank,
    vectorScore: r.vector_score, keywordScore: r.keyword_score, outcome: r.outcome,
  }));
  const costs = (costRes.results || []) as CostRow[];
  const gate = spans.find((s) => s.name === "gate");
  const unresolvedCount = typeof gate?.attrs?.unresolved === "number" ? (gate.attrs.unresolved as number) : 0;
  const timings = parseJson<Record<string, number>>(ev.timings_json, {});
  const status = ev.status ?? (ev.grounded === 1 ? "grounded" : "no_evidence");
  const totalMs = ev.latency_ms ?? timings.total ?? (spans.length ? Math.max(...spans.map((s) => s.startMs + s.durationMs)) : null);

  // 프롬프트/응답 블록 — O5 권장안: 관리자만 원문 블록을 받는다(그래도 기본은 마스킹).
  let promptBlock: Record<string, unknown>;
  if (!ev.trace_r2_key) promptBlock = { available: false, reason: "no_r2_key" };
  else if (!isAdmin) promptBlock = { available: true, restricted: true, reason: "admin_only" };
  else {
    const blob = await readTraceBlob(c.env, ev.trace_r2_key);
    promptBlock = blob
      ? { available: true, restricted: false, masked: !unmask, messages: m(blob.prompt?.messages ?? []), rawResponse: m(blob.rawResponse ?? null), searchQuestion: m(blob.searchQuestion) }
      : { available: false, reason: "r2_missing" };
  }

  return c.json({
    ok: true,
    masked: !unmask,
    trace: {
      id: ev.id,
      createdAt: ev.created_at,
      sessionId: ev.session_id,
      origin: ev.origin,
      evalRunId: ev.eval_run_id,
      question: m(ev.question),
      answer: m(ev.answer),
      status,
      gapId: ev.gap_id,
      engine: ev.engine,
      searchEngine: ev.search_engine,
      promptVersion: ev.prompt_version,
      model: ev.model,
      knowledgeEpoch: ev.knowledge_epoch,
      latencyMs: totalMs,
      timings,
      tokens: {
        prompt: ev.prompt_tokens,
        completion: ev.completion_tokens,
        total: ev.prompt_tokens == null && ev.completion_tokens == null ? null : (ev.prompt_tokens ?? 0) + (ev.completion_tokens ?? 0),
      },
      cost: summarizeEventCost(costs, { model: ev.model, promptTokens: ev.prompt_tokens, completionTokens: ev.completion_tokens }),
      costLogs: costs,
      aigLogIds: parseJson<string[]>(ev.aig_log_ids, []),
      feedback: ev.feedback ? { rating: ev.feedback, comment: m(ev.feedback_comment), at: ev.feedback_at } : null,
      sourceIds: parseJson<string[]>(ev.source_ids, []),
      spans,
      retrievals: retrievals.map((r) => ({ ...r, title: m(r.title), article: m(r.article) })),
      retrievalOutcomes: RETRIEVAL_OUTCOMES,
      unresolvedCount,
      thresholds: { scoreFloor: SCORE_FLOOR, keywordGateMin: KEYWORD_GATE_MIN },
      scores: ((scoreRes.results || []) as Array<Record<string, unknown>>).map((s) => ({ ...s, comment: m(s.comment as string | null) })),
      prompt: promptBlock,
    },
  });
});

tracesApp.post("/traces/:id/scores", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown; comment?: unknown };
  const value = typeof body.value === "number" ? body.value : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) return c.json({ ok: false, error: "value must be a number in [0, 1]" }, 400);
  const ev = await c.env.DB.prepare("SELECT id FROM ask_events WHERE id = ?").bind(id).first<{ id: string }>();
  if (!ev) return c.json({ ok: false, error: "trace not found" }, 404);
  // 일일 한도 (KV, KST 날짜). KV가 없거나 실패하면 한도 없이 통과(fail-open, 데모 보호용).
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const key = `obs:human-score:${day}`;
  try {
    const n = parseInt((await c.env.CACHE?.get(key)) || "0", 10) || 0;
    if (n >= HUMAN_SCORE_DAILY_LIMIT) return c.json({ ok: false, error: "daily human score limit reached" }, 429, { "Retry-After": "3600" });
    await c.env.CACHE?.put(key, String(n + 1), { expirationTtl: 2 * 24 * 3600 });
  } catch { /* fail-open */ }
  const comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : null;
  const scoreId = await recordScore(c.env, { eventId: id, name: "human_score", value: Math.round(value * 10) / 10, source: "human", comment });
  if (!scoreId) return c.json({ ok: false, error: "score not recorded" }, 500);
  return c.json({ ok: true, id: scoreId });
});

tracesApp.post("/costs/sync", async (c) => {
  if (!(await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret")))) return c.json({ ok: false, error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { since?: string; until?: string };
  const res = await syncGatewayCosts(c.env, { since: body.since, until: body.until });
  if (!res.ok) return c.json(res, res.status === 503 ? 503 : res.error.endsWith("not set") ? 400 : 502);
  return c.json(res);
});

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

tracesApp.get("/summary", async (c: Ctx) => {
  const win = c.req.query("window") || "24h";
  const mm = /^(\d{1,3})([hd])$/.exec(win);
  if (!mm) return c.json({ ok: false, error: "window must look like 24h or 7d" }, 400);
  const hours = Math.min(parseInt(mm[1], 10) * (mm[2] === "d" ? 24 : 1), 24 * 90);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const origin = c.req.query("origin") === "eval" ? "eval" : "user";
  const rows = (await c.env.DB.prepare(
    `SELECT e.id, ${STATUS_EXPR} AS status, e.latency_ms, e.timings_json, e.prompt_tokens, e.completion_tokens, e.feedback, e.model
       FROM ask_events e WHERE e.created_at >= ? AND e.origin = ? ORDER BY e.created_at DESC LIMIT 5000`,
  ).bind(since, origin).all<{ id: string; status: string; latency_ms: number | null; timings_json: string; prompt_tokens: number | null; completion_tokens: number | null; feedback: string | null; model: string | null }>()).results || [];
  const lat = rows.map((r) => r.latency_ms ?? parseJson<Record<string, number>>(r.timings_json, {}).total).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const withTokens = rows.filter((r) => r.prompt_tokens != null || r.completion_tokens != null);
  // 비용: 이벤트별로 상세 API(summarizeEventCost)와 같은 규칙 — 게이트웨이 로그가 있으면 그 합,
  // 없으면 토큰 × 단가표 추정(estimated). 그래서 동기화 전(AIG_LOGS_TOKEN 없음)에도 KPI와 상세가 맞는다.
  const costByEvent = new Map<string, Array<{ cost_usd: number | null; estimated: number }>>();
  const costRows = (await c.env.DB.prepare(
    `SELECT tc.event_id, tc.cost_usd, tc.estimated FROM trace_costs tc JOIN ask_events e ON e.id = tc.event_id WHERE e.created_at >= ? AND e.origin = ?`,
  ).bind(since, origin).all<{ event_id: string; cost_usd: number | null; estimated: number }>()).results || [];
  for (const r of costRows) {
    const list = costByEvent.get(r.event_id) ?? [];
    list.push(r);
    costByEvent.set(r.event_id, list);
  }
  let usd: number | null = null;
  let estimated = false;
  let costLogs = 0;
  for (const r of rows) {
    const s = summarizeEventCost(costByEvent.get(r.id) ?? [], { model: r.model, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens });
    costLogs += s.logs;
    if (s.usd == null) { if (s.source === "gateway") estimated = true; continue; }
    usd = (usd ?? 0) + s.usd;
    if (s.estimated) estimated = true;
  }
  const grounded = rows.filter((r) => r.status === "grounded").length;
  return c.json({
    ok: true,
    window: win,
    origin,
    questions: rows.length,
    groundedRate: rows.length ? grounded / rows.length : null,
    noEvidence: rows.filter((r) => r.status === "no_evidence").length,
    latency: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    tokens: withTokens.length ? withTokens.reduce((a, r) => a + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0) : null,
    tokensCoverage: rows.length ? withTokens.length / rows.length : null,
    cost: { usd: usd == null ? null : Math.round(usd * 1e9) / 1e9, estimated, logs: costLogs },
    feedback: { up: rows.filter((r) => r.feedback === "up").length, down: rows.filter((r) => r.feedback === "down").length },
  });
});
