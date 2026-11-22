// 회귀 검증 로컬 하네스 (2026-11-21). P3 하네스(async-approval/p3-harness/harness.ts) 사본 + 회귀용 라우트 2개.
// 운영 코드(HEAD)를 그대로 import한다 — 바꾸는 것은 모델(대본 모의)과 외부 fetch(기록만)뿐이다.
// 추가: /h/dup  — 같은 workflow-step 메시지를 큐에 2번 넣는다 (항목 3 멱등성).
//       /h/count — 사용자별 tasks·emails·pending_actions 수.
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import type { ThinkModel } from "@cloudflare/think";
import { workflowApp } from "../../../../src/workflow/routes";
import { processWorkflowStep, stepMessage } from "../../../../src/workflow/engine";
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

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
const MAIL = { to: "kim@example.com", subject: "[RG] 분기 리뷰 안내", body: "안녕하세요, 분기 리뷰 일정 안내드립니다." };
const HOOK = { url: "https://hooks.example.com/rg", method: "POST", headers: { Authorization: "Bearer p2-secret-token", "X-Trace": "rg" }, body: { event: "review", n: 1 } };
const SCRIPTS: Record<string, Step[]> = {
  LDEF: [{ tool: "send_email", args: MAIL }, { text: "안내 메일을 승인 대기열에 넣었습니다. 승인되면 발송됩니다." }],
  LSYNC: [{ tool: "send_email", args: { ...MAIL, subject: "[RG] 동기식 안내" } }, { text: "승인된 메일 발송 결과를 확인했습니다." }],
  LTWO: [{ tool: "send_email", args: { ...MAIL, subject: "[RG] 두 건 중 메일" } }, { tool: "webhook", args: HOOK }, { text: "메일과 외부 호출을 승인 대기열에 넣었습니다. 아직 실행되지 않았습니다." }],
  TDEF: [{ tool: "send_email", args: { ...MAIL, subject: "[RG] Think 안내" } }, { text: "안내 메일은 승인 대기열에 들어갔고 아직 발송되지 않았습니다. 승인되면 발송됩니다." }],
  TSYNC: [{ tool: "send_email", args: { ...MAIL, subject: "[RG] Think 동기식" } }, { text: "승인 후 실행 결과를 확인했습니다." }],
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
      doStream: async () => {
        const i = this.kvGet<number>("h_calls", 0);
        this.kvPut("h_calls", i + 1);
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
    return { ...(await this.inspect()), h_calls: this.kvGet("h_calls", 0), deferTurns: this.kvGet("deferTurns", {}) };
  }
}

const h = new Hono<{ Bindings: Env }>();

