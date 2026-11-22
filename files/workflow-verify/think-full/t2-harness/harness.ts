// Think T2 하네스 (2026-11-20). 운영 코드를 그대로 import한다 — 여기서 고치는 것은 시험용 서브클래스뿐이다.
// - HarnessAssistantAgent: 운영 AssistantAgent에 (i) 대본대로 도구를 부르는 모의 모델(선택), (ii) 줄인 한도, (iii) 노드 실행 계수·모의 실행만 덧씌운다.
//   훅·한도 판정·이벤트·대화 저장 코드는 운영 클래스 것이 그대로 돈다.
// - /api/agents/* 는 운영 라우트(src/assistant/routes.ts agentsApp)를 그대로 마운트한다 (세션 쿠키 인증 포함).
// - 로컬(wrangler dev): D1·KV·DO 로컬, 모의 모델. 원격(people-os-t2-harness): 실제 Qwen + 실제 ask-pipeline (/h/real).
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import type { ThinkModel } from "@cloudflare/think";
import { AssistantAgent, assistantDoName, assistantIdFor, type AssistantLimits, type AssistantOwner, type TurnState } from "../../../../src/assistant/agent";
import { agentsApp } from "../../../../src/assistant/routes";
import { createSession } from "../../../../src/auth";
import { APPROVAL_REQUIRED_NODES, type Env, type NodeContext, type NodeResult, type NodeType } from "../../../../src/workflow/types";
export { AgentSession } from "../../../../src/agent-session";

type ScriptItem = { tool: string; input: Record<string, unknown> } | { text: string };
interface HCfg {
  script?: ScriptItem[]; // 없으면 실제 모델(Qwen)
  cycle?: boolean;
  mockNodes?: boolean;
  toolSleepMs?: number;
  limits?: Partial<AssistantLimits>;
}

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

export class HarnessAssistantAgent extends AssistantAgent {
  private hcfg(): HCfg { return this.kvGet<HCfg>("h_cfg", {}); }
  async hConfigure(cfg: HCfg) { this.kvPut("h_cfg", cfg); this.kvPut("h_calls", 0); return { ok: true }; }

  getModel(): ThinkModel {
    const cfg = this.hcfg();
    if (!cfg.script?.length) return super.getModel();
    const script = cfg.script;
    return new MockLanguageModelV4({
      doStream: async () => {
        const i = this.kvGet<number>("h_calls", 0);
        this.kvPut("h_calls", i + 1);
        const item = cfg.cycle ? script[i % script.length] : script[Math.min(i, script.length - 1)];
        const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
        if ("tool" in item) {
          chunks.push({ type: "tool-call", toolCallId: `call_${i}_${Date.now()}`, toolName: item.tool, input: JSON.stringify({ ...item.input, ...(item.tool === "create_task" ? { title: `${String(item.input.title ?? "할 일")} #${i}` } : {}) }) });
          chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE });
        } else {
          chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: item.text }, { type: "text-end", id: "t" });
          chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
        }
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 5 }) } as never;
      },
    }) as unknown as ThinkModel;
  }

  protected limits(): AssistantLimits {
    return { ...super.limits(), ...(this.hcfg().limits ?? {}) };
  }

  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    const cfg = this.hcfg();
    const log = this.kvGet<Array<{ tool: string; at: number; runId: string }>>("h_exec", []);
    log.push({ tool: type, at: Date.now(), runId: ctx.runId });
    this.kvPut("h_exec", log);
    if (cfg.toolSleepMs) await new Promise((r) => setTimeout(r, cfg.toolSleepMs));
    if (!cfg.mockNodes) return super.execNode(type, ctx, args);
    if ((APPROVAL_REQUIRED_NODES as string[]).includes(type)) this.kvPut("h_sent", this.kvGet<number>("h_sent", 0) + 1);
    if (type === "ask_rag" || type === "ask_personal") return { status: "succeeded", output: { answer: "(모의) 연차는 15일입니다.", sources: [{ title: "취업규칙 제20조" }], grounded: true } };
    return { status: "succeeded", output: { mock: true, tool: type, args } };
  }

  async hState() {
    return { ...(await this.inspectState()), h_calls: this.kvGet("h_calls", 0), h_exec: this.kvGet("h_exec", []), h_sent: this.kvGet("h_sent", 0), h_cfg: this.hcfg() };
  }
  async hAbort() {
    this.emit("abortRequested", {});
    this.ctx.abort("t2 harness kill");
  }
}

