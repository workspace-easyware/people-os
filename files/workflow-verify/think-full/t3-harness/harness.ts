// Think T3 하네스 (2026-11-20). 운영 코드를 그대로 import한다 — 여기서 고치는 것은 시험용 서브클래스뿐이다.
// - HarnessAssistantAgent: 운영 AssistantAgent + (i) 대본 모의 모델(선택, 모델 입력에 자식 결과가 들어갔는지 기록), (ii) 줄인 한도·하루 상한·"다음 날" 흉내,
//   (iii) 노드 모의 실행, (iv) 조사 자식을 HarnessResearchAgent로 바꿈. 훅·한도·이벤트·대화 저장·runAgentTool 경로는 운영 코드 그대로.
// - HarnessResearchAgent: 운영 ResearchAgent + 대본 모의 모델·모의 노드 (부모가 input.h로 넘긴 설정을 쓴다).
// - HarnessThinkAgent(T1 하네스 것 재사용) + 운영 엔진 queue(): Think 경로 한도(활성 30분·LLM 30회) 시험.
// - /api/agents/* 는 운영 agentsApp, /api/obs/* 는 운영 workflowRunsApp를 그대로 마운트한다 (세션 쿠키 인증 포함).
// - 원격(people-os-t3-harness): 실제 Qwen + 실제 ask-pipeline으로 조사 위임 (/h/real), 라이브 think 비교 run 생성 (/h/live-run, 운영 큐에 생산자로만 붙는다).
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import type { ThinkModel } from "@cloudflare/think";
import { AssistantAgent, assistantDoName, assistantIdFor, kstDay, type AssistantLimits, type AssistantOwner, type TurnState } from "../../../../src/assistant/agent";
import { ResearchAgent } from "../../../../src/assistant/research";
import { agentsApp } from "../../../../src/assistant/routes";
import { workflowRunsApp } from "../../../../src/obs/routes-workflows";
import { createSession } from "../../../../src/auth";
import { checkWorkflowRateLimit, processWorkflowStep, stepMessage } from "../../../../src/workflow/engine";
import { thinkAgentName } from "../../../../src/workflow/think-agent";
import { APPROVAL_REQUIRED_NODES, type Env, type NodeContext, type NodeResult, type NodeType, type WorkflowStepMessage } from "../../../../src/workflow/types";
import type { HarnessThinkAgent } from "../t1-harness/harness";
export { AgentSession } from "../../../../src/agent-session";
export { WorkflowAgent } from "../../../../src/workflow/agent-do";
export { HarnessThinkAgent } from "../t1-harness/harness";

type ScriptItem = { tool: string; input: Record<string, unknown> } | { text: string };
interface ChildCfg { script?: ScriptItem[]; mockNodes?: boolean }
interface HCfg {
  script?: ScriptItem[]; // 없으면 실제 모델(Qwen)
  cycle?: boolean;
  mockNodes?: boolean;
  limits?: Partial<AssistantLimits>;
  dailyCap?: number;
  dayOffset?: number; // "다음 날" 흉내 (일 단위)
  child?: ChildCfg; // 조사 자식 설정 (없으면 실제 모델·실제 노드)
  marker?: string; // 모델 입력(prompt)에 이 문자열이 들어오면 h_marker_hits를 센다 (자식 결과가 부모 모델에 들어갔는지)
}

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function mockModel(script: ScriptItem[], cycle: boolean, next: () => number, onPrompt?: (p: string) => void): ThinkModel {
  return new MockLanguageModelV4({
    doStream: async (opts: { prompt?: unknown }) => {
      const i = next();
      if (onPrompt) { try { onPrompt(JSON.stringify(opts?.prompt ?? "")); } catch { /* 무시 */ } }
      const item = cycle ? script[i % script.length] : script[Math.min(i, script.length - 1)];
      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("tool" in item) {
        chunks.push({ type: "tool-call", toolCallId: `call_${i}_${Date.now()}`, toolName: item.tool, input: JSON.stringify(item.input) });
        chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE });
      } else {
        chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: item.text }, { type: "text-end", id: "t" });
        chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
      }
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 5 }) } as never;
    },
  } as never) as unknown as ThinkModel;
}

