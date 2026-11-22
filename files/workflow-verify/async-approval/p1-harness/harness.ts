// 비동기 승인 P1 로컬 하네스 (2026-11-21). 운영 코드를 그대로 import한다.
// - /api/workflows/* 는 운영 라우트(src/workflow/routes.ts workflowApp)를 그대로 마운트한다 (세션 쿠키 인증 포함).
// - 큐(PIPELINE)는 메모리 가짜로 바꾸고, /h/drain이 운영 processWorkflowStep으로 메시지를 하나씩 처리한다.
// - globalThis.fetch를 가로채 Resend·웹훅 호출을 기록만 한다 (실제 외부 호출 0). RESEND_API_KEY는 가짜 값.
import { Hono } from "hono";
import { workflowApp } from "../../../../src/workflow/routes";
import { processWorkflowStep, sweepStaleWorkflowRuns } from "../../../../src/workflow/engine";
import { createSession } from "../../../../src/auth";
import type { Env, WorkflowStepMessage } from "../../../../src/workflow/types";

const QUEUE: WorkflowStepMessage[] = [];
const FETCHES: Array<{ url: string; method: string; at: string }> = [];

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  FETCHES.push({ url, method, at: new Date().toISOString() });
  if (url.includes("api.resend.com")) return new Response(JSON.stringify({ id: `re_fake_${FETCHES.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: true, echo: method }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
void realFetch;

function henv(env: Env): Env {
  return {
    ...env,
    RESEND_API_KEY: "re_test_fake_key",
    PIPELINE: { send: async (m: WorkflowStepMessage) => { QUEUE.push(m); }, sendBatch: async () => {} } as unknown as Queue<unknown>,
  };
}

const h = new Hono<{ Bindings: Env }>();
h.use("*", async (c, next) => { c.env = henv(c.env); return next(); });

h.get("/h/session", async (c) => {
  const id = c.req.query("user") ?? "u_p1";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `P1 ${id}`, "user", now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id, cookie: setCookie.split(";")[0] });
});

// 큐를 비울 때까지 운영 엔진으로 처리한다 (최대 50개).
h.get("/h/drain", async (c) => {
  const done: Array<{ runId: string; stepIndex: number; approved?: boolean; error?: string }> = [];
  for (let i = 0; i < 50 && QUEUE.length; i++) {
    const m = QUEUE.shift()!;
    try { await processWorkflowStep(c.env, m); done.push({ runId: m.runId, stepIndex: m.stepIndex, approved: m.approved }); }
    catch (e) { done.push({ runId: m.runId, stepIndex: m.stepIndex, error: String(e) }); }
  }
  return c.json({ processed: done, left: QUEUE.length });
});

// 큐 재전달 시뮬레이션: 첫 전달이 대기 동작을 쌓은 뒤 엔진 예외로 점유가 풀린 상황(step failed, run running)을 만들고 같은 메시지를 다시 처리한다.
h.get("/h/redeliver", async (c) => {
  const runId = c.req.query("run")!;
  const stepIndex = Number(c.req.query("step") ?? 0);
  await c.env.DB.prepare("UPDATE workflow_run_steps SET status='failed', error='(하네스) 엔진 오류 가정' WHERE run_id=? AND step_index=?").bind(runId, stepIndex).run();
  await c.env.DB.prepare("UPDATE workflow_runs SET status='running', finished_at=NULL WHERE id=?").bind(runId).run();
  await processWorkflowStep(c.env, { type: "workflow-step", runId, stepIndex, enqueuedAt: new Date().toISOString() });
  return c.json({ redelivered: { runId, stepIndex }, queued: QUEUE.length });
});

h.get("/h/state", async (c) => {
  const runId = c.req.query("run")!;
  const run = await c.env.DB.prepare("SELECT id, owner_id, status, error, current_step, output_json FROM workflow_runs WHERE id=?").bind(runId).first();
  const steps = (await c.env.DB.prepare("SELECT step_index, node_type, status, input_json, output_json, error FROM workflow_run_steps WHERE run_id=? ORDER BY step_index").bind(runId).all()).results;
  const pending = (await c.env.DB.prepare("SELECT * FROM workflow_pending_actions WHERE run_id=? ORDER BY step_index").bind(runId).all()).results;
  const notifications = (await c.env.DB.prepare("SELECT id, type FROM notifications WHERE ref_id=?").bind(runId).all()).results;
  const owner = (run as { owner_id?: string } | null)?.owner_id ?? "";
  const emails = (await c.env.DB.prepare("SELECT id, to_addr, subject, provider_id FROM emails WHERE owner_id=?").bind(owner).all()).results;
  const tasks = (await c.env.DB.prepare("SELECT id, title FROM tasks WHERE owner_id=?").bind(owner).all()).results;
  return c.json({ run, steps, pending, notifications, emails, tasks, fetches: FETCHES, queue: QUEUE.length });
});

// 만료: 8일 전 queued 행을 만들고 운영 sweep을 부른다.
h.get("/h/expire", async (c) => {
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  const fresh = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR REPLACE INTO workflow_pending_actions (id, run_id, step_index, turn, owner_id, node_type, args_json, status, created_at) VALUES ('wfpa_old_0','run_old',0,NULL,'u_exp','send_email','{}','queued',?)").bind(old).run();
  await c.env.DB.prepare("INSERT OR REPLACE INTO workflow_pending_actions (id, run_id, step_index, turn, owner_id, node_type, args_json, status, created_at) VALUES ('wfpa_new_0','run_new',0,NULL,'u_exp','send_email','{}','queued',?)").bind(fresh).run();
  const sweep = await sweepStaleWorkflowRuns(c.env);
  const rows = (await c.env.DB.prepare("SELECT id, status, created_at, decided_at FROM workflow_pending_actions WHERE owner_id='u_exp' ORDER BY id").all()).results;
  return c.json({ sweep, rows });
});

h.route("/api/workflows", workflowApp);

export default { fetch: (req: Request, env: Env, ctx: ExecutionContext) => h.fetch(req, env, ctx) } satisfies ExportedHandler<Env>;