// ---------------------------------------------------------------------------

const harness = new Hono<{ Bindings: Env }>();
const userOf = (id: string): AssistantOwner => ({ id, email: `${id}@example.com`, role: "user", name: `T2 하네스 ${id}` });
const stubOf = async (env: Env, userId: string) =>
  (await getAgentByName(env.ASSISTANT_AGENT as unknown as DurableObjectNamespace<HarnessAssistantAgent>, assistantDoName(userId))) as unknown as HarnessAssistantAgent;

const TERMINAL = ["completed", "aborted", "skipped", "error"];
async function waitTurn(env: Env, userId: string, turnNo: number, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    let st: Record<string, unknown> | null = null;
    try { st = await (await stubOf(env, userId)).hState(); } catch { /* 강제 종료 직후 — 다시 붙는다 */ }
    const t = (st?.turns as TurnState[] | undefined)?.find((x) => x.turnNo === turnNo);
    if ((t && TERMINAL.includes(t.status)) || Date.now() - t0 > timeoutMs) return { ms: Date.now() - t0, turn: t ?? null, state: st };
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function brief(w: { ms: number; turn: TurnState | null; state: Record<string, unknown> | null }) {
  const t = w.turn;
  return {
    ms: w.ms, status: t?.status ?? null, stop: t?.stop ?? null, steps: t?.steps, llmCalls: t?.llmCalls, toolCalls: t?.toolCalls,
    recoveries: t?.recoveries, thinkingEmptySteps: t?.thinkingEmptySteps, thinkingSteps: t?.thinkingSteps,
    final: t?.final ? String(t.final).slice(0, 400) : null,
    exec: (w.state?.h_exec as Array<{ tool: string }> | undefined)?.map((e) => e.tool),
    submissions: (w.state?.submissions as Array<{ submissionId: string; status: string }> | undefined)?.map((x) => `${x.submissionId}=${x.status}`),
  };
}

// 원격 시험 창 (T0·T1과 같은 방식). 로컬은 OPEN_UNTIL이 없어 항상 열린다.
harness.use("*", async (c, next) => {
  const openUntil = (c.env as unknown as { OPEN_UNTIL?: string }).OPEN_UNTIL;
  if (openUntil !== undefined && !(Date.now() < Number(openUntil))) return c.json({ error: "closed" }, 403);
  return next();
});

// 로컬 전용: 시험 사용자 + 세션 쿠키 (운영 createSession 그대로)
harness.get("/h/session", async (c) => {
  const id = c.req.query("user") ?? "u_t2a";
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(id, `${id}@example.com`, `T2 ${id}`, "user", now).run();
  const setCookie = await createSession(c.env, id);
  return c.json({ id: assistantIdFor(id), cookie: setCookie.split(";")[0] });
});
harness.post("/h/config", async (c) => {
  const s = await stubOf(c.env, c.req.query("user") ?? "");
  return c.json(await s.hConfigure((await c.req.json()) as HCfg));
});
harness.get("/h/state", async (c) => c.json(await (await stubOf(c.env, c.req.query("user") ?? "")).hState()));
harness.get("/h/abort", async (c) => {
  try { await (await stubOf(c.env, c.req.query("user") ?? "")).hAbort(); return c.json({ killed: "returned" }); } catch (e) { return c.json({ killed: `threw: ${String(e).slice(0, 160)}` }); }
});
harness.get("/h/history", async (c) => {
  const u = c.req.query("user") ?? "";
  return c.json(await (await stubOf(c.env, u)).history({ userId: u }));
});
harness.get("/h/wait", async (c) => {
  const u = c.req.query("user") ?? "";
  return c.json(brief(await waitTurn(c.env, u, Number(c.req.query("turn") ?? 1), Number(c.req.query("timeout") ?? 60000))));
});

// 한도 (모의 모델, 운영 훅). kind: steps | llm | time | repeat | kill
harness.get("/h/limits", async (c) => {
  const kind = c.req.query("kind") ?? "steps";
  const user = `u_lim_${kind}_${Date.now()}`;
  const s = await stubOf(c.env, user);
  const ALT: ScriptItem[] = [{ tool: "create_task", input: { title: "교대 A" } }, { tool: "ask_rag", input: { question: "교대 B" } }];
  const ALT2: ScriptItem[] = [{ tool: "create_task", input: { title: "교대 A" } }, { tool: "summarize", input: { docId: "d1" } }];
  if (kind === "steps") await s.hConfigure({ mockNodes: true, cycle: true, script: ALT2 });
  else if (kind === "llm") await s.hConfigure({ mockNodes: true, cycle: true, script: ALT, limits: { llmCap: Number(c.req.query("cap") ?? 7) } }); // 운영 20은 10스텝 안에 못 닿는다(최대 15) → 시험값 7: 모델 스텝 + ask_rag 합계 7에서 멈춰야 한다
  else if (kind === "time") await s.hConfigure({ mockNodes: true, cycle: true, script: ALT2, toolSleepMs: 2000, limits: { timeoutMs: 5000 } });
  else if (kind === "repeat") await s.hConfigure({ mockNodes: true, cycle: true, script: [{ tool: "create_task", input: { title: "반복" } }] });
  else if (kind === "kill") await s.hConfigure({ mockNodes: true, cycle: true, script: ALT2, toolSleepMs: 2500 });
  else if (kind === "blocked") await s.hConfigure({ mockNodes: true, script: [{ tool: "send_email", input: { to: "a@example.com", subject: "s", body: "b" } }, { tool: "webhook", input: { url: "https://example.com" } }, { text: "초안까지만 만들 수 있습니다." }] });
  const sub = await s.send({ user: userOf(user), text: `한도 시험 ${kind}` });
  if (kind === "kill") {
    await new Promise((r) => setTimeout(r, Number(c.req.query("killAt") ?? 8000)));
    let killed = "returned";
    try { await s.hAbort(); } catch (e) { killed = `threw: ${String(e).slice(0, 120)}`; }
    const w = await waitTurn(c.env, user, sub.turnNo, 120000);
    return c.json({ kind, user, sub, killed, ...brief(w) });
  }
  const w = await waitTurn(c.env, user, sub.turnNo, 90000);
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  return c.json({ kind, user, sub, ...brief(w), events: ev.events.map((e) => `${e.ev}${e.data.tool ? `:${e.data.tool}` : ""}${e.data.reason ? `:${e.data.reason}` : ""}${e.data.why ? `:${e.data.why}` : ""}`), sent: (await s.hState()).h_sent });
});

// 원격 전용: 실제 모델 + 실제 노드(ask-pipeline). 세션 없이 DO RPC를 직접 부른다 (사용자 id는 시험용 합성 id).
harness.get("/h/real", async (c) => {
  const user = c.req.query("user") ?? "u_t2r";
  const text = c.req.query("text") ?? "연차 휴가는 1년에 며칠인가요?";
  const s = await stubOf(c.env, user);
  await s.hConfigure({});
  const sub = await s.send({ user: userOf(user), text });
  const w = await waitTurn(c.env, user, sub.turnNo, Number(c.req.query("timeout") ?? 170000));
  const ev = await s.events({ userId: user, after: 0, limit: 500 });
  return c.json({
    user, sub, ...brief(w),
    events: ev.events.filter((e) => e.turn === sub.turnNo).map((e) => ({ ev: e.ev, ...e.data })),
  });
});

// 운영 라우트 (세션 쿠키 인증 그대로)
harness.route("/api/agents", agentsApp);

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => harness.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