export class HarnessResearchAgent extends ResearchAgent {
  private hc(): ChildCfg { return ((this.job()?.h ?? {}) as ChildCfg); }
  getModel(): ThinkModel {
    const c = this.hc();
    if (!c.script?.length) return super.getModel();
    return mockModel(c.script, false, () => { const i = this.kvGet<number>("h_calls", 0); this.kvPut("h_calls", i + 1); return i; });
  }
  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    const log = this.kvGet<Array<{ tool: string; user: string; runId: string }>>("h_exec", []);
    log.push({ tool: type, user: ctx.user.id, runId: ctx.runId });
    this.kvPut("h_exec", log);
    if (!this.hc().mockNodes) return super.execNode(type, ctx, args);
    return { status: "succeeded", output: { answer: "(모의) 연차는 15일, 경조사 휴가는 본인 결혼 5일입니다.", sources: [{ title: "취업규칙 제20조" }, { title: "경조사 규정 제3조" }], grounded: true } };
  }
}

export class HarnessAssistantAgent extends AssistantAgent {
  private hcfg(): HCfg { return this.kvGet<HCfg>("h_cfg", {}); }
  async hConfigure(cfg: HCfg) { this.kvPut("h_cfg", cfg); this.kvPut("h_calls", 0); this.kvPut("h_marker_hits", 0); return { ok: true }; }

  getModel(): ThinkModel {
    const cfg = this.hcfg();
    if (!cfg.script?.length) return super.getModel();
    return mockModel(cfg.script, !!cfg.cycle, () => { const i = this.kvGet<number>("h_calls", 0); this.kvPut("h_calls", i + 1); return i; },
      cfg.marker ? (p) => { if (p.includes(cfg.marker!)) this.kvPut("h_marker_hits", this.kvGet<number>("h_marker_hits", 0) + 1); } : undefined);
  }
  protected limits(): AssistantLimits { return { ...super.limits(), ...(this.hcfg().limits ?? {}) }; }
  protected dailyCap(): number { return this.hcfg().dailyCap ?? super.dailyCap(); }
  protected dayKey(): string { return kstDay(Date.now() + (this.hcfg().dayOffset ?? 0) * 86400_000); }
  protected researchClass(): typeof ResearchAgent { return HarnessResearchAgent; }
  protected researchExtra() { const c = this.hcfg().child; return c ? { h: c } : {}; }
  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    const cfg = this.hcfg();
    const log = this.kvGet<Array<{ tool: string; at: number }>>("h_exec", []);
    log.push({ tool: type, at: Date.now() });
    this.kvPut("h_exec", log);
    if (!cfg.mockNodes) return super.execNode(type, ctx, args);
    if ((APPROVAL_REQUIRED_NODES as string[]).includes(type)) this.kvPut("h_sent", this.kvGet<number>("h_sent", 0) + 1);
    if (type === "ask_rag" || type === "ask_personal") return { status: "succeeded", output: { answer: "(모의) 연차는 15일입니다.", sources: [{ title: "취업규칙 제20조" }], grounded: true } };
    return { status: "succeeded", output: { mock: true, tool: type, args } };
  }
  async hState() {
    return {
      ...(await this.inspectState()), h_calls: this.kvGet("h_calls", 0), h_exec: this.kvGet("h_exec", []), h_sent: this.kvGet("h_sent", 0),
      h_marker_hits: this.kvGet("h_marker_hits", 0), h_cfg: this.hcfg(),
      agentToolRuns: this.ctx.storage.sql.exec("SELECT * FROM cf_agent_tool_runs").toArray().map((r) => ({ run_id: r.run_id, status: r.status, agent_type: r.agent_type })),
    };
  }
  /** 자식(조사) facet의 상태를 직접 읽는다 (부모가 연 facet 이름 = runId). */
  async hChild(runId: string) {
    const child = (await this.subAgent(HarnessResearchAgent, runId)) as unknown as { hChildState(): Promise<unknown> };
    return child.hChildState();
  }
}
// 자식 상태 읽기 (하네스 전용 RPC)
(HarnessResearchAgent.prototype as unknown as { hChildState: () => Promise<unknown> }).hChildState = async function (this: HarnessResearchAgent) {
  const self = this as unknown as { kvGet<T>(k: string, f: T): T; job(): unknown };
  return {
    job: (() => { const j = self.job() as Record<string, unknown> | null; return j ? { ...j, owner: (j.owner as { id?: string } | undefined)?.id } : null; })(),
    offered: self.kvGet("offered", null), steps: self.kvGet("steps", 0), llmCalls: self.kvGet("llmCalls", 0), toolCalls: self.kvGet("toolCalls", 0),
    tools: self.kvGet("tools", []), blocked: self.kvGet("blocked", 0), stop: self.kvGet("stop", null), final: self.kvGet("final", null), h_exec: self.kvGet("h_exec", []),
    messages: (await this.getMessages()).map((m) => ({ role: m.role, text: (m.parts ?? []).filter((p) => p.type === "text").map((p) => (p as { text?: string }).text ?? "").join("").slice(0, 300) })),
  };
};

