// Think T3 남은 문제 6개 수정 하네스 (2026-11-21). 운영 코드를 그대로 import한다 — 여기서 고치는 것은 시험용 서브클래스뿐이다 (T3 하네스 패턴).
// - FixAssistantAgent: 운영 AssistantAgent + 대본 모의 모델(글을 여러 조각으로 천천히 흘린다 — 토큰 스트리밍 시험), 모의 노드, 조사 자식 교체, 하트비트 간격.
// - FixResearchAgent: 운영 ResearchAgent + 대본 모의 모델·모의 노드(느린 노드 가능 — 진행 이벤트 시험).
// - FixThinkAgent: T1 HarnessThinkAgent + 원격에서는 결과 전달(deliver)을 건너뛴다 (원격 시험 Worker에는 큐가 없고 운영 D1을 바인딩한다).
// - /api/agents/* 는 운영 agentsApp, /api/obs/* 는 운영 workflowRunsApp 그대로 (세션 쿠키 인증 포함). queue()는 운영 엔진 processWorkflowStep.
// 로컬:  npx wrangler dev --local --config files/workflow-verify/think-full/t3-fixes-harness/wrangler.toml --port 8831 --persist-to files/workflow-verify/think-full/t3-fixes-harness/state
// 원격:  cf-wrangler.py deploy --config files/workflow-verify/think-full/t3-fixes-harness/wrangler.remote.toml  (실제 Qwen + 실제 ask-pipeline)
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import type { ThinkModel } from "@cloudflare/think";
import { AssistantAgent, assistantDoName, assistantIdFor, type AssistantLimits, type AssistantOwner, type TurnState } from "../../../../src/assistant/agent";
import { ResearchAgent } from "../../../../src/assistant/research";
import { agentsApp } from "../../../../src/assistant/routes";
import { workflowRunsApp } from "../../../../src/obs/routes-workflows";
import { createSession } from "../../../../src/auth";
import { processWorkflowStep, resumeWorkflowRun, stepMessage } from "../../../../src/workflow/engine";
import { thinkAgentName, type ThinkStartInput } from "../../../../src/workflow/think-agent";
import { type Env, type NodeContext, type NodeResult, type NodeType, type WorkflowStepMessage } from "../../../../src/workflow/types";
import { HarnessThinkAgent } from "../t1-harness/harness";
export { AgentSession } from "../../../../src/agent-session";
export { WorkflowAgent } from "../../../../src/workflow/agent-do";

type ScriptItem = { tool: string; input: Record<string, unknown> } | { text: string };
interface ChildCfg { script?: ScriptItem[]; mockNodes?: boolean; nodeSleepMs?: number }
interface HCfg {
  script?: ScriptItem[]; // 없으면 실제 모델(Qwen)
  mockNodes?: boolean;
  limits?: Partial<AssistantLimits>;
  child?: ChildCfg;
  streamDelayMs?: number; // 모의 모델이 글 조각 사이에 쉬는 시간 (토큰 스트리밍 시험)
  pieceChars?: number;
  heartbeatTickMs?: number;
}

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function mockModel(script: ScriptItem[], next: () => number, delayMs = 5, pieceChars = 0): ThinkModel {
  return new MockLanguageModelV4({
    doStream: async () => {
      const i = next();
      const item = script[Math.min(i, script.length - 1)];
      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("tool" in item) {
        chunks.push({ type: "tool-call", toolCallId: `call_${i}_${Date.now()}`, toolName: item.tool, input: JSON.stringify(item.input) });
        chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE });
      } else {
        chunks.push({ type: "text-start", id: "t" });
        const n = pieceChars > 0 ? pieceChars : item.text.length;
        for (let k = 0; k < item.text.length; k += n) chunks.push({ type: "text-delta", id: "t", delta: item.text.slice(k, k + n) });
        chunks.push({ type: "text-end", id: "t" });
        chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
      }
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: delayMs }) } as never;
    },
  } as never) as unknown as ThinkModel;
}

