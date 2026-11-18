// WF-6 에이전트 루프 DO (2026-11-18). 제안서 4.2.1.
// 인스턴스 1개 = run 1개의 agent 단계 1개 (id = idFromName(`agent:<runId>:<stepIndex>`)).
// DO는 "지금 몇 턴째인지, 무엇을 골랐고 무엇이 나왔는지"만 든다. 도구 실행·D1 기록·큐는 엔진(agent.ts)이 한다.
//
// 직렬화: DO는 인스턴스가 하나뿐이지만, Qwen3 호출처럼 storage가 아닌 await 동안에는 다른 요청이 끼어들 수 있다
// (input gate는 storage 연산만 막는다). 그래서 모든 변경 요청을 인스턴스 안의 promise 체인(serial)으로 한 줄로 세운다.
// → 같은 run의 턴이 동시에 두 번 돌지 않는다.
//
// 멱등성(턴 번호 가드): advance는 turn 번호를 받는다. 이미 기록된 턴(turn < turns.length)이면 state를 바꾸지 않고
// 저장된 결정을 replay:true로 돌려준다. 이미 끝난 루프(done)면 저장된 최종 결과를 그대로 돌려준다.
//
// 멈춤 원칙: 목표에 도달하지 못했어도, 멈춤 자체는 정상 종료다 (max_steps / repeat_tool / timeout / llm_cap → 단계 성공).
// 모델이 도구 선택을 못 하는 경우(JSON 파싱 실패 3연속)만 실패로 끝낸다 (tool_selection_failed).
import { LLM_MODEL, responseText } from "../ask-pipeline";
import { aiGatewayOptions } from "../ai-gateway";
import { NODE_REGISTRY, extractJson } from "./nodes";
import { TOOL_NODE_TYPES, type Env, type ToolNodeType } from "./types";

export const AGENT_LLM_CAP = 20; // 이 agent 단계 안의 도구 선택 호출 상한 (run 전체 30회 캡과 별개)
// WF-11: 28분. 엔진의 run 활성 시간 상한(30분)보다 먼저 걸리게 해서, 30분에 걸린 agent run이 엔진 실패("실행 시간 상한")가
// 아니라 에이전트의 "정상 멈춤"(stopped: timeout, 지금까지의 관찰로 마무리)으로 끝나게 한다. 엔진이 넘겨준 활성 시작 시각부터 잰다.
export const AGENT_TIMEOUT_MS = 28 * 60 * 1000;
export const AGENT_REPEAT_LIMIT = 3;
export const AGENT_PARSE_FAIL_LIMIT = 3;
const HISTORY_TURNS = 10;
const OBS_MAX = 1500;
const CTX_MAX = 3000;

export type StopReason = "max_steps" | "repeat_tool" | "timeout" | "llm_cap" | "tool_selection_failed";

export interface AgentTurn {
  turn: number;
  thinking: string;
  action: "tool" | "finish" | "invalid";
  tool?: ToolNodeType;
  args?: Record<string, unknown>;
  final?: string;
  observation?: string;
  error?: string;
  at: string;
}

export interface PendingAction { turn: number; tool: ToolNodeType; args: Record<string, unknown>; thinking: string }

export type AdvanceResult =
  | { status: "tool"; turn: number; tool: ToolNodeType; args: Record<string, unknown>; thinking: string; replay?: boolean; observed?: boolean; nextTurn: number }
  | { status: "invalid"; turn: number; error: string; replay?: boolean; nextTurn: number }
  | { status: "finish"; final: string; thinking: string; turns: AgentTurn[]; replay?: boolean }
  | { status: "stopped"; reason: StopReason; final: string; turns: AgentTurn[]; replay?: boolean };

export interface AdvanceInput {
  turn?: number;
  goal: string;
  tools: ToolNodeType[];
  maxSteps: number;
  runInput: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  /** 엔진이 계산한 활성 시작 시각 (run 시작 또는 마지막 승인 중 늦은 것, ms) */
  activeSinceMs: number;
}

type Msg = { role: "system" | "user"; content: string };