// ---------------------------------------------------------------------------

const harness = new Hono<{ Bindings: Env }>();
const userOf = (id: string): AssistantOwner => ({ id, email: `${id}@example.com`, role: "user", name: `T3 하네스 ${id}` });
const stubOf = async (env: Env, userId: string) =>
  (await getAgentByName(env.ASSISTANT_AGENT as unknown as DurableObjectNamespace<HarnessAssistantAgent>, assistantDoName(userId))) as unknown as HarnessAssistantAgent;
const thinkOf = async (env: Env, name: string) =>
  (await getAgentByName(env.ThinkAgent as unknown as DurableObjectNamespace<HarnessThinkAgent>, name)) as unknown as HarnessThinkAgent;

const TERMINAL = ["completed", "aborted", "skipped", "error"];
async function waitTurn(env: Env, userId: string, turnNo: number, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    let st: Record<string, unknown> | null = null;
    try { st = await (await stubOf(env, userId)).hState(); } catch { /* 재시작 직후 */ }
    const t = (st?.turns as TurnState[] | undefined)?.find((x) => x.turnNo === turnNo);
    if ((t && TERMINAL.includes(t.status)) || Date.now() - t0 > timeoutMs) return { ms: Date.now() - t0, turn: t ?? null, state: st };
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function brief(w: { ms: number; turn: TurnState | null; state: Record<string, unknown> | null }) {
  const t = w.turn;
  return {
    ms: w.ms, status: t?.status ?? null, stop: t?.stop ?? null, steps: t?.steps, llmCalls: t?.llmCalls, toolCalls: t?.toolCalls, researchRuns: t?.researchRuns ?? 0,
    thinkingSteps: t?.thinkingSteps, final: t?.final ? String(t.final).slice(0, 600) : null,
    exec: (w.state?.h_exec as Array<{ tool: string }> | undefined)?.map((e) => e.tool), markerHits: w.state?.h_marker_hits, agentToolRuns: w.state?.agentToolRuns,
  };
}

harness.use("*", async (c, next) => {
  const openUntil = (c.env as unknown as { OPEN_UNTIL?: string }).OPEN_UNTIL;
  if (openUntil !== undefined && !(Date.now() < Number(openUntil))) return c.json({ error: "closed" }, 403);
  return next();
});

// 로컬 전용: 시험 사용자 + 세션 쿠키 (운영 createSession 그대로). role=hr_admin이면 관측 API 시험용.
harness.get("/h/session", async (c) => {
  if ((c.env as unknown as { OPEN_UNTIL?: string }).OPEN_UNTIL !== undefined) return c.json({ error: "local only" }, 403);
  const id = c.req.query("user") ?? "u_t3a";
  const role = c.req.query("role") === "hr_admin" ? "hr_admin" : "user";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `T3 ${id}`, role, now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id: assistantIdFor(id), cookie: setCookie.split(";")[0] });
});
harness.post("/h/config", async (c) => c.json(await (await stubOf(c.env, c.req.query("user") ?? "")).hConfigure((await c.req.json()) as HCfg)));
harness.get("/h/state", async (c) => c.json(await (await stubOf(c.env, c.req.query("user") ?? "")).hState()));
harness.get("/h/wait", async (c) => {
  const u = c.req.query("user") ?? "";
  return c.json(brief(await waitTurn(c.env, u, Number(c.req.query("turn") ?? 1), Number(c.req.query("timeout") ?? 60000))));
});
harness.get("/h/child", async (c) => c.json(await (await stubOf(c.env, c.req.query("user") ?? "")).hChild(c.req.query("run") ?? "")));