export class FixResearchAgent extends ResearchAgent {
  private hc(): ChildCfg { return ((this.job()?.h ?? {}) as ChildCfg); }
  getModel(): ThinkModel {
    const c = this.hc();
    if (!c.script?.length) return super.getModel();
    return mockModel(c.script, () => { const i = this.kvGet<number>("h_calls", 0); this.kvPut("h_calls", i + 1); return i; });
  }
  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    const c = this.hc();
    if (c.nodeSleepMs) await new Promise((r) => setTimeout(r, c.nodeSleepMs));
    if (!c.mockNodes) return super.execNode(type, ctx, args);
    return { status: "succeeded", output: { answer: `(모의) ${String(args.question ?? "")} → 연차 15일, 경조사 본인 결혼 5일.`, sources: [{ title: "취업규칙 제20조" }], grounded: true } };
  }
  async hChildState() {
    return {
      steps: this.kvGet("steps", 0), llmCalls: this.kvGet("llmCalls", 0), toolCalls: this.kvGet("toolCalls", 0), tools: this.kvGet("tools", []),
      stopStored: this.kvGet("stop", null), selfFinished: this.kvGet("selfFinished", null), forced: this.kvGet("forced", null), final: this.kvGet<string | null>("final", null),
      output: this.getAgentToolOutput(""),
    };
  }
}

export class FixAssistantAgent extends AssistantAgent {
  private hcfg(): HCfg { return this.kvGet<HCfg>("h_cfg", {}); }
  async hConfigure(cfg: HCfg) { this.kvPut("h_cfg", cfg); this.kvPut("h_calls", 0); return { ok: true }; }
  getModel(): ThinkModel {
    const cfg = this.hcfg();
    if (!cfg.script?.length) return super.getModel();
    return mockModel(cfg.script, () => { const i = this.kvGet<number>("h_calls", 0); this.kvPut("h_calls", i + 1); return i; }, cfg.streamDelayMs ?? 5, cfg.pieceChars ?? 0);
  }
  protected limits(): AssistantLimits { return { ...super.limits(), ...(this.hcfg().limits ?? {}) }; }
  protected researchClass(): typeof ResearchAgent { return FixResearchAgent; }
  protected researchExtra() { const c = this.hcfg().child; return c ? { h: c } : {}; }
  protected researchHeartbeatTickMs(): number { return this.hcfg().heartbeatTickMs ?? super.researchHeartbeatTickMs(); }
  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    if (!this.hcfg().mockNodes) return super.execNode(type, ctx, args);
    return { status: "succeeded", output: { answer: "(모의) 연차는 15일입니다.", sources: [{ title: "취업규칙 제20조" }], grounded: true } };
  }
  async hState() { return { ...(await this.inspectState()), h_calls: this.kvGet("h_calls", 0), h_cfg: this.hcfg() }; }
  async hChild(runId: string) {
    const child = (await this.subAgent(FixResearchAgent, runId)) as unknown as { hChildState(): Promise<unknown> };
    return child.hChildState();
  }
}

/** 원격(REMOTE=1)에서는 결과 전달을 건너뛴다 — 큐가 없고 운영 D1을 바인딩하므로 workflow_agent_steps를 건드리지 않게. 로컬은 운영 deliver 그대로. */
export class FixThinkAgent extends HarnessThinkAgent {
  async deliver(p: { submissionId: string; attempt: number }): Promise<void> {
    if ((this.env as unknown as { REMOTE?: string }).REMOTE === "1") { this.log("deliverSkipped", { submissionId: p.submissionId }); return; }
    return super.deliver(p);
  }
}

// ---------------------------------------------------------------------------

const h = new Hono<{ Bindings: Env }>();
const userOf = (id: string): AssistantOwner => ({ id, email: `${id}@example.com`, role: "user", name: `T3fix ${id}` });
const stubOf = async (env: Env, userId: string) =>
  (await getAgentByName(env.ASSISTANT_AGENT as unknown as DurableObjectNamespace<FixAssistantAgent>, assistantDoName(userId))) as unknown as FixAssistantAgent;
const thinkOf = async (env: Env, name: string) =>
  (await getAgentByName(env.ThinkAgent as unknown as DurableObjectNamespace<FixThinkAgent>, name)) as unknown as FixThinkAgent;
