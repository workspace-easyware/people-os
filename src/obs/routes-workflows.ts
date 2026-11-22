// 워크플로우 run 관측 API (WF-11, 읽기 전용). index.ts가 `app.route("/api/obs", workflowRunsApp)`로 마운트한다.
//
//   GET /workflow-runs?limit=50&status=&owner=   run 목록 (최신순, hr_admin 전용)
//   GET /workflow-runs/:runId                    run 정보 + 단계 타임라인 (hr_admin 전용)
//
// 읽기 전용: 실행·승인·스케줄 상태를 바꾸지 않는다. 새 카운터·스키마 없이 기존 workflow_runs / workflow_run_steps에서 계산한다.
// - LLM 호출 수 = LLM_NODE_TYPES 단계 수 + agent 단계의 LLM 호출 (Think: output.llmCalls = 모델 스텝 + LLM 도구, legacy: output.turns 길이)
// - 소요 시간 = finished_at - started_at (둘 중 하나라도 없으면 null → 화면에서 "—").
//   끝난 think agent 단계만 workflow_agent_steps.created_at → 단계 finished_at (T3 고침 4 — 엔진의 점유 해제가 started_at을 다시 찍기 때문)
// 게이트: 익명 401, 로그인했지만 hr_admin 아님 403 (hr_admin 세션 또는 X-Admin-Secret = auth.ts isAdminRequest).
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest } from "../auth";
import { LLM_NODE_TYPES, agentOutputLlmCalls } from "../workflow/engine";
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
       (SELECT COALESCE(SUM(CASE WHEN json_valid(s.output_json) THEN COALESCE(json_extract(s.output_json, '$.llmCalls'), json_array_length(json_extract(s.output_json, '$.turns'))) ELSE 0 END), 0)
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

// Think T3 (2026-11-20): 어시스턴트 턴 요약 (D1 assistant_turns, 마이그레이션 0041 — AssistantAgent가 턴 끝에 1행 쓴다).
//   GET /assistant-turns?limit=50&owner=   최신순. 대화 내용은 없다 (상태·스텝·LLM 호출 수·도구 이름·하위 에이전트 위임 수).
// 표가 없으면(0041 미적용) 빈 목록 + schemaMissing.
workflowRunsApp.get("/assistant-turns", async (c) => {
  const denied = await gate(c);
  if (denied) return denied;
  const q = c.req.query();
  const n = parseInt(q.limit ?? "", 10);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 50;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.owner) { where.push("(t.user_id = ? OR u.email = ?)"); binds.push(q.owner, q.owner); }
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT t.user_id, t.turn_no, t.status, t.stopped_reason, t.steps, t.llm_calls, t.tool_calls, t.tools, t.research_runs, t.recoveries,
              t.duration_ms, t.started_at, t.ended_at, u.email AS owner_email, u.name AS owner_name
         FROM assistant_turns t LEFT JOIN users u ON u.id = t.user_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY t.ended_at DESC LIMIT ?`,
    ).bind(...binds, limit).all<Record<string, unknown>>();
    const turns = (results ?? []).map((r) => ({
      user_id: r.user_id, owner_email: r.owner_email ?? null, owner_name: r.owner_name ?? null, turn_no: Number(r.turn_no),
      status: r.status, stopped_reason: r.stopped_reason ?? null, steps: Number(r.steps ?? 0), llm_calls: Number(r.llm_calls ?? 0),
      tool_calls: Number(r.tool_calls ?? 0), tools: (parseJson(r.tools) as string[] | null) ?? [], research_runs: Number(r.research_runs ?? 0),
      recoveries: Number(r.recoveries ?? 0), duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
      started_at: r.started_at ?? null, ended_at: r.ended_at,
    }));
    return c.json({ ok: true, turns });
  } catch (e) {
    if (/no such table/i.test(String(e))) return c.json({ ok: true, turns: [], schemaMissing: true });
    throw e;
  }
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
  // T3 고침 4(b): think agent 단계는 엔진이 점유를 풀고 깨움 메시지를 처리할 때 started_at을 다시 찍어 수십 ms로 보인다.
  // 실제 단계 시간은 workflow_agent_steps.created_at(첫 메시지) → 단계 finished_at(엔진이 결과를 처리한 시각)으로 잰다 (표시만 — 한도 판정과 무관).
  // 끝 시각을 agent_steps.updated_at으로 쓰지 않는 이유: 고치기 전 버전의 결과 재알림 알람(2분 뒤)이 이미 처리된 행을 다시 써 updated_at이 밀린
  // 행이 남아 있다 (라이브 wfrun_mwoi511c_ez0l4k: updated_at 기준 155초, finished_at 기준 41.7초). finished_at이 없으면 updated_at.
  // 표가 없으면(0040 미적용) 기존 조회로 떨어진다.
  let results: Record<string, unknown>[] | undefined;
  try {
    ({ results } = await c.env.DB.prepare(
      `SELECT s.step_index, s.node_type, s.node_name, s.status, s.output_json, s.error, s.started_at, s.finished_at,
              a.runtime AS agent_runtime, a.created_at AS agent_created_at, a.updated_at AS agent_updated_at
         FROM workflow_run_steps s LEFT JOIN workflow_agent_steps a ON a.run_id = s.run_id AND a.step_index = s.step_index
        WHERE s.run_id = ? ORDER BY s.step_index`,
    ).bind(runId).all<Record<string, unknown>>());
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
    ({ results } = await c.env.DB.prepare(
      "SELECT step_index, node_type, node_name, status, output_json, error, started_at, finished_at FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index",
    ).bind(runId).all<Record<string, unknown>>());
  }
  const steps = (results ?? []).map((s) => {
    const type = s.node_type as string;
    let llm = 0;
    if ((LLM_NODE_TYPES as string[]).includes(type)) llm = 1;
    else if (type === "agent") llm = agentOutputLlmCalls(parseJson(s.output_json)); // T3 고침 4(a): Think는 output.llmCalls
    const thinkDone = type === "agent" && s.agent_runtime === "think" && !!s.finished_at;
    return {
      step_index: s.step_index, node_type: type, node_name: s.node_name, status: s.status,
      started_at: s.started_at ?? null, finished_at: s.finished_at ?? null,
      duration_ms: thinkDone
        ? ms(s.agent_created_at as string, (s.finished_at as string) ?? (s.agent_updated_at as string) ?? null) ?? ms(s.started_at as string, s.finished_at as string)
        : ms(s.started_at as string, (s.finished_at as string) ?? null),
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