// 항목 6 (로컬, 모의 모델): 부모가 research를 부르고 → 자식(facet)이 ask_rag로 근거를 모아 요약 → 그 요약이 부모의 다음 모델 입력에 들어가 최종 답.
harness.get("/h/research-local", async (c) => {
  const user = c.req.query("user") ?? `u_res_${Date.now()}`;
  const s = await stubOf(c.env, user);
  const marker = "조사요약마커-T3";
  await s.hConfigure({
    mockNodes: true, marker,
    script: [{ tool: "research", input: { topic: "연차 휴가와 경조사 휴가 규정 비교" } }, { text: "정리: 연차 15일, 경조사(본인 결혼) 5일입니다. (출처: 취업규칙 제20조, 경조사 규정 제3조)" }],
    child: { mockNodes: true, script: [{ tool: "ask_rag", input: { question: "연차와 경조사 휴가 일수" } }, { tool: "send_email", input: { to: "x@example.com", subject: "s", body: "b" } }, { text: `${marker}: 연차 15일(취업규칙 제20조), 경조사 본인 결혼 5일(경조사 규정 제3조).` }] },
  });
  const sub = await s.send({ user: userOf(user), text: "연차와 경조사 휴가 규정을 비교해 정리해 줘" });
  const w = await waitTurn(c.env, user, sub.turnNo, 60000);
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  const rs = ev.events.find((e) => e.ev === "researchStart");
  const child = rs ? await s.hChild(String(rs.data.runId)) : null;
  const hist = await s.history({ userId: user });
  return c.json({
    user, sub, ...brief(w), child,
    events: ev.events.map((e) => `${e.ev}${e.data.tool ? `:${e.data.tool}` : ""}${e.data.status ? `:${e.data.status}` : ""}${e.data.runId ? `:${e.data.runId}` : ""}`),
    researchEnd: ev.events.find((e) => e.ev === "researchEnd")?.data ?? null,
    lastAssistantMessage: hist.messages.filter((m) => m.role === "assistant").slice(-1)[0] ?? null,
  });
});

// 원격 전용: 실제 모델(부모·자식 모두 Qwen) + 실제 노드(ask-pipeline). 세션 없이 DO RPC (사용자 id는 시험용 합성 id).
harness.get("/h/real", async (c) => {
  const user = c.req.query("user") ?? "u_t3r";
  const text = c.req.query("text") ?? "연차 휴가와 경조사 휴가 규정을 조사 담당에게 맡겨 비교 정리해 줘";
  const s = await stubOf(c.env, user);
  await s.hConfigure({});
  const sub = await s.send({ user: userOf(user), text });
  const w = await waitTurn(c.env, user, sub.turnNo, Number(c.req.query("timeout") ?? 280000));
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  const rs = ev.events.filter((e) => e.turn === sub.turnNo && e.ev === "researchStart");
  const children = [];
  for (const r of rs) children.push(await s.hChild(String(r.data.runId)));
  return c.json({ user, sub, ...brief(w), children, events: ev.events.filter((e) => e.turn === sub.turnNo).map((e) => ({ ev: e.ev, ...e.data })) });
});

// ---- 항목 8 (로컬): Think 경로에서 run 한도 (엔진 쪽) ----
const EUSER = { id: "u_t3eng", email: "t3eng@example.com", name: "T3 엔진", role: "user" };
async function seed(env: Env, runId: string, steps: unknown[], startedAt = new Date().toISOString(), owner = EUSER.id) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(EUSER.id, EUSER.email, EUSER.name, EUSER.role, now).run();
  const wfId = `wf_${runId}`;
  await env.DB.prepare("INSERT INTO workflows (id, owner_id, name, status, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(wfId, owner, `T3 ${runId}`, "active", JSON.stringify({ version: 1, steps }), now, now).run();
  await env.DB.prepare("INSERT INTO workflow_runs (id, workflow_id, owner_id, status, input_json, current_step, started_at) VALUES (?,?,?,'queued','{}',0,?)")
    .bind(runId, wfId, owner, startedAt).run();
}
async function runState(env: Env, runId: string) {
  const run = await env.DB.prepare("SELECT status, current_step, error FROM workflow_runs WHERE id=?").bind(runId).first();
  const { results: steps } = await env.DB.prepare("SELECT step_index, node_type, status, substr(output_json,1,300) AS out, error FROM workflow_run_steps WHERE run_id=? AND (step_index >= 25 OR node_type != 'llm') ORDER BY step_index").bind(runId).all();
  const agentRow = await env.DB.prepare("SELECT step_index, runtime, status, steps, llm_calls, substr(result_json,1,300) AS result FROM workflow_agent_steps WHERE run_id=?").bind(runId).first();
  return { run, steps, agentRow };
}

