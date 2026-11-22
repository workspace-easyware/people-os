// Think 전면 도입 T2 (2026-11-20): 사용자당 어시스턴트 DO (계획 think-cloudflare-os-full-adoption-plan.md 2.1 D).
//
// - 인스턴스 1개 = 사용자 1명 (이름 `assistant:<userId>`). 대화는 Think가 DO SQLite에 저장하므로 DO 재시작·재배포 뒤에도 이어진다.
// - 워크플로 agent 단계(ThinkAgent, `think:<runId>:<stepIndex>`)와 **클래스·바인딩·저장소가 다르다** → 상태가 섞일 수 없다.
// - 답 생성은 기존 ask-pipeline을 **도구로** 부른다 (ask_rag·ask_personal → nodes.ts runAskNode → runAsk). 질문 탭(AgentSession)은 건드리지 않는다.
// - 도구는 6개(ASSISTANT_TOOLS)로 좁힌다: getTools()가 6개만 만들고, beforeTurn의 activeTools로 Think 기본 도구(워크스페이스 등 7개)도 막는다.
//   부작용 도구(send_email·webhook)는 없다 — 메일은 초안(email_draft)까지만. 그래도 beforeToolCall이 목록 밖 도구를 한 번 더 막는다.
// - 한도는 T1과 같은 값·같은 방식(DO 저장소 누적값): 턴당 10스텝, LLM 20회(모델 스텝 + LLM 도구 호출 합계), 28분, 같은 도구 3회 연속.
//   어시스턴트 턴은 워크플로 run이 아니므로 run 전체 LLM 30회 캡에는 묶지 않는다. 턴의 llmCalls는 턴 상태·이벤트에 남긴다.
// - 턴 구분: runTurn(submit)의 metadata.turnNo → Think가 사용자 메시지에 저장 → 복구 턴에서도 activeTurnMetadata로 같은 턴 번호를 읽는다.
//   (T1 주의: 복구 턴은 requestId가 바뀌고 stepNumber를 0부터 다시 센다 → 카운터는 턴 번호 키의 저장소 값으로만 센다.)
// - 진행 이벤트: 훅마다 pos_ev 표에 한 줄 (턴 시작·도구 시작/끝·스텝·턴 끝). 라우트가 `after` 커서로 읽는다 (2초 폴링 / SSE 래퍼).
// T3 (2026-11-20):
// - research 도구 = 조사 하위 에이전트(ResearchAgent, research.ts) 위임. runAgentTool로 facet 자식을 부르고, 자식의 LLM 사용량을 턴 llmCalls에 더한다.
// - 하루 턴 상한 30회 (KST 날짜 키 `day:<YYYY-MM-DD>`, 초과 시 라우트 429). 대화 지우기(clear)로 초기화되지 않는다.
// - 대화 지우기: clear() — Think 메시지·하위 에이전트 실행·이벤트·원장 삭제, 턴 상태는 남긴다 (관측용).
// - 턴이 끝나면 D1 assistant_turns(0041)에 요약 1행 (관측 탭 "어시스턴트"). 대화 내용은 싣지 않는다.
import { Think } from "@cloudflare/think";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
  ChunkContext,
  PrepareStepContext,
  StepConfig,
  StepContext,
  ThinkModel,
  ThinkSubmissionInspection,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { LLM_MODEL } from "../ask-pipeline";
import type { AgentToolProgressSnapshot, AgentToolRunInfo } from "agents";
import { ResearchAgent, researchRunId, type ResearchInput, type ResearchOutput, type ResearchProgressData } from "./research";
import { executeNode } from "../workflow/nodes";
import { AGENT_LLM_CAP, AGENT_REPEAT_LIMIT, AGENT_TIMEOUT_MS, type StopReason } from "../workflow/agent-do";
import { THINK_LLM_TOOL_TYPES, asText, buildNodeTools, clip, stableKey, stripThink } from "../workflow/think-agent";
import { APPROVAL_REQUIRED_NODES, type Env, type NodeContext, type NodeResult, type NodeType, type ToolNodeType } from "../workflow/types";

/** 어시스턴트가 쓸 수 있는 도구 (이 목록 밖은 모델에 열리지 않는다). 부작용 도구(send_email·webhook)는 넣지 않는다. */
export const ASSISTANT_TOOLS: ToolNodeType[] = ["ask_rag", "ask_personal", "summarize", "llm", "email_draft", "create_task"];
export const ASSISTANT_MAX_STEPS = 10;
/** T3: 하위 에이전트(조사) 위임 도구. 노드 도구가 아니라 runAgentTool(ResearchAgent)을 부른다. 읽기 전용이다. */
export const RESEARCH_TOOL = "research";
/** T3: 사용자별 하루 턴 상한 (KST 날짜 기준, DO 저장소 카운터). 대화 지우기로 초기화되지 않는다. */
export const ASSISTANT_DAILY_TURNS = 30;
/** KST(UTC+9) 날짜 YYYY-MM-DD. */
export function kstDay(ms = Date.now()): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}
const EVENT_KEEP = 3000; // pos_ev 보존 줄 수 (넘으면 오래된 것부터 지운다)
const TERMINAL = new Set(["completed", "aborted", "skipped", "error"]);

/** DO 이름 (내부). 워크플로 단계 이름 `think:<runId>:<stepIndex>`와 접두어가 다르고 클래스도 다르다. */
export function assistantDoName(userId: string): string {
  return `assistant:${userId}`;
}
/** 라우트의 `:id` (사용자에게 보이는 어시스턴트 id). 호출자 것과 다르면 라우트가 404를 낸다. */
export function assistantIdFor(userId: string): string {
  return `asst_${userId}`;
}

