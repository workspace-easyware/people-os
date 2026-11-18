// 워크플로우 run 관측 API (WF-11, 읽기 전용). index.ts가 `app.route("/api/obs", workflowRunsApp)`로 마운트한다.
//
//   GET /workflow-runs?limit=50&status=&owner=   run 목록 (최신순, hr_admin 전용)
//   GET /workflow-runs/:runId                    run 정보 + 단계 타임라인 (hr_admin 전용)
//
// 읽기 전용: 실행·승인·스케줄 상태를 바꾸지 않는다. 새 카운터·스키마 없이 기존 workflow_runs / workflow_run_steps에서 계산한다.
// - LLM 호출 수 = LLM_NODE_TYPES 단계 수 + agent 단계의 output.turns 길이
// - 소요 시간 = finished_at - started_at (둘 중 하나라도 없으면 null → 화면에서 "—")
// 게이트: 익명 401, 로그인했지만 hr_admin 아님 403 (hr_admin 세션 또는 X-Admin-Secret = auth.ts isAdminRequest).
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest } from "../auth";
import { LLM_NODE_TYPES } from "../workflow/engine";
import type { ObsEnv } from "./types";

type Env = { Bindings: ObsEnv };
type Ctx = Context<Env>;

export const workflowRunsApp = new Hono<Env>();

const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"];

const LLM_IN = LLM_NODE_TYPES.map((t) => `'${t}'`).join(","); // 상수 목록 — 사용자 입력 아님

/** 익명 401 / 비관리자 403. 통과하면 null. */
async function gate(c: Ctx): Promise<Response | null> {
  const cookie = c.req.header("cookie");
  const secret = c.req.header("x-admin-secret");
  if (await isAdminRequest(c.env as never, cookie, secret)) return null;
  const user = await getSessionUser(c.env as never, cookie);
  if (!user) return c.json({ ok: false, error: "로그인이 필요합니다." }, 401);
  return c.json({ ok: false, error: "관리자만 볼 수 있습니다." }, 403);
}

function ms(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function parseJson(s: unknown): unknown {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}

workflowRunsApp.get("/workflow-runs", async (c) => {
  const denied = await gate(c);
  if (denied) return denied;
  const q = c.req.query();
  const n = parseInt(q.limit ?? "", 10);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 50;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.status) {
    if (!RUN_STATUSES.includes(q.status)) return c.json({ ok: false, error: "status 값이 올바르지 않습니다." }, 400);
    where.push("r.status = ?"); binds.push(q.status);
  }
  if (q.owner) { where.push("(r.owner_id = ? OR u.email = ?)"); binds.push(q.owner, q.owner); }
  const sql =
    `SELECT r.id, r.workflow_id, r.owner_id, r.status, r.error, r.started_at, r.finished_at, w.name AS workflow_name, u.email AS owner_email, u.name AS owner_name,
       (SELECT COUNT(*) FROM workflow_run_steps s WHERE s.run_id = r.id) AS step_count,
       (SELECT COUNT(*) FROM workflow_run_steps s WHERE s.run_id = r.id AND s.node_type IN (${LLM_IN})) AS llm_nodes,
       (SELECT COALESCE(SUM(CASE WHEN json_valid(s.output_json) THEN json_array_length(json_extract(s.output_json, '$.turns')) ELSE 0 END), 0)
          FROM workflow_run_steps s WHERE s.run_id = r.id AND s.node_type = 'agent') AS agent_turns
     FROM workflow_runs r
     LEFT JOIN workflows w ON w.id = r.workflow_id
     LEFT JOIN users u ON u.id = r.owner_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY r.started_at DESC, r.id DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds, limit).all<Record<string, unknown>>();
  const runs = (results ?? []).map((r) => ({
    id: r.id, workflow_id: r.workflow_id, workflow_name: r.workflow_name ?? "(삭제된 워크플로우)",
    owner_id: r.owner_id, owner_email: r.owner_email ?? null, owner_name: r.owner_name ?? null,
    status: r.status, started_at: r.started_at, finished_at: r.finished_at ?? null,
    duration_ms: ms(r.started_at as string, (r.finished_at as string) ?? null),
    step_count: Number(r.step_count ?? 0),
    llm_calls: Number(r.llm_nodes ?? 0) + Number(r.agent_turns ?? 0),
    error: r.error ?? null,
  }));
  return c.json({ ok: true, runs });
});

workflowRunsApp.get("/workflow-runs/:runId", async (c) => {
  const denied = await gate(c);
  if (denied) return denied;
  const runId = c.req.param("runId");
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.workflow_id, r.owner_id, r.status, r.error, r.started_at, r.finished_at, r.current_step, w.name AS workflow_name, u.email AS owner_email, u.name AS owner_name
     FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = ?`,
  ).bind(runId).first<Record<string, unknown>>();
  if (!r) return c.json({ ok: false, error: "실행을 찾을 수 없습니다." }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT step_index, node_type, node_name, status, output_json, error, started_at, finished_at FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index",
  ).bind(runId).all<Record<string, unknown>>();
  const steps = (results ?? []).map((s) => {
    const type = s.node_type as string;
    let llm = 0;
    if ((LLM_NODE_TYPES as string[]).includes(type)) llm = 1;
    else if (type === "agent") {
      const turns = (parseJson(s.output_json) as { turns?: unknown } | null)?.turns;
      llm = Array.isArray(turns) ? turns.length : 0;
    }
    return {
      step_index: s.step_index, node_type: type, node_name: s.node_name, status: s.status,
      started_at: s.started_at ?? null, finished_at: s.finished_at ?? null,
      duration_ms: ms(s.started_at as string, (s.finished_at as string) ?? null),
      llm_calls: llm, error: s.error ?? null,
    };
  });
  return c.json({
    ok: true,
    run: {
      id: r.id, workflow_id: r.workflow_id, workflow_name: r.workflow_name ?? "(삭제된 워크플로우)",
      owner_id: r.owner_id, owner_email: r.owner_email ?? null, owner_name: r.owner_name ?? null,
      status: r.status, current_step: r.current_step ?? 0, started_at: r.started_at, finished_at: r.finished_at ?? null,
      duration_ms: ms(r.started_at as string, (r.finished_at as string) ?? null),
      step_count: steps.length, llm_calls: steps.reduce((a, s) => a + s.llm_calls, 0), error: r.error ?? null,
    },
    steps,
  });
});