harness.get("/h/eng/rate", async (c) => {
  const owner = `u_t3rate_${Date.now()}`;
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(owner, `${owner}@example.com`, "T3 rate", "user", now).run();
  const agentStep = [{ id: "a1", type: "agent", name: "에이전트", config: { goal: "시험", tools: ["create_task"], maxSteps: 4 } }];
  const out: Record<string, unknown> = {};
  // 동시 3: think agent run 3개를 running으로 두면 4번째는 거절
  for (let i = 0; i < 3; i++) {
    await seed(c.env, `wr_t3rate_${owner}_${i}`, agentStep, now, owner);
    await c.env.DB.prepare("UPDATE workflow_runs SET status='running' WHERE id=?").bind(`wr_t3rate_${owner}_${i}`).run();
  }
  out.concurrent = await checkWorkflowRateLimit(c.env, owner);
  // 하루 20: 동시 run을 끝내고 20번 통과시킨 뒤 21번째
  await c.env.DB.prepare("UPDATE workflow_runs SET status='succeeded' WHERE owner_id=?").bind(owner).run();
  const daily: string[] = [];
  for (let i = 0; i < 21; i++) { const r = await checkWorkflowRateLimit(c.env, owner); daily.push(r.ok ? "ok" : `no:${r.reason}`); }
  out.daily = { first20: daily.slice(0, 20).every((x) => x === "ok"), call21: daily[20] };
  return c.json(out);
});

harness.get("/h/eng/active", async (c) => {
  // 활성 30분: 31분 전에 시작한 think agent run → 첫 메시지에서 엔진이 실패로 닫는다 (DO에 제출하지 않음).
  const runId = `wr_t3active_${Date.now()}`;
  await seed(c.env, runId, [{ id: "a1", type: "agent", name: "에이전트", config: { goal: "시험", tools: ["create_task"], maxSteps: 4 } }], new Date(Date.now() - 31 * 60_000).toISOString());
  await c.env.PIPELINE.send(stepMessage(runId, 0));
  return c.json({ runId });
});

