// Think 전면 도입 T2 (2026-11-20): 어시스턴트 라우트 (계획 2.4). index.ts에서 /api/agents 에 마운트한다.
//
// - 세션 전용 (X-Admin-Secret 불가 — 워크플로우 라우트와 같은 규칙). getSessionUser가 역할(hr_admin·user) 검사까지 한다.
// - DO는 바깥에 직접 열지 않는다 (routeAgentRequest 쓰지 않음 → 기존 이중 게이트를 우회하지 않는다). 라우트가 인증한 뒤 RPC로만 부른다.
// - `:id`는 호출자의 어시스턴트 id(asst_<userId>)여야 한다. 아니면 404 (다른 사용자의 어시스턴트가 있는지도 흘리지 않는다).
//
//   GET  /api/agents                    → { assistant, workflowAgents }  (T3 에이전트 화면 목록: 내 어시스턴트 + 내 워크플로 agent 단계 20개)
//   GET  /api/agents/wf/:runId/:step    → 워크플로 agent 단계 1개의 도구 호출 기록 (T3, 내 run만 — 아니면 404)
//   DELETE /api/agents/:id/messages     → 대화 지우기 (T3, 열린 턴이 있으면 409)
//   GET  /api/agents/me                 → { id }  (내 어시스턴트 id)
//   POST /api/agents/:id/messages       → 202 { turnNo, submissionId, accepted, status }  (runTurn submit, 바로 돌려준다)
//   GET  /api/agents/:id/messages       → { messages, turns }  (DO SQLite의 대화 기록)
//   GET  /api/agents/:id/events?after=N → { events, cursor, latestTurn }  (2초 폴링용)
//        Accept: text/event-stream 이면 같은 이벤트를 SSE로 흘린다 (서버가 0.4초마다 DO를 읽는다, 최대 55초 — 끊기면 Last-Event-ID로 이어 받는다).
//        T3 고침 2: 이벤트에 `delta`(답 글 조각, 250ms·120자 단위)가 더해졌다. 에이전트 화면은 SSE로 받아 이어 붙이고, 안 되면 2초 폴링으로 돌아간다.
import { Hono } from "hono";
import type { Context } from "hono";
import { getAgentByName } from "agents";
import { getSessionUser, type SessionUser } from "../auth";
import type { Env } from "../workflow/types";
import { thinkAgentName } from "../workflow/think-agent";
import { assistantDoName, assistantIdFor, type AssistantAgent } from "./agent";

export const agentsApp = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const MAX_TEXT = 4000;
const SSE_MAX_MS = 55_000;
// T3 고침 2: 토큰 스트리밍(delta 이벤트)을 화면이 SSE로 받는다 → 1초에서 0.4초로 (DO 읽기는 열린 턴이 있는 동안만).
const SSE_POLL_MS = 400;

class AgError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, message: string) {
    super(message);
  }
}

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
  if (!u) throw new AgError(401, "로그인이 필요합니다.");
  if (mutating && !originOk(c)) throw new AgError(403, "허용되지 않는 요청입니다.");
  return u;
}

/** 호출자 것이 아니면 404. 맞으면 그 사용자의 DO 스텁. */
async function ownStub(c: C, u: SessionUser): Promise<AssistantAgent> {
  if (c.req.param("id") !== assistantIdFor(u.id)) throw new AgError(404, "어시스턴트를 찾을 수 없습니다.");
  if (!c.env.ASSISTANT_AGENT) throw new AgError(503, "어시스턴트가 아직 준비되지 않았습니다.");
  return (await getAgentByName(c.env.ASSISTANT_AGENT, assistantDoName(u.id))) as unknown as AssistantAgent;
}

function fail(c: C, e: unknown) {
  if (e instanceof AgError) return c.json({ ok: false, error: e.message }, e.status);
  const msg = String((e as Error)?.message ?? e);
  const daily = /assistant_daily_limit:(\d+)/.exec(msg);
  if (daily) return c.json({ ok: false, error: `오늘 어시스턴트 사용 한도(${daily[1]}회)를 다 썼습니다. 내일(한국 시간 0시 이후) 다시 이용해 주세요.`, code: "daily_limit" }, 429);
  if (msg.includes("assistant_busy_clear")) return c.json({ ok: false, error: "처리 중인 메시지가 끝난 뒤에 대화를 지울 수 있습니다." }, 409);
  if (msg.includes("assistant_busy")) return c.json({ ok: false, error: "이전 메시지를 처리하고 있습니다. 잠시 뒤 다시 보내 주세요." }, 429);
  if (msg.includes("assistant_owner_mismatch")) return c.json({ ok: false, error: "어시스턴트를 찾을 수 없습니다." }, 404);
  console.error(JSON.stringify({ event: "assistant.error", error: msg.slice(0, 300) }));
  return c.json({ ok: false, error: "어시스턴트 요청을 처리하지 못했습니다." }, 500);
}