const SYSTEM_PROMPT = `너는 People OS 워크플로우 안에서 일하는 에이전트다. 사용자가 준 목표에 다가가기 위해, 매 턴마다 다음 행동 하나를 고른다.
규칙:
(a) 한 번에 도구 하나만 고른다. 도구는 아래 "쓸 수 있는 도구" 목록에 있는 이름만 쓸 수 있다.
(b) 목표에 도달했으면 action을 "finish"로 하고 final에 최종 답을 쓴다.
(c) 같은 도구를 반복해서 부르지 않는다. 이미 얻은 관찰 결과를 다시 얻으려고 같은 도구를 부르지 마라.
(d) 모르면 추측하지 말고 action "finish"로 final에 "할 수 없다"고 이유와 함께 밝힌다.
(e) 출력은 반드시 JSON 객체 하나만 쓴다. 설명·마크다운·코드펜스를 붙이지 않는다.
action 필드에는 반드시 "tool" 또는 "finish" 중 하나만 쓴다. 도구 이름은 action이 아니라 tool 필드에 쓴다.
도구를 고를 때 예시: {"thinking": "…", "action": "tool", "tool": "create_task", "args": {"title": "…", "dueDate": "…"}}
끝낼 때 예시: {"thinking": "…", "action": "finish", "final": "…"}`;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function asText(v: unknown, n: number): string {
  if (v === undefined) return "";
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return clip(s ?? "", n);
}

/** 모델 응답을 한 턴의 결정으로. 실패하면 error 문자열. */
export function parseDecision(raw: string, tools: ToolNodeType[]):
  | { ok: true; thinking: string; action: "tool"; tool: ToolNodeType; args: Record<string, unknown> }
  | { ok: true; thinking: string; action: "finish"; final: string }
  | { ok: false; error: string; thinking: string } {
  let j: Record<string, unknown>;
  try {
    j = extractJson(raw.replace(/<think>[\s\S]*?<\/think>/g, ""));
  } catch (e) {
    return { ok: false, error: `JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`, thinking: "" };
  }
  const thinking = clip(typeof j.thinking === "string" ? j.thinking : "", 1000);
  if (j.action === "finish") {
    const final = typeof j.final === "string" && j.final.trim() ? j.final.trim() : "";
    if (!final) return { ok: false, error: "finish인데 final이 비어 있습니다.", thinking };
    return { ok: true, thinking, action: "finish", final: clip(final, 4000) };
  }
  // 모델이 action에 도구 이름을 쓰는 경우(실제 Qwen3 출력)를 관용한다: action이 허용된 도구 이름이면 tool 호출로 본다.
  const actionIsTool = typeof j.action === "string" && j.action !== "tool" && (tools as string[]).includes(j.action);
  if (j.action === "tool" || actionIsTool) {
    const validTool = (v: unknown): v is string => typeof v === "string" && (tools as string[]).includes(v);
    const tool = actionIsTool ? (validTool(j.tool) ? j.tool : j.action) : j.tool;
    if (!validTool(tool)) {
      return { ok: false, error: `쓸 수 없는 도구입니다: ${String(tool)}`, thinking };
    }
    const args = j.args && typeof j.args === "object" && !Array.isArray(j.args) ? (j.args as Record<string, unknown>) : {};
    return { ok: true, thinking, action: "tool", tool: tool as ToolNodeType, args };
  }
  return { ok: false, error: `action이 올바르지 않습니다: ${String(j.action)}`, thinking };
}

export function buildMessages(inp: AdvanceInput, turns: AgentTurn[]): Msg[] {
  const toolLines = inp.tools
    .filter((t) => (TOOL_NODE_TYPES as string[]).includes(t))
    .map((t) => `- ${t}: ${NODE_REGISTRY[t].description} (입력 키: ${NODE_REGISTRY[t].inputKeys.join(", ") || "없음"})`)
    .join("\n");
  const history = turns.slice(-HISTORY_TURNS).map((t) => {
    const lines = [`[턴 ${t.turn + 1}] 생각: ${t.thinking || "-"}`];
    if (t.action === "tool") lines.push(`행동: ${t.tool} ${asText(t.args ?? {}, 500)}`);
    else if (t.action === "invalid") lines.push(`행동: (형식 오류) ${t.error ?? ""}`);
    if (t.observation !== undefined) lines.push(`관찰: ${t.observation}`);
    else if (t.action === "tool" && t.error) lines.push(`관찰: (실패) ${t.error}`);
    return lines.join("\n");
  }).join("\n\n");
  const content = [
    `목표:\n${inp.goal}`,
    `쓸 수 있는 도구:\n${toolLines}`,
    `run 입력: ${asText(inp.runInput ?? {}, CTX_MAX)}`,
    `앞 단계 출력: ${asText(inp.stepOutputs ?? {}, CTX_MAX)}`,
    `지금까지의 기록 (최근 ${HISTORY_TURNS}턴):\n${history || "(없음 — 첫 턴)"}`,
    `남은 턴: ${Math.max(inp.maxSteps - turns.length, 0)}. 다음 행동을 JSON 하나로만 답하라.`,
  ].join("\n\n");
  return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content }];
}

