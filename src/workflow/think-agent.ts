// Think 전면 도입 T1 (2026-11-20): 워크플로우 agent 단계의 Think 런타임 DO.
// 계획: think-cloudflare-os-full-adoption-plan.md 2장 A·B·C·G. 참고 구현: think-gate/src/index.ts (T0 관문).
//
// 인스턴스 1개 = run 1개의 agent 단계 1개 (이름 = `think:<runId>:<stepIndex>`). legacy(WorkflowAgent, agent-do.ts)와 같은 단위다.
// 엔진(agent-think.ts)은 startStep()으로 제출(runTurn submit, 키 = `runId:stepIndex`)만 하고 끝낸다. 루프는 이 DO가 복구 파이버 안에서
// 스스로 돌고, 턴이 끝나면(onSubmissionStatus) 결과를 D1 workflow_agent_steps에 쓰고 workflow-step 메시지로 엔진을 깨운다.
//
// T0에서 넘겨받은 주의사항을 이렇게 반영했다.
// - 메모리 필드는 쓰지 않는다. 한도 카운터·멈춤 사유·승인 대기·활성 시작 시각은 전부 DO SQLite(pos_kv)에 둔다.
// - 스텝 상한·LLM 상한은 훅의 stepNumber가 아니라 저장소 누적값으로 센다 (복구 턴은 stepNumber를 0부터 다시 센다).
// - 복구 여부는 trigger === "recovery-*" / continuation으로 본다 (onChatResponse.recovered는 믿지 않는다).
// - 중단된 도구는 복구 턴에서 다시 실행된다 → 도구 실행에 멱등 원장(pos_fx)을 둔다.
//   · 일반 도구: 키 = 도구 + 입력. 끝난 실행은 저장된 결과를 돌려준다 (at-least-once, 끝난 것은 다시 안 함).
//   · 부작용 도구(send_email·webhook): 루프 안에서는 절대 실행하지 않는다(beforeToolCall 차단 + 노드의 approved 검사).
//     승인 뒤 resumeApproved()에서만 실행하고, 키 = `runId:stepIndex:toolCallId`로 "시작" 표시를 먼저 남긴다 (at-most-once).
// - activeTools로 도구를 반드시 좁힌다 (Think 기본 도구가 섞여 들어온다).
import { Think } from "@cloudflare/think";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
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
import { NODE_REGISTRY, executeNode } from "./nodes";
import { AGENT_LLM_CAP, AGENT_REPEAT_LIMIT, AGENT_TIMEOUT_MS, type AgentTurn, type StopReason } from "./agent-do";
import {
  APPROVAL_REQUIRED_NODES, DEFERRABLE_NODES, TOOL_NODE_TYPES, WEBHOOK_METHODS,
  type Env, type NodeContext, type NodeResult, type NodeType, type ToolNodeType,
} from "./types";

/** LLM을 부르는 도구 노드 (engine.ts LLM_NODE_TYPES와 같은 목록 — 순환 import를 피하려고 여기 둔다). */
export const THINK_LLM_TOOL_TYPES: ToolNodeType[] = ["ask_rag", "ask_personal", "summarize", "reflect_coach", "reflect_coachee", "llm", "email_draft"];
const OBS_MAX = 1500;
const CTX_MAX = 3000;
const TERMINAL = new Set(["completed", "aborted", "skipped", "error"]);

export function thinkAgentName(runId: string, stepIndex: number): string {
  return `think:${runId}:${stepIndex}`;
}

// ---------------------------------------------------------------------------
// 도구 변환: NODE_REGISTRY → AI SDK 도구 (설명·입력 키를 그대로 쓴다)
// ---------------------------------------------------------------------------

/** 필수 입력 키. 나머지 입력 키는 선택(optional)이다. 노드가 실행 시점에 다시 검증한다. */
const REQUIRED_KEYS: Partial<Record<ToolNodeType, string[]>> = {
  ask_rag: ["question"], ask_personal: ["question"], summarize: ["docId"], draft_pptx: ["title", "bullets"],
  email_draft: ["to", "context"], send_email: ["to", "subject", "body"], create_task: ["title"], llm: ["prompt"],
  create_calendar_event: ["title", "start"], webhook: ["url"], condition: ["source", "operator"],
};