agentsApp.get("/me", async (c) => {
  try {
    const u = await requireUser(c);
    return c.json({ ok: true, id: assistantIdFor(u.id) });
  } catch (e) {
    return fail(c, e);
  }
});

// ---- T3: 에이전트 화면 목록 (내 어시스턴트 + 내 워크플로 agent 단계) ----

type AgentTurnLite = { turn: number; action: string; tool?: string; thinking?: string; observation?: string; final?: string; error?: string; at?: string };

function parseJson<T>(s: unknown): T | null {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
function cut(s: unknown, n: number): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function liteTurns(turns: unknown, obsMax: number): AgentTurnLite[] {
  if (!Array.isArray(turns)) return [];
  return (turns as Array<Record<string, unknown>>).slice(0, 30).map((t) => ({
    turn: Number(t.turn ?? 0), action: String(t.action ?? ""), tool: typeof t.tool === "string" ? t.tool : undefined,
    thinking: cut(t.thinking, 300), observation: cut(t.observation, obsMax), final: cut(t.final, 600), error: cut(t.error, 300),
    at: typeof t.at === "string" ? t.at : undefined,
  }));
}

/** 내 워크플로 agent 단계 (최신 20개). 승인 대기 = run이 waiting_approval이고 현재 단계가 이 단계. */
async function myWorkflowAgents(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.run_id, s.step_index, s.node_name, s.status AS step_status, s.output_json, s.error AS step_error, s.started_at, s.finished_at,
            r.workflow_id, r.status AS run_status, r.current_step, r.started_at AS run_started_at, w.name AS workflow_name,
            a.runtime, a.status AS think_status, a.steps AS think_steps, a.llm_calls AS think_llm
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.run_id
       LEFT JOIN workflows w ON w.id = r.workflow_id
       LEFT JOIN workflow_agent_steps a ON a.run_id = s.run_id AND a.step_index = s.step_index
      WHERE r.owner_id = ? AND s.node_type = 'agent'
      ORDER BY COALESCE(s.started_at, r.started_at) DESC LIMIT 20`,
  ).bind(userId).all<Record<string, unknown>>();
  return (results ?? []).map((r) => {
    const out = parseJson<{ final?: string; turns?: unknown; stoppedReason?: string | null; runtime?: string }>(r.output_json);
    const turns = Array.isArray(out?.turns) ? (out!.turns as Array<Record<string, unknown>>) : [];
    const waiting = r.run_status === "waiting_approval" && Number(r.current_step) === Number(r.step_index);
    return {
      runId: r.run_id, stepIndex: Number(r.step_index), stepName: r.node_name, workflowId: r.workflow_id,
      workflowName: r.workflow_name ?? "(삭제된 워크플로우)",
      runtime: r.runtime === "think" ? "think" : "legacy",
      status: waiting ? "waiting_approval" : String(r.step_status ?? ""), runStatus: r.run_status,
      running: !waiting && (r.step_status === "running" || (r.step_status === "pending" && ["queued", "running"].includes(String(r.run_status)))),
      waitingApproval: waiting,
      startedAt: r.started_at ?? r.run_started_at ?? null, finishedAt: r.finished_at ?? null,
      steps: r.runtime === "think" ? Number(r.think_steps ?? 0) : turns.length,
      llmCalls: r.runtime === "think" ? Number(r.think_llm ?? 0) : turns.length,
      tools: turns.filter((t) => t.action === "tool" && typeof t.tool === "string").map((t) => String(t.tool)),
      stoppedReason: out?.stoppedReason ?? null, final: cut(out?.final, 300) ?? null, error: cut(r.step_error, 300) ?? null,
      link: `#workflow/${r.workflow_id}?run=${r.run_id}`,
    };
  });
}