harness.get("/h/eng/llm", async (c) => {
  // LLM 30: 앞 단계에서 llm 노드 26개를 이미 썼다 → agent 단계 예산 4 (30 − 26) → Think DO가 llm_cap으로 멈춘다.
  // 그 뒤 llm 노드(#27)는 엔진이 LLM 노드 수(26)만 세므로 막히지 않는다 = T1 주의 1 남은 문제 (로컬은 Workers AI가 없어 그 노드는 실패로 끝난다).
  const runId = `wr_t3llm_${Date.now()}`;
  const steps: unknown[] = [];
  for (let i = 0; i < 26; i++) steps.push({ id: `l${i}`, type: "llm", name: `LLM ${i}`, config: { prompt: "x" } });
  steps.push({ id: "a1", type: "agent", name: "에이전트", config: { goal: "시험", tools: ["create_task", "create_calendar_event"], maxSteps: 10 } });
  steps.push({ id: "l27", type: "llm", name: "agent 뒤 LLM", config: { prompt: "agent 뒤" } });
  await seed(c.env, runId, steps);
  const now = new Date().toISOString();
  for (let i = 0; i < 26; i++) {
    await c.env.DB.prepare("INSERT INTO workflow_run_steps (run_id, step_index, node_type, node_name, status, output_json, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(runId, i, "llm", `LLM ${i}`, "succeeded", JSON.stringify({ text: "x" }), now, now).run();
  }
  await c.env.DB.prepare("UPDATE workflow_runs SET status='running', current_step=26 WHERE id=?").bind(runId).run();
  const a = await thinkOf(c.env, thinkAgentName(runId, 26));
  await a.hConfigure({ mockNodes: true, cycle: true, script: [{ tool: "create_task", input: { title: "교대 A" } }, { tool: "create_calendar_event", input: { title: "교대 B", start: "2026-11-21T09:00:00+09:00" } }] });
  await c.env.PIPELINE.send(stepMessage(runId, 26));
  return c.json({ runId });
});

harness.get("/h/eng/approval", async (c) => {
  // 승인 대기 표시 (항목 5·7 보조): think agent가 send_email을 고르면 실행 전에 막히고 run이 waiting_approval로 멈춘다 (발송 0).
  const runId = `wr_t3apr_${Date.now()}`;
  await seed(c.env, runId, [
    { id: "a1", type: "agent", name: "에이전트(메일)", config: { goal: "할 일을 만들고 박지영에게 확정 메일을 보내라", tools: ["create_task", "send_email"], maxSteps: 4 } },
  ]);
  const a = await thinkOf(c.env, thinkAgentName(runId, 0));
  await a.hConfigure({ mockNodes: true, script: [{ tool: "create_task", input: { title: "승인 시험" } }, { tool: "send_email", input: { to: "jy.park@example.com", subject: "확정", body: "확정합니다." } }, { text: "보냈습니다." }] });
  await c.env.PIPELINE.send(stepMessage(runId, 0));
  return c.json({ runId });
});
harness.get("/h/eng/think-sent", async (c) => {
  const s = (await (await thinkOf(c.env, thinkAgentName(c.req.query("id") ?? "", 0))).hState()) as Record<string, unknown>;
  return c.json({ sent: s.h_sent, exec: s.h_exec, stop: s.stop, pending: s.pending });
});

harness.get("/h/eng/run", async (c) => {
  const runId = c.req.query("id") ?? "";
  const st = await runState(c.env, runId);
  let think: unknown = null;
  const step = Number((st.agentRow as { step_index?: number } | null)?.step_index ?? -1);
  if (step >= 0) {
    const s = (await (await thinkOf(c.env, thinkAgentName(runId, step))).hState()) as Record<string, unknown>;
    think = { steps: s.steps, modelCalls: s.modelCalls, llmCalls: s.llmCalls, stop: s.stop, llmBudget: (s.job as { llmBudget?: number } | null)?.llmBudget, outcome: (s.outcome as { status?: string } | null)?.status };
  }
  return c.json({ ...st, think });
});

// ---- 원격 전용: 라이브 think 비교 run (항목 7) ----
// LIVE_WF의 워크플로를 그 소유자로 한 번 실행한다 = 화면의 "실행" 버튼(POST /api/workflows/:id/runs)과 같은 처리: 속도 제한 → createRun → 첫 단계 큐 투입.
// 큐는 운영 people-os-pipeline에 **생산자로만** 붙는다 (이 Worker에는 소비자가 없다) → 운영 Worker가 AGENT_RUNTIME=think로 처리한다.
harness.get("/h/live-run", async (c) => {
  const wfId = (c.env as unknown as { LIVE_WF?: string }).LIVE_WF;
  if (!wfId || c.req.query("wf") !== wfId) return c.json({ error: "LIVE_WF not set or mismatch" }, 403);
  const wf = await c.env.DB.prepare("SELECT id, owner_id FROM workflows WHERE id=?").bind(wfId).first<{ id: string; owner_id: string }>();
  if (!wf) return c.json({ error: "workflow not found" }, 404);
  const rl = await checkWorkflowRateLimit(c.env, wf.owner_id);
  if (!rl.ok) return c.json({ error: rl.reason }, 429);
  const { createRun } = await import("../../../../src/workflow/store");
  const run = await createRun(c.env.DB, wf.owner_id, wf.id, {});
  await c.env.PIPELINE.send(stepMessage(run.id, 0));
  return c.json({ runId: run.id, workflowId: wf.id });
});
harness.get("/h/live-state", async (c) => {
  const runId = c.req.query("run") ?? "";
  if (!/^wfrun_/.test(runId)) return c.json({ error: "bad run" }, 400);
  const run = await c.env.DB.prepare("SELECT id, workflow_id, status, current_step, error, started_at, finished_at FROM workflow_runs WHERE id=?").bind(runId).first();
  const { results: steps } = await c.env.DB.prepare("SELECT step_index, node_type, status, output_json, error, started_at, finished_at FROM workflow_run_steps WHERE run_id=? ORDER BY step_index").bind(runId).all();
  const agentRow = await c.env.DB.prepare("SELECT runtime, status, steps, llm_calls, submission_id, consumed_submission, created_at, updated_at FROM workflow_agent_steps WHERE run_id=?").bind(runId).first();
  const { results: approvals } = await c.env.DB.prepare("SELECT id, type, created_at FROM notifications WHERE ref_id=?").bind(runId).all();
  return c.json({ run, steps, agentRow, approvals });
});

harness.route("/api/agents", agentsApp);
harness.route("/api/obs", workflowRunsApp);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => harness.fetch(req, env, ctx),
  async queue(batch: MessageBatch<WorkflowStepMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body?.type === "workflow-step") await processWorkflowStep(env, msg.body);
        msg.ack();
      } catch (e) {
        console.log(`[t3h] message failed: ${String(e).slice(0, 300)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkflowStepMessage>;