const TERMINAL = ["completed", "aborted", "skipped", "error"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTurn(env: Env, userId: string, turnNo: number, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    let st: Record<string, unknown> | null = null;
    try { st = await (await stubOf(env, userId)).hState(); } catch { /* 재시작 직후 */ }
    const t = (st?.turns as TurnState[] | undefined)?.find((x) => x.turnNo === turnNo);
    if ((t && TERMINAL.includes(t.status)) || Date.now() - t0 > timeoutMs) return { ms: Date.now() - t0, turn: t ?? null };
    await sleep(1000);
  }
}
function evRow(e: { id: number; ts: number; ev: string; data: Record<string, unknown> }, t0: number) {
  const d = e.data;
  const keep: Record<string, unknown> = {};
  for (const k of ["tool", "status", "stop", "stoppedReason", "steps", "maxSteps", "source", "message", "elapsedMs", "llmCalls", "text", "thinking", "final"]) if (d[k] !== undefined && d[k] !== null && d[k] !== "") keep[k] = typeof d[k] === "string" ? String(d[k]).slice(0, 200) : d[k];
  return { id: e.id, at: e.ts - t0, ev: e.ev, ...keep };
}

h.use("*", async (c, next) => {
  const openUntil = (c.env as unknown as { OPEN_UNTIL?: string }).OPEN_UNTIL;
  if (openUntil !== undefined && !(Date.now() < Number(openUntil))) return c.json({ error: "closed" }, 403);
  return next();
});

// 로컬 전용: 시험 사용자 + 세션 쿠키 (운영 createSession 그대로).
h.get("/h/session", async (c) => {
  if ((c.env as unknown as { REMOTE?: string }).REMOTE === "1") return c.json({ error: "local only" }, 403);
  const id = c.req.query("user") ?? "u_fx_a";
  const role = c.req.query("role") === "hr_admin" ? "hr_admin" : "user";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `T3fix ${id}`, role, now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id: assistantIdFor(id), cookie: setCookie.split(";")[0] });
});
h.get("/h/state", async (c) => c.json(await (await stubOf(c.env, c.req.query("user") ?? "")).hState()));

// ---- 고침 2 (로컬, 모의 모델): 긴 답을 0.3초 간격 조각으로 흘린다. 이 요청은 제출 → (턴 진행 중) 이벤트 읽기를 반복해 시간표를 남긴다. ----
h.get("/h/stream-start", async (c) => {
  const user = c.req.query("user") ?? "u_fx_a";
  const s = await stubOf(c.env, user);
  const text = "연차 휴가는 1년 이상 근속하면 15일이 주어지고, 2년마다 1일씩 늘어 최대 25일까지 받을 수 있습니다. 입사 첫해에는 한 달 개근마다 1일씩 생깁니다. (출처: 『연차휴가』 제12조)";
  await s.hConfigure({ mockNodes: true, streamDelayMs: Number(c.req.query("delay") ?? 300), pieceChars: 8, script: [{ tool: "ask_rag", input: { question: "연차 일수" } }, { text }] });
  const sub = await s.send({ user: userOf(user), text: "연차 휴가는 1년에 며칠인가요?" });
  return c.json({ sub, expectedChars: text.length });
});
h.get("/h/stream-timeline", async (c) => {
  // 같은 턴을 0.5초마다 JSON으로 읽어 (경과 시각, 그때까지 받은 delta 수·글자 수, 턴 상태)를 남긴다 — "턴이 끝나기 전에 조각이 도착했는가".
  const user = c.req.query("user") ?? "u_fx_a";
  const turnNo = Number(c.req.query("turn") ?? 1);
  const s = await stubOf(c.env, user);
  const t0 = Date.now();
  const rows: Array<{ ms: number; turnStatus: string | null; deltas: number; chars: number; lastEv: string | null }> = [];
  let after = Number(c.req.query("after") ?? 0);
  let deltas = 0, chars = 0;
  for (let i = 0; i < 120; i++) {
    const r = await s.events({ userId: user, after });
    for (const e of r.events) if (e.turn === turnNo && e.ev === "delta") { deltas++; chars += String(e.data.text ?? "").length; }
    after = r.cursor;
    const st = r.latestTurn?.status ?? null;
    rows.push({ ms: Date.now() - t0, turnStatus: st, deltas, chars, lastEv: r.events.length ? r.events[r.events.length - 1].ev : null });
    if (st && TERMINAL.includes(st)) break;
    await sleep(500);
  }
  const all = await s.events({ userId: user, after: 0, limit: 500 });
  const turnEv = all.events.filter((e) => e.turn === turnNo);
  const end = turnEv.find((e) => e.ev === "turnEnd");
  const ds = turnEv.filter((e) => e.ev === "delta");
  return c.json({
    rows, deltaEvents: ds.length, firstDeltaBeforeEndMs: end && ds.length ? end.ts - ds[0].ts : null,
    deltasBeforeEnd: end ? ds.filter((e) => e.ts < end.ts).length : null,
    joined: ds.map((e) => String(e.data.text ?? "")).join(""),
    events: turnEv.map((e) => evRow(e, turnEv[0]?.ts ?? 0)),
  });
});

