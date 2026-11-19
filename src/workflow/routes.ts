// 워크플로우 API (WF-1, 2026-11-18). index.ts에서 "/api/workflows"에 mount한다 (경로는 mount 기준 상대).
// 전부 로그인 필수 — 세션 쿠키만 본다. X-Admin-Secret만으로는 401 (캘린더 C1과 같은 원칙).
// 모든 조회는 owner_id = 세션 사용자 id. 남의 워크플로우·run은 404 (존재 은닉).
//   GET    /                  내 워크플로우 목록 (최신순, 최대 100)
//   POST   /                  {name, description?, definition} 생성 (definition 검증 실패 400)
//   GET    /:id               상세
//   PATCH  /:id               name/description/status/definition 수정 (definition은 재검증)
//   DELETE /:id               삭제 (runs·steps 포함, 공유 행은 ON DELETE CASCADE)
//   GET    /shared            공유받은 워크플로우 + 템플릿 (WF-9, shared_via·can_copy). /:id보다 먼저 등록
//   POST   /:id/copy          복사 (WF-9). copy 권한이 있을 때만, 없으면 404. 복사본은 내 소유·비공개
//   POST   /:id/shares        {scope:department|all, permission:view|copy} 공유 upsert (WF-9, 소유자만, 201/200)
//   GET    /:id/shares        공유 목록 (소유자만)
//   DELETE /:id/shares/:shareId  공유 삭제 (소유자만)
//   PATCH  /:id               is_template는 hr_admin만 (아니면 403). 공유받은 워크플로우의 실행·run·스케줄은 소유자만 (복사 후 실행)
//   GET    /:id/runs          run 목록
//   POST   /:id/runs          {input?} run 생성 (queued, current_step 0) + 첫 단계 큐 투입(WF-3). 속도 제한 초과 429
//   GET    /runs/:runId       run 상세 + steps
//   POST   /runs/:runId/approve  승인 대기 run 재개 (WF-4). 없음/타인 404, 대기 아님 409. 본문 불필요
//   POST   /runs/:runId/reject   승인 대기 run 취소 (WF-4). 같은 규칙
//   POST   /:id/schedules             스케줄·이벤트 트리거 생성 (WF-8). {trigger_type:"schedule",cron} | {trigger_type:"event",event:"transcript_completed"}
//   GET    /:id/schedules             목록
//   PATCH  /:id/schedules/:sid        {enabled} 토글만
//   DELETE /:id/schedules/:sid        삭제 (워크플로우 삭제 시 ON DELETE CASCADE로 같이 지워진다)
// 대기 중 승인 목록은 기존 GET /api/approval/notifications (type WORKFLOW_APPROVAL, link /#workflow/<wfId>?run=<runId>)를 재사용한다.
// 본문 상한: definition_json 256KB, input_json 64KB 초과 시 413. 스키마 누락(migration 0027 미적용)은 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { uid } from "../lib";
import { EVENT_NAMES, isValidCron } from "./schedules";
import { getSessionUser, type SessionUser } from "../auth";
import {
  createRun, createWorkflow, deleteWorkflow, getRun, getWorkflow, getWorkflowById, listRuns, listWorkflows, updateWorkflow,
} from "./store";
import {
  canViewWorkflow, createShare, deleteShare, listShares, listSharedEntries, ShareNotFound, SHARE_PERMISSIONS, SHARE_SCOPES,
  type SharePermission, type ShareScope,
} from "./sharing";
import { cancelWorkflowRun, checkWorkflowRateLimit, resumeWorkflowRun, stepMessage } from "./engine";
import { WORKFLOW_TEMPLATES } from "./templates";
import { validateDefinition, WORKFLOW_STATUSES, type Env, type WorkflowDefinition, type WorkflowStatus } from "./types";

export const workflowApp = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const MAX_DEFINITION = 256 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_BODY = MAX_DEFINITION + 16 * 1024; // 정의 + name/description 여유
const MAX_NAME = 200;
const MAX_DESC = 2000;