export interface AssistantOwner { id: string; email: string; role: string; coaching_role?: string; name?: string }
export interface AssistantLimits { maxSteps: number; timeoutMs: number; repeatLimit: number; llmCap: number }
export type AssistantStop = StopReason;

/** 턴 1개의 상태 (pos_kv `turn:<n>`). 한도 카운터는 전부 여기 — 메모리 필드는 쓰지 않는다. */
export interface TurnState {
  turnNo: number;
  submissionId: string;
  status: "queued" | "running" | "completed" | "aborted" | "skipped" | "error";
  queuedAt: number;
  startedAt: number | null; // 활성 시작 (첫 beforeTurn) — 28분은 여기서 잰다
  endedAt: number | null;
  turnBase: number; // 현재 Think 턴(복구 턴 포함)이 시작될 때의 누적 스텝
  steps: number; // 모델 스텝 누적
  llmCalls: number; // 모델 스텝 + LLM 도구 호출 누적
  toolCalls: number;
  lastTools: string[];
  stop: AssistantStop | null;
  final: string | null;
  recoveries: number;
  thinkingEmptySteps: number; // Qwen thinking(reasoningText)이 빈 스텝 수 (T1 주의 7 관측용)
  thinkingSteps: number;
  researchRuns?: number; // T3: 조사 하위 에이전트 위임 횟수 (그 LLM 호출 수는 llmCalls에 더해진다)
}

export interface AssistantEvent { id: number; ts: number; turn: number; ev: string; data: Record<string, unknown> }

const SYSTEM_PROMPT = [
  "너는 People OS의 개인 업무 어시스턴트다. 사용자와 이어지는 대화를 하며, 필요하면 주어진 도구를 골라 부른 뒤 한국어로 답한다.",
  "규칙:",
  "(a) 회사 규정·HR 제도·복리후생·근태·휴가 같은 질문은 추측하지 말고 반드시 ask_rag 도구로 공용 지식에서 근거를 찾은 뒤, 그 결과의 answer와 sources를 바탕으로 답한다. 출처 제목을 답에 밝힌다.",
  "(b) 사용자 자신의 문서·메모·회의록에 관한 질문은 ask_personal 도구를 쓴다.",
  "(c) 메일은 email_draft로 초안까지만 만든다. 메일을 보내거나 외부로 요청을 보내는 일은 하지 않는다 — 발송은 사용자가 직접 한다고 안내한다.",
  "(d) 한 번에 도구 하나만 부른다. 이미 얻은 결과를 다시 얻으려고 같은 도구를 반복하지 않는다. 답에 충분한 정보가 모이면 도구 없이 답한다.",
  "(e) 도구 결과에 근거가 없거나(grounded=false) 모르면 모른다고 밝히고 담당 부서 확인을 권한다.",
  "(f) 인사·잡담처럼 도구가 필요 없는 말에는 도구 없이 짧게 답한다.",
  "(g) 규정 여러 개를 비교하거나 여러 항목을 한꺼번에 조사·정리해 달라는 요청은 research 도구로 조사 담당 하위 에이전트에게 맡기고, 돌아온 summary와 sources를 바탕으로 답한다. 규정 하나를 묻는 질문은 ask_rag를 쓴다.",
].join("\n");

/** T3 고침 2: 토큰 스트리밍 — text-delta를 모아 이 간격·길이마다 `delta` 이벤트 1줄로 남긴다 (토큰마다 SQL 쓰기를 하지 않는다). */
const DELTA_FLUSH_MS = 250;
const DELTA_FLUSH_CHARS = 120;
/** T3 고침 6: 조사 위임 중 자식 진행 신호가 이 시간 동안 없으면 부모가 "조사 중" 진행 이벤트를 남긴다 (화면이 멈춰 보이지 않게). */
export const RESEARCH_HEARTBEAT_MS = 15_000;

function stopLabel(reason: AssistantStop, lim: AssistantLimits): string {
  const label: Record<AssistantStop, string> = {
    max_steps: `최대 단계 수(${lim.maxSteps})에 도달`,
    repeat_tool: `같은 도구를 ${lim.repeatLimit}번 연속으로 호출`,
    timeout: "실행 시간 상한에 도달",
    llm_cap: `LLM 호출 상한(${lim.llmCap})에 도달`,
    tool_selection_failed: "모델이 도구 선택에 실패",
  };
  return label[reason];
}