// ---- 고침 5·6 (로컬, 모의 모델): 조사 위임. mode=complete | maxsteps | slow | heartbeat ----
h.get("/h/research-local", async (c) => {
  const mode = c.req.query("mode") ?? "complete";
  const user = c.req.query("user") ?? `u_fx_res_${mode}_${Date.now()}`;
  const s = await stubOf(c.env, user);
  const q = (n: number) => ({ tool: "ask_rag", input: { question: `조사 질문 ${n}` } });
  const summary = { text: "정리: 연차 15일(취업규칙 제20조), 경조사 본인 결혼 5일(경조사 규정 제3조)." };
  const child: ChildCfg =
    mode === "complete" ? { mockNodes: true, script: [q(1), q(2), q(3), summary] } // 4스텝째(상한 4)에 정리를 쓰고 스스로 끝냄
    : mode === "maxsteps" ? { mockNodes: true, script: [q(1), q(2), q(3), q(4), q(5)] } // 끝까지 도구만 부름 → 상한
    : mode === "slow" ? { mockNodes: true, nodeSleepMs: 12_000, script: [q(1), q(2), summary] } // 도구 12초 × 2
    : { mockNodes: true, nodeSleepMs: 40_000, script: [q(1), summary] }; // heartbeat: 도구 1개가 40초 (자식 신호 공백)
  await s.hConfigure({
    mockNodes: true, child,
    script: [{ tool: "research", input: { topic: `연차·경조사 휴가 비교 (${mode})` } }, { text: "조사 결과를 바탕으로 정리했습니다." }],
  });
  const sub = await s.send({ user: userOf(user), text: "연차와 경조사 휴가 규정을 비교해 정리해 줘" });
  const w = await waitTurn(c.env, user, sub.turnNo, 150_000);
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  const turnEv = ev.events.filter((e) => e.turn === sub.turnNo);
  const rs = turnEv.find((e) => e.ev === "researchStart");
  const re = turnEv.find((e) => e.ev === "researchEnd");
  const prog = turnEv.filter((e) => e.ev === "researchProgress");
  const gaps: number[] = [];
  if (rs && re) {
    const marks = [rs.ts, ...prog.map((e) => e.ts), re.ts];
    for (let i = 1; i < marks.length; i++) gaps.push(marks[i] - marks[i - 1]);
  }
  return c.json({
    user, mode, turn: { status: w.turn?.status, stop: w.turn?.stop, steps: w.turn?.steps, llmCalls: w.turn?.llmCalls, ms: w.ms },
    researchEnd: re?.data ?? null, child: rs ? await s.hChild(String(rs.data.runId)) : null,
    researchMs: rs && re ? re.ts - rs.ts : null, progressCount: prog.length, firstProgressAfterStartMs: rs && prog.length ? prog[0].ts - rs.ts : null,
    maxGapMs: gaps.length ? Math.max(...gaps) : null, gaps,
    events: turnEv.map((e) => evRow(e, rs?.ts ?? turnEv[0]?.ts ?? 0)),
  });
});