class WfError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, message: string) {
    super(message);
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

async function requireUser(c: C, mutating = false): Promise<SessionUser> {
  const u = await getSessionUser(c.env, c.req.header("cookie"));
  if (!u) throw new WfError(401, "로그인이 필요합니다.");
  if (mutating && !originOk(c)) throw new WfError(403, "허용되지 않는 요청입니다.");
  return u;
}

async function readJson(c: C, max = MAX_BODY): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (bytes(text) > max) throw new WfError(413, "요청 본문이 너무 큽니다.");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new WfError(400, "JSON 객체 본문이 필요합니다.");
  }
}

function checkDefinition(raw: unknown) {
  if (bytes(JSON.stringify(raw ?? null)) > MAX_DEFINITION) throw new WfError(413, "워크플로우 정의가 너무 큽니다 (최대 256KB).");
  const v = validateDefinition(raw);
  if (!v.ok) throw new WfError(400, v.error);
  return v.def;
}

function checkName(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new WfError(400, "이름은 비어 있지 않은 문자열이어야 합니다.");
  if (v.length > MAX_NAME) throw new WfError(400, `이름은 ${MAX_NAME}자 이하여야 합니다.`);
  return v.trim();
}
function checkDesc(v: unknown): string {
  if (typeof v !== "string") throw new WfError(400, "설명은 문자열이어야 합니다.");
  if (v.length > MAX_DESC) throw new WfError(400, `설명은 ${MAX_DESC}자 이하여야 합니다.`);
  return v;
}

function isSchemaMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(m) && /workflow/i.test(m);
}

workflowApp.onError((e, c) => {
  if (e instanceof WfError) return c.json({ error: e.message }, e.status);
  if (e instanceof ShareNotFound) return c.json({ error: e.message }, 404);
  if (isSchemaMissing(e)) return c.json({ error: "워크플로우 스키마가 아직 적용되지 않았습니다 (migration 0027/0028)" }, 503);
  console.error("workflow error", e);
  return c.json({ error: "서버 오류가 발생했습니다." }, 500);
});

workflowApp.get("/", async (c) => {
  const u = await requireUser(c);
  return c.json({ workflows: await listWorkflows(c.env.DB, u.id, { limit: 100 }) });
});

// WF 템플릿 (2026-11-19): 코드 내장 기업용 템플릿 5개. /:id보다 먼저 등록한다. 읽기 전용.
workflowApp.get("/templates", async (c) => {
  await requireUser(c);
  return c.json({ templates: WORKFLOW_TEMPLATES });
});

workflowApp.post("/", async (c) => {
  const u = await requireUser(c, true);
  const b = await readJson(c);
  const name = checkName(b.name);
  const description = b.description === undefined ? "" : checkDesc(b.description);
  const definition = checkDefinition(b.definition);
  const workflow = await createWorkflow(c.env.DB, u.id, { name, description, definition });
  return c.json({ workflow }, 201);
});

// /runs/:runId 는 /:id 계열보다 먼저 등록한다.
workflowApp.get("/runs/:runId", async (c) => {
  const u = await requireUser(c);
  const run = await getRun(c.env.DB, u.id, c.req.param("runId"));
  if (!run) throw new WfError(404, "실행을 찾을 수 없습니다.");
  return c.json({ run });
});

// 전체 점검(2026-11-18) P1: 공유·템플릿·복사로 남에게 나가는 정의에서는 웹훅 헤더 **값**을 비운다 (키는 유지).
// 헤더 값은 Authorization 토큰 같은 비밀일 수 있고, 승인 요약(engine.ts)도 이미 이름만 보여 준다.
// 소유자 본인 응답은 그대로다. 복사한 사람은 헤더 값을 직접 다시 넣어야 한다.
function redactShared<T extends { definition: WorkflowDefinition }>(wf: T): T {
  const def = wf.definition;
  if (!def || !Array.isArray(def.steps)) return wf;
  const steps = def.steps.map((s) => {
    const h = s?.type === "webhook" ? (s.config as Record<string, unknown> | undefined)?.headers : undefined;
    if (!h || typeof h !== "object" || Array.isArray(h)) return s;
    return { ...s, config: { ...s.config, headers: Object.fromEntries(Object.keys(h as object).map((k) => [k, ""])) } };
  });
  return { ...wf, definition: { ...def, steps } };
}

