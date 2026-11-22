// Think 전면 도입 T1 (2026-11-20): agent 단계의 엔진 쪽 연결 (계획 2장 C).
// engine.ts의 agent 분기가 런타임을 고른 뒤(pickAgentRuntime) Think면 여기로 온다. legacy(agent.ts)는 그대로다.
//
// 메시지 3종
//   (첫 메시지)   점유를 풀고(running→pending) ThinkAgent.startStep() — runTurn submit, 키 = `runId:stepIndex`. 엔진은 여기서 끝.
//                 DO가 루프를 스스로 돌고, 끝나면 workflow_agent_steps에 결과를 쓰고 thinkSubmissionId가 붙은 workflow-step 메시지를 넣는다.
//   (깨움 메시지) thinkSubmissionId가 D1 행의 submission_id와 같고 결과가 있으면: completed → 단계 성공 / failed → 실패 /
//                 approval → 기존 승인 게이트(requestWorkflowApproval·결재함·approval.js)로 멈춤. 처리 뒤 consumed_submission 기록.
//   (승인 메시지) 점유를 풀고 ThinkAgent.resumeApproved() — DO가 그 도구 1개를 approved=true로 한 번만 실행하고 이어지는 턴을 제출.
//
// 점유를 DO 호출보다 **먼저** 푸는 이유: DO가 아주 빨리 끝나 깨움 메시지가 먼저 도착하면 running 행을 점유하지 못해 버려진다.
// 먼저 풀면 같은 첫 메시지가 중복 전달돼도 같은 키라 Think가 accepted:false로 거른다. DO 호출이 실패하면 throw → 큐 재시도.
// 엔진 연결은 submissionId 기준이다 (복구 턴은 requestId가 바뀐다 — T0 k3).
import { getAgentByName } from "agents";
import type { AgentStepHooks, AgentTurnInput } from "./agent";
import { approvalSummary } from "./agent";
import { thinkAgentName, type PendingTool, type ThinkOutcome } from "./think-agent";
import { agentSettings, isDeferredAgentStep, resolveVars, type Env, type ToolNodeType, type WorkflowStepMessage } from "./types";

export type AgentRuntime = "think" | "legacy";

/**
 * 이 agent 단계의 런타임. 한 번 정해지면 끝까지 바뀌지 않는다 (계획 R11 — AGENT_RUNTIME을 바꿔 재배포해도 진행 중인 단계는 그대로).
 * - workflow_agent_steps에 행이 있으면 그 런타임.
 * - 없고 AGENT_RUNTIME !== "think"면 legacy (행을 쓰지 않는다 — legacy 경로의 D1 쓰기는 늘지 않는다).
 * - 없고 think인데 이미 진행 중인 legacy 단계의 메시지(agentTurn ≥ 1 또는 승인 재개)면 legacy.
 * - 그 밖(새 단계의 첫 메시지)은 think 행을 만든다.
 * legacy 모드에서 표가 없으면(0040 미적용) 조회 실패를 legacy로 본다.
 */
export async function pickAgentRuntime(env: Env, msg: WorkflowStepMessage, approved: boolean): Promise<AgentRuntime> {
  const want: AgentRuntime = env.AGENT_RUNTIME === "think" ? "think" : "legacy";
  let row: { runtime: string } | null;
  try {
    row = await env.DB.prepare("SELECT runtime FROM workflow_agent_steps WHERE run_id=? AND step_index=?")
      .bind(msg.runId, msg.stepIndex).first<{ runtime: string }>();
  } catch (e) {
    if (want === "legacy") return "legacy";
    throw e;
  }
  if (row) return row.runtime === "think" ? "think" : "legacy";
  if (want === "legacy") return "legacy";
  if ((typeof msg.agentTurn === "number" && msg.agentTurn > 0) || approved || msg.thinkSubmissionId) return "legacy";
  if (!env.ThinkAgent) return "legacy"; // 바인딩이 없는 배포 (안전 폴백)
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO workflow_agent_steps(run_id, step_index, runtime, status, created_at, updated_at) VALUES(?,?,'think','new',?,?)",
  ).bind(msg.runId, msg.stepIndex, now, now).run();
  const again = await env.DB.prepare("SELECT runtime FROM workflow_agent_steps WHERE run_id=? AND step_index=?")
    .bind(msg.runId, msg.stepIndex).first<{ runtime: string }>();
  return again?.runtime === "think" ? "think" : "legacy";
}

/** 엔진이 단계 행을 직접 다루는 함수 (점유 해제). engine.ts가 넘긴다. */
export interface ThinkStepExtras {
  /** 점유 해제 (running → pending). requeue와 달리 메시지를 보내지 않는다. */
  release(): Promise<void>;
  /** 이 단계 전에 run이 쓴 LLM 호출 수 (LLM 노드 단계 + 다른 agent 단계의 turns). */
  priorLlmCalls: number;
  /** run 전체 LLM 캡 (engine.ts LLM_CALL_CAP). */
  llmCap: number;
}