// ---- 원격 전용: 실제 Qwen(부모·자식) + 실제 ask-pipeline. 고침 2(실제 스트리밍)·3(한국어 thinking)·5·6 확인 ----
// /h/real-start: 제출만 하고 바로 돌려준다 (긴 턴은 요청이 중간에서 끊길 수 있다 — 결과는 /h/report로 읽는다).
h.get("/h/real-start", async (c) => {
  const user = c.req.query("user") ?? "u_t3fx_r";
  const text = c.req.query("text") ?? "연차 휴가와 경조사 휴가 규정을 조사 담당에게 맡겨 비교 정리해 줘";
  const s = await stubOf(c.env, user);
  await s.hConfigure({});
  return c.json({ user, sub: await s.send({ user: userOf(user), text }) });
});
h.get("/h/report", async (c) => {
  const user = c.req.query("user") ?? "u_t3fx_r";
  const s = await stubOf(c.env, user);
  const st = (await s.hState()) as unknown as { turnSeq: number; turns: TurnState[] };
  const n = Number(c.req.query("turn") ?? st.turnSeq);
  return c.json(await turnReport(s, user, n, { ms: null, turn: (st.turns ?? []).find((x) => x.turnNo === n) ?? null }, null));
});
async function turnReport(s: FixAssistantAgent, user: string, turnNo: number, w: { ms: number | null; turn: TurnState | null }, sub: unknown) {
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  const turnEv = ev.events.filter((e) => e.turn === turnNo);
  const t0 = turnEv[0]?.ts ?? 0;
  const end = turnEv.find((e) => e.ev === "turnEnd");
  const ds = turnEv.filter((e) => e.ev === "delta");
  const rs = turnEv.filter((e) => e.ev === "researchStart");
  const prog = turnEv.filter((e) => e.ev === "researchProgress");
  const children = [];
  for (const r of rs) children.push(await s.hChild(String(r.data.runId)));
  const re = turnEv.find((e) => e.ev === "researchEnd");
  const marks = rs.length && re ? [rs[0].ts, ...prog.map((e) => e.ts), re.ts] : [];
  const gaps = marks.slice(1).map((x, i) => x - marks[i]);
  return {
    user, sub, turn: w.turn, ms: w.ms,
    streaming: { deltaEvents: ds.length, deltasBeforeEnd: end ? ds.filter((e) => e.ts < end.ts).length : null, firstDeltaAt: ds.length ? ds[0].ts - t0 : null, endAt: end ? end.ts - t0 : null, joined: ds.map((e) => String(e.data.text ?? "")).join("").slice(0, 1500) },
    research: { progressCount: prog.length, firstProgressAfterStartMs: rs.length && prog.length ? prog[0].ts - rs[0].ts : null, maxGapMs: gaps.length ? Math.max(...gaps) : null, gaps },
    thinking: turnEv.filter((e) => e.ev === "step").map((e) => String(e.data.thinking ?? "")),
    children,
    events: turnEv.filter((e) => e.ev !== "delta").map((e) => evRow(e, t0)),
  };
}
h.get("/h/real", async (c) => {
  const user = c.req.query("user") ?? "u_t3fx_r";
  const text = c.req.query("text") ?? "연차 휴가와 경조사 휴가 규정을 조사 담당에게 맡겨 비교 정리해 줘";
  const s = await stubOf(c.env, user);
  await s.hConfigure({});
  const sub = await s.send({ user: userOf(user), text });
  const w = await waitTurn(c.env, user, sub.turnNo, Number(c.req.query("timeout") ?? 280_000));
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  const turnEv = ev.events.filter((e) => e.turn === sub.turnNo);
  const t0 = turnEv[0]?.ts ?? 0;
  const end = turnEv.find((e) => e.ev === "turnEnd");
  const ds = turnEv.filter((e) => e.ev === "delta");
  const rs = turnEv.filter((e) => e.ev === "researchStart");
  const children = [];
  for (const r of rs) children.push(await s.hChild(String(r.data.runId)));
  return c.json({
    user, sub, turn: w.turn, ms: w.ms,
    streaming: { deltaEvents: ds.length, deltasBeforeEnd: end ? ds.filter((e) => e.ts < end.ts).length : null, firstDeltaAt: ds.length ? ds[0].ts - t0 : null, endAt: end ? end.ts - t0 : null, joined: ds.map((e) => String(e.data.text ?? "")).join("").slice(0, 1500) },
    thinking: turnEv.filter((e) => e.ev === "step").map((e) => String(e.data.thinking ?? "")),
    children,
    events: turnEv.filter((e) => e.ev !== "delta").map((e) => evRow(e, t0)),
  });
});

