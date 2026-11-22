// 비동기 승인 P2 로컬 하네스 (2026-11-21). 운영 코드를 그대로 import한다 — 바꾸는 것은 모델(대본 모의)과 외부 fetch(기록만)뿐이다.
// - /api/workflows/* : 운영 workflowApp 그대로 (세션 쿠키 인증, 결정 API 포함).
// - 큐: 로컬 실제 큐(p2-harness-pipeline). queue()는 운영 processWorkflowStep / processWorkflowAction을 부른다.
//   워크플로우별 런타임은 KV mode:<workflowId>로 legacy를 강제할 수 있다 (기본 AGENT_RUNTIME=think).
//   KV hold-actions=1이면 workflow-action 메시지를 KV에 보관만 하고(ack) /h/release가 운영 processWorkflowAction으로 처리한다.
// - 모델: 목표 문장의 표식 [S:<이름>]으로 대본을 고른다. legacy는 기록의 "[턴 " 개수, Think는 DO별 호출 수가 대본 위치다.
// - fetch: Resend·웹훅 호출을 가로채 기록만 한다 (실제 외부 호출 0).
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import type { ThinkModel } from "@cloudflare/think";
import { workflowApp } from "../../../../src/workflow/routes";
import { processWorkflowStep } from "../../../../src/workflow/engine";
import { processWorkflowAction } from "../../../../src/workflow/pending-actions";
import { ThinkAgent, thinkAgentName } from "../../../../src/workflow/think-agent";
import { WorkflowAgent } from "../../../../src/workflow/agent-do";
import { createSession } from "../../../../src/auth";
import type { Env, WorkflowActionMessage, WorkflowStepMessage } from "../../../../src/workflow/types";