// WF-9: 공유받은 워크플로우 + 템플릿. /:id보다 먼저 등록한다 ("shared"가 id로 잡히지 않게).
workflowApp.get("/shared", async (c) => {
  const u = await requireUser(c);
  const entries = await listSharedEntries(c.env.DB, u.id);
  return c.json({ workflows: entries.map((e) => ({ ...redactShared(e.workflow), shared_via: e.via, can_copy: e.can_copy })) });
});

workflowApp.get("/:id", async (c) => {
  const u = await requireUser(c);
  const id = c.req.param("id");
  const own = await getWorkflow(c.env.DB, u.id, id);
  if (own) return c.json({ workflow: own, steps: own.definition.steps });
  // WF-9: 남의 워크플로우는 공유/템플릿으로 볼 수 있을 때만 (보기 전용). 못 보면 404 — 존재 은닉.
  const other = await getWorkflowById(c.env.DB, id);
  const access = other ? await canViewWorkflow(c.env.DB, u.id, other) : null;
  if (!other || !access?.view) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  const safe = redactShared(other);
  return c.json({ workflow: safe, steps: safe.definition.steps, shared: true, can_copy: access.copy });
});

// WF-9: 복사. 새 워크플로우는 복사한 사람 소유·비공개·비템플릿. 원본의 공유 행·run·스케줄은 이어받지 않는다.
workflowApp.post("/:id/copy", async (c) => {
  const u = await requireUser(c, true);
  const other = await getWorkflowById(c.env.DB, c.req.param("id"));
  const access = other ? await canViewWorkflow(c.env.DB, u.id, other) : null;
  if (!other || !access?.copy) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  const workflow = await createWorkflow(c.env.DB, u.id, {
    name: `${other.name} (복사)`.slice(0, MAX_NAME), description: other.description, definition: redactShared(other).definition,
  });
  return c.json({ workflow }, 201);
});

// WF-9: 공유 관리 (소유자만, 타인·없음 404)
workflowApp.post("/:id/shares", async (c) => {
  const u = await requireUser(c, true);
  const b = await readJson(c, 4096);
  if (typeof b.scope !== "string" || !(SHARE_SCOPES as readonly string[]).includes(b.scope)) throw new WfError(400, "공유 범위(scope)는 department | all 중 하나여야 합니다.");
  if (typeof b.permission !== "string" || !(SHARE_PERMISSIONS as readonly string[]).includes(b.permission)) throw new WfError(400, "권한(permission)은 view | copy 중 하나여야 합니다.");
  const { share, created } = await createShare(c.env.DB, u.id, c.req.param("id"), b.scope as ShareScope, b.permission as SharePermission);
  return c.json({ share }, created ? 201 : 200);
});

workflowApp.get("/:id/shares", async (c) => {
  const u = await requireUser(c);
  return c.json({ shares: await listShares(c.env.DB, u.id, c.req.param("id")) });
});

workflowApp.delete("/:id/shares/:shareId", async (c) => {
  const u = await requireUser(c, true);
  await deleteShare(c.env.DB, u.id, c.req.param("id"), c.req.param("shareId"));
  return c.json({ ok: true });
});

workflowApp.patch("/:id", async (c) => {
  const u = await requireUser(c, true);
  const id = c.req.param("id");
  if (!(await getWorkflow(c.env.DB, u.id, id))) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  const b = await readJson(c);
  const patch: { name?: string; description?: string; status?: WorkflowStatus; definition?: ReturnType<typeof checkDefinition>; is_template?: boolean } = {};
  if (b.is_template !== undefined) {
    // WF-9: 템플릿 지정·해제는 hr_admin만. 조용히 무시하지 않고 403.
    if (u.role !== "hr_admin") throw new WfError(403, "템플릿 지정은 HR 관리자만 할 수 있습니다.");
    if (typeof b.is_template !== "boolean") throw new WfError(400, "템플릿 지정 값(is_template)은 true 또는 false여야 합니다.");
    patch.is_template = b.is_template;
  }
  if (b.name !== undefined) patch.name = checkName(b.name);
  if (b.description !== undefined) patch.description = checkDesc(b.description);
  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !(WORKFLOW_STATUSES as readonly string[]).includes(b.status)) {
      throw new WfError(400, "상태(status)는 draft | active | paused 중 하나여야 합니다.");
    }
    patch.status = b.status as WorkflowStatus;
  }
  if (b.definition !== undefined) patch.definition = checkDefinition(b.definition);
  const w = await updateWorkflow(c.env.DB, u.id, id, patch);
  if (!w) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  return c.json({ workflow: w });
});