function stopFinal(reason: StopReason, turns: AgentTurn[]): string {
  const label: Record<StopReason, string> = {
    max_steps: "최대 단계 수에 도달",
    repeat_tool: "같은 도구를 3번 연속으로 호출",
    timeout: "실행 시간 상한(30분)에 도달",
    llm_cap: `도구 선택 LLM 호출 상한(${AGENT_LLM_CAP}회)에 도달`,
    tool_selection_failed: "모델이 도구 선택 형식을 3번 연속으로 지키지 못함",
  };
  const last = [...turns].reverse().find((t) => t.observation !== undefined);
  return `목표에 도달하기 전에 멈췄습니다: ${label[reason]}.${last ? ` 마지막 관찰: ${clip(last.observation ?? "", 500)}` : ""}`;
}

export class WorkflowAgent {
  state: DurableObjectState;
  env: Env;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** 이 인스턴스 안에서 요청을 한 줄로 세운다 (앞 요청이 끝나야 다음 요청이 시작). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** 도구 선택 모델 호출. 하네스가 이 메서드만 바꿔 mock 응답을 넣는다. */
  protected async callModel(messages: Msg[]): Promise<string> {
    const out = await this.env.AI.run(LLM_MODEL as keyof AiModels, { messages, reasoning_effort: "medium" } as never, aiGatewayOptions({ tag: "workflow-agent" }));
    return responseText(out);
  }

  private async load() {
    const m = await this.state.storage.get<unknown>(["turns", "lastTools", "pendingAction", "startedAt", "llmCalls", "parseFailures", "done"]);
    return {
      turns: (m.get("turns") as AgentTurn[] | undefined) ?? [],
      lastTools: (m.get("lastTools") as string[] | undefined) ?? [],
      pendingAction: (m.get("pendingAction") as PendingAction | null | undefined) ?? null,
      startedAt: (m.get("startedAt") as string | undefined) ?? null,
      llmCalls: (m.get("llmCalls") as number | undefined) ?? 0,
      parseFailures: (m.get("parseFailures") as number | undefined) ?? 0,
      done: (m.get("done") as AdvanceResult | undefined) ?? null,
    };
  }