const KEY_HINTS: Record<string, string> = {
  question: "질문 문장", docId: "문서 id", recordingId: "녹음 id", transcript: "전사 텍스트", title: "제목",
  bullets: "슬라이드 불릿 문장 목록", to: "받는 사람 메일 주소 (여러 명이면 쉼표로 구분)", context: "메일에 담을 상황 설명",
  subject: "메일 제목", body: "본문", dueDate: "기한 YYYY-MM-DD (선택)", prompt: "LLM에 보낼 프롬프트",
  start: "시작 시각 ISO 8601", end: "종료 시각 ISO 8601", allDay: "종일 일정이면 true", url: "호출할 https URL",
  method: "HTTP 메서드", headers: "HTTP 헤더 (값은 문자열)", source: "비교할 값의 경로", operator: "비교 연산자", value: "비교할 값",
  // pptx_edit (2026-11-21) — 기본 도구 목록에는 없다 (tools에 명시했을 때만 열린다).
  deckId: "편집할 덱 id", ops: "PPTX 편집 op 배열 (JSON)", instruction: "덱을 어떻게 고칠지 자연어 지시",
  // xlsx_edit (2026-11-21) — 노드별 힌트 ("<노드>.<키>"가 있으면 그것을 쓴다). 기본 도구 목록에는 없다.
  "xlsx_edit.docId": "편집할 업로드 .xlsx 문서 id", "xlsx_edit.ops": "XLSX 편집 op 배열 (JSON: cell·formula·row·sheet)",
  "xlsx_edit.instruction": "워크북을 어떻게 고칠지 자연어 지시",
  // docx_edit (2026-11-22) — 기본 도구 목록에는 없다.
  "docx_edit.docId": "편집할 .docx 문서 id", "docx_edit.ops": "DOCX 편집 op 배열 (JSON: replace·paragraph·cell·insert·delete)",
  "docx_edit.instruction": "Word 문서를 어떻게 고칠지 자연어 지시",
  // docx_create (2026-11-21) — 기본 도구 목록에는 없다.
  "docx_create.title": "새 Word 문서 제목", "docx_create.instruction": "어떤 문서를 쓸지 자연어 지시",
  "docx_create.definition": "문서 정의 JSON 문자열 {title, sections:[{heading, level, paragraphs, bullets, numbered, table:{header, rows}}]} (instruction 대신)",
  // docx_create 확장 (2026-11-22): 이미지·목차·머리말/바닥글 — 모두 선택.
  "docx_create.images": "문서에 넣을 이미지 문서 id (여러 개면 쉼표로 구분, 선택)", "docx_create.toc": "목차를 넣으려면 \"true\" (선택)",
  "docx_create.header": "머리말 문구 (선택)", "docx_create.footer": "바닥글 문구 (선택)", "docx_create.pageNumber": "바닥글에 쪽 번호를 넣으려면 \"true\" (선택)",
};

function keySchema(toolName: ToolNodeType, key: string): z.ZodType {
  let s: z.ZodType;
  switch (key) {
    case "bullets": s = z.array(z.string()); break;
    case "allDay": s = z.boolean(); break;
    case "headers": s = z.record(z.string(), z.string()); break;
    case "method": s = z.enum(WEBHOOK_METHODS); break;
    case "body": s = toolName === "webhook" ? z.unknown() : z.string(); break;
    case "value": s = z.unknown(); break;
    default: s = z.string();
  }
  return s.describe(KEY_HINTS[`${toolName}.${key}`] ?? KEY_HINTS[key] ?? key);
}

/** 노드 1개의 입력 스키마 (zod 객체). 하네스가 이 함수로 "설명·입력 키 유지"를 확인한다. */
export function nodeInputSchema(toolName: ToolNodeType): z.ZodObject<Record<string, z.ZodType>> {
  const required = new Set(REQUIRED_KEYS[toolName] ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const k of NODE_REGISTRY[toolName].inputKeys) shape[k] = required.has(k) ? keySchema(toolName, k) : keySchema(toolName, k).optional();
  return z.object(shape);
}

export type NodeToolExecutor = (toolName: ToolNodeType, args: Record<string, unknown>, toolCallId: string) => Promise<unknown>;

/**
 * NODE_REGISTRY의 모든 노드(agent 제외 14종 — agent는 레지스트리에 없다)를 AI SDK 도구로 바꾼다.
 * 실제로 모델에 열리는 도구는 beforeTurn의 activeTools가 정한다 (agent 설정의 tools ∩ TOOL_NODE_TYPES — condition 제외 13종 안에서).
 */
