// WF-6 에이전트 단계 1턴 진행 (2026-11-18). 엔진(processWorkflowStep)이 step.type === "agent"일 때 executeNode 대신 부른다.
// 큐 메시지 1개 = 1턴. 루프 상태는 WorkflowAgent DO(agent-do.ts)가 들고, 도구 실행·D1 기록·큐는 여기(엔진 쪽)서 한다.
//
// 한 턴의 흐름
//   (승인 메시지)  DO take-pending → 그 도구를 approved=true로 실행 → observe → 다음 턴 메시지
//   (일반 메시지)  DO advance(turn) → finish/stopped: 단계 성공(파싱 실패 3연속만 실패)
//                                    → invalid(형식 오류): 다음 턴 메시지
//                                    → tool: 승인 필요 도구면 DO에 pending 저장 + 승인 대기로 멈춤 (다음 메시지 없음)
//                                            아니면 executeNode(tool) → observe → 다음 턴 메시지
// 도구 실행은 workflow_run_steps 행을 따로 만들지 않는다 (agent 단계 1행만). 턴 기록은 DO + 최종 output에 남는다.
// 도구 실패는 run을 실패시키지 않는다: 관찰에 에러를 적고 다음 턴으로 간다 (같은 도구 3연속이면 DO가 repeat_tool로 멈춘다).
//
// 승인 범위 (명세와 다른 점 — 보안상 좁혔다): 승인은 "그 pending 행동 1개"에만 유효하다. 다음 턴 메시지는 approved 없이 보낸다.
// approved를 다음 턴으로 넘기면 같은 agent 단계 안에서 나중에 고른 send_email이 승인 없이 실행되기 때문이다.
import { executeNode } from "./nodes";
import type { AdvanceResult, PendingAction } from "./agent-do";
import {
  APPROVAL_REQUIRED_NODES, DEFERRABLE_NODES, agentSettings, isDeferredAgentStep, resolveVars,
  type Env, type NodeContext, type NodeType, type ToolNodeType, type WorkflowStepDef, type WorkflowStepMessage,
} from "./types";

/** 비동기 승인 P2: 지연 모드에서 대기열에 넣은 도구의 관찰 머리말 (하네스가 이 문구로 확인한다). */
export const DEFERRED_OBSERVATION = "(승인 대기열에 넣음 — 승인되면 실행됩니다)";

export function agentDoName(runId: string, stepIndex: number): string {
  return `agent:${runId}:${stepIndex}`;
}

/** 엔진이 넘겨주는 단계 기록 함수들 (D1 상태 전이는 engine.ts가 소유한다). */
export interface AgentStepHooks {
  /** 단계 성공 + 다음 단계(또는 run 완료) */
  complete(output: unknown): Promise<void>;
  /** 단계·run 실패 */
  fail(error: string): Promise<void>;
  /** 승인 대기로 멈춤: 알림 + 단계 pending + run waiting_approval. 다음 메시지 없음. */
  pause(p: { nodeType: NodeType; nodeName: string; summary: string; turn: number }): Promise<void>;
  /** 점유를 풀고(running→pending) 다음 턴 메시지를 보낸다. run은 running 그대로. */
  requeue(nextTurn: number): Promise<void>;
  /** 점유만 푼다 (중복 메시지 — 할 일 없음). */
  release(): Promise<void>;
}

export interface AgentTurnInput {
  step: WorkflowStepDef;
  msg: WorkflowStepMessage;
  /** 엔진 판정: 이 메시지가 승인 재개 메시지인가 (msg.approved && 멈춘 단계) */
  approved: boolean;
  /** 현재 단계의 NodeContext (도구 실행에 재사용, approved만 바꾼다) */
  ctx: NodeContext;
  /** 활성 시간 기준점 (run 시작 또는 마지막 승인, ms) — DO의 30분 timeout 판정용 */
  activeSinceMs: number;
}