export async function advanceThinkAgentStep(env: Env, p: AgentTurnInput, hooks: AgentStepHooks, x: ThinkStepExtras): Promise<void> {
  const { step, msg, ctx } = p;
  if (!env.ThinkAgent) throw new Error("ThinkAgent 바인딩이 없습니다.");
  const name = thinkAgentName(ctx.runId, ctx.stepIndex);

  // 1. 깨움 메시지: DO가 D1에 쓴 결과를 읽어 단계를 진행한다.
  if (msg.thinkSubmissionId) {
    const row = await env.DB.prepare(
      "SELECT submission_id, status, result_json, consumed_submission FROM workflow_agent_steps WHERE run_id=? AND step_index=?",
    ).bind(ctx.runId, ctx.stepIndex).first<{ submission_id: string | null; status: string; result_json: string | null; consumed_submission: string | null }>();
    const sid = msg.thinkSubmissionId;
    if (!row || row.submission_id !== sid || row.consumed_submission === sid || !row.result_json || !["completed", "approval", "failed"].includes(row.status)) {
      await x.release(); // 옛 제출·중복·아직 결과 없음
      return;
    }
    const result = JSON.parse(row.result_json) as ThinkOutcome["result"];
    if (row.status === "completed") {
      await hooks.complete(result);
    } else if (row.status === "failed") {
      await hooks.fail(`에이전트(Think) 실행 실패: ${(result as { error?: string }).error ?? "알 수 없는 오류"}`);
    } else {
      const pt = result as PendingTool;
      await hooks.pause({
        nodeType: pt.tool, nodeName: `${step.name} → ${pt.tool}`,
        summary: approvalSummary(pt.tool as ToolNodeType, pt.args ?? {}, pt.thinking ?? ""), turn: pt.turn,
      });
    }
    // 처리한 뒤에 표시한다 (처리 중 예외면 표시 없이 큐 재시도 → 같은 결과를 다시 처리. complete/pause는 점유한 running 행에서만 바뀐다).
    await env.DB.prepare("UPDATE workflow_agent_steps SET consumed_submission=?, updated_at=? WHERE run_id=? AND step_index=?")
      .bind(sid, new Date().toISOString(), ctx.runId, ctx.stepIndex).run();
    return;
  }

  // 2. 승인 재개: 점유를 풀고 DO가 저장해 둔 도구를 한 번만 실행한다.
  if (p.approved) {
    await x.release();
    const stub = await getAgentByName(env.ThinkAgent, name);
    const r = await stub.resumeApproved({ activeSinceMs: p.activeSinceMs });
    if (r.status === "submitted" || r.status === "stopped") {
      await env.DB.prepare("UPDATE workflow_agent_steps SET status='running', submission_id=?, updated_at=? WHERE run_id=? AND step_index=? AND (submission_id IS NULL OR submission_id != ?)")
        .bind(r.submissionId ?? null, new Date().toISOString(), ctx.runId, ctx.stepIndex, r.submissionId ?? "").run();
    }
    return;
  }

  // 3. 첫 메시지: 제출만 하고 끝낸다.
  const vars: Record<string, unknown> = {};
  for (const [id, out] of Object.entries(ctx.stepOutputs ?? {})) {
    vars[id] = { ...(out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {}), output: out };
  }
  const settings = agentSettings({ ...(step.config ?? {}), goal: resolveVars(step.config?.goal ?? "", { input: ctx.input ?? {}, steps: vars }) });
  await x.release();
  const stub = await getAgentByName(env.ThinkAgent, name);
  const r = await stub.startStep({
    runId: ctx.runId, workflowId: ctx.workflowId, stepIndex: ctx.stepIndex, stepName: step.name,
    user: ctx.user, input: ctx.input ?? {}, stepOutputs: ctx.stepOutputs ?? {},
    goal: settings.goal, tools: settings.tools, maxSteps: settings.maxSteps,
    gatedAll: step.requiresApproval === true,
    deferred: isDeferredAgentStep(step), // 비동기 승인 P2

    llmBudget: Math.max(0, x.llmCap - x.priorLlmCalls),
    activeSinceMs: p.activeSinceMs,
  });
  if (r.accepted) {
    // DO가 아직 결과를 쓰지 않았을 때만 running으로 (빠르게 끝난 DO의 결과를 덮지 않는다).
    await env.DB.prepare("UPDATE workflow_agent_steps SET status='running', submission_id=?, updated_at=? WHERE run_id=? AND step_index=? AND status='new'")
      .bind(r.submissionId, new Date().toISOString(), ctx.runId, ctx.stepIndex).run();
  }
}