agentsApp.get("/", async (c) => {
  try {
    const u = await requireUser(c);
    const id = assistantIdFor(u.id);
    let assistant: Record<string, unknown> = { id, name: "내 어시스턴트", kind: "assistant" };
    if (c.env.ASSISTANT_AGENT) {
      const stub = (await getAgentByName(c.env.ASSISTANT_AGENT, assistantDoName(u.id))) as unknown as AssistantAgent;
      const h = await stub.history({ userId: u.id, limit: 1 });
      const last = h.turns[h.turns.length - 1] ?? null;
      assistant = {
        ...assistant, usage: h.usage,
        running: !!last && !["completed", "aborted", "skipped", "error"].includes(last.status),
        lastTurn: last ? { turnNo: last.turnNo, status: last.status, steps: last.steps, llmCalls: last.llmCalls, endedAt: last.endedAt, stop: last.stop } : null,
      };
    }
    let workflowAgents: unknown[] = [];
    let workflowError: string | null = null;
    try { workflowAgents = await myWorkflowAgents(c.env, u.id); } catch (e) { workflowError = "워크플로 에이전트 목록을 읽지 못했습니다."; console.error(JSON.stringify({ event: "agents.list.error", error: String(e).slice(0, 200) })); }
    return c.json({ ok: true, assistant, workflowAgents, workflowError });
  } catch (e) {
    return fail(c, e);
  }
});

/** 워크플로 agent 단계 1개의 도구 호출 기록. 내 run이 아니면 404. 끝난 단계는 D1 output, 실행 중인 Think 단계는 DO 상태를 읽는다. */
agentsApp.get("/wf/:runId/:stepIndex", async (c) => {
  try {
    const u = await requireUser(c);
    const runId = c.req.param("runId");
    const stepIndex = Number(c.req.param("stepIndex"));
    if (!Number.isInteger(stepIndex) || stepIndex < 0) throw new AgError(404, "에이전트 실행을 찾을 수 없습니다.");
    const row = await c.env.DB.prepare(
      `SELECT s.status, s.output_json, s.error, r.status AS run_status, r.current_step, r.workflow_id, a.runtime
         FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
         LEFT JOIN workflow_agent_steps a ON a.run_id = s.run_id AND a.step_index = s.step_index
        WHERE s.run_id = ? AND s.step_index = ? AND s.node_type = 'agent' AND r.owner_id = ?`,
    ).bind(runId, stepIndex, u.id).first<Record<string, unknown>>();
    if (!row) throw new AgError(404, "에이전트 실행을 찾을 수 없습니다.");
    const out = parseJson<{ turns?: unknown; final?: string; stoppedReason?: string | null }>(row.output_json);
    let turns = liteTurns(out?.turns, 800);
    let live: Record<string, unknown> | null = null;
    if (!out?.turns && row.runtime === "think" && c.env.ThinkAgent) {
      // 아직 끝나지 않은 Think 단계: DO에 쌓인 turns·카운터·승인 대기를 읽는다 (읽기 전용).
      const stub = await getAgentByName(c.env.ThinkAgent, thinkAgentName(runId, stepIndex));
      const st = (await stub.inspect()) as { turns?: unknown; steps?: number; llmCalls?: number; stop?: string | null; pending?: { tool?: string } | null };
      turns = liteTurns(st.turns, 800);
      live = { steps: st.steps ?? 0, llmCalls: st.llmCalls ?? 0, stop: st.stop ?? null, pendingTool: st.pending?.tool ?? null };
    }
    // 지연 승인(P3)으로 이 단계가 쌓은 대기 동작 중 아직 승인 대기(queued)인 수 — 화면이 워크플로우 "대기 동작" 섹션으로 가는 배지를 단다.
    // (2026-11-21 브라우저 회귀 5번) 테이블이 없거나 실패하면 null (배지 없음).
    let pendingActions: number | null = null;
    try {
      const pa = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_pending_actions WHERE run_id = ? AND step_index = ? AND owner_id = ? AND status = 'queued'",
      ).bind(runId, stepIndex, u.id).first<{ n: number }>();
      pendingActions = Number(pa?.n ?? 0);
    } catch { pendingActions = null; }
    return c.json({
      pendingActions, workflowId: row.workflow_id ?? null,
      ok: true, runId, stepIndex, runtime: row.runtime === "think" ? "think" : "legacy", status: row.status, runStatus: row.run_status,
      waitingApproval: row.run_status === "waiting_approval" && Number(row.current_step) === stepIndex,
      final: cut(out?.final, 2000) ?? null, stoppedReason: out?.stoppedReason ?? null, error: cut(row.error, 500) ?? null,
      turns, live, link: `#workflow/${row.workflow_id}?run=${runId}`,
    });
  } catch (e) {
    return fail(c, e);
  }
});