  async advance(inp: AdvanceInput): Promise<AdvanceResult> {
    const s = await this.load();
    if (s.done) return { ...s.done, replay: true } as AdvanceResult;

    // 턴 번호 가드: 이미 기록된 턴이면 저장된 결정을 그대로 돌려준다 (state 변경 없음).
    if (typeof inp.turn === "number" && inp.turn < s.turns.length) {
      const t = s.turns[inp.turn];
      if (t.action === "tool" && t.tool) {
        return { status: "tool", turn: t.turn, tool: t.tool, args: t.args ?? {}, thinking: t.thinking, replay: true, observed: t.observation !== undefined, nextTurn: s.turns.length };
      }
      return { status: "invalid", turn: t.turn, error: t.error ?? "", replay: true, nextTurn: s.turns.length };
    }

    const stop = async (reason: StopReason): Promise<AdvanceResult> => {
      const r: AdvanceResult = { status: "stopped", reason, final: stopFinal(reason, s.turns), turns: s.turns };
      await this.state.storage.put("done", r);
      return r;
    };
    if (!s.startedAt) await this.state.storage.put("startedAt", new Date().toISOString());

    // 멈춤 조건 (모델을 부르기 전에 먼저 본다)
    if (s.turns.length >= inp.maxSteps) return stop("max_steps");
    const last = s.lastTools.slice(-AGENT_REPEAT_LIMIT);
    if (last.length === AGENT_REPEAT_LIMIT && last.every((t) => t === last[0])) return stop("repeat_tool");
    if (Date.now() - inp.activeSinceMs > AGENT_TIMEOUT_MS) return stop("timeout");
    if (s.llmCalls >= AGENT_LLM_CAP) return stop("llm_cap");

    // ReAct 선택
    await this.state.storage.put("llmCalls", s.llmCalls + 1);
    let raw = "";
    let callError: string | null = null;
    try {
      raw = await this.callModel(buildMessages(inp, s.turns));
    } catch (e) {
      callError = `모델 호출 실패: ${e instanceof Error ? e.message : String(e)}`;
    }
    const d = callError ? { ok: false as const, error: callError, thinking: "" } : parseDecision(raw, inp.tools);
    const turnNo = s.turns.length;
    const at = new Date().toISOString();

    if (!d.ok) {
      const fails = s.parseFailures + 1;
      const turn: AgentTurn = { turn: turnNo, thinking: d.thinking, action: "invalid", error: d.error, at };
      s.turns.push(turn);
      await this.state.storage.put({ turns: s.turns, parseFailures: fails });
      if (fails >= AGENT_PARSE_FAIL_LIMIT) return stop("tool_selection_failed");
      return { status: "invalid", turn: turnNo, error: d.error, nextTurn: s.turns.length };
    }
    if (d.action === "finish") {
      s.turns.push({ turn: turnNo, thinking: d.thinking, action: "finish", final: d.final, at });
      const r: AdvanceResult = { status: "finish", final: d.final, thinking: d.thinking, turns: s.turns };
      await this.state.storage.put({ turns: s.turns, parseFailures: 0, done: r });
      return r;
    }
    s.turns.push({ turn: turnNo, thinking: d.thinking, action: "tool", tool: d.tool, args: d.args, at });
    s.lastTools.push(d.tool);
    await this.state.storage.put({ turns: s.turns, lastTools: s.lastTools.slice(-10), parseFailures: 0 });
    return { status: "tool", turn: turnNo, tool: d.tool, args: d.args, thinking: d.thinking, nextTurn: s.turns.length };
  }

  /** 도구 실행 결과를 그 턴에 붙인다. 이미 붙어 있으면 바꾸지 않는다 (재전달 대비). */
  async observe(p: { turn: number; observation?: unknown; error?: string }): Promise<{ ok: boolean; nextTurn: number }> {
    const s = await this.load();
    const t = s.turns[p.turn];
    if (!t || t.action !== "tool") return { ok: false, nextTurn: s.turns.length };
    if (t.observation === undefined) {
      t.observation = p.error ? `(실패) ${clip(p.error, OBS_MAX)}` : asText(p.observation ?? null, OBS_MAX);
      if (p.error) t.error = clip(p.error, OBS_MAX);
      await this.state.storage.put("turns", s.turns);
    }
    return { ok: true, nextTurn: s.turns.length };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = async () => (await request.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      if (request.method === "POST" && url.pathname === "/advance") {
        const b = (await body()) as unknown as AdvanceInput;
        return Response.json(await this.serial(() => this.advance(b)));
      }
      if (request.method === "POST" && url.pathname === "/observe") {
        const b = (await body()) as { turn: number; observation?: unknown; error?: string };
        return Response.json(await this.serial(() => this.observe(b)));
      }
      if (request.method === "POST" && url.pathname === "/pending") {
        const b = (await body()) as unknown as PendingAction;
        await this.serial(() => this.state.storage.put("pendingAction", { turn: b.turn, tool: b.tool, args: b.args ?? {}, thinking: b.thinking ?? "" }));
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/take-pending") {
        // 꺼내서 null로 지운다 — 승인된 행동은 한 번만 실행된다.
        const p = await this.serial(async () => {
          const cur = ((await this.state.storage.get("pendingAction")) as PendingAction | null | undefined) ?? null;
          if (cur) await this.state.storage.put("pendingAction", null);
          return cur;
        });
        return Response.json({ pending: p });
      }
      if (request.method === "GET" && url.pathname === "/state") {
        const s = await this.serial(() => this.load());
        return Response.json(s);
      }
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
    return Response.json({ ok: false, error: "unknown DO route" }, { status: 404 });
  }
}