export function buildNodeTools(exec: NodeToolExecutor): ToolSet {
  const out: ToolSet = {};
  for (const name of Object.keys(NODE_REGISTRY) as ToolNodeType[]) {
    const entry = NODE_REGISTRY[name];
    const gated = APPROVAL_REQUIRED_NODES.includes(name) ? " (밖으로 나가는 동작: 사람의 승인 뒤에만 실행된다)" : "";
    out[name] = tool({
      description: `${entry.description}${gated} 결과 키: ${entry.outputKeys.join(", ")}`,
      inputSchema: nodeInputSchema(name),
      execute: async (input, opts) => exec(name, (input ?? {}) as Record<string, unknown>, opts.toolCallId),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DO
// ---------------------------------------------------------------------------

/** 엔진이 넘기는 작업 정보 (startStep 1회만 저장된다). */
export interface ThinkJob {
  runId: string;
  workflowId: string;
  stepIndex: number;
  stepName: string;
  user: NodeContext["user"];
  input: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  goal: string;
  tools: ToolNodeType[];
  maxSteps: number;
  /** step.requiresApproval === true: 고르는 모든 도구가 승인을 받는다 (legacy와 같은 규칙). */
  gatedAll: boolean;
  /** 비동기 승인 P2: approvalMode "deferred" 단계. send_email·webhook을 차단하지 않고 대기열에 넣은 뒤 턴을 계속한다. 없으면 동기식. */
  deferred?: boolean;
  /** 이 agent 단계가 쓸 수 있는 LLM 호출 수 = run 전체 캡(30) − 이 단계 전에 쓴 LLM 호출 수. */
  llmBudget: number;
}
export interface ThinkStartInput extends ThinkJob { activeSinceMs: number }

type Stop = StopReason | "approval_required";
export interface PendingTool { turn: number; tool: ToolNodeType; args: Record<string, unknown>; toolCallId: string; thinking: string }
export type ThinkOutcome =
  | { submissionId: string; status: "completed"; result: { final: string; turns: AgentTurn[]; stoppedReason: StopReason | null; runtime: "think"; submissionId: string; steps: number; llmCalls: number } }
  | { submissionId: string; status: "approval"; result: PendingTool & { runtime: "think"; submissionId: string } }
  | { submissionId: string; status: "failed"; result: { error: string; runtime: "think"; submissionId: string } };

/** 한도 (하네스가 서브클래스에서 줄여 시험한다). */
export interface ThinkLimits { timeoutMs: number; repeatLimit: number; agentLlmCap: number }

// T3 고침 3(한국어 판단 근거)은 미완: 시스템 프롬프트·사용자 메시지(한국어·영어 문장)로 지시해도 Qwen의 thinking이 영어로 나와
// 프롬프트를 바꾸지 않았다 (T3-FIXES-RESULT.md 3번, t3-fixes-harness/out-real-wf-*.json).
const PROMPT_HEAD = [
  "너는 People OS 워크플로우 안에서 일하는 에이전트다. 사용자가 준 목표에 다가가기 위해 주어진 도구를 골라 부르고, 목표에 도달하면 도구 없이 한국어로 최종 답을 쓴다.",
  "규칙:",
  "(a) 한 번에 도구 하나만 부른다. 주어진 도구 목록에 있는 것만 쓸 수 있다.",
  "(b) 목표에 도달했으면 도구를 더 부르지 말고 최종 답을 쓴다.",
  "(c) 이미 얻은 결과를 다시 얻으려고 같은 도구를 반복해서 부르지 않는다.",
  "(d) 모르면 추측하지 말고 할 수 없다고 이유와 함께 밝힌다.",
];
/** 동기식 규칙 (e) — 문구 그대로. */
const SYSTEM_PROMPT = [
  ...PROMPT_HEAD,
  "(e) 메일 발송(send_email)·외부 호출(webhook)처럼 밖으로 나가는 동작은 사람의 승인을 받은 뒤에만 실행된다. 승인 대기라는 결과를 받으면 다시 부르지 말고 멈춘다.",
].join("\n");
/** 비동기 승인 P2: 지연 모드 규칙 (e). 대기열에 넣었다는 결과를 받으면 멈추지 않고 이어 가되, 실행됐다고 말하지 않는다. */
const SYSTEM_PROMPT_DEFERRED = [
  ...PROMPT_HEAD,
  "(e) 메일 발송(send_email)·외부 호출(webhook)처럼 밖으로 나가는 동작은 바로 실행되지 않고 승인 대기열에 들어간다. 사람이 승인해야 실행된다. 대기열에 넣었다는 결과(queued: true, executed: false)를 받으면 같은 동작을 다시 부르지 말고 남은 목표를 이어서 진행한다. 최종 답에서는 그 동작이 아직 실행되지 않았고 승인되면 실행된다고 말한다. \"보냈습니다\"·\"발송했습니다\"·\"호출했습니다\"처럼 이미 실행된 것처럼 쓰지 않는다.",
].join("\n");
/** 비동기 승인 P2: 대기열에 넣은 도구의 결과로 모델에 돌려주는 안내. */
export const DEFERRED_TOOL_NOTICE = "대기열에 넣었습니다. 아직 실행되지 않았습니다. 승인되면 실행됩니다. 같은 동작을 다시 부르지 말고, 최종 답에서는 아직 실행되지 않았다고 말하세요.";

// T2: 어시스턴트(src/assistant/agent.ts)가 같은 도우미를 쓰도록 export만 붙였다 (동작 변화 없음).
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
export function asText(v: unknown, n: number): string {
  if (v === undefined) return "";
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return clip(s ?? "", n);
}
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
/** 입력 객체를 키 순서와 무관한 문자열로 (멱등 원장 키). */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableKey((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function thinkStopFinal(reason: StopReason, turns: AgentTurn[], limits: ThinkLimits): string {
  const label: Record<StopReason, string> = {
    max_steps: "최대 단계 수에 도달",
    repeat_tool: `같은 도구를 ${limits.repeatLimit}번 연속으로 호출`,
    timeout: "실행 시간 상한(30분)에 도달",
    llm_cap: "LLM 호출 상한에 도달",
    tool_selection_failed: "모델이 도구 선택에 실패",
  };
  const last = [...turns].reverse().find((t) => t.observation !== undefined);
  return `목표에 도달하기 전에 멈췄습니다: ${label[reason]}.${last ? ` 마지막 관찰: ${clip(last.observation ?? "", 500)}` : ""}`;
}

export class ThinkAgent extends Think<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS pos_kv (k TEXT PRIMARY KEY, v TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS pos_fx (k TEXT PRIMARY KEY, state TEXT, result TEXT, at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS pos_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ev TEXT, data TEXT)");
  }

  // ---- 저장 도우미 (전부 동기 SQL — await 사이에 끼어드는 요청이 없도록 판단과 기록을 한 블록에서 끝낸다) ----
  protected kvGet<T>(k: string, fallback: T): T {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM pos_kv WHERE k = ?", k).toArray();
    return rows.length ? (JSON.parse(String(rows[0].v)) as T) : fallback;
  }
  protected kvPut(k: string, v: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO pos_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v ?? null));
  }
  private num(k: string): number { return this.kvGet<number>(k, 0); }
  private bump(k: string, by = 1): number { const n = this.num(k) + by; this.kvPut(k, n); return n; }
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
  protected log(ev: string, data?: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO pos_log (ts, ev, data) VALUES (?, ?, ?)", Date.now(), ev, JSON.stringify(data ?? null));
  }
  private job(): ThinkJob | null { return this.kvGet<ThinkJob | null>("job", null); }
  private stop(): Stop | null { return this.kvGet<Stop | null>("stop", null); }
  private setStop(s: Stop): void { if (!this.stop()) { this.kvPut("stop", s); this.log("stop", { reason: s }); } }
  private turns(): AgentTurn[] { return this.kvGet<AgentTurn[]>("turns", []); }

  /** 한도 (하네스가 덮어써서 줄인다). */
  protected limits(): ThinkLimits {
    return { timeoutMs: AGENT_TIMEOUT_MS, repeatLimit: AGENT_REPEAT_LIMIT, agentLlmCap: AGENT_LLM_CAP };
  }
  /** 노드 실행 (하네스가 덮어써서 부작용 실행 횟수를 센다). */
  protected execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    return executeNode(type, ctx, args);
  }
  private nodeCtx(job: ThinkJob, approved: boolean): NodeContext {
    return { env: this.env, user: job.user, runId: job.runId, workflowId: job.workflowId, stepIndex: job.stepIndex, input: job.input, stepOutputs: job.stepOutputs, approved };
  }
  private gated(job: ThinkJob, name: string): boolean {
    return job.gatedAll || (APPROVAL_REQUIRED_NODES as string[]).includes(name);
  }
  /** 비동기 승인 P2: 지연 모드에서 차단 대신 대기열에 넣을 도구인가 (send_email·webhook만). */
  private deferrable(job: ThinkJob, name: string): boolean {
    return job.deferred === true && (DEFERRABLE_NODES as string[]).includes(name);
  }
  /**
   * 지연 동작의 턴 번호. 원장 키(도구+입력)마다 한 번 정해 저장한다 → 복구 턴이 같은 호출을 다시 실행해도 같은 id(INSERT OR IGNORE),
   * 한 스텝에 서로 다른 동작이 둘이어도 id가 겹치지 않는다. 기본값은 지금 진행 중인 모델 스텝 번호(turns의 turn과 같다).
   */
  private deferTurn(key: string): number {
    const m = this.kvGet<Record<string, number>>("deferTurns", {});
    if (typeof m[key] === "number") return m[key];
    const used = new Set(Object.values(m));
    let t = this.num("steps");
    while (used.has(t)) t++;
    m[key] = t;
    this.kvPut("deferTurns", m);
    return t;
  }

  /**
   * 한도 판정. 걸리면 멈춤 사유를 저장소에 남기고 돌려준다. cumSteps = 지금까지 끝난 모델 스텝 수(누적).
   * 스텝·LLM 상한은 저장소 누적값 기준이라 복구 턴에서 stepNumber가 0으로 돌아가도 그대로 걸린다.
   */
  private checkLimits(cumSteps?: number): Stop | null {
    const cur = this.stop();
    if (cur) return cur;
    const job = this.job();
    if (!job) return null;
    const lim = this.limits();
    const steps = Math.max(this.num("steps"), cumSteps ?? 0);
    let r: StopReason | null = null;
    if (steps >= job.maxSteps) r = "max_steps";
    else if (Date.now() - this.num("activeSinceMs") > lim.timeoutMs) r = "timeout";
    else if (this.num("modelCalls") >= lim.agentLlmCap || this.num("llmCalls") >= job.llmBudget) r = "llm_cap";
    if (r) this.setStop(r);
    return r;
  }

  // ---- Think 설정 ----
  getModel(): ThinkModel {
    return LLM_MODEL; // @cf/qwen/qwen3.8-27b — T0 관문 3에서 도구 선택 10/10
  }
  getSystemPrompt() {
    // P2: 지연 모드 단계만 규칙 (e)가 다르다 (Think는 턴마다 이 메서드를 다시 읽는다 — job은 startStep에서 먼저 저장된다).
    return this.job()?.deferred ? SYSTEM_PROMPT_DEFERRED : SYSTEM_PROMPT;
  }
  getTools(): ToolSet {
    return buildNodeTools((name, args, toolCallId) => this.runTool(name, args, toolCallId));
  }

  /** 루프 안의 도구 실행. 부작용 도구는 beforeToolCall에서 이미 막혔다 — 여기서도 approved:false로만 부른다 (2차 방어). */
  private async runTool(name: ToolNodeType, args: Record<string, unknown>, toolCallId: string): Promise<unknown> {
    const job = this.job();
    if (!job) return { error: "작업 정보가 없습니다." };
    const defer = this.deferrable(job, name);
    if (this.gated(job, name) && !defer) return { error: "승인이 필요한 도구라 실행하지 않았습니다." };
    const key = `${name}:${stableKey(args)}`;
    const prev = this.fxGet(key);
    if (prev?.state === "done") {
      this.log("toolReplay", { tool: name, toolCallId });
      return prev.result;
    }
    this.fxPut(key, "started", null);
    // P2: 지연 모드면 approved:false + deferActions로 부른다 → 노드가 검증 뒤 대기 동작을 쌓고 시뮬레이션 출력을 돌려준다 (실행 없음).
    const ctx = this.nodeCtx(job, false);
    if (defer) { ctx.deferActions = true; ctx.deferTurn = this.deferTurn(key); }
    const res = await this.execNode(name, ctx, args);
    let out: unknown;
    if (defer && res.status === "succeeded") {
      // 모델이 "보냈다"고 착각하지 않도록: 실행 안 됨을 필드와 문장 둘 다로 알린다. simulated:true는 노드 출력 그대로 남긴다.
      out = { queued: true, executed: false, notice: DEFERRED_TOOL_NOTICE, ...((res.output ?? {}) as Record<string, unknown>) };
      this.log("toolDeferred", { tool: name, toolCallId, pendingActionId: (res.output as { pendingActionId?: string } | undefined)?.pendingActionId });
    } else if (defer && res.status === "waiting_approval") {
      // 지연 모드에서 노드가 승인을 요구할 일은 없다 (방어). 실행하지 않고 실패로 돌려준다 — 턴을 멈추지 않는다.
      out = { error: "승인 대기열에 넣지 못했습니다 (실행하지 않음)." };
    } else if (res.status === "succeeded") {
      const s = asText(res.output ?? null, 4000);
      out = s.length >= 4000 ? { truncated: s } : (res.output ?? null);
    } else if (res.status === "waiting_approval") {
      // 2차 방어선: 노드가 스스로 승인을 요구했다. 승인 대기로 멈춘다 (결과는 원장에 남기지 않는다).
      if (!this.kvGet<PendingTool | null>("pending", null)) {
        this.kvPut("pending", { turn: this.num("steps"), tool: name, args, toolCallId, thinking: "" } satisfies PendingTool);
      }
      this.setStop("approval_required");
      return { error: "승인이 필요한 동작이라 실행하지 않았습니다. 승인 대기로 멈춥니다." };
    } else {
      out = { error: res.error || "도구 실행 실패" };
    }
    this.fxPut(key, "done", out);
    return out;
  }

  // ---- 훅: 도구 좁히기·한도·승인 차단 ----
  beforeTurn(ctx: TurnContext): TurnConfig {
    const job = this.job();
    if (!job) return { activeTools: [], maxSteps: 1 };
    const steps = this.num("steps");
    this.kvPut("turnBase", steps);
    const active = job.tools.filter((t) => (TOOL_NODE_TYPES as string[]).includes(t) && Object.prototype.hasOwnProperty.call(ctx.tools, t));
    this.log("beforeTurn", { requestId: ctx.requestId, trigger: ctx.trigger, continuation: ctx.continuation, steps, offered: Object.keys(ctx.tools).length, active });
    const stopped = this.checkLimits(steps);
    if (stopped) {
      // 이미 멈춰야 하는 상태로 턴이 열렸다 (승인 재개 직후 등). 도구 없이 1스텝만 — 보통은 onChatRecovery·resumeApproved가 먼저 막는다.
      return { activeTools: [], toolChoice: "none", maxSteps: 1 };
    }
    return {
      activeTools: active,
      maxSteps: Math.max(1, job.maxSteps - steps), // Think의 안전 상한 (턴마다 다시 센다 → 남은 수로 준다)
      stopWhen: [(o: { steps: ReadonlyArray<unknown> }) => this.checkLimits(this.num("turnBase") + o.steps.length) !== null],
    };
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    const cum = this.num("turnBase") + (ctx.stepNumber ?? 0);
    this.log("beforeStep", { step: ctx.stepNumber, cum });
    // 스텝 수·경과 시간: 이미 넘었으면 도구를 닫는다 (stopWhen이 놓친 경우의 예비 — 복구 턴 첫 스텝 등).
    if (this.checkLimits(cum)) return { activeTools: [], toolChoice: "none" } as StepConfig;
  }

  beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const job = this.job();
    if (!job) return { action: "block", reason: "작업 정보가 없습니다." };
    const name = ctx.toolName;
    const obs = (o: string) => { const m = this.kvGet<Record<string, string>>("obs", {}); m[ctx.toolCallId] = o; this.kvPut("obs", m); };
    const block = (why: string, reason: string): ToolCallDecision => {
      obs(`(차단) ${reason}`);
      this.log("toolBlocked", { tool: name, why, toolCallId: ctx.toolCallId });
      return { action: "block", reason };
    };
    const cur = this.stop();
    if (cur) return block(cur, cur === "approval_required" ? "다른 동작이 승인을 기다리고 있어 실행하지 않았습니다." : "한도에 걸려 더 실행하지 않습니다.");
    if (Date.now() - this.num("activeSinceMs") > this.limits().timeoutMs) {
      this.setStop("timeout");
      return block("timeout", "실행 시간 상한을 넘어 도구를 실행하지 않았습니다.");
    }
    if (this.gated(job, name) && !this.deferrable(job, name)) {
      // (P2: 지연 모드의 send_email·webhook은 차단하지 않는다 — runTool이 대기열에 넣는다. pending·approval_required 없음.)
      // 승인 차단 (G): 실행하지 않고 저장소에 남긴 뒤 턴을 끝낸다 → 엔진이 기존 승인 게이트(알림·결재함·approval.js)로 보낸다.
      if (!this.kvGet<PendingTool | null>("pending", null)) {
        this.kvPut("pending", { turn: this.num("steps"), tool: name as ToolNodeType, args: (ctx.input ?? {}) as Record<string, unknown>, toolCallId: ctx.toolCallId, thinking: "" } satisfies PendingTool);
      }
      this.setStop("approval_required");
      return block("approval_required", "승인이 필요한 동작입니다. 승인 요청을 남겼고 실행하지 않았습니다. 다시 부르지 말고 멈추세요.");
    }
    if ((THINK_LLM_TOOL_TYPES as string[]).includes(name)) {
      // LLM 도구도 run 전체 LLM 캡에 합산한다.
      if (this.num("llmCalls") + 1 > job.llmBudget) {
        this.setStop("llm_cap");
        return block("llm_cap", "LLM 호출 상한에 도달해 실행하지 않았습니다.");
      }
      this.bump("llmCalls");
    }
    // 반복: 같은 도구 N번 연속이면 이번 호출은 실행하고 이 스텝 끝에서 멈춘다 (legacy와 같은 시점).
    const lastTools = [...this.kvGet<string[]>("lastTools", []), name].slice(-10);
    this.kvPut("lastTools", lastTools);
    const n = this.limits().repeatLimit;
    const tail = lastTools.slice(-n);
    if (tail.length === n && tail.every((t) => t === tail[0])) this.setStop("repeat_tool");
    this.log("toolCall", { tool: name, toolCallId: ctx.toolCallId });
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    const m = this.kvGet<Record<string, string>>("obs", {});
    if (m[ctx.toolCallId] === undefined) {
      const out = ctx.success ? (ctx.output as unknown) : undefined;
      const err = !ctx.success ? String((ctx as { error?: unknown }).error ?? "도구 실행 실패")
        : out && typeof out === "object" && "error" in (out as object) ? String((out as { error: unknown }).error) : null;
      m[ctx.toolCallId] = err ? `(실패) ${clip(err, OBS_MAX)}` : asText(out ?? null, OBS_MAX);
      this.kvPut("obs", m);
    }
    this.log("toolDone", { tool: ctx.toolName, success: ctx.success });
  }

  /** 모델 스텝 1개 = 기존 turns 1개 (관측 API가 turns 길이를 LLM 호출 수로 센다). */
  onStepFinish(ctx: StepContext): void {
    const turnNo = this.num("steps");
    this.bump("steps");
    this.bump("modelCalls");
    this.bump("llmCalls");
    const c = ctx as unknown as { text?: string; reasoningText?: string; toolCalls?: Array<{ toolName: string; toolCallId: string; input: unknown }>; finishReason?: string };
    const calls = c.toolCalls ?? [];
    const obs = this.kvGet<Record<string, string>>("obs", {});
    const thinking = clip(stripThink(c.reasoningText ?? "") || (calls.length ? stripThink(c.text ?? "") : ""), 1000);
    const at = new Date().toISOString();
    let turn: AgentTurn & { calls?: Array<{ tool: string; args: unknown; observation?: string }> };
    if (calls.length) {
      const first = calls[0];
      turn = { turn: turnNo, thinking, action: "tool", tool: first.toolName as ToolNodeType, args: (first.input ?? {}) as Record<string, unknown>, observation: obs[first.toolCallId], at };
      if (calls.length > 1) turn.calls = calls.map((x) => ({ tool: x.toolName, args: x.input, observation: obs[x.toolCallId] }));
      const p = this.kvGet<PendingTool | null>("pending", null);
      if (p && !p.thinking && calls.some((x) => x.toolCallId === p.toolCallId)) this.kvPut("pending", { ...p, thinking });
    } else {
      const text = clip(stripThink(c.text ?? ""), 4000);
      turn = text ? { turn: turnNo, thinking, action: "finish", final: text, at } : { turn: turnNo, thinking, action: "invalid", error: `빈 응답 (${c.finishReason ?? "?"})`, at };
    }
    const turns = this.turns();
    turns.push(turn);
    this.kvPut("turns", turns);
    this.log("stepFinish", { step: ctx.stepNumber, turnNo, tools: calls.map((x) => x.toolName), finishReason: c.finishReason });
    this.checkLimits(turnNo + 1);
  }

  protected async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions | void> {
    const stopped = this.checkLimits(this.num("steps"));
    this.log("chatRecovery", { attempt: ctx.attempt, kind: ctx.recoveryKind, stopped });
    // 이미 멈춘 상태(한도·승인 대기)면 이어 돌지 않는다 — 제출이 끝나면 onSubmissionStatus가 멈춤 결과를 전달한다.
    if (stopped) return { continue: false, persist: true };
  }

  // ---- 결과 전달 (엔진 연결 C) ----
  private buildOutcome(sub: ThinkSubmissionInspection): ThinkOutcome {
    const sid = sub.submissionId;
    const stop = this.stop();
    const turns = this.turns();
    const pending = this.kvGet<PendingTool | null>("pending", null);
    const base = { runtime: "think" as const, submissionId: sid };
    if (stop === "approval_required" && pending) return { submissionId: sid, status: "approval", result: { ...pending, ...base } };
    const counts = { steps: this.num("steps"), llmCalls: this.num("llmCalls") };
    if (stop && stop !== "approval_required") {
      return { submissionId: sid, status: "completed", result: { final: thinkStopFinal(stop, turns, this.limits()), turns, stoppedReason: stop, ...base, ...counts } };
    }
    if (sub.status === "completed") {
      const fin = [...turns].reverse().find((t) => t.action === "finish");
      if (fin?.final) return { submissionId: sid, status: "completed", result: { final: fin.final, turns, stoppedReason: null, ...base, ...counts } };
      const job = this.job();
      const reason: StopReason = job && counts.steps >= job.maxSteps ? "max_steps" : "tool_selection_failed";
      if (reason === "max_steps") return { submissionId: sid, status: "completed", result: { final: thinkStopFinal(reason, turns, this.limits()), turns, stoppedReason: reason, ...base, ...counts } };
      return { submissionId: sid, status: "failed", result: { error: "에이전트가 최종 답 없이 턴을 끝냈습니다.", ...base } };
    }
    return { submissionId: sid, status: "failed", result: { error: `Think 턴이 ${sub.status} 상태로 끝났습니다${sub.error ? `: ${clip(sub.error, 300)}` : ""}.`, ...base } };
  }

  protected async onSubmissionStatus(sub: ThinkSubmissionInspection): Promise<void> {
    this.log("submissionStatus", { id: sub.submissionId, status: sub.status, requestId: sub.requestId, error: sub.error });
    if (!TERMINAL.has(sub.status)) return;
    if (sub.submissionId !== this.kvGet<string | null>("currentSubmission", null)) return; // 옛 제출 (중복 전달)
    const outcome = this.buildOutcome(sub);
    this.kvPut("outcome", outcome);
    await this.deliver({ submissionId: sub.submissionId, attempt: 0 });
  }

  /**
   * 결과를 D1에 쓰고 workflow-step 메시지로 엔진을 깨운다. 멱등. 엔진이 결과를 처리했다는 표시(consumed_submission)가
   * 없으면 2분 뒤 다시 깨운다 (최대 5회) — 깨우는 메시지가 점유 경합 등으로 버려져도 run이 멈춰 있지 않게.
   * 스케줄 콜백으로도 불린다 (public).
   */
  async deliver(p: { submissionId: string; attempt: number }): Promise<void> {
    const outcome = this.kvGet<ThinkOutcome | null>("outcome", null);
    const job = this.job();
    if (!outcome || !job || outcome.submissionId !== p.submissionId) return;
    try {
      const now = new Date().toISOString();
      // T3 고침 4(b): 엔진이 이미 이 제출을 처리했으면(재알림 알람) 행을 다시 쓰지 않는다 — updated_at이 단계 끝 시각으로 남는다
      // (관측 API가 created_at→updated_at을 think 단계 소요 시간으로 쓴다). 처리 표시는 결과를 읽은 뒤에만 남으므로 결과는 이미 D1에 있다.
      const done = await this.env.DB.prepare("SELECT consumed_submission FROM workflow_agent_steps WHERE run_id=? AND step_index=?")
        .bind(job.runId, job.stepIndex).first<{ consumed_submission: string | null }>();
      if (done?.consumed_submission === p.submissionId) return;
      await this.env.DB.prepare(
        "UPDATE workflow_agent_steps SET status=?, result_json=?, submission_id=?, steps=?, llm_calls=?, updated_at=? WHERE run_id=? AND step_index=?",
      ).bind(outcome.status, JSON.stringify(outcome.result), outcome.submissionId, this.num("steps"), this.num("llmCalls"), now, job.runId, job.stepIndex).run();
      const row = await this.env.DB.prepare("SELECT consumed_submission FROM workflow_agent_steps WHERE run_id=? AND step_index=?")
        .bind(job.runId, job.stepIndex).first<{ consumed_submission: string | null }>();
      if (row?.consumed_submission === p.submissionId) return;
      await this.env.PIPELINE.send({ type: "workflow-step", runId: job.runId, stepIndex: job.stepIndex, enqueuedAt: now, thinkSubmissionId: p.submissionId });
      this.log("wake", { submissionId: p.submissionId, attempt: p.attempt, status: outcome.status });
      if (p.attempt < 5) await this.schedule(120, "deliver", { submissionId: p.submissionId, attempt: p.attempt + 1 });
    } catch (e) {
      this.log("wakeFailed", { attempt: p.attempt, error: String(e).slice(0, 300) });
      if (p.attempt < 8) await this.schedule(30, "deliver", { submissionId: p.submissionId, attempt: p.attempt + 1 });
    }
  }

  // ---- 엔진이 부르는 RPC ----

  /** 첫 제출. 같은 단계의 중복 메시지는 같은 키라 accepted:false로 끝난다. */
  async startStep(inp: ThinkStartInput): Promise<{ submissionId: string; accepted: boolean; status: string }> {
    const key = `${inp.runId}:${inp.stepIndex}`;
    if (!this.job()) {
      const { activeSinceMs, ...job } = inp;
      this.kvPut("job", job);
      this.kvPut("activeSinceMs", activeSinceMs);
      this.kvPut("currentSubmission", key);
    }
    const job = this.job() as ThinkJob;
    const text = [
      `목표:\n${job.goal}`,
      `run 입력: ${asText(job.input ?? {}, CTX_MAX)}`,
      `앞 단계 출력: ${asText(job.stepOutputs ?? {}, CTX_MAX)}`,
      `최대 ${job.maxSteps}단계 안에 끝내라. 도구는 한 번에 하나씩 부르고, 목표에 도달하면 도구 없이 최종 답을 써라.`,
    ].join("\n\n");
    const r = await this.runTurn({ mode: "submit", input: text, submissionId: key, idempotencyKey: key, metadata: { runId: job.runId, stepIndex: job.stepIndex } });
    this.log("submit", { submissionId: r.submissionId, accepted: r.accepted, status: r.status });
    return { submissionId: r.submissionId, accepted: r.accepted, status: r.status };
  }

  /**
   * 승인 재개. 저장해 둔 도구 1개를 approved=true로 한 번만 실행하고, 결과를 담아 이어지는 턴을 제출한다.
   * pending은 첫 await 전에 지운다 → 같은 승인 메시지가 두 번 와도 두 번째는 noop.
   */
  async resumeApproved(p: { activeSinceMs: number }): Promise<{ status: "noop" | "submitted" | "stopped"; submissionId?: string; observation?: string }> {
    const job = this.job();
    const pending = this.kvGet<PendingTool | null>("pending", null);
    if (!job || !pending) return { status: "noop" };
    this.kvPut("pending", null);
    this.kvPut("stop", null);
    this.kvPut("activeSinceMs", p.activeSinceMs);
    const fxKey = `${job.runId}:${job.stepIndex}:${pending.toolCallId}`;
    const prev = this.fxGet(fxKey);
    let observation: string;
    if (prev?.state === "done") observation = String(prev.result);
    else if (prev?.state === "started") observation = "(결과 불명) 이전 실행이 도중에 끊겼습니다. 중복 실행을 막기 위해 다시 실행하지 않았습니다.";
    else {
      this.fxPut(fxKey, "started", null);
      const res = await this.execNode(pending.tool, this.nodeCtx(job, true), pending.args);
      observation = res.status === "succeeded" ? asText(res.output ?? null, OBS_MAX) : `(실패) ${clip(res.error || res.status, OBS_MAX)}`;
      this.fxPut(fxKey, "done", observation);
    }
    this.log("approvedTool", { tool: pending.tool, toolCallId: pending.toolCallId, replay: !!prev });
    // 그 도구 호출의 turns 항목에 실제 관찰을 붙인다.
    const turns = this.turns();
    const t = turns.find((x) => x.turn === pending.turn);
    if (t) { t.observation = observation; this.kvPut("turns", turns); }

    const n = this.bump("resumeCount");
    const sid = `${job.runId}:${job.stepIndex}:a${n}`;
    this.kvPut("currentSubmission", sid);
    if (this.checkLimits(this.num("steps"))) {
      // 더 돌 수 없다 (스텝·LLM·시간 상한) — 모델을 부르지 않고 멈춤 결과를 바로 전달한다.
      this.kvPut("outcome", this.buildOutcome({ submissionId: sid, status: "completed", createdAt: Date.now() }));
      await this.deliver({ submissionId: sid, attempt: 0 });
      return { status: "stopped", submissionId: sid, observation };
    }
    const text = `[승인 후 실행 결과] ${pending.tool}: ${observation}\n\n목표를 이어서 진행하라. 이미 끝났으면 도구 없이 최종 답을 써라.`;
    await this.runTurn({ mode: "submit", input: text, submissionId: sid, idempotencyKey: sid, metadata: { runId: job.runId, stepIndex: job.stepIndex, resume: n } });
    this.log("submit", { submissionId: sid, resume: n });
    return { status: "submitted", submissionId: sid, observation };
  }

  /** 관측·하네스용 읽기 전용 상태. */
  async inspect(): Promise<Record<string, unknown>> {
    const events = this.ctx.storage.sql.exec("SELECT ts, ev, data FROM pos_log ORDER BY id").toArray()
      .map((r) => ({ ts: Number(r.ts), ev: String(r.ev), data: JSON.parse(String(r.data)) }));
    return {
      job: this.job(), steps: this.num("steps"), modelCalls: this.num("modelCalls"), llmCalls: this.num("llmCalls"),
      stop: this.stop(), pending: this.kvGet("pending", null), turns: this.turns(), outcome: this.kvGet("outcome", null),
      currentSubmission: this.kvGet("currentSubmission", null), submissions: await this.listSubmissions(), events,
    };
  }
}