agentsApp.post("/:id/messages", async (c) => {
  try {
    const u = await requireUser(c, true);
    const stub = await ownStub(c, u);
    const raw = await c.req.text();
    if (raw.length > MAX_TEXT * 4 + 1024) throw new AgError(413, "요청 본문이 너무 큽니다.");
    let body: { text?: unknown; clientId?: unknown };
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new AgError(400, "JSON 객체 본문이 필요합니다."); }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new AgError(400, "text가 필요합니다.");
    if (text.length > MAX_TEXT) throw new AgError(413, `메시지는 ${MAX_TEXT}자까지 보낼 수 있습니다.`);
    const clientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.clientId) ? body.clientId : undefined;
    const r = await stub.send({ user: { id: u.id, email: u.email, role: u.role, coaching_role: u.coaching_role, name: u.name }, text, clientId });
    console.log(JSON.stringify({ event: "assistant.submit", turnNo: r.turnNo, accepted: r.accepted, status: r.status }));
    return c.json({ ok: true, id: assistantIdFor(u.id), ...r }, 202);
  } catch (e) {
    return fail(c, e);
  }
});

// T3: 대화 지우기 (본인 어시스턴트만, 남의 id는 404). 열린 턴이 있으면 409. 하루 사용량은 초기화되지 않는다.
agentsApp.delete("/:id/messages", async (c) => {
  try {
    const u = await requireUser(c, true);
    const stub = await ownStub(c, u);
    const r = await stub.clear({ userId: u.id });
    console.log(JSON.stringify({ event: "assistant.clear", clearedThrough: r.clearedThrough }));
    return c.json({ ok: true, id: assistantIdFor(u.id), ...r });
  } catch (e) {
    return fail(c, e);
  }
});

agentsApp.get("/:id/messages", async (c) => {
  try {
    const u = await requireUser(c);
    const stub = await ownStub(c, u);
    const r = await stub.history({ userId: u.id, limit: Number(c.req.query("limit") ?? 50) });
    return c.json({ ok: true, id: assistantIdFor(u.id), ...r });
  } catch (e) {
    return fail(c, e);
  }
});

agentsApp.get("/:id/events", async (c) => {
  try {
    const u = await requireUser(c);
    const stub = await ownStub(c, u);
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0;
    if (!(c.req.header("accept") ?? "").includes("text/event-stream")) {
      const r = await stub.events({ userId: u.id, after });
      return c.json({ ok: true, id: assistantIdFor(u.id), pollMs: 2000, ...r });
    }
    // SSE: 같은 이벤트 로그를 서버가 1초마다 읽어 흘린다. 열린 턴이 없으면 끝(turnEnd)까지 보낸 뒤 닫는다.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const userId = u.id;
    const pump = async () => {
      let cursor = after;
      const t0 = Date.now();
      try {
        await w.write(enc.encode(`retry: 2000\n\n`));
        while (Date.now() - t0 < SSE_MAX_MS) {
          const r = await stub.events({ userId, after: cursor });
          for (const ev of r.events) await w.write(enc.encode(`id: ${ev.id}\nevent: ${ev.ev}\ndata: ${JSON.stringify(ev)}\n\n`));
          cursor = r.cursor;
          const lt = r.latestTurn;
          const idle = !lt || ["completed", "aborted", "skipped", "error"].includes(lt.status);
          if (idle && r.events.length === 0) break;
          await new Promise((res) => setTimeout(res, SSE_POLL_MS));
        }
        await w.write(enc.encode(`event: end\ndata: ${JSON.stringify({ cursor })}\n\n`));
      } catch {
        /* 클라이언트가 끊었다 */
      } finally {
        try { await w.close(); } catch { /* 이미 닫힘 */ }
      }
    };
    c.executionCtx.waitUntil(pump());
    return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  } catch (e) {
    return fail(c, e);
  }
});
