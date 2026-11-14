// S4 M4 — evals API (Hono 하위 앱). M6-β가 app.route('/api/obs', evalsApp)로 마운트한다.
// 설계 §8: runs·trend·gaps·prompts·trace judge·guards. 응답 규약 {ok:true,...} / {ok:false,error}.
// 테이블이 없으면(0013/0014 미적용) 503 — 앱 전체를 죽이지 않는다.
// 관리자 경로(중단·prompt 활성화)는 X-Admin-Secret 필수 (ADMIN_SECRET 미설정이면 항상 거부).
import { Hono } from "hono";
import type { Context } from "hono";
import type { AskEnv } from "../ask-pipeline";
import { clampLimit, decodeCursor, obsSchemaNotReadyBody, obsSchemaReady, paginate } from "./db";
import { applyGapAction, appliedItemIds, listGaps, openGapCount } from "./gaps";
import {
  LOCK_TTL_MS, MANUAL_RUNS_PER_DAY, RUN_COST_CAP_USD, dailyCount, kstDate, loadGuardConfig, readLock, TRACE_JUDGE_PER_DAY,
} from "./guards";
import { isAdminRequest } from "../auth";
import { activatePrompt, createPromptDraft, getActivePrompt, getPromptById, listPrompts } from "./prompts";
import { DEFAULT_DATASET_ID, abortRun, getRunDetail, getTrend, judgeTrace, listRuns, mapRun, startRun } from "./runner";
import type { ObsEnv } from "./types";

type Bindings = ObsEnv & AskEnv;
type C = Context<{ Bindings: Bindings }>;

export const evalsApp = new Hono<{ Bindings: Bindings }>();

// 관리자 검사 — 이중 게이트 (hr_admin 세션 또는 X-Admin-Secret). auth.ts isAdminRequest.
const isAdmin = (c: C) => isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret"));

function fail(c: C, status: number, error: string, extra: Record<string, unknown> = {}) {
  return c.json({ ok: false, error, ...extra }, status as 400);
}

async function readJson(c: C): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 스키마 확인 (이 하위 앱의 모든 경로).
evalsApp.use("*", async (c, next) => {
  if (!(await obsSchemaReady(c.env.DB))) return c.json(obsSchemaNotReadyBody(), 503);
  await next();
});

// ---- runs ---------------------------------------------------------------------------------

evalsApp.post("/evals/runs", async (c) => {
  const body = await readJson(c);
  const trigger = body.trigger === "regression" ? "regression" : "manual"; // cron은 HTTP로 시작하지 않는다
  const datasetId = typeof body.datasetId === "string" && body.datasetId ? body.datasetId : DEFAULT_DATASET_ID;
  const limit = typeof body.limit === "number" ? body.limit : typeof body.limit === "string" ? parseInt(body.limit, 10) : undefined;
  const promptVersionId = typeof body.promptVersionId === "string" && body.promptVersionId ? body.promptVersionId : undefined;
  // 회귀 실행: applied 동작의 연결 항목을 앞에 둔다 (전체 데이터셋도 함께 돈다).
  const priorityItemIds = trigger === "regression" ? await appliedItemIds(c.env) : undefined;
  const r = await startRun(c.env, { datasetId, trigger, limit, promptVersionId, priorityItemIds });
  if (!r.ok) {
    if (r.retryAfter) c.header("Retry-After", String(r.retryAfter));
    return fail(c, r.status, r.error, { ...(r.holder ? { runId: r.holder } : {}), ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) });
  }
  return c.json({ ok: true, runId: r.runId, status: r.runStatus, itemsTotal: r.itemsTotal, truncated: r.truncated, ...(r.skippedBecause ? { skippedBecause: r.skippedBecause } : {}) }, r.status);
});