export class AssistantAgent extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pos_kv (k TEXT PRIMARY KEY, v TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS pos_fx (k TEXT PRIMARY KEY, state TEXT, result TEXT, at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS pos_ev (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, turn INTEGER, ev TEXT, data TEXT)");
  }

  // ---- 저장 도우미 (동기 SQL) ----
  protected kvGet<T>(k: string, fallback: T): T {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM pos_kv WHERE k = ?", k).toArray();
    return rows.length ? (JSON.parse(String(rows[0].v)) as T) : fallback;
  }
  protected kvPut(k: string, v: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO pos_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v ?? null));
  }
  private fxGet(k: string): { state: string; result: unknown } | null {
    const rows = this.ctx.storage.sql.exec("SELECT state, result FROM pos_fx WHERE k = ?", k).toArray();
    return rows.length ? { state: String(rows[0].state), result: rows[0].result === null ? null : JSON.parse(String(rows[0].result)) } : null;
  }
  private fxPut(k: string, state: "started" | "done", result: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO pos_fx (k, state, result, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET state = excluded.state, result = excluded.result, at = excluded.at",
      k, state, result === undefined ? null : JSON.stringify(result), Date.now(),
    );
  }
  protected emit(ev: string, data: Record<string, unknown> = {}, turn = this.runningTurn()): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO pos_ev (ts, turn, ev, data) VALUES (?, ?, ?, ?)", Date.now(), turn, ev, JSON.stringify(data));
    const n = this.kvGet<number>("evCount", 0) + 1;
    if (n > EVENT_KEEP + 500) {
      sql.exec("DELETE FROM pos_ev WHERE id <= (SELECT MAX(id) FROM pos_ev) - ?", EVENT_KEEP);
      this.kvPut("evCount", EVENT_KEEP);
    } else this.kvPut("evCount", n);
  }

  protected owner(): AssistantOwner | null { return this.kvGet<AssistantOwner | null>("owner", null); }
  private runningTurn(): number { return this.kvGet<number>("runningTurn", 0); }
  protected turnState(n: number): TurnState | null { return this.kvGet<TurnState | null>(`turn:${n}`, null); }
  private putTurn(t: TurnState): void { this.kvPut(`turn:${t.turnNo}`, t); }
  /** 현재 턴 상태를 읽고 → 고치고 → 저장 (한 블록, await 없음). */
  private mutTurn(fn: (t: TurnState) => void, n = this.runningTurn()): TurnState | null {
    const t = this.turnState(n);
    if (!t) return null;
    fn(t);
    this.putTurn(t);
    return t;
  }

  /** 한도 (하네스가 덮어써서 줄인다). T1 agent 한도와 같은 값. */
  protected limits(): AssistantLimits {
    return { maxSteps: ASSISTANT_MAX_STEPS, timeoutMs: AGENT_TIMEOUT_MS, repeatLimit: AGENT_REPEAT_LIMIT, llmCap: AGENT_LLM_CAP };
  }
  /** 노드 실행 (하네스가 덮어써서 모의 실행·계수한다). */
  protected execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    return executeNode(type, ctx, args);
  }
  private nodeCtx(owner: AssistantOwner, turnNo: number): NodeContext {
    // runId·workflowId는 노드가 세션 id·할 일 출처 표시에만 쓴다 (ask: `wf_asst_<uid>_t<n>_<turn>`, create_task: source `workflow:assistant`).
    return {
      env: this.env, user: { id: owner.id, email: owner.email, role: owner.role, coaching_role: owner.coaching_role },
      runId: `asst_${owner.id}_t${turnNo}`, workflowId: "assistant", stepIndex: turnNo, input: {}, stepOutputs: {}, approved: false,
    };
  }

  /** 한도 판정. 걸리면 멈춤 사유를 턴 상태에 남긴다. cumSteps = 지금까지 끝난(또는 끝날) 모델 스텝 누적. */
  private checkLimits(cumSteps?: number): AssistantStop | null {
    const t = this.turnState(this.runningTurn());
    if (!t) return null;
    if (t.stop) return t.stop;
    const lim = this.limits();
    const steps = Math.max(t.steps, cumSteps ?? 0);
    let r: AssistantStop | null = null;
    if (steps >= lim.maxSteps) r = "max_steps";
    else if (t.startedAt !== null && Date.now() - t.startedAt > lim.timeoutMs) r = "timeout";
    else if (t.llmCalls >= lim.llmCap) r = "llm_cap";
    if (r) this.setStop(r);
    return r;
  }
  private setStop(r: AssistantStop): void {
    let set = false;
    this.mutTurn((t) => { if (!t.stop) { t.stop = r; set = true; } });
    if (set) this.emit("limit", { reason: r });
  }

  // ---- Think 설정 ----
  getModel(): ThinkModel {
    return LLM_MODEL;
  }
  getSystemPrompt() {
    return SYSTEM_PROMPT;
  }
  /** 노드 도구 중 어시스턴트 6개만 만든다 (T1 주의 8: getTools를 바꿀 때도 좁힌다 — beforeTurn activeTools가 2차로 막는다). */
  getTools(): ToolSet {
    const all = buildNodeTools((name, args, toolCallId) => this.runTool(name, args, toolCallId));
    const out: ToolSet = {};
    for (const n of ASSISTANT_TOOLS) if (all[n]) out[n] = all[n];
    out[RESEARCH_TOOL] = tool({
      description: "조사 담당 하위 에이전트에게 조사를 맡긴다. 규정 여러 개 비교, 여러 항목 정리처럼 근거를 여러 번 찾아야 하는 요청에 쓴다. 결과 키: summary, sources, grounded",
      inputSchema: z.object({ topic: z.string().describe("조사할 주제와 정리할 항목 (한국어 문장)") }),
      execute: async (input, opts) => this.runResearch((input ?? {}) as { topic?: string }, opts.toolCallId),
    });
    return out;
  }

  /** 조사 하위 에이전트 클래스 (하네스가 모의 모델 자식으로 바꾼다). */
  protected researchClass(): typeof ResearchAgent { return ResearchAgent; }
  /** 자식 입력에 덧붙일 값 (하네스 전용 — 운영은 없음). */
  protected researchExtra(): Partial<ResearchInput> { return {}; }

  /**
   * research 도구 실행 = runAgentTool(ResearchAgent). 자식 이름(runId)은 턴 + 입력으로 정해져, 복구 턴에서 다시 불려도 같은 자식을 다시 붙잡는다
   * (runAgentTool은 runId 기준 멱등). 자식이 쓴 LLM 호출 수를 이 턴의 llmCalls에 더한다.
   */
  private async runResearch(args: { topic?: string }, toolCallId: string): Promise<unknown> {
    const owner = this.owner();
    const turnNo = this.runningTurn();
    if (!owner) return { error: "어시스턴트 소유자 정보가 없습니다." };
    const topic = String(args.topic ?? "").trim();
    if (!topic) return { error: "조사 주제(topic)가 필요합니다." };
    const key = `${turnNo}:${RESEARCH_TOOL}:${stableKey({ topic })}`;
    const prev = this.fxGet(key);
    if (prev?.state === "done") {
      this.emit("toolReplay", { tool: RESEARCH_TOOL, toolCallId });
      return prev.result;
    }
    this.fxPut(key, "started", null);
    const runId = researchRunId(owner.id, turnNo, { topic });
    this.emit("researchStart", { runId, toolCallId, topic: clip(topic, 300) });
    const input: ResearchInput = {
      topic, turnNo, owner: { id: owner.id, email: owner.email, role: owner.role, coaching_role: owner.coaching_role }, ...this.researchExtra(),
    };
    // T3 고침 6: 자식 진행 신호(onProgress)가 RESEARCH_HEARTBEAT_MS 동안 없으면 "조사 중" 이벤트를 남긴다 (메모리 상태 — 위임이 끝나면 지운다).
    const live = { turn: turnNo, toolCallId, startedAt: Date.now(), lastAt: Date.now(), steps: 0 };
    this.researchLive.set(runId, live);
    const hb = setInterval(() => {
      try {
        if (Date.now() - live.lastAt < RESEARCH_HEARTBEAT_MS) return;
        live.lastAt = Date.now();
        this.emit("researchProgress", { runId, toolCallId, source: "heartbeat", steps: live.steps, elapsedMs: Date.now() - live.startedAt }, turnNo);
      } catch { /* 진행 표시 실패는 무시 */ }
    }, this.researchHeartbeatTickMs());
    let out: unknown;
    try {
      const r = await this.runAgentTool<ResearchInput, ResearchOutput>(this.researchClass(), { input, runId, parentToolCallId: toolCallId, eventDelivery: "terminal" });
      const o = r.output;
      const used = Math.max(1, Number(o?.llmCalls ?? 0));
      this.mutTurn((s) => { s.llmCalls += used; s.researchRuns = (s.researchRuns ?? 0) + 1; }, turnNo);
      this.emit("researchEnd", {
        runId, toolCallId, status: r.status, steps: o?.steps ?? null, llmCalls: used, tools: o?.tools ?? [], stop: o?.stop ?? null,
        grounded: o?.grounded ?? null, sources: (o?.sources ?? []).map((x) => x.title).filter(Boolean).slice(0, 5),
        summary: clip(o?.summary ?? r.summary ?? "", 300), ...(r.error ? { error: clip(r.error, 200) } : {}),
      });
      out = r.status === "completed"
        ? { summary: clip(o?.summary ?? r.summary ?? "", 3000), sources: o?.sources ?? [], grounded: o?.grounded ?? null }
        : { error: `조사 에이전트가 끝나지 못했습니다 (${r.status}${r.error ? `: ${clip(r.error, 200)}` : ""}).` };
    } catch (e) {
      this.mutTurn((s) => { s.llmCalls += 1; s.researchRuns = (s.researchRuns ?? 0) + 1; }, turnNo);
      this.emit("researchEnd", { runId, toolCallId, status: "error", error: clip(String(e), 200) });
      out = { error: "조사 에이전트를 부르지 못했습니다." };
    } finally {
      clearInterval(hb);
      this.researchLive.delete(runId);
    }
    this.fxPut(key, "done", out);
    return out;
  }

  /** T3 고침 6: 진행 중인 조사 위임 (runId → 마지막 신호 시각). 메모리만 — 위임 중에는 DO가 요청을 붙잡고 있어 내려가지 않는다. */
  private researchLive = new Map<string, { turn: number; toolCallId: string; startedAt: number; lastAt: number; steps: number }>();
  /** 하트비트 점검 간격 (ms). 15초 상한 + 이 간격 안에 "조사 중" 이벤트가 나온다 → 최대 약 20초. */
  protected researchHeartbeatTickMs(): number { return 5000; }

  /**
   * T3 고침 6: 자식(ResearchAgent)의 reportProgress 신호 → 부모 진행 이벤트 `researchProgress` (2초 폴링·SSE로 화면에 보인다).
   * eventDelivery "terminal"이어도 progress 프레임은 부모 tail로 온다. best-effort — 안 와도 하트비트가 덮는다.
   */
  async onProgress(run: AgentToolRunInfo, p: AgentToolProgressSnapshot): Promise<void> {
    const live = this.researchLive.get(run.runId);
    const d = (p.data && typeof p.data === "object" ? p.data : {}) as Partial<ResearchProgressData>;
    if (live) {
      live.lastAt = Date.now();
      if (typeof d.steps === "number") live.steps = d.steps;
    }
    this.emit("researchProgress", {
      runId: run.runId, toolCallId: live?.toolCallId ?? run.parentToolCallId ?? null, source: "child",
      message: clip(String(p.message ?? ""), 120), phase: p.phase ?? null,
      steps: typeof d.steps === "number" ? d.steps : null, maxSteps: typeof d.maxSteps === "number" ? d.maxSteps : null,
      tool: typeof d.tool === "string" ? d.tool : null, llmCalls: typeof d.llmCalls === "number" ? d.llmCalls : null,
      elapsedMs: live ? Date.now() - live.startedAt : null,
    }, live?.turn ?? this.runningTurn());
  }

  // ---- T3 고침 2: 토큰 스트리밍 (text-delta → delta 이벤트) ----
  private deltaBuf = "";
  private deltaAt = 0;
  private flushDelta(): void {
    if (!this.deltaBuf) return;
    const text = this.deltaBuf;
    this.deltaBuf = "";
    this.deltaAt = Date.now();
    this.emit("delta", { text });
  }
  /** 토큰마다 불린다 (관찰 전용). 글 조각만 모아 두었다가 250ms·120자마다 `delta` 이벤트로 남긴다. 스텝이 끝나면 남은 것을 내보낸다. */
  onChunk(ctx: ChunkContext): void {
    const ch = ctx.chunk as { type: string; text?: string };
    if (ch.type !== "text-delta" || typeof ch.text !== "string" || !ch.text) return;
    this.deltaBuf += ch.text;
    if (this.deltaBuf.length >= DELTA_FLUSH_CHARS || Date.now() - this.deltaAt >= DELTA_FLUSH_MS) this.flushDelta();
  }

  /**
   * 도구 실행. 멱등 원장 키 = 턴 번호 + 도구 + 입력: 같은 턴의 복구 턴이 끝난 실행을 다시 하지 않는다 (at-least-once — 실행 도중 끊기면 다시 실행될 수 있다).
   * 다른 턴에서 같은 질문을 하면 새로 실행한다 (규정이 바뀌었을 수 있다).
   */
  private async runTool(name: ToolNodeType, args: Record<string, unknown>, toolCallId: string): Promise<unknown> {
    const owner = this.owner();
    const turnNo = this.runningTurn();
    if (!owner) return { error: "어시스턴트 소유자 정보가 없습니다." };
    if (!(ASSISTANT_TOOLS as string[]).includes(name) || (APPROVAL_REQUIRED_NODES as string[]).includes(name)) {
      return { error: "어시스턴트가 쓸 수 없는 도구라 실행하지 않았습니다." };
    }
    const key = `${turnNo}:${name}:${stableKey(args)}`;
    const prev = this.fxGet(key);
    if (prev?.state === "done") {
      this.emit("toolReplay", { tool: name, toolCallId });
      return prev.result;
    }
    this.fxPut(key, "started", null);
    const res = await this.execNode(name, this.nodeCtx(owner, turnNo), args);
    let out: unknown;
    if (res.status === "succeeded") {
      const s = asText(res.output ?? null, 4000);
      out = s.length >= 4000 ? { truncated: s } : (res.output ?? null);
    } else {
      out = { error: res.error || (res.status === "waiting_approval" ? "승인이 필요한 동작이라 실행하지 않았습니다." : "도구 실행 실패") };
    }
    this.fxPut(key, "done", out);
    return out;
  }

  // ---- 훅 ----
  beforeTurn(ctx: TurnContext): TurnConfig {
    const meta = this.activeTurnMetadata as { turnNo?: unknown } | undefined;
    const n = Number(meta?.turnNo) || this.kvGet<number>("turnSeq", 0);
    this.kvPut("runningTurn", n);
    const recovery = ctx.continuation || String(ctx.trigger ?? "").startsWith("recovery");
    const t = this.mutTurn((s) => {
      if (s.startedAt === null) s.startedAt = Date.now();
      s.status = "running";
      s.turnBase = s.steps;
      if (recovery) s.recoveries += 1;
    }, n);
    const active: string[] = [...ASSISTANT_TOOLS, RESEARCH_TOOL].filter((x) => Object.prototype.hasOwnProperty.call(ctx.tools, x));
    this.emit(recovery ? "turnResume" : "turnStart", {
      requestId: ctx.requestId, trigger: ctx.trigger ?? null, continuation: ctx.continuation, steps: t?.steps ?? 0,
      offered: Object.keys(ctx.tools).length, active,
    }, n);
    if (!t) return { activeTools: [], toolChoice: "none", maxSteps: 1 };
    if (this.checkLimits(t.steps)) return { activeTools: [], toolChoice: "none", maxSteps: 1 };
    const lim = this.limits();
    return {
      activeTools: active,
      maxSteps: Math.max(1, lim.maxSteps - t.steps),
      stopWhen: [(o: { steps: ReadonlyArray<unknown> }) => this.checkLimits((this.turnState(this.runningTurn())?.turnBase ?? 0) + o.steps.length) !== null],
    };
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    const t = this.turnState(this.runningTurn());
    const cum = (t?.turnBase ?? 0) + (ctx.stepNumber ?? 0);
    if (this.checkLimits(cum)) return { activeTools: [], toolChoice: "none" } as StepConfig;
  }

  beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const name = ctx.toolName;
    const block = (why: string, reason: string): ToolCallDecision => {
      this.emit("toolBlocked", { tool: name, toolCallId: ctx.toolCallId, why });
      return { action: "block", reason };
    };
    if ((!(ASSISTANT_TOOLS as string[]).includes(name) && name !== RESEARCH_TOOL) || (APPROVAL_REQUIRED_NODES as string[]).includes(name)) {
      return block("not_allowed", "어시스턴트가 쓸 수 없는 도구입니다. 메일은 초안(email_draft)까지만 만들 수 있습니다.");
    }
    const t = this.turnState(this.runningTurn());
    if (!t) return block("no_turn", "턴 정보가 없습니다.");
    if (t.stop) return block(t.stop, "한도에 걸려 더 실행하지 않습니다.");
    const lim = this.limits();
    if (t.startedAt !== null && Date.now() - t.startedAt > lim.timeoutMs) {
      this.setStop("timeout");
      return block("timeout", "실행 시간 상한을 넘어 도구를 실행하지 않았습니다.");
    }
    if ((THINK_LLM_TOOL_TYPES as string[]).includes(name) && t.llmCalls + 1 > lim.llmCap) {
      this.setStop("llm_cap");
      return block("llm_cap", "LLM 호출 상한에 도달해 실행하지 않았습니다.");
    }
    // 조사 위임: 자식이 최소 2회(스텝 1 + 도구 1)는 쓰므로 남은 예산이 2 미만이면 맡기지 않는다. 실제 사용량은 끝난 뒤 runResearch가 더한다.
    if (name === RESEARCH_TOOL && t.llmCalls + 2 > lim.llmCap) {
      return block("llm_cap", "남은 LLM 호출 수가 부족해 조사를 맡기지 않았습니다. 지금까지의 정보로 답하세요.");
    }
    let repeat = false;
    this.mutTurn((s) => {
      if ((THINK_LLM_TOOL_TYPES as string[]).includes(name)) s.llmCalls += 1;
      s.toolCalls += 1;
      s.lastTools = [...s.lastTools, name].slice(-10);
      const tail = s.lastTools.slice(-lim.repeatLimit);
      repeat = tail.length === lim.repeatLimit && tail.every((x) => x === tail[0]);
    });
    // 같은 도구 N번 연속: 이번 호출은 실행하고 이 스텝 끝에서 멈춘다 (T1·legacy와 같은 시점).
    if (repeat) this.setStop("repeat_tool");
    this.emit("toolStart", { tool: name, toolCallId: ctx.toolCallId, args: asText(ctx.input ?? {}, 300) });
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    const out = ctx.success ? (ctx.output as unknown) : undefined;
    const err = !ctx.success ? String((ctx as { error?: unknown }).error ?? "도구 실행 실패")
      : out && typeof out === "object" && "error" in (out as object) ? String((out as { error: unknown }).error) : null;
    const grounded = out && typeof out === "object" && "grounded" in (out as object) ? (out as { grounded: unknown }).grounded === true : undefined;
    this.emit("toolEnd", {
      tool: ctx.toolName, toolCallId: ctx.toolCallId, ok: !err,
      ...(err ? { error: clip(err, 300) } : { observation: asText(out ?? null, 300) }),
      ...(grounded !== undefined ? { grounded } : {}),
    });
  }

  onStepFinish(ctx: StepContext): void {
    this.flushDelta(); // 고침 2: 이 스텝의 남은 글 조각을 step 이벤트보다 먼저
    const c = ctx as unknown as { text?: string; reasoningText?: string; toolCalls?: Array<{ toolName: string }>; finishReason?: string };
    const calls = c.toolCalls ?? [];
    const reasoning = stripThink(c.reasoningText ?? "");
    const t = this.mutTurn((s) => {
      s.steps += 1;
      s.llmCalls += 1;
      if (reasoning) s.thinkingSteps += 1; else s.thinkingEmptySteps += 1;
      if (!calls.length) {
        const text = clip(stripThink(c.text ?? ""), 4000);
        if (text) s.final = text;
      }
    });
    this.emit("step", {
      step: t?.steps ?? null, tools: calls.map((x) => x.toolName), finishReason: c.finishReason ?? null,
      thinking: reasoning ? clip(reasoning, 300) : "", ...(calls.length ? {} : { text: clip(stripThink(c.text ?? ""), 300) }),
      llmCalls: t?.llmCalls ?? null,
    });
    if (t) this.checkLimits(t.steps);
  }

  protected async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions | void> {
    const t = this.turnState(this.runningTurn());
    const stopped = this.checkLimits(t?.steps ?? 0);
    this.emit("recovery", { attempt: ctx.attempt, kind: ctx.recoveryKind, stopped });
    if (stopped) return { continue: false, persist: true };
  }

  protected async onSubmissionStatus(sub: ThinkSubmissionInspection): Promise<void> {
    const n = this.kvGet<number | null>(`sub:${sub.submissionId}`, null);
    if (n === null || !TERMINAL.has(sub.status)) return;
    if (this.runningTurn() === n) this.flushDelta(); // 고침 2: 끊긴 스텝의 남은 조각 (turnEnd보다 먼저)
    const prev = this.turnState(n);
    if (!prev || TERMINAL.has(prev.status)) return; // 이미 마감 (중복 전달)
    const lim = this.limits();
    const t = this.mutTurn((s) => {
      s.status = sub.status as TurnState["status"];
      s.endedAt = Date.now();
      if (s.stop) s.final = `목표에 도달하기 전에 멈췄습니다: ${stopLabel(s.stop, lim)}.${s.final ? ` 마지막 응답: ${clip(s.final, 500)}` : ""}`;
      else if (!s.final && sub.status !== "completed") s.final = `답을 만들지 못했습니다 (${sub.status}${sub.error ? `: ${clip(sub.error, 200)}` : ""}).`;
    }, n);
    if (!t) return;
    this.emit("turnEnd", {
      status: t.status, stoppedReason: t.stop, steps: t.steps, llmCalls: t.llmCalls, toolCalls: t.toolCalls,
      ms: t.startedAt !== null && t.endedAt !== null ? t.endedAt - t.startedAt : null, final: clip(t.final ?? "", 1000),
      thinkingEmptySteps: t.thinkingEmptySteps, recoveries: t.recoveries, researchRuns: t.researchRuns ?? 0,
    }, n);
    await this.recordTurnSummary(t);
    // 한도로 멈췄으면 대화 기록에도 멈춤 안내를 남긴다 (턴을 새로 돌리지 않는 addMessages — 다음 턴에서 모델도 본다).
    if (t.stop) {
      try {
        await this.addMessages([{ id: `asst-stop-${n}`, role: "assistant", parts: [{ type: "text", text: t.final ?? "" }] }]);
      } catch (e) {
        this.emit("noteFailed", { error: clip(String(e), 200) }, n);
      }
    }
  }

  /**
   * T3: 관측 탭용 턴 요약 1행 (D1 assistant_turns, 마이그레이션 0041). 내용(질문·답)은 싣지 않는다.
   * 실패해도 턴에는 영향이 없다 (표가 없거나 D1 오류면 이벤트만 남긴다).
   */
  private async recordTurnSummary(t: TurnState): Promise<void> {
    const o = this.owner();
    if (!o) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO assistant_turns (user_id, turn_no, status, stopped_reason, steps, llm_calls, tool_calls, tools, research_runs, recoveries, duration_ms, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, turn_no) DO UPDATE SET status=excluded.status, stopped_reason=excluded.stopped_reason, steps=excluded.steps,
           llm_calls=excluded.llm_calls, tool_calls=excluded.tool_calls, tools=excluded.tools, research_runs=excluded.research_runs,
           recoveries=excluded.recoveries, duration_ms=excluded.duration_ms, started_at=excluded.started_at, ended_at=excluded.ended_at`,
      ).bind(
        o.id, t.turnNo, t.status, t.stop, t.steps, t.llmCalls, t.toolCalls, JSON.stringify(t.lastTools ?? []), t.researchRuns ?? 0, t.recoveries,
        t.startedAt !== null && t.endedAt !== null ? t.endedAt - t.startedAt : null,
        t.startedAt !== null ? new Date(t.startedAt).toISOString() : null, new Date(t.endedAt ?? Date.now()).toISOString(),
      ).run();
    } catch (e) {
      this.emit("summaryFailed", { error: clip(String(e), 200) }, t.turnNo);
    }
  }

  /** 하루 턴 상한 (하네스가 덮어써서 줄인다). */
  protected dailyCap(): number { return ASSISTANT_DAILY_TURNS; }
  /** 오늘 날짜 키 (하네스가 덮어써서 "다음 날"을 흉내 낸다). */
  protected dayKey(): string { return kstDay(); }
  private usage(): { day: string; used: number; cap: number } {
    const day = this.dayKey();
    return { day, used: this.kvGet<number>(`day:${day}`, 0), cap: this.dailyCap() };
  }
  private openTurns(): number {
    const seq = this.kvGet<number>("turnSeq", 0);
    let open = 0;
    for (let i = Math.max(1, seq - 5); i <= seq; i++) {
      const s = this.turnState(i);
      if (s && !TERMINAL.has(s.status)) open++;
    }
    return open;
  }

  // ---- 라우트가 부르는 RPC (라우트가 호출자 = 소유자임을 확인한 뒤에만 부른다. 여기서도 소유자를 한 번 더 본다) ----

  private assertOwner(userId: string): void {
    const o = this.owner();
    if (o && o.id !== userId) throw new Error("assistant_owner_mismatch");
  }

  /** 메시지 1개 제출. runTurn({mode:"submit"})으로 큐에 넣고 바로 돌려준다 (턴은 DO 안에서 이어 돈다). */
  async send(p: { user: AssistantOwner; text: string; clientId?: string }): Promise<{ turnNo: number; submissionId: string; accepted: boolean; status: string; duplicate?: boolean }> {
    this.assertOwner(p.user.id);
    this.kvPut("owner", { id: p.user.id, email: p.user.email, role: p.user.role, coaching_role: p.user.coaching_role, name: p.user.name } satisfies AssistantOwner);
    if (p.clientId) {
      const seen = this.kvGet<number | null>(`cid:${p.clientId}`, null);
      if (seen !== null) {
        const t = this.turnState(seen);
        return { turnNo: seen, submissionId: t?.submissionId ?? "", accepted: false, status: t?.status ?? "unknown", duplicate: true };
      }
    }
    // 동시에 열린 턴은 2개까지 (실행 중 1 + 대기 1). 그 이상은 라우트가 429로 바꾼다.
    const seq = this.kvGet<number>("turnSeq", 0);
    if (this.openTurns() >= 2) throw new Error("assistant_busy");
    // T3: 하루 턴 상한. 같은 clientId 재전송(위)은 세지 않는다. 제출이 실패하면(아래 catch) 되돌린다.
    const u = this.usage();
    if (u.used >= u.cap) throw new Error(`assistant_daily_limit:${u.cap}`);
    this.kvPut(`day:${u.day}`, u.used + 1);
    const n = seq + 1;
    const sid = `turn-${n}`;
    this.kvPut("turnSeq", n);
    this.kvPut(`sub:${sid}`, n);
    if (p.clientId) this.kvPut(`cid:${p.clientId}`, n);
    this.putTurn({
      turnNo: n, submissionId: sid, status: "queued", queuedAt: Date.now(), startedAt: null, endedAt: null, turnBase: 0,
      steps: 0, llmCalls: 0, toolCalls: 0, lastTools: [], stop: null, final: null, recoveries: 0, thinkingEmptySteps: 0, thinkingSteps: 0,
    });
    this.emit("turnQueued", { submissionId: sid, chars: p.text.length }, n);
    try {
      const r = await this.runTurn({ mode: "submit", input: p.text, submissionId: sid, idempotencyKey: sid, metadata: { turnNo: n } });
      return { turnNo: n, submissionId: r.submissionId, accepted: r.accepted, status: r.status };
    } catch (e) {
      // 제출 자체가 실패하면 턴을 error로 닫는다 — 안 닫으면 "열린 턴"으로 남아 이후 메시지가 계속 429가 된다.
      this.kvPut(`day:${u.day}`, Math.max(0, this.kvGet<number>(`day:${u.day}`, 1) - 1));
      const t = this.mutTurn((s) => { s.status = "error"; s.endedAt = Date.now(); s.final = "메시지를 접수하지 못했습니다. 다시 보내 주세요."; }, n);
      this.emit("turnEnd", { status: "error", stoppedReason: null, steps: 0, llmCalls: 0, toolCalls: 0, ms: null, final: t?.final ?? "", error: clip(String(e), 200) }, n);
      throw e;
    }
  }

  /** 진행 이벤트 (after 커서 이후). */
  async events(p: { userId: string; after?: number; limit?: number }): Promise<{ events: AssistantEvent[]; cursor: number; latestTurn: TurnState | null }> {
    this.assertOwner(p.userId);
    const after = Math.max(0, Math.floor(Number(p.after) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(p.limit) || 200)));
    const events = this.ctx.storage.sql.exec("SELECT id, ts, turn, ev, data FROM pos_ev WHERE id > ? ORDER BY id LIMIT ?", after, limit).toArray()
      .map((r) => ({ id: Number(r.id), ts: Number(r.ts), turn: Number(r.turn), ev: String(r.ev), data: JSON.parse(String(r.data)) as Record<string, unknown> }));
    const cursor = events.length ? events[events.length - 1].id : after;
    return { events, cursor, latestTurn: this.turnState(this.kvGet<number>("turnSeq", 0)) };
  }

  /** 대화 기록 (Think가 DO SQLite에 저장한 메시지) + 최근 턴 상태. */
  async history(p: { userId: string; limit?: number }): Promise<{ messages: Array<{ id: string; role: string; text: string; tools: Array<{ tool: string; state?: string }> }>; turns: TurnState[]; usage: { day: string; used: number; cap: number } }> {
    this.assertOwner(p.userId);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(p.limit) || 50)));
    const msgs = (await this.getMessages()).slice(-limit).map((m) => {
      const parts = (m.parts ?? []) as Array<{ type: string; text?: string; state?: string; toolName?: string }>;
      const text = parts.filter((x) => x.type === "text").map((x) => x.text ?? "").join("");
      const tools = parts.filter((x) => x.type.startsWith("tool-") || x.type === "dynamic-tool")
        .map((x) => ({ tool: x.type === "dynamic-tool" ? String(x.toolName ?? "") : x.type.slice(5), state: x.state }));
      return { id: m.id, role: m.role, text: m.role === "assistant" ? stripThink(text) : text, tools };
    });
    const seq = this.kvGet<number>("turnSeq", 0);
    const from = Math.max(1, seq - 9, this.kvGet<number>("clearedThrough", 0) + 1); // T3: 지운 대화의 턴은 화면에 다시 보이지 않는다
    const turns: TurnState[] = [];
    for (let i = from; i <= seq; i++) { const s = this.turnState(i); if (s) turns.push(s); }
    return { messages: msgs, turns, usage: this.usage() };
  }

  /**
   * T3: 대화 지우기. Think 대화 기록 + 하위 에이전트 실행 기록 + 진행 이벤트 + 도구 원장을 지운다.
   * 턴 상태(pos_kv turn:<n>)와 턴 번호·하루 사용량은 남긴다 (관측·한도용 — 지워도 하루 상한이 초기화되지 않는다).
   * 열린 턴이 있으면 지우지 않는다 (라우트가 409로 바꾼다).
   */
  async clear(p: { userId: string }): Promise<{ cleared: true; clearedThrough: number }> {
    this.assertOwner(p.userId);
    if (this.openTurns() > 0) throw new Error("assistant_busy_clear");
    await this.clearMessages();
    try { await this.clearAgentToolRuns(); } catch (e) { this.emit("clearRunsFailed", { error: clip(String(e), 200) }, 0); }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM pos_ev");
    sql.exec("DELETE FROM pos_fx");
    this.kvPut("evCount", 0);
    const seq = this.kvGet<number>("turnSeq", 0);
    this.kvPut("clearedThrough", seq);
    this.emit("cleared", { clearedThrough: seq }, 0); // AUTOINCREMENT라 이벤트 id는 지운 뒤에도 커서보다 커진다
    return { cleared: true, clearedThrough: seq };
  }

  /** 관측·하네스용 읽기 전용 상태. */
  async inspectState(): Promise<Record<string, unknown>> {
    const seq = this.kvGet<number>("turnSeq", 0);
    const turns: TurnState[] = [];
    for (let i = 1; i <= seq; i++) { const s = this.turnState(i); if (s) turns.push(s); }
    return { owner: this.owner(), turnSeq: seq, runningTurn: this.runningTurn(), turns, submissions: await this.listSubmissions() };
  }
}