h.get("/h/session", async (c) => {
  const id = c.req.query("user") ?? "u_rga";
  const role = c.req.query("role") === "hr_admin" ? "hr_admin" : "user";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `RG ${id}`, role, now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id, role, cookie: setCookie.split(";")[0] });
});
// 라이브 후속: 라이브 시험 세션용 난수 토큰 (줄바꿈 없음). 해시는 셸 sha256sum으로.
h.get("/h/token", (c) => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return c.text([...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
});
// 라이브 후속: wrangler tail --format json 출력(들여쓴 JSON 객체 연속)을 받아 entrypoint·이벤트별 cpuTime/wallTime을 합산한다.
h.post("/h/tail-sum", async (c) => {
  const text = await c.req.text();
  const objs: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
  }
  const from = c.req.query("from") ?? "", to = c.req.query("to") ?? "9";
  const groups: Record<string, { n: number; cpu: number; cpuMax: number; wall: number; outcomes: Record<string, number>; exceptions: number; versions: string[] }> = {};
  for (const o of objs) {
    const ts = new Date(Number(o.eventTimestamp ?? 0)).toISOString();
    if (ts < from || ts > to) continue;
    const ev = (o.event ?? {}) as Record<string, unknown>;
    const kind = ev.request ? "fetch" : ev.queue ? `queue:${String(ev.queue)}` : ev.cron ? "cron" : (ev.type ? String(ev.type) : "alarm/other");
    const key = `${String(o.entrypoint ?? "-")} | ${kind}`;
    const g = groups[key] ??= { n: 0, cpu: 0, cpuMax: 0, wall: 0, outcomes: {}, exceptions: 0, versions: [] };
    const cpu = Number(o.cpuTime ?? 0), wall = Number(o.wallTime ?? 0);
    g.n++; g.cpu += cpu; g.cpuMax = Math.max(g.cpuMax, cpu); g.wall += wall;
    const oc = String(o.outcome); g.outcomes[oc] = (g.outcomes[oc] ?? 0) + 1;
    g.exceptions += Array.isArray(o.exceptions) ? o.exceptions.length : 0;
    const v = String(((o.scriptVersion ?? {}) as Record<string, unknown>).id ?? "").slice(0, 8);
    if (v && !g.versions.includes(v)) g.versions.push(v);
  }
  return c.json({ events: objs.length, from, to, groups });
});
h.get("/h/mode", async (c) => {
  await c.env.CACHE.put(`mode:${c.req.query("wf")}`, c.req.query("mode") ?? "legacy");
  return c.json({ ok: true });
});
// 항목 3: 같은 workflow-step 메시지를 큐에 2번 넣는다 (같은 객체 = 같은 enqueuedAt). approved=1이면 승인 재개 메시지.
h.get("/h/dup", async (c) => {
  const m = stepMessage(c.req.query("run")!, Number(c.req.query("step") ?? "0"), c.req.query("approved") === "1");
  await c.env.PIPELINE.send(m);
  await c.env.PIPELINE.send(m);
  return c.json({ sent: 2, message: m });
});
// 같은 메시지를 소비자에 동시에 2번 (재전달이 겹치는 경우).
h.get("/h/dup-direct", async (c) => {
  const m = stepMessage(c.req.query("run")!, Number(c.req.query("step") ?? "0"), c.req.query("approved") === "1");
  const r = await Promise.allSettled([processWorkflowStep(c.env, m), processWorkflowStep(c.env, m)]);
  return c.json({ message: m, results: r.map((x) => x.status === "fulfilled" ? "ok" : String(x.reason).slice(0, 200)) });
});
h.get("/h/count", async (c) => {
  const u = c.req.query("user")!;
  const one = async (sql: string) => (await c.env.DB.prepare(sql).bind(u).first<{ n: number }>())?.n ?? 0;
  return c.json({
    tasks: await one("SELECT COUNT(*) AS n FROM tasks WHERE owner_id=?"),
    emails: await one("SELECT COUNT(*) AS n FROM emails WHERE owner_id=?"),
    pending: await one("SELECT COUNT(*) AS n FROM workflow_pending_actions WHERE owner_id=?"),
    fetches: FETCHES.length,
  });
});
h.get("/h/state", async (c) => {
  const runId = c.req.query("run")!;
  const run = await c.env.DB.prepare("SELECT id, workflow_id, owner_id, status, error, current_step, output_json FROM workflow_runs WHERE id=?").bind(runId).first<Record<string, unknown>>();
  const steps = (await c.env.DB.prepare("SELECT step_index, node_type, status, output_json, error FROM workflow_run_steps WHERE run_id=? ORDER BY step_index").bind(runId).all()).results;
  const pending = (await c.env.DB.prepare("SELECT id, step_index, turn, node_type, status, error FROM workflow_pending_actions WHERE run_id=? ORDER BY id").bind(runId).all()).results;
  const agentRow = await c.env.DB.prepare("SELECT runtime, status, submission_id, consumed_submission FROM workflow_agent_steps WHERE run_id=?").bind(runId).first();
  const owner = String(run?.owner_id ?? "");
  const emails = (await c.env.DB.prepare("SELECT id, to_addr, subject, provider_id FROM emails WHERE owner_id=? ORDER BY created_at").bind(owner).all()).results;
  let think: unknown = null;
  if (agentRow && (agentRow as { runtime?: string }).runtime === "think") {
    const a = (await getAgentByName(c.env.ThinkAgent as unknown as DurableObjectNamespace<HarnessThinkAgent>, thinkAgentName(runId, 0))) as unknown as HarnessThinkAgent;
    const s = (await a.hState()) as Record<string, unknown>;
    think = { stop: s.stop, outcome: s.outcome, turns: s.turns, deferTurns: s.deferTurns, h_calls: s.h_calls };
  }
  return c.json({ run, steps, pending, agentRow, emails, think, fetchCount: FETCHES.length });
});
h.get("/h/fetches", (c) => c.json({ fetches: FETCHES }));

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
          console.log(`[rgh] step ${body.runId}#${body.stepIndex} turn=${body.agentTurn ?? "-"} approved=${body.approved ?? false} think=${body.thinkSubmissionId ?? "-"} mode=${mode ?? "think"}`);
          await processWorkflowStep(e2, body);
        } else if (body?.type === "workflow-action") {
          console.log(`[rgh] action ${body.pendingActionId}`);
          await processWorkflowAction(env, body);
        }
        msg.ack();
      } catch (e) {
        console.log(`[rgh] message failed: ${String(e).slice(0, 300)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkflowStepMessage | WorkflowActionMessage>;