evalsApp.get("/evals/runs", async (c) => {
  const limit = clampLimit(c.req.query("limit"), 50, 200);
  const rawCursor = c.req.query("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return fail(c, 400, "invalid cursor");
  const rows = await listRuns(c.env, { datasetId: c.req.query("datasetId") || undefined, limit, cursor });
  const page = paginate(rows, limit);
  return c.json({ ok: true, runs: page.items.map(mapRun), nextCursor: page.nextCursor });
});

evalsApp.get("/evals/runs/:id", async (c) => {
  const d = await getRunDetail(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "run not found");
  return c.json({ ok: true, ...d });
});

evalsApp.post("/evals/runs/:id/abort", async (c) => {
  if (!(await isAdmin(c))) return fail(c, 403, "admin only");
  const r = await abortRun(c.env, c.req.param("id"));
  if (!r.ok) return fail(c, 409, r.error || "cannot abort");
  return c.json({ ok: true, status: r.status });
});

evalsApp.get("/evals/trend", async (c) => {
  const datasetId = c.req.query("datasetId") || DEFAULT_DATASET_ID;
  return c.json({ ok: true, datasetId, points: await getTrend(c.env, datasetId) });
});

evalsApp.get("/evals/guards", async (c) => {
  const g = await loadGuardConfig(c.env);
  const lock = await readLock(c.env);
  const now = Date.now();
  return c.json({
    ok: true,
    enabled: g.enabled,
    maxItemsPerRun: g.maxItems,
    manualRunsPerDay: g.manualPerDay,
    manualRunsDefault: MANUAL_RUNS_PER_DAY,
    manualRunsUsedToday: await dailyCount(c.env, "manual"),
    traceJudgePerDay: TRACE_JUDGE_PER_DAY,
    traceJudgeUsedToday: await dailyCount(c.env, "tracejudge"),
    kstDate: kstDate(now),
    costCapUsd: g.costCapUsd,
    costCapDefaultUsd: RUN_COST_CAP_USD,
    lock: lock && lock.value.expiresAt > now ? { runId: lock.value.runId, expiresAt: new Date(lock.value.expiresAt).toISOString() } : null,
    lockTtlMinutes: LOCK_TTL_MS / 60000,
  });
});

// ---- gaps ---------------------------------------------------------------------------------

evalsApp.get("/gaps", async (c) => {
  const gaps = await listGaps(c.env, { status: c.req.query("status") || undefined, kind: c.req.query("kind") || undefined });
  return c.json({ ok: true, gaps });
});

evalsApp.get("/gaps/count", async (c) => c.json({ ok: true, open: await openGapCount(c.env) }));

evalsApp.post("/gaps/:key/actions", async (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  const r = await applyGapAction(c.env, key, await readJson(c));
  if (!r.ok) return fail(c, r.status, r.error, r.question ? { question: r.question } : {});
  return c.json({ ok: true, action: r.action, ...(r.itemId ? { itemId: r.itemId } : {}), ...(r.gapId ? { gapId: r.gapId } : {}), ...(r.existingItem != null ? { existingItem: r.existingItem } : {}) });
});

// ---- prompts ------------------------------------------------------------------------------

evalsApp.get("/prompts", async (c) => {
  const name = c.req.query("name") || undefined;
  const active = await getActivePrompt(c.env, "ask-system");
  return c.json({ ok: true, prompts: await listPrompts(c.env, name), activeId: active.id });
});

evalsApp.get("/prompts/:id", async (c) => {
  const p = await getPromptById(c.env, c.req.param("id"));
  return p ? c.json({ ok: true, prompt: p }) : fail(c, 404, "prompt version not found");
});

evalsApp.post("/prompts", async (c) => {
  const body = await readJson(c);
  const r = await createPromptDraft(c.env, { name: typeof body.name === "string" ? body.name : undefined, body: body.body, note: body.note });
  if (!r.ok) return fail(c, r.status, r.error);
  return c.json({ ok: true, prompt: r.prompt }, 201);
});

evalsApp.post("/prompts/:id/activate", async (c) => {
  if (!(await isAdmin(c))) return fail(c, 403, "admin only");
  const r = await activatePrompt(c.env, c.req.param("id"));
  if (!r.ok) return fail(c, r.status, r.error);
  return c.json({ ok: true, prompt: r.prompt, retired: r.retired });
});

// ---- trace judge (M4 경로, 트레이스 화면의 "판정 실행") --------------------------------------

evalsApp.post("/traces/:id/judge", async (c) => {
  const r = await judgeTrace(c.env, c.req.param("id"));
  if (!r.ok) {
    if (r.retryAfter) c.header("Retry-After", String(r.retryAfter));
    return fail(c, r.status, r.error, r.retryAfter ? { retryAfter: r.retryAfter } : {});
  }
  return c.json(r);
});

export default evalsApp;