// 원격 전용: 워크플로 agent(ThinkAgent) 실제 Qwen 1단계 — 판단 근거(thinking) 언어 확인 (고침 3). 결과 전달은 건너뛴다 (FixThinkAgent).
h.get("/h/real-wf", async (c) => {
  const runId = `wr_t3fx_${Date.now()}`;
  const goal = c.req.query("goal") ?? "회사 규정에서 연차 휴가가 1년에 며칠인지 찾아 한 문장으로 정리해라.";
  const tools = (c.req.query("tools") ?? "ask_rag").split(",") as ThinkStartInput["tools"];
  const a = await thinkOf(c.env, thinkAgentName(runId, 0));
  await a.hConfigure({});
  const job: ThinkStartInput = {
    runId, workflowId: "wf_t3fx", stepIndex: 0, stepName: "에이전트", user: { id: "u_t3fx_w", email: "u_t3fx_w@example.com", role: "user" },
    input: {}, stepOutputs: {}, goal, tools, maxSteps: 4, gatedAll: false, llmBudget: 30, activeSinceMs: Date.now(),
  };
  const r = await a.startStep(job);
  const t0 = Date.now();
  let st = (await a.hState()) as Record<string, unknown>;
  while (Date.now() - t0 < 200_000 && !st.outcome) { await sleep(1500); st = (await a.hState()) as Record<string, unknown>; }
  const o = st.outcome as { status?: string; result?: Record<string, unknown> } | null;
  return c.json({
    runId, submit: r, ms: Date.now() - t0, outcome: o?.status ?? null, final: o?.result?.final ?? null, steps: st.steps, llmCalls: st.llmCalls,
    turns: ((st.turns as Array<Record<string, unknown>>) ?? []).map((t) => ({ turn: t.turn, action: t.action, tool: t.tool, thinking: t.thinking, final: t.final })),
  });
});

// ---- 고침 1·4 (로컬): 엔진 ----
const EUSER = { id: "u_fx_eng", email: "fxeng@example.com", name: "T3fix 엔진", role: "user" };
async function seed(env: Env, runId: string, steps: unknown[], owner = EUSER.id) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(EUSER.id, EUSER.email, EUSER.name, EUSER.role, now).run();
  const wfId = `wf_${runId}`;
  await env.DB.prepare("INSERT INTO workflows (id, owner_id, name, status, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(wfId, owner, `T3fix ${runId}`, "active", JSON.stringify({ version: 1, steps }), now, now).run();
  await env.DB.prepare("INSERT INTO workflow_runs (id, workflow_id, owner_id, status, input_json, current_step, started_at) VALUES (?,?,?,'queued','{}',0,?)")
    .bind(runId, wfId, owner, now).run();
}
async function prefillLlm(env: Env, runId: string, n: number) {
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO workflow_run_steps (run_id, step_index, node_type, node_name, status, output_json, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(runId, i, "llm", `LLM ${i}`, "succeeded", JSON.stringify({ text: "x" }), now, now).run();
  }
  await env.DB.prepare("UPDATE workflow_runs SET status='running', current_step=? WHERE id=?").bind(n, runId).run();
}

// prior=26: llm 26개를 이미 썼다 → agent 예산 4 → agent가 4를 다 쓰면 합계 30 → 뒤 llm 노드(#27)는 엔진 8번에서 막혀야 한다.
// prior=20 + agentScript=short: 합계 22 → 뒤 llm 노드는 막히면 안 된다 (과잉 차단 없음 대조군).
h.get("/h/eng/llm", async (c) => {
  const prior = Number(c.req.query("prior") ?? 26);
  const short = c.req.query("agent") === "short";
  const runId = `wr_fxllm${prior}${short ? "s" : ""}_${Date.now()}`;
  const steps: unknown[] = [];
  for (let i = 0; i < prior; i++) steps.push({ id: `l${i}`, type: "llm", name: `LLM ${i}`, config: { prompt: "x" } });
  steps.push({ id: "a1", type: "agent", name: "에이전트", config: { goal: "시험", tools: ["create_task", "create_calendar_event"], maxSteps: 10 } });
  steps.push({ id: "lz", type: "llm", name: "agent 뒤 LLM", config: { prompt: "agent 뒤" } });
  await seed(c.env, runId, steps);
  await prefillLlm(c.env, runId, prior);
  const a = await thinkOf(c.env, thinkAgentName(runId, prior));
  await a.hConfigure(short
    ? { mockNodes: true, script: [{ tool: "create_task", input: { title: "대조" } }, { text: "끝" }] }
    : { mockNodes: true, cycle: true, script: [{ tool: "create_task", input: { title: "교대 A" } }, { tool: "create_calendar_event", input: { title: "교대 B", start: "2026-11-21T09:00:00+09:00" } }] });
  await c.env.PIPELINE.send(stepMessage(runId, prior));
  return c.json({ runId, agentStep: prior, afterStep: prior + 1 });
});