type Fetched = { url: string; method: string; headerKeys: string[]; authorization: string | null; body: string | null; at: string };
const FETCHES: Fetched[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  FETCHES.push({ url, method, headerKeys: [...h.keys()], authorization: h.get("authorization") ? "(present)" : null, body: typeof init?.body === "string" ? init.body.slice(0, 300) : null, at: new Date().toISOString() });
  if (url.includes("api.resend.com")) return new Response(JSON.stringify({ id: `re_fake_${FETCHES.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: true, captured: true, echo: method }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// 대본
type Step = { tool: string; args: Record<string, unknown> } | { text: string };
const MAIL = { to: "kim@example.com", subject: "[P2] 분기 리뷰 안내", body: "안녕하세요, 분기 리뷰 일정 안내드립니다." };
const HOOK = { url: "https://hooks.example.com/p2", method: "POST", headers: { Authorization: "Bearer p2-secret-token", "X-Trace": "p2" }, body: { event: "review", n: 1 } };
const SCRIPTS: Record<string, Step[]> = {
  LDEF: [{ tool: "send_email", args: MAIL }, { text: "안내 메일을 승인 대기열에 넣었습니다. 승인되면 발송됩니다." }],
  LSYNC: [{ tool: "send_email", args: { ...MAIL, subject: "[P2] 동기식 안내" } }, { text: "승인된 메일 발송 결과를 확인했습니다." }],
  LBAD: [{ tool: "send_email", args: { ...MAIL, to: "not-an-address" } }, { text: "주소가 잘못돼 메일을 대기열에 넣지 못했습니다." }],
  LTWO: [{ tool: "send_email", args: { ...MAIL, subject: "[P2] 두 건 중 메일" } }, { tool: "webhook", args: HOOK }, { text: "메일과 외부 호출을 승인 대기열에 넣었습니다. 아직 실행되지 않았습니다." }],
  TDEF: [{ tool: "send_email", args: { ...MAIL, subject: "[P2] Think 안내" } }, { text: "안내 메일은 승인 대기열에 들어갔고 아직 발송되지 않았습니다. 승인되면 발송됩니다." }],
  TSYNC: [{ tool: "send_email", args: { ...MAIL, subject: "[P2] Think 동기식" } }, { text: "승인 후 실행 결과를 확인했습니다." }],
  TBAD: [{ tool: "send_email", args: { ...MAIL, to: "bad address" } }, { text: "주소 오류로 대기열에 넣지 못했습니다." }],
};
const marker = (s: string) => /\[S:([A-Z]+)\]/.exec(s)?.[1] ?? "";

export class HarnessWorkflowAgent extends WorkflowAgent {
  protected async callModel(messages: Array<{ role: string; content: string }>): Promise<string> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const script = SCRIPTS[marker(user)] ?? [{ text: "대본 없음" }];
    const i = (user.match(/\[턴 \d+\]/g) ?? []).length;
    const s = script[Math.min(i, script.length - 1)];
    if ("tool" in s) return JSON.stringify({ thinking: `대본 ${i}`, action: "tool", tool: s.tool, args: s.args });
    return JSON.stringify({ thinking: `대본 ${i}`, action: "finish", final: s.text });
  }
}

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
export class HarnessThinkAgent extends ThinkAgent {
  getModel(): ThinkModel {
    const job = this.kvGet<{ goal?: string } | null>("job", null);
    const script = SCRIPTS[marker(job?.goal ?? "")] ?? [{ text: "대본 없음" }];
    return new MockLanguageModelV4({
      doStream: async (opts: { prompt?: unknown }) => {
        const i = this.kvGet<number>("h_calls", 0);
        this.kvPut("h_calls", i + 1);
        // 모델이 실제로 받은 도구 결과·시스템 프롬프트를 남긴다 (모델에 무엇이 보였는지 증거).
        const seen = this.kvGet<unknown[]>("h_prompts", []);
        seen.push(JSON.stringify(opts.prompt ?? null).slice(0, 4000));
        this.kvPut("h_prompts", seen);
        const s = script[Math.min(i, script.length - 1)];
        const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
        if ("tool" in s) {
          chunks.push({ type: "tool-call", toolCallId: `call_${i}`, toolName: s.tool, input: JSON.stringify(s.args) });
          chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE });
        } else {
          chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: s.text }, { type: "text-end", id: "t" });
          chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
        }
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 5 }) } as never;
      },
    }) as unknown as ThinkModel;
  }
  async hState() {
    return { ...(await this.inspect()), h_calls: this.kvGet("h_calls", 0), h_prompts: this.kvGet("h_prompts", []), deferTurns: this.kvGet("deferTurns", {}) };
  }
}

// ---------------------------------------------------------------------------
const h = new Hono<{ Bindings: Env }>();

h.get("/h/session", async (c) => {
  const id = c.req.query("user") ?? "u_p2a";
  const role = c.req.query("role") === "hr_admin" ? "hr_admin" : "user";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `P2 ${id}`, role, now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id, role, cookie: setCookie.split(";")[0] });
});

h.get("/h/mode", async (c) => {
  await c.env.CACHE.put(`mode:${c.req.query("wf")}`, c.req.query("mode") ?? "legacy");
  return c.json({ ok: true });
});
h.get("/h/hold", async (c) => {
  await c.env.CACHE.put("hold-actions", c.req.query("on") === "1" ? "1" : "0");
  return c.json({ hold: c.req.query("on") === "1" });
});
// 보관한 workflow-action 메시지를 운영 소비자로 처리한다. times=2면 같은 메시지를 두 번(재전달 가정).
h.get("/h/release", async (c) => {
  const held = JSON.parse((await c.env.CACHE.get("held-actions")) ?? "[]") as WorkflowActionMessage[];
  const times = Number(c.req.query("times") ?? "1");
  const done: unknown[] = [];
  for (const m of held) for (let k = 0; k < times; k++) {
    try { await processWorkflowAction(c.env, m); done.push({ id: m.pendingActionId, k, ok: true }); }
    catch (e) { done.push({ id: m.pendingActionId, k, error: String(e) }); }
  }
  await c.env.CACHE.put("held-actions", "[]");
  return c.json({ processed: done });
});
h.get("/h/user-status", async (c) => {
  await c.env.DB.prepare("UPDATE users SET status=? WHERE id=?").bind(c.req.query("status") ?? "inactive", c.req.query("user")).run();
  return c.json({ ok: true });
});

h.get("/h/state", async (c) => {
  const runId = c.req.query("run")!;
  const run = await c.env.DB.prepare("SELECT id, workflow_id, owner_id, status, error, current_step, output_json FROM workflow_runs WHERE id=?").bind(runId).first<Record<string, unknown>>();
  const steps = (await c.env.DB.prepare("SELECT step_index, node_type, status, input_json, output_json, error FROM workflow_run_steps WHERE run_id=? ORDER BY step_index").bind(runId).all()).results;
  const pending = (await c.env.DB.prepare("SELECT * FROM workflow_pending_actions WHERE run_id=? ORDER BY id").bind(runId).all()).results;
  const notifications = (await c.env.DB.prepare("SELECT id, type FROM notifications WHERE ref_id=?").bind(runId).all()).results;
  const agentRow = await c.env.DB.prepare("SELECT runtime, status, submission_id, consumed_submission FROM workflow_agent_steps WHERE run_id=?").bind(runId).first();
  const owner = String(run?.owner_id ?? "");
  const emails = (await c.env.DB.prepare("SELECT id, to_addr, subject, provider_id FROM emails WHERE owner_id=? ORDER BY created_at").bind(owner).all()).results;
  let think: unknown = null;
  if (agentRow && (agentRow as { runtime?: string }).runtime === "think" && c.req.query("think") !== "0") {
    const a = (await getAgentByName(c.env.ThinkAgent as unknown as DurableObjectNamespace<HarnessThinkAgent>, thinkAgentName(runId, 0))) as unknown as HarnessThinkAgent;
    const s = (await a.hState()) as Record<string, unknown>;
    think = { stop: s.stop, pending: s.pending, outcome: s.outcome, turns: s.turns, deferTurns: s.deferTurns, h_calls: s.h_calls, h_prompts: c.req.query("prompts") ? s.h_prompts : undefined, toolEvents: ((s.events as Array<{ ev: string; data: unknown }>) ?? []).filter((e) => /tool|stop/i.test(e.ev)) };
  }
  return c.json({ run, steps, pending, notifications, agentRow, emails, think, fetches: FETCHES });
});
h.get("/h/fetches", (c) => c.json({ fetches: FETCHES }));
h.get("/h/action", async (c) => c.json(await c.env.DB.prepare("SELECT * FROM workflow_pending_actions WHERE id=?").bind(c.req.query("id")).first()));

h.route("/api/workflows", workflowApp);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => h.fetch(req, env, ctx),
  async queue(batch: MessageBatch<WorkflowStepMessage | WorkflowActionMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        if (body?.type === "workflow-step") {
          const run = await env.DB.prepare("SELECT workflow_id FROM workflow_runs WHERE id=?").bind(body.runId).first<{ workflow_id: string }>();
          const mode = run ? await env.CACHE.get(`mode:${run.workflow_id}`) : null;
          const e2 = mode === "legacy" ? ({ ...env, AGENT_RUNTIME: "legacy" } as Env) : env;
          console.log(`[p2h] step ${body.runId}#${body.stepIndex} turn=${body.agentTurn ?? "-"} approved=${body.approved ?? false} think=${body.thinkSubmissionId ?? "-"} mode=${mode ?? "think"}`);
          await processWorkflowStep(e2, body);
        } else if (body?.type === "workflow-action") {
          if ((await env.CACHE.get("hold-actions")) === "1") {
            const held = JSON.parse((await env.CACHE.get("held-actions")) ?? "[]") as WorkflowActionMessage[];
            held.push(body);
            await env.CACHE.put("held-actions", JSON.stringify(held));
            console.log(`[p2h] action held ${body.pendingActionId}`);
          } else {
            console.log(`[p2h] action ${body.pendingActionId}`);
            await processWorkflowAction(env, body);
          }
        }
        msg.ack();
      } catch (e) {
        console.log(`[p2h] message failed: ${String(e).slice(0, 300)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkflowStepMessage | WorkflowActionMessage>;