workflowApp.delete("/:id", async (c) => {
  const u = await requireUser(c, true);
  if (!(await deleteWorkflow(c.env.DB, u.id, c.req.param("id")))) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  return c.json({ ok: true });
});

workflowApp.get("/:id/runs", async (c) => {
  const u = await requireUser(c);
  const id = c.req.param("id");
  if (!(await getWorkflow(c.env.DB, u.id, id))) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  return c.json({ runs: await listRuns(c.env.DB, u.id, id, { limit: 50 }) });
});

workflowApp.post("/:id/runs", async (c) => {
  const u = await requireUser(c, true);
  const id = c.req.param("id");
  if (!(await getWorkflow(c.env.DB, u.id, id))) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  const b = await readJson(c, MAX_INPUT + 1024);
  let input: Record<string, unknown> = {};
  if (b.input !== undefined) {
    if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new WfError(400, "실행 입력은 객체여야 합니다.");
    if (bytes(JSON.stringify(b.input)) > MAX_INPUT) throw new WfError(413, "실행 입력이 너무 큽니다 (최대 64KB).");
    input = b.input as Record<string, unknown>;
  }
  // WF-3 속도 제한: 동시 3개 / 하루 20회. KV·D1 오류면 통과 (fail-open).
  const rl = await checkWorkflowRateLimit(c.env, u.id);
  if (!rl.ok) throw new WfError(429, rl.reason);
  const run = await createRun(c.env.DB, u.id, id, input);
  // WF-3: 첫 단계를 큐에 넣는다. PIPELINE.send가 실패하면 run은 queued로 남고,
  // 정체 청소(sweepStaleWorkflowRuns, EVAL_CRON)가 60분 뒤 failed("실행 시간 초과(60분)")로 정리한다.
  let enqueued = true;
  try {
    await c.env.PIPELINE.send(stepMessage(run.id, 0));
  } catch (e) {
    enqueued = false;
    console.error("workflow enqueue failed", run.id, e instanceof Error ? e.message : String(e));
  }
  return c.json({ run, enqueued }, 201);
});

// ---- WF-4 승인 게이트 ----
// 소유권 검사(getRun, 타인 404)는 엔진 함수 호출 전에 반드시 한다 — resume/cancel은 owner를 보지 않는다.
async function decide(c: C, runId: string, action: "approve" | "reject") {
  const u = await requireUser(c, true);
  const run = await getRun(c.env.DB, u.id, runId);
  if (!run) throw new WfError(404, "실행을 찾을 수 없습니다.");
  if (run.status !== "waiting_approval") throw new WfError(409, `승인 대기 상태가 아닙니다 (${run.status}).`);
  const r = action === "approve" ? await resumeWorkflowRun(c.env, runId) : await cancelWorkflowRun(c.env, runId);
  if (!r.ok) throw new WfError(409, (r as { error?: string }).error ?? "이미 처리된 요청입니다.");
  await c.env.DB.prepare(
    "UPDATE notifications SET read_at = datetime('now') WHERE ref_type='workflow_run' AND ref_id=? AND user_id=? AND read_at IS NULL",
  ).bind(runId, u.id).run();
  return c.json({ ok: true, runId, status: action === "approve" ? "running" : "cancelled" });
}

workflowApp.post("/runs/:runId/approve", (c) => decide(c, c.req.param("runId"), "approve"));
workflowApp.post("/runs/:runId/reject", (c) => decide(c, c.req.param("runId"), "reject"));

// ---- WF-8 스케줄·이벤트 트리거 ----
const MAX_SCHEDULES_PER_WORKFLOW = 10;
const SCHEDULE_COLS = "id, workflow_id, owner_id, trigger_type, cron, event, enabled, last_run_at, created_at, updated_at";

