// Think 전면 도입 T3 (2026-11-20): 어시스턴트의 "조사" 하위 에이전트 (계획 2.1 E).
//
// - 부모(AssistantAgent)의 research 도구가 runAgentTool(ResearchAgent, { runId })로 부른다. 자식은 부모 DO 안의 facet이라
//   **바인딩·DO 마이그레이션이 없다** (worker 진입점에서 export만 한다). facet을 쓰려면 ctx.exports가 필요해
//   compatibility_flags에 enable_ctx_exports를 넣었다 (compatibility_date는 그대로 2025-07-18 — T3 사전 확인 people-os-t3-probe).
// - 자식 이름(runId) 접두어는 `research:` — 어시스턴트(`assistant:`)·워크플로 단계(`think:`)와 다르다. 실행 1번 = 자식 1개.
// - 도구는 읽기 전용 3개(ask_rag·ask_personal·summarize)만. 부작용 도구·할 일 만들기·메일 초안은 없다.
//   getTools()가 3개만 만들고, beforeTurn activeTools로 Think 기본 도구도 막고, beforeToolCall이 한 번 더 막는다.
// - 한도: 4스텝, LLM 8회(모델 스텝 + LLM 도구), 6분. 카운터는 DO 저장소 누적값 (복구 턴에서도 이어 센다).
//   자식이 쓴 LLM 호출 수는 결과(output.llmCalls)로 부모에 돌려주고, 부모가 자기 턴의 llmCalls(20회 상한)에 더한다.
// - 소유자(ask_personal의 권한 검사용)는 부모가 input으로 넘기고, formatAgentToolInput이 저장소에 두고 **모델 메시지에는 주제만** 넣는다.
import { Think } from "@cloudflare/think";
import type {
  PrepareStepContext,
  StepConfig,
  StepContext,
  ThinkModel,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { ToolSet, UIMessage } from "ai";
import { LLM_MODEL } from "../ask-pipeline";
import { executeNode } from "../workflow/nodes";
import { THINK_LLM_TOOL_TYPES, asText, buildNodeTools, clip, stableKey, stripThink } from "../workflow/think-agent";
import { APPROVAL_REQUIRED_NODES, type Env, type NodeContext, type NodeResult, type NodeType, type ToolNodeType } from "../workflow/types";

export const RESEARCH_TOOLS: ToolNodeType[] = ["ask_rag", "ask_personal", "summarize"];
export interface ResearchLimits { maxSteps: number; llmCap: number; timeoutMs: number }
export const RESEARCH_LIMITS: ResearchLimits = { maxSteps: 4, llmCap: 8, timeoutMs: 6 * 60 * 1000 };

export interface ResearchOwner { id: string; email: string; role: string; coaching_role?: string }
/** 부모가 넘기는 입력. `h`는 하네스 전용 (운영에서는 넣지 않는다). */
export interface ResearchInput { topic: string; owner: ResearchOwner; turnNo: number; h?: unknown }
export interface ResearchOutput {
  summary: string;
  sources: Array<{ title?: string; doc_id?: string }>;
  grounded: boolean | null;
  steps: number;
  llmCalls: number;
  toolCalls: number;
  tools: string[];
  stop: string | null;
}

/** 자식 facet 이름 = runAgentTool runId. 같은 턴·같은 입력이면 같은 id → runAgentTool이 중복 실행하지 않는다 (복구 턴에서도). */
export function researchRunId(userId: string, turnNo: number, args: unknown): string {
  let h = 0x811c9dc5;
  const s = stableKey(args);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `research:${userId}:t${turnNo}:${h.toString(16).padStart(8, "0")}`;
}

const SYSTEM_PROMPT = [
  "너는 People OS 어시스턴트의 조사 담당 하위 에이전트다. 주어진 조사 주제에 대해 도구로 근거를 모은 뒤, 한국어로 짧게 정리해 돌려준다.",
  "규칙:",
  "(a) 회사 규정·HR 제도 질문은 ask_rag로, 사용자 본인 문서는 ask_personal로 찾는다. 문서 id가 주어지면 summarize를 쓸 수 있다.",
  "(b) 한 번에 도구 하나만 부른다. 같은 질문을 반복하지 않는다. 최대 3번 안에 근거를 모은다.",
  "(c) 근거를 다 모았으면 도구 없이 정리를 쓴다: 항목별 핵심 2~5줄 + 출처 제목. 근거가 없으면 없다고 쓴다.",
  "(d) 메일·할 일·외부 호출은 하지 않는다. 너는 조사만 한다.",
].join("\n");

/** T3 고침 6: 부모(onProgress)가 진행 이벤트로 옮기는 진행 신호의 data 모양. */
export interface ResearchProgressData { steps: number; maxSteps: number; tool?: string; llmCalls: number }

export class ResearchAgent extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pos_kv (k TEXT PRIMARY KEY, v TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS pos_fx (k TEXT PRIMARY KEY, state TEXT, result TEXT, at INTEGER)");
  }

  protected kvGet<T>(k: string, fallback: T): T {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM pos_kv WHERE k = ?", k).toArray();
    return rows.length ? (JSON.parse(String(rows[0].v)) as T) : fallback;
  }
  protected kvPut(k: string, v: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO pos_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v ?? null));
  }
  private num(k: string): number { return this.kvGet<number>(k, 0); }
  private bump(k: string, by = 1): number { const n = this.num(k) + by; this.kvPut(k, n); return n; }
  protected job(): ResearchInput | null { return this.kvGet<ResearchInput | null>("job", null); }
  private stop(): string | null { return this.kvGet<string | null>("stop", null); }
  private setStop(s: string): void { if (!this.stop()) this.kvPut("stop", s); }

  /** 한도 (하네스가 덮어써서 줄인다). */
  protected limits(): ResearchLimits { return RESEARCH_LIMITS; }
  /** 노드 실행 (하네스가 덮어써서 모의 실행한다). */
  protected execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    return executeNode(type, ctx, args);
  }

  /** 부모 입력 → 자식의 첫 사용자 메시지. 소유자는 저장소에만 두고 메시지에는 주제만 넣는다. 실행(runId)마다 1번 불린다. */
  protected formatAgentToolInput(input: unknown): UIMessage {
    const raw = (input && typeof input === "object" ? input : { topic: String(input ?? "") }) as Partial<ResearchInput>;
    const job: ResearchInput = {
      topic: clip(String(raw.topic ?? "").trim(), 1000),
      owner: raw.owner as ResearchOwner,
      turnNo: Number(raw.turnNo) || 0,
      ...(raw.h !== undefined ? { h: raw.h } : {}),
    };
    if (!this.job()) {
      this.kvPut("job", job);
      this.kvPut("startedAt", Date.now());
    }
    return {
      id: crypto.randomUUID(), role: "user",
      parts: [{ type: "text", text: `조사 주제:\n${job.topic || "(주제 없음)"}\n\n도구로 근거를 모은 뒤 항목별로 짧게 정리하고 출처 제목을 밝혀라.` }],
    };
  }

  getModel(): ThinkModel { return LLM_MODEL; }
  getSystemPrompt() { return SYSTEM_PROMPT; }
  getTools(): ToolSet {
    const all = buildNodeTools((name, args) => this.runTool(name, args));
    const out: ToolSet = {};
    for (const n of RESEARCH_TOOLS) if (all[n]) out[n] = all[n];
    return out;
  }

  private nodeCtx(job: ResearchInput): NodeContext {
    const o = job.owner;
    return {
      env: this.env, user: { id: o.id, email: o.email, role: o.role, coaching_role: o.coaching_role },
      runId: `research_${o.id}_t${job.turnNo}`, workflowId: "assistant-research", stepIndex: job.turnNo, input: {}, stepOutputs: {}, approved: false,
    };
  }

  /** 도구 실행 (멱등 원장: 도구 + 입력 — 복구 턴이 끝난 실행을 다시 하지 않는다). */
  private async runTool(name: ToolNodeType, args: Record<string, unknown>): Promise<unknown> {
    const job = this.job();
    if (!job?.owner?.id) return { error: "조사 작업 정보가 없습니다." };
    if (!(RESEARCH_TOOLS as string[]).includes(name) || (APPROVAL_REQUIRED_NODES as string[]).includes(name)) {
      return { error: "조사 에이전트가 쓸 수 없는 도구라 실행하지 않았습니다." };
    }
    const key = `${name}:${stableKey(args)}`;
    const rows = this.ctx.storage.sql.exec("SELECT state, result FROM pos_fx WHERE k = ?", key).toArray();
    if (rows.length && String(rows[0].state) === "done") return rows[0].result === null ? null : JSON.parse(String(rows[0].result));
    this.ctx.storage.sql.exec("INSERT INTO pos_fx (k, state, result, at) VALUES (?, 'started', NULL, ?) ON CONFLICT(k) DO UPDATE SET state='started', at=excluded.at", key, Date.now());
    const res = await this.execNode(name, this.nodeCtx(job), args);
    let out: unknown;
    if (res.status === "succeeded") {
      const s = asText(res.output ?? null, 3000);
      out = s.length >= 3000 ? { truncated: s } : (res.output ?? null);
    } else out = { error: res.error || "도구 실행 실패" };
    this.ctx.storage.sql.exec("UPDATE pos_fx SET state='done', result=?, at=? WHERE k = ?", JSON.stringify(out ?? null), Date.now(), key);
    return out;
  }

  private checkLimits(cumSteps?: number): string | null {
    const cur = this.stop();
    if (cur) return cur;
    const lim = this.limits();
    const steps = Math.max(this.num("steps"), cumSteps ?? 0);
    let r: string | null = null;
    if (steps >= lim.maxSteps) r = "max_steps";
    else if (Date.now() - this.num("startedAt") > lim.timeoutMs) r = "timeout";
    else if (this.num("llmCalls") >= lim.llmCap) r = "llm_cap";
    if (r) this.setStop(r);
    return r;
  }

  beforeTurn(ctx: TurnContext): TurnConfig {
    const steps = this.num("steps");
    this.kvPut("turnBase", steps);
    if (!this.job() || this.checkLimits(steps)) return { activeTools: [], toolChoice: "none", maxSteps: 1 };
    const active = RESEARCH_TOOLS.filter((x) => Object.prototype.hasOwnProperty.call(ctx.tools, x));
    this.kvPut("offered", { offered: Object.keys(ctx.tools).length, active, trigger: ctx.trigger ?? null });
    return {
      activeTools: active,
      maxSteps: Math.max(1, this.limits().maxSteps - steps),
      stopWhen: [(o: { steps: ReadonlyArray<unknown> }) => this.checkLimits(this.num("turnBase") + o.steps.length) !== null],
    };
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    if (this.checkLimits(this.num("turnBase") + (ctx.stepNumber ?? 0))) {
      this.kvPut("forced", true); // 한도로 도구를 닫은 스텝 — 이 스텝의 글은 "스스로 끝냄"이 아니다 (고침 5)
      return { activeTools: [], toolChoice: "none" } as StepConfig;
    }
  }

  /**
   * T3 고침 6: 진행 신호 (부모의 onProgress → 부모 진행 이벤트 researchProgress). 실패해도 조사에는 영향이 없다.
   * eventDelivery "terminal"에서도 progress 프레임은 부모로 전달된다 (agents AgentToolEventDelivery 문서).
   */
  private progress(message: string, tool?: string): void {
    const data: ResearchProgressData = { steps: this.num("steps"), maxSteps: this.limits().maxSteps, llmCalls: this.num("llmCalls"), ...(tool ? { tool } : {}) };
    try {
      // persist: data(스텝 수·도구)가 부모 onProgress 스냅숏에 실리게 (기본은 data를 싣지 않는다)
      void this.reportProgress({ message, phase: tool ? "tool" : "step", fraction: Math.min(1, data.steps / Math.max(1, data.maxSteps)), data }, { persist: true })
        .catch(() => { /* 진행 신호 실패는 무시 */ });
    } catch { /* 무시 */ }
  }

  beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const name = ctx.toolName;
    if (!(RESEARCH_TOOLS as string[]).includes(name) || (APPROVAL_REQUIRED_NODES as string[]).includes(name)) {
      this.bump("blocked");
      return { action: "block", reason: "조사 에이전트는 ask_rag·ask_personal·summarize만 쓸 수 있습니다." };
    }
    if (this.stop()) return { action: "block", reason: "한도에 걸려 더 실행하지 않습니다." };
    if ((THINK_LLM_TOOL_TYPES as string[]).includes(name)) {
      if (this.num("llmCalls") + 1 > this.limits().llmCap) { this.setStop("llm_cap"); return { action: "block", reason: "LLM 호출 상한에 도달했습니다." }; }
      this.bump("llmCalls");
    }
    this.bump("toolCalls");
    this.kvPut("tools", [...this.kvGet<string[]>("tools", []), name].slice(-10));
    this.progress(`${name} 검색 중`, name);
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    if (!ctx.success) return;
    const out = ctx.output as { sources?: unknown; grounded?: unknown } | null;
    if (!out || typeof out !== "object") return;
    if (Array.isArray(out.sources)) {
      const prev = this.kvGet<Array<{ title?: string; doc_id?: string }>>("sources", []);
      for (const s of out.sources.slice(0, 5) as Array<Record<string, unknown>>) {
        const item = { title: typeof s?.title === "string" ? s.title : undefined, doc_id: typeof s?.doc_id === "string" ? s.doc_id : undefined };
        if (!prev.some((p) => p.title === item.title && p.doc_id === item.doc_id)) prev.push(item);
      }
      this.kvPut("sources", prev.slice(0, 10));
    }
    if (typeof out.grounded === "boolean") this.kvPut("grounded", this.kvGet<boolean | null>("grounded", null) === true || out.grounded);
  }

  onStepFinish(ctx: StepContext): void {
    const c = ctx as unknown as { text?: string; toolCalls?: unknown[] };
    this.bump("steps");
    this.bump("llmCalls");
    const hasTools = (c.toolCalls ?? []).length > 0;
    if (!hasTools) {
      const text = clip(stripThink(c.text ?? ""), 3000);
      if (text) this.kvPut("final", text);
      // 고침 5: 도구 없이 정리를 쓴 스텝 = 자식이 스스로 끝냈다 (한도로 도구를 닫은 스텝은 forced로 따로 표시).
      this.kvPut("selfFinished", !!text && !this.kvGet<boolean>("forced", false));
    } else this.kvPut("selfFinished", false);
    this.checkLimits(this.num("steps"));
    this.progress(hasTools ? `스텝 ${this.num("steps")} 끝 (도구 호출)` : `스텝 ${this.num("steps")} 끝 (정리 작성)`);
  }

  /**
   * runAgentTool 결과의 output (부모가 받는다).
   * 고침 5: 마지막 스텝이 도구 없는 정리였으면(스스로 끝냄) stop = "completed" — 그 스텝이 상한(4)과 같아 저장소에 max_steps가 남아도.
   * 한도로 멈춘 경우(도구 스텝에서 상한·LLM 캡·시간)는 그 사유를 그대로 둔다.
   */
  protected getAgentToolOutput(_runId: string): ResearchOutput {
    const stop = this.kvGet<boolean>("selfFinished", false) ? "completed" : this.stop();
    const final = this.kvGet<string | null>("final", null);
    return {
      summary: final ?? (stop ? `조사를 끝내지 못했습니다 (${stop}).` : ""),
      sources: this.kvGet("sources", []),
      grounded: this.kvGet<boolean | null>("grounded", null),
      steps: this.num("steps"),
      llmCalls: this.num("llmCalls"),
      toolCalls: this.num("toolCalls"),
      tools: this.kvGet<string[]>("tools", []),
      stop,
    };
  }
  protected getAgentToolSummary(runId: string, output: unknown): string {
    const o = output as ResearchOutput | undefined;
    return o?.summary || super.getAgentToolSummary(runId, output);
  }
}