// 고침 4: agent(ask_rag 1회, 도구 3초) → create_task. 끝나면 관측 API가 llm_calls 3(모델 2 + ask_rag 1), duration ≈ 실제 시간(수 초)을 보여야 한다.
h.get("/h/eng/obs", async (c) => {
  const runId = `wr_fxobs_${Date.now()}`;
  await seed(c.env, runId, [
    { id: "a1", type: "agent", name: "에이전트(근거)", config: { goal: "연차 규정을 찾아 정리", tools: ["ask_rag"], maxSteps: 4 } },
    { id: "t2", type: "create_task", name: "후속 할 일", config: { title: "관측 시험 후속" } },
  ]);
  const a = await thinkOf(c.env, thinkAgentName(runId, 0));
  await a.hConfigure({ mockNodes: true, toolSleepMs: 3000, script: [{ tool: "ask_rag", input: { question: "연차 일수" } }, { text: "연차는 15일입니다." }] });
  await c.env.PIPELINE.send(stepMessage(runId, 0));
  return c.json({ runId });
});

// 동기식 회귀 (엔진 7번·승인 재개 경로): think agent가 send_email을 고르면 승인 대기 → 승인 → 1회 실행 → run 성공.
h.get("/h/eng/sync", async (c) => {
  const runId = `wr_fxsync_${Date.now()}`;
  await seed(c.env, runId, [{ id: "a1", type: "agent", name: "에이전트(메일)", config: { goal: "확정 메일을 보내라", tools: ["send_email"], maxSteps: 4 } }]);
  const a = await thinkOf(c.env, thinkAgentName(runId, 0));
  await a.hConfigure({ mockNodes: true, script: [{ tool: "send_email", input: { to: "jy.park@example.com", subject: "확정", body: "확정합니다." } }, { text: "승인 후 발송했습니다." }] });
  await c.env.PIPELINE.send(stepMessage(runId, 0));
  return c.json({ runId });
});
h.get("/h/eng/approve", async (c) => c.json(await resumeWorkflowRun(c.env, c.req.query("id") ?? "")));

h.get("/h/eng/run", async (c) => {
  const runId = c.req.query("id") ?? "";
  const run = await c.env.DB.prepare("SELECT status, current_step, error FROM workflow_runs WHERE id=?").bind(runId).first();
  const { results: steps } = await c.env.DB.prepare(
    "SELECT step_index, node_type, status, substr(output_json,1,200) AS out, error, started_at, finished_at FROM workflow_run_steps WHERE run_id=? AND (step_index >= 19 OR node_type != 'llm') ORDER BY step_index",
  ).bind(runId).all();
  const agentRow = await c.env.DB.prepare("SELECT step_index, runtime, status, steps, llm_calls, created_at, updated_at, consumed_submission FROM workflow_agent_steps WHERE run_id=?").bind(runId).first<Record<string, unknown>>();
  let think: unknown = null;
  if (agentRow) {
    const s = (await (await thinkOf(c.env, thinkAgentName(runId, Number(agentRow.step_index)))).hState()) as Record<string, unknown>;
    think = { steps: s.steps, modelCalls: s.modelCalls, llmCalls: s.llmCalls, stop: s.stop, llmBudget: (s.job as { llmBudget?: number } | null)?.llmBudget, outcome: (s.outcome as { status?: string } | null)?.status, sent: s.h_sent, turns: Array.isArray(s.turns) ? s.turns.length : null };
  }
  return c.json({ run, steps, agentRow, think });
});

h.route("/api/agents", agentsApp);
h.route("/api/obs", workflowRunsApp);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => h.fetch(req, env, ctx),
  async queue(batch: MessageBatch<WorkflowStepMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body?.type === "workflow-step") await processWorkflowStep(env, msg.body);
        msg.ack();
      } catch (e) {
        console.log(`[t3fx] message failed: ${String(e).slice(0, 300)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkflowStepMessage>;