async function doCall<T>(stub: DurableObjectStub, path: string, body?: unknown): Promise<T> {
  const res = await stub.fetch(`https://workflow-agent${path}`, body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`WorkflowAgent ${path} 실패 (${res.status}): ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

export function approvalSummary(tool: ToolNodeType, args: Record<string, unknown>, thinking: string): string {
  const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
  const head = tool === "send_email"
    ? `받는 사람: ${s(args.to)}\n제목: ${s(args.subject)}${s(args.body ?? args.text) ? `\n본문 미리보기: ${s(args.body ?? args.text).slice(0, 300)}` : ""}`
    : tool === "webhook"
      ? `외부 호출: ${s(args.method) || "POST"} ${s(args.url)}${args.body !== undefined ? `\n본문 미리보기: ${s(args.body).slice(0, 300)}` : ""}` // 헤더 값은 싣지 않는다 (토큰 가능)
      : `입력: ${s(args).slice(0, 500)}`;
  return `에이전트가 고른 도구: ${tool}\n${head}${thinking ? `\n에이전트 판단: ${thinking.slice(0, 300)}` : ""}`;
}

export async function advanceAgentTurn(env: Env, p: AgentTurnInput, hooks: AgentStepHooks): Promise<void> {
  const { step, msg, ctx } = p;
  const stub = env.WORKFLOW_AGENT.get(env.WORKFLOW_AGENT.idFromName(agentDoName(ctx.runId, ctx.stepIndex)));
  // 목표 문장의 {{input.x}} / {{steps.<id>.output.y}}는 다른 노드 config와 같은 규칙으로 치환한다.
  const steps: Record<string, unknown> = {};
  for (const [id, out] of Object.entries(ctx.stepOutputs ?? {})) {
    steps[id] = { ...(out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {}), output: out };
  }
  const settings = agentSettings({ ...(step.config ?? {}), goal: resolveVars(step.config?.goal ?? "", { input: ctx.input ?? {}, steps }) });
  // requiresApproval:true인 agent는 고르는 모든 도구가 승인을 받는다. 아니면 APPROVAL_REQUIRED_NODES(send_email)만.
  const gated = (tool: ToolNodeType) => step.requiresApproval === true || APPROVAL_REQUIRED_NODES.includes(tool);
  // 비동기 승인 P2: approvalMode "deferred"인 agent 단계에서는 send_email·webhook을 멈추지 않고 대기열에 넣는다. 나머지는 지금과 같다.
  const deferrable = (tool: ToolNodeType) => isDeferredAgentStep(step) && DEFERRABLE_NODES.includes(tool);

  const runTool = async (turn: number, tool: ToolNodeType, args: Record<string, unknown>, approvedTool: boolean, thinking: string) => {
    const res = await executeNode(tool, { ...ctx, approved: approvedTool }, args);
    if (res.status === "waiting_approval") {
      // 2차 방어선: 노드가 스스로 승인을 요구했다. pending으로 저장하고 멈춘다.
      await doCall(stub, "/pending", { turn, tool, args, thinking } satisfies PendingAction);
      await hooks.pause({ nodeType: tool, nodeName: `${step.name} → ${tool}`, summary: approvalSummary(tool, args, thinking), turn });
      return;
    }
    const obs = await doCall<{ ok: boolean; nextTurn: number }>(stub, "/observe",
      res.status === "succeeded" ? { turn, observation: res.output ?? null } : { turn, error: res.error || "도구 실행 실패" });
    await hooks.requeue(obs.nextTurn);
  };

  /**
   * 비동기 승인 P2: 지연 모드에서 에이전트가 고른 send_email·webhook. 노드를 deferActions로 부른다 → 노드가 검증·SSRF 검사를 먼저 하고
   * 통과하면 대기 동작(wfpa_<runId>_<stepIndex>_t<turn>)을 INSERT OR IGNORE로 쌓고 시뮬레이션 출력을 돌려준다 (재전달돼도 행 1개).
   * 검증 실패는 대기 동작 없이 도구 실패로 관찰된다. 관찰에는 "아직 실행되지 않았다"는 사실과 simulated:true를 그대로 싣는다.
   */
  const runDeferred = async (turn: number, tool: ToolNodeType, args: Record<string, unknown>) => {
    const res = await executeNode(tool, { ...ctx, approved: false, deferActions: true, deferTurn: turn }, args);
    const obs = res.status === "succeeded"
      ? { turn, observation: `${DEFERRED_OBSERVATION} 아직 실행되지 않았습니다. 같은 동작을 다시 부르지 마세요. ${JSON.stringify(res.output ?? null)}` }
      : { turn, error: res.status === "failed" ? (res.error || "도구 실행 실패") : "승인 대기열에 넣지 못했습니다 (실행하지 않음)." };
    const o = await doCall<{ ok: boolean; nextTurn: number }>(stub, "/observe", obs);
    await hooks.requeue(o.nextTurn);
  };

  // 1. 승인 재개: 저장해 둔 행동을 꺼내 실행한다 (새 선택을 하지 않는다). 꺼내면 지워지므로 한 번만 실행된다.
  if (p.approved) {
    const { pending } = await doCall<{ pending: PendingAction | null }>(stub, "/take-pending", {});
    if (!pending) { await hooks.release(); return; } // 중복 승인 메시지 — 이미 실행됨
    await runTool(pending.turn, pending.tool, pending.args, true, pending.thinking);
    return;
  }

  // 2. 한 턴 진행 (DO가 턴 번호로 중복 전달을 가드한다)
  const r = await doCall<AdvanceResult>(stub, "/advance", {
    turn: typeof msg.agentTurn === "number" ? msg.agentTurn : 0,
    goal: settings.goal, tools: settings.tools, maxSteps: settings.maxSteps,
    runInput: ctx.input, stepOutputs: ctx.stepOutputs, activeSinceMs: p.activeSinceMs,
  });

  if (r.status === "finish") {
    await hooks.complete({ final: r.final, turns: r.turns, stoppedReason: null });
    return;
  }
  if (r.status === "stopped") {
    // 멈춤은 정상 종료다 (목표 미도달이어도). 모델이 형식을 못 지킨 경우만 실패.
    if (r.reason === "tool_selection_failed") {
      await hooks.fail(`에이전트 도구 선택 실패: 모델 응답 형식 오류가 3번 연속 발생했습니다.`);
      return;
    }
    await hooks.complete({ final: r.final, turns: r.turns, stoppedReason: r.reason });
    return;
  }
  if (r.status === "invalid") {
    // 형식 오류 턴. replay(이미 처리된 턴의 재전달)면 다음 턴이 이미 진행 중일 수 있다 → 마지막 턴일 때만 이어 보낸다.
    if (r.replay && r.nextTurn !== r.turn + 1) { await hooks.release(); return; }
    await hooks.requeue(r.nextTurn);
    return;
  }

  // r.status === "tool"
  if (r.replay && r.observed) {
    // 이미 실행·기록된 턴의 재전달. 다음 턴이 아직 시작 안 됐을 때만 이어 보낸다 (도구는 다시 실행하지 않는다).
    if (r.nextTurn === r.turn + 1) await hooks.requeue(r.nextTurn);
    else await hooks.release();
    return;
  }
  if (gated(r.tool) && deferrable(r.tool)) {
    // 비동기 승인 P2: 지연 모드 agent 단계 — 멈추지 않고 대기 동작을 쌓은 뒤 다음 턴으로 (DO /pending은 쓰지 않는다).
    await runDeferred(r.turn, r.tool, r.args);
    return;
  }
  if (gated(r.tool)) {
    // 승인 게이트 (WF-3 §7과 같은 원칙): 선택을 DO에 저장하고 멈춘다. 승인 뒤 approved 메시지가 1번 분기로 실행한다.
    await doCall(stub, "/pending", { turn: r.turn, tool: r.tool, args: r.args, thinking: r.thinking } satisfies PendingAction);
    await hooks.pause({ nodeType: r.tool, nodeName: `${step.name} → ${r.tool}`, summary: approvalSummary(r.tool, r.args, r.thinking), turn: r.turn });
    return;
  }
  await runTool(r.turn, r.tool, r.args, false, r.thinking);
}