async function ownWorkflow(c: C, u: SessionUser): Promise<string> {
  const id = c.req.param("id") as string;
  if (!(await getWorkflow(c.env.DB, u.id, id))) throw new WfError(404, "워크플로우를 찾을 수 없습니다.");
  return id;
}

workflowApp.post("/:id/schedules", async (c) => {
  const u = await requireUser(c, true);
  const id = await ownWorkflow(c, u);
  const b = await readJson(c, 4096);
  let cron: string | null = null, event: string | null = null;
  if (b.trigger_type === "schedule") {
    // 형식만 본다 ("지금 맞는가"가 아님).
    if (typeof b.cron !== "string" || !isValidCron(b.cron)) throw new WfError(400, "크론 식은 5필드(분 시 일 월 요일, 숫자·*·,·-·/ 만) 형식이어야 합니다.");
    cron = b.cron.trim().replace(/\s+/g, " ");
  } else if (b.trigger_type === "event") {
    if (typeof b.event !== "string" || !(EVENT_NAMES as readonly string[]).includes(b.event)) throw new WfError(400, `이벤트(event)는 ${EVENT_NAMES.join(" | ")} 중 하나여야 합니다.`);
    event = b.event;
  } else {
    throw new WfError(400, "트리거 종류(trigger_type)는 schedule | event 중 하나여야 합니다.");
  }
  const cnt = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM workflow_schedules WHERE workflow_id = ?").bind(id).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= MAX_SCHEDULES_PER_WORKFLOW) throw new WfError(400, `워크플로우당 스케줄은 최대 ${MAX_SCHEDULES_PER_WORKFLOW}개입니다.`);
  const sid = uid("wfs");
  await c.env.DB.prepare(
    "INSERT INTO workflow_schedules(id, workflow_id, owner_id, trigger_type, cron, event) VALUES(?,?,?,?,?,?)",
  ).bind(sid, id, u.id, b.trigger_type, cron, event).run();
  const schedule = await c.env.DB.prepare(`SELECT ${SCHEDULE_COLS} FROM workflow_schedules WHERE id = ?`).bind(sid).first();
  return c.json({ schedule }, 201);
});

workflowApp.get("/:id/schedules", async (c) => {
  const u = await requireUser(c);
  const id = await ownWorkflow(c, u);
  const { results } = await c.env.DB.prepare(
    `SELECT ${SCHEDULE_COLS} FROM workflow_schedules WHERE workflow_id = ? AND owner_id = ? ORDER BY created_at, id`,
  ).bind(id, u.id).all();
  return c.json({ schedules: results });
});

workflowApp.patch("/:id/schedules/:sid", async (c) => {
  const u = await requireUser(c, true);
  const id = await ownWorkflow(c, u);
  const b = await readJson(c, 4096);
  const keys = Object.keys(b);
  if (keys.length !== 1 || keys[0] !== "enabled" || typeof b.enabled !== "boolean") throw new WfError(400, "활성화 여부(enabled: true|false)만 변경할 수 있습니다.");
  const r = await c.env.DB.prepare(
    "UPDATE workflow_schedules SET enabled = ?, updated_at = datetime('now') WHERE id = ? AND workflow_id = ? AND owner_id = ?",
  ).bind(b.enabled ? 1 : 0, c.req.param("sid"), id, u.id).run();
  if ((r.meta?.changes ?? 0) < 1) throw new WfError(404, "스케줄을 찾을 수 없습니다.");
  const schedule = await c.env.DB.prepare(`SELECT ${SCHEDULE_COLS} FROM workflow_schedules WHERE id = ?`).bind(c.req.param("sid")).first();
  return c.json({ schedule });
});

workflowApp.delete("/:id/schedules/:sid", async (c) => {
  const u = await requireUser(c, true);
  const id = await ownWorkflow(c, u);
  const r = await c.env.DB.prepare("DELETE FROM workflow_schedules WHERE id = ? AND workflow_id = ? AND owner_id = ?")
    .bind(c.req.param("sid"), id, u.id).run();
  if ((r.meta?.changes ?? 0) < 1) throw new WfError(404, "스케줄을 찾을 수 없습니다.");
  return c.json({ ok: true });
});
