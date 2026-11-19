// 워크플로우 실행 엔진 (WF-3, 2026-11-18). 제안서 4.1.3.
// run 하나를 "단계마다 큐 메시지 1개"로 직렬 실행한다. 큐(people-os-pipeline)는 at-least-once라
// 같은 메시지가 두 번 올 수 있다 → (run_id, step_index) 행을 조건부 UPDATE로 점유(claim)해 한 번만 실행한다.
//
// 상태 흐름
//   run:  queued → running → (waiting_approval → running)* → succeeded | failed | cancelled
//   step: pending → running → succeeded | failed   (승인 대기 중에는 pending으로 되돌려 둔다; 거절되면 skipped)
//
// 재시도 규칙
// - 노드가 돌려준 실패({status:'failed'})는 최종 실패다: step·run을 failed로 기록하고 throw하지 않는다(ack).
//   (노드는 executeNode에서 이미 예외를 실패로 바꾸고, AI 노드는 로컬 폴백이 있다.)
// - 엔진 자체의 예외(D1·큐 오류)는 step을 failed로 되돌린 뒤 다시 throw한다 → queue()가 msg.retry() →
//   재전달 시 claim이 failed→running으로 다시 점유해 재실행. 3회 넘게 실패하면 DLQ (기존 파이프라인과 같음).
// - 실행 도중 워커가 죽어 step이 running에 남으면 재전달은 claim에 실패해 그냥 끝난다 → 정체 청소(60분)가 failed로 정리.
//
// 시간 상한
// - 30분 상한은 "활성 시간" 기준: run.started_at, 또는 마지막 승인 시각(승인된 단계의 input_json.approvedAt /
//   승인 메시지의 enqueuedAt) 중 늦은 것부터 잰다. 승인 대기 시간까지 세면 승인이 30분 넘게 걸린 run은
//   재개하자마자 실패하기 때문이다.
// - 정체 청소(sweep)도 같은 이유로 run.started_at과 "마지막 단계 활동 시각"이 둘 다 기준보다 오래된 run만 정리한다.
//
// agent 단계 (WF-6)
// - step.type === "agent"면 executeNode 대신 advanceAgentTurn(agent.ts)이 한 턴만 진행한다. 큐 메시지 1개 = 1턴.
// - 턴 사이에는 단계를 running → pending으로 되돌리고(다음 메시지가 다시 점유할 수 있게) 같은 단계 메시지(agentTurn+1)를 보낸다.
//   run은 running 그대로. 루프가 끝나야(finish/stopped) 단계가 succeeded가 된다.
// - 단계 단위 승인 게이트(7번)는 agent에 걸지 않는다: 승인은 에이전트가 고른 도구 단위로 agent.ts가 건다.
// - 30분 상한(4번)은 agent 단계에도 매 턴 그대로 적용된다. run 전체 LLM 30회 캡은 단계 행 기준이라 agent 턴은
//   세지 않는다 — 대신 DO가 agent 단계 안에서 도구 선택 호출을 20회로 따로 막는다.
import { executeNode } from "./nodes";
import { logEvent } from "../obs/log";
import { requestWorkflowApproval } from "./approvals";
import { advanceAgentTurn, type AgentStepHooks } from "./agent";
import {
  APPROVAL_REQUIRED_NODES, resolveNextStep, resolveVars,
  type Env, type NodeContext, type NodeResult, type NodeType, type WorkflowDefinition, type WorkflowStepDef, type WorkflowStepMessage,
} from "./types";

export const RUN_MAX_ACTIVE_MS = 30 * 60 * 1000;
export const STALE_RUN_MS = 60 * 60 * 1000;
export const STALE_APPROVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const LLM_CALL_CAP = 30;
export const LLM_NODE_TYPES: NodeType[] = ["ask_rag", "ask_personal", "summarize", "reflect_coach", "reflect_coachee", "llm", "email_draft"];
export const MAX_CONCURRENT_RUNS = 3;
export const MAX_DAILY_RUNS = 20;
const SWEEP_BATCH = 100;

const ACTIVE = ["queued", "running", "waiting_approval"] as const;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

type RunDb = { id: string; workflow_id: string; owner_id: string; status: string; input_json: string; current_step: number | null; started_at: string };
type StepDb = { step_index: number; node_type: string; status: string; input_json: string | null; output_json: string | null; started_at: string | null; finished_at: string | null };

const nowIso = () => new Date().toISOString();

function parseJson(s: unknown): unknown {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function stepMessage(runId: string, stepIndex: number, approved = false): WorkflowStepMessage {
  const m: WorkflowStepMessage = { type: "workflow-step", runId, stepIndex, enqueuedAt: nowIso() };
  if (approved) m.approved = true;
  return m;
}

/** run을 최종 상태로. 이미 최종 상태(취소 등)면 덮어쓰지 않는다. */
async function finishRun(env: Env, runId: string, status: "succeeded" | "failed" | "cancelled", p: { error?: string; output?: unknown } = {}): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE workflow_runs SET status=?, error=?, output_json=COALESCE(?, output_json), finished_at=? WHERE id=? AND status IN ('queued','running','waiting_approval')`,
  ).bind(status, p.error ?? null, p.output === undefined ? null : JSON.stringify(p.output), nowIso(), runId).run();
  const changed = (r.meta?.changes ?? 0) > 0;
  // Workers Logs: run 종료 1줄 (상태·식별자만 — 출력·오류 본문은 싣지 않는다. 오류 본문은 D1 workflow_runs.error에 있다).
  if (changed) logEvent("workflow.run_finished", { runId, status, hasError: !!p.error });
  return changed;
}

async function setStep(env: Env, runId: string, stepIndex: number, fromStatus: string, p: { status: string; output?: unknown; error?: string | null; finished?: boolean }): Promise<void> {
  await env.DB.prepare(
    `UPDATE workflow_run_steps SET status=?, output_json=COALESCE(?, output_json), error=?, finished_at=? WHERE run_id=? AND step_index=? AND status=?`,
  ).bind(
    p.status, p.output === undefined ? null : JSON.stringify(p.output), p.error ?? null, p.finished ? nowIso() : null, runId, stepIndex, fromStatus,
  ).run();
}

/** 활성 시간 기준점: run 시작 또는 마지막 승인 시각 중 늦은 것 (ms). */
function activeSince(run: RunDb, steps: StepDb[], approvedAtMsg?: string): number {
  let base = Date.parse(run.started_at) || 0;
  for (const s of steps) {
    const inp = parseJson(s.input_json) as { approvedAt?: string } | null;
    const t = inp?.approvedAt ? Date.parse(inp.approvedAt) : NaN;
    if (!Number.isNaN(t) && t > base) base = t;
  }
  if (approvedAtMsg) {
    const t = Date.parse(approvedAtMsg);
    if (!Number.isNaN(t) && t > base) base = t;
  }
  return base;
}

function needsApproval(step: WorkflowStepDef): boolean {
  return step.requiresApproval === true || APPROVAL_REQUIRED_NODES.includes(step.type);
}

/** 승인 요청 본문용 요약. config를 앞 단계 출력으로 치환한 뒤 핵심만. */
function approvalSummary(step: WorkflowStepDef, input: Record<string, unknown>, stepOutputs: Record<string, unknown>): string {
  const steps: Record<string, unknown> = {};
  for (const [id, out] of Object.entries(stepOutputs)) {
    steps[id] = { ...(out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {}), output: out };
  }
  let cfg: Record<string, unknown> = {};
  try { cfg = (resolveVars(step.config ?? {}, { input, steps }) as Record<string, unknown>) ?? {}; } catch { /* 요약 실패는 무시 */ }
  const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
  if (step.type === "send_email") {
    const body = s(cfg.body ?? cfg.text);
    return `받는 사람: ${s(cfg.to)}\n제목: ${s(cfg.subject)}${body ? `\n본문 미리보기: ${body.slice(0, 300)}` : ""}`;
  }
  if (step.type === "webhook") {
    // 헤더 값에는 토큰이 들어갈 수 있다 — 알림에는 헤더 이름만 싣는다 (WF-9).
    const hdr = cfg.headers && typeof cfg.headers === "object" ? Object.keys(cfg.headers as object).join(", ") : "";
    const body = cfg.body === undefined ? "" : s(cfg.body);
    return `외부 호출: ${s(cfg.method) || "POST"} ${s(cfg.url)}${hdr ? `\n헤더: ${hdr}` : ""}${body ? `\n본문 미리보기: ${body.slice(0, 300)}` : ""}`;
  }
  return `설정: ${s(cfg).slice(0, 500)}`;
}

function stepOutputsBefore(def: WorkflowDefinition, steps: StepDb[], stepIndex: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of steps) {
    // 그래프(WF-7): 인덱스가 큰 단계가 먼저 실행됐을 수 있다 → 현재 단계만 빼고 성공한 단계는 모두 앞선(조상) 단계다 (DAG).
    if (s.step_index === stepIndex || s.status !== "succeeded") continue;
    const id = def.steps[s.step_index]?.id;
    if (id) out[id] = parseJson(s.output_json);
  }
  return out;
}

/**
 * 성공한 단계 다음: 간선(next)을 따라 다음 단계 메시지를 보내거나 run을 끝낸다 (WF-7, resolveNextStep).
 * 정의는 DAG라 각 단계는 run당 최대 1번 실행된다 — 루프는 없다 (반복은 WF-8 스케줄). (runId, stepIndex) claim이 그대로 맞는 이유.
 * run.current_step은 "마지막으로 실행한(또는 실행 중인) 단계 인덱스"다 — 다음 단계가 아니라 방금 끝낸 단계.
 */
async function advance(env: Env, runId: string, def: WorkflowDefinition, stepIndex: number, output: unknown): Promise<void> {
  const nx = resolveNextStep(def, stepIndex, output);
  if (nx.kind === "next") {
    await env.PIPELINE.send(stepMessage(runId, nx.index));
    return;
  }
  if (nx.kind === "error") {
    await finishRun(env, runId, "failed", { error: `${def.steps[stepIndex]?.name ?? "단계"}: ${nx.error}` });
    return;
  }
  await finishRun(env, runId, "succeeded", { output: output ?? null });
}

/** 승인 대기로 멈춘다: 알림(멱등) → step을 pending으로 되돌림(승인 후 다시 점유할 수 있게) → run waiting_approval. */
async function pauseForApproval(
  env: Env, run: RunDb, step: WorkflowStepDef, stepIndex: number, input: Record<string, unknown>, stepOutputs: Record<string, unknown>,
): Promise<void> {
  await requestWorkflowApproval(env, {
    runId: run.id, workflowId: run.workflow_id, stepIndex, nodeType: step.type, nodeName: step.name,
    summary: approvalSummary(step, input, stepOutputs),
  });
  await env.DB.prepare(
    "UPDATE workflow_run_steps SET status='pending', input_json=?, started_at=NULL, error=NULL WHERE run_id=? AND step_index=? AND status='running'",
  ).bind(JSON.stringify({ approval: "requested", requestedAt: nowIso() }), run.id, stepIndex).run();
  await env.DB.prepare("UPDATE workflow_runs SET status='waiting_approval', current_step=? WHERE id=? AND status IN ('queued','running')")
    .bind(stepIndex, run.id).run();
}

/** agent 단계(WF-6)의 D1 상태 전이. 모든 전이는 "이 메시지가 점유한 running 행"에서만 일어난다. */
function agentHooks(env: Env, run: RunDb, def: WorkflowDefinition, step: WorkflowStepDef, stepIndex: number): AgentStepHooks {
  const runId = run.id;
  const releaseStep = async (inputJson?: string) => {
    if (inputJson === undefined) {
      await env.DB.prepare("UPDATE workflow_run_steps SET status='pending' WHERE run_id=? AND step_index=? AND status='running'")
        .bind(runId, stepIndex).run();
    } else {
      await env.DB.prepare("UPDATE workflow_run_steps SET status='pending', input_json=? WHERE run_id=? AND step_index=? AND status='running'")
        .bind(inputJson, runId, stepIndex).run();
    }
  };
  return {
    async complete(output) {
      await setStep(env, runId, stepIndex, "running", { status: "succeeded", output: output ?? null, error: null, finished: true });
      await advance(env, runId, def, stepIndex, output ?? null);
    },
    async fail(error) {
      await setStep(env, runId, stepIndex, "running", { status: "failed", error, finished: true });
      await finishRun(env, runId, "failed", { error: `${step.name}: ${error}` });
    },
    async pause({ nodeType, nodeName, summary, turn }) {
      await requestWorkflowApproval(env, { runId, workflowId: run.workflow_id, stepIndex, nodeType, nodeName, summary, turn });
      // 이전 승인 시각(approvedAt)은 남겨 둔다 — 지우면 활성 시간 기준점이 run 시작으로 돌아간다.
      const cur = await env.DB.prepare("SELECT input_json FROM workflow_run_steps WHERE run_id=? AND step_index=?")
        .bind(runId, stepIndex).first<{ input_json: string | null }>();
      const prevApprovedAt = (parseJson(cur?.input_json) as { approvedAt?: string } | null)?.approvedAt;
      await releaseStep(JSON.stringify({ approval: "requested", requestedAt: nowIso(), agentTurn: turn, ...(prevApprovedAt ? { approvedAt: prevApprovedAt } : {}) }));
      await env.DB.prepare("UPDATE workflow_runs SET status='waiting_approval', current_step=? WHERE id=? AND status IN ('queued','running')")
        .bind(stepIndex, runId).run();
    },
    async requeue(nextTurn) {
      // 점유를 먼저 푼다: 보낸 뒤에 풀면 다음 메시지가 먼저 도착해 점유에 실패하고 사라질 수 있다.
      await releaseStep();
      await env.PIPELINE.send({ ...stepMessage(runId, stepIndex), agentTurn: nextTurn });
    },
    async release() {
      await releaseStep();
    },
  };
}

/** 큐 소비자(index.ts queue())가 부른다. 노드 실패는 throw하지 않는다. 엔진 예외만 throw(→ 재시도). */
export async function processWorkflowStep(env: Env, msg: WorkflowStepMessage): Promise<void> {
  const { runId, stepIndex } = msg;
  if (typeof runId !== "string" || !runId || !Number.isInteger(stepIndex) || stepIndex < 0) return;

  // 1~3. run 조회 / 늦은 메시지 / 승인 없는 재개 금지
  const run = await env.DB.prepare(
    "SELECT id, workflow_id, owner_id, status, input_json, current_step, started_at FROM workflow_runs WHERE id = ?",
  ).bind(runId).first<RunDb>();
  if (!run) return;
  if (TERMINAL.has(run.status)) return;
  // 승인은 그 run이 멈춰 있던 단계(current_step)에만 유효하다.
  const approved = msg.approved === true && stepIndex === (run.current_step ?? 0);
  if (run.status === "waiting_approval" && !approved) return;

  const { results: steps } = await env.DB.prepare(
    "SELECT step_index, node_type, status, input_json, output_json, started_at, finished_at FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index",
  ).bind(runId).all<StepDb>();

  // 전체 점검(2026-11-18) P1: 오래된 승인 메시지 차단. 큐는 at-least-once라 이미 처리된 승인 메시지가 다시 올 수 있다.
  // 그 사이 같은 단계(에이전트의 다음 턴)가 새로 승인을 요청했다면, 이 메시지는 그 요청보다 **먼저** 만들어진 것이므로
  // 새 요청의 승인이 아니다 — 무시한다. 정상 승인 메시지는 항상 승인 요청(requestedAt) 뒤에 만들어진다.
  if (approved) {
    const cur = steps.find((s) => s.step_index === stepIndex);
    const meta = cur ? (parseJson(cur.input_json) as { approval?: string; requestedAt?: string } | null) : null;
    const reqAt = meta?.approval === "requested" && meta.requestedAt ? Date.parse(meta.requestedAt) : NaN;
    const enqAt = Date.parse(msg.enqueuedAt);
    if (Number.isFinite(reqAt) && Number.isFinite(enqAt) && enqAt < reqAt) return;
  }

  // 4. 활성 시간 30분 상한
  const activeSinceMs = activeSince(run, steps, approved ? msg.enqueuedAt : undefined);
  if (Date.now() - activeSinceMs > RUN_MAX_ACTIVE_MS) {
    await finishRun(env, runId, "failed", { error: "실행 시간 상한(30분)을 넘었습니다." });
    return;
  }

  // 5. 정의 / 단계
  const wf = await env.DB.prepare("SELECT definition_json FROM workflows WHERE id = ? AND owner_id = ?")
    .bind(run.workflow_id, run.owner_id).first<{ definition_json: string }>();
  const def = wf ? (parseJson(wf.definition_json) as WorkflowDefinition | null) : null;
  const step = def && Array.isArray(def.steps) ? def.steps[stepIndex] : undefined;
  if (!def || !step) {
    await finishRun(env, runId, "failed", { error: `단계 정의를 찾을 수 없습니다 (#${stepIndex}).` });
    return;
  }

  // 6. 멱등성 / 점유
  const existing = steps.find((s) => s.step_index === stepIndex);
  if (existing?.status === "succeeded") {
    await advance(env, runId, def, stepIndex, parseJson(existing.output_json)); // 재전달 — 저장된 출력으로 다음 단계
    return;
  }
  if (!existing) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO workflow_run_steps(run_id,step_index,node_type,node_name,status) VALUES(?,?,?,?,'pending')",
    ).bind(runId, stepIndex, step.type, step.name).run();
  }
  const startedAt = nowIso();
  const claim = await env.DB.prepare(
    "UPDATE workflow_run_steps SET status='running', started_at=?, error=NULL, finished_at=? WHERE run_id=? AND step_index=? AND status IN ('pending','failed')",
  ).bind(startedAt, null, runId, stepIndex).run();
  if ((claim.meta?.changes ?? 0) === 0) return; // 다른 전달이 처리 중 (또는 running에 고아로 남음 → sweep)

  try {
    const input = (parseJson(run.input_json) as Record<string, unknown>) ?? {};
    const stepOutputs = stepOutputsBefore(def, steps, stepIndex);

    // 7. 승인 게이트 (1차 방어선 — send_email 노드도 ctx.approved를 다시 확인한다)
    if (step.type !== "agent" && needsApproval(step) && !approved) {
      await pauseForApproval(env, run, step, stepIndex, input, stepOutputs);
      return; // 다음 단계 메시지 없음
    }
    if (approved) {
      await env.DB.prepare("UPDATE workflow_run_steps SET input_json=? WHERE run_id=? AND step_index=?")
        .bind(JSON.stringify({ approval: "approved", approvedAt: startedAt }), runId, stepIndex).run();
    }
    await env.DB.prepare("UPDATE workflow_runs SET status='running', current_step=? WHERE id=? AND status IN ('queued','running','waiting_approval')")
      .bind(stepIndex, runId).run();

    // 8. LLM 호출 상한 — 이 단계가 LLM 노드이고 이전 LLM 단계가 이미 30개면 거부
    if (LLM_NODE_TYPES.includes(step.type)) {
      const llmSoFar = steps.filter((s) => s.step_index !== stepIndex && (LLM_NODE_TYPES as string[]).includes(s.node_type)).length;
      if (llmSoFar >= LLM_CALL_CAP) {
        const error = `LLM 호출 상한(${LLM_CALL_CAP}회)에 도달`;
        await setStep(env, runId, stepIndex, "running", { status: "failed", error, finished: true });
        await finishRun(env, runId, "failed", { error });
        return;
      }
    }

    // 9. 실행
    // 전체 점검(2026-11-18) P1: 비활성 계정의 스케줄·이벤트 run이 계속 도는 것을 막는다 (로그인 세션과 같은 status='active' 조건).
    const u = await env.DB.prepare("SELECT id, email, name, role, coaching_role FROM users WHERE id = ? AND status = 'active'")
      .bind(run.owner_id).first<{ id: string; email: string; name: string | null; role: string; coaching_role: string | null }>();
    if (!u) {
      const error = "실행한 사용자를 찾을 수 없습니다.";
      await setStep(env, runId, stepIndex, "running", { status: "failed", error, finished: true });
      await finishRun(env, runId, "failed", { error });
      return;
    }
    const user = { id: u.id, email: u.email, name: u.name ?? "", role: u.role, coaching_role: u.coaching_role ?? undefined };
    const ctx: NodeContext = { env, user, runId, workflowId: run.workflow_id, stepIndex, input, stepOutputs, approved };

    // 9-a. agent 단계 (WF-6): 한 턴만 진행. 절대 executeNode로 보내지 않는다.
    if (step.type === "agent") {
      await advanceAgentTurn(env, { step, msg, approved, ctx, activeSinceMs }, agentHooks(env, run, def, step, stepIndex));
      return;
    }

    const res: NodeResult = await executeNode(step.type, ctx, step.config ?? {});

    // 10~13. 기록
    if (res.status === "waiting_approval") {
      // 2차 방어선: 노드가 승인을 요구했다 (엔진 게이트를 통과했는데도). 승인 대기로 멈춘다.
      await pauseForApproval(env, run, step, stepIndex, input, stepOutputs);
      return;
    }
    if (res.status === "succeeded") {
      await setStep(env, runId, stepIndex, "running", { status: "succeeded", output: res.output ?? null, error: null, finished: true });
      await advance(env, runId, def, stepIndex, res.output ?? null);
      return;
    }
    const error = res.error || "단계 실행에 실패했습니다.";
    await setStep(env, runId, stepIndex, "running", { status: "failed", error, finished: true });
    await finishRun(env, runId, "failed", { error: `${step.name}: ${error}` });
  } catch (e) {
    // 엔진 예외: 점유를 풀어(failed) 재전달 때 다시 점유할 수 있게 하고 큐 재시도에 맡긴다.
    try {
      await setStep(env, runId, stepIndex, "running", { status: "failed", error: `엔진 오류(재시도 예정): ${errMsg(e)}`, finished: true });
    } catch { /* D1 자체가 죽었으면 sweep이 정리 */ }
    throw e;
  }
}

/**
 * WF-4 승인 API가 부른다. 호출 전에 소유자 확인은 WF-4가 해야 한다 (이 함수는 owner 검사 없음).
 * waiting_approval → running 으로 바꾸고 멈춘 단계(current_step)를 approved:true로 다시 큐에 넣는다.
 */
export async function resumeWorkflowRun(env: Env, runId: string): Promise<{ ok: boolean; error?: string }> {
  const run = await env.DB.prepare("SELECT status, current_step FROM workflow_runs WHERE id = ?").bind(runId)
    .first<{ status: string; current_step: number | null }>();
  if (!run) return { ok: false, error: "실행을 찾을 수 없습니다." };
  if (run.status !== "waiting_approval") return { ok: false, error: `승인 대기 상태가 아닙니다 (${run.status}).` };
  const upd = await env.DB.prepare("UPDATE workflow_runs SET status='running' WHERE id=? AND status='waiting_approval'").bind(runId).run();
  if ((upd.meta?.changes ?? 0) === 0) return { ok: false, error: "이미 처리된 승인입니다." };
  try {
    await env.PIPELINE.send(stepMessage(runId, run.current_step ?? 0, true));
  } catch (e) {
    await env.DB.prepare("UPDATE workflow_runs SET status='waiting_approval' WHERE id=? AND status='running'").bind(runId).run();
    return { ok: false, error: `큐 전송 실패: ${errMsg(e)}` };
  }
  return { ok: true };
}

/** WF-4 거절 API가 부른다 (owner 검사는 WF-4). waiting_approval → cancelled, 대기 중 단계는 skipped. */
export async function cancelWorkflowRun(env: Env, runId: string): Promise<{ ok: boolean }> {
  const r = await env.DB.prepare(
    "UPDATE workflow_runs SET status='cancelled', error='승인 거절로 취소됨', finished_at=? WHERE id=? AND status='waiting_approval'",
  ).bind(nowIso(), runId).run();
  const ok = (r.meta?.changes ?? 0) > 0;
  if (ok) {
    await env.DB.prepare("UPDATE workflow_run_steps SET status='skipped', finished_at=? WHERE run_id=? AND status='pending'").bind(nowIso(), runId).run();
  }
  return { ok };
}

/**
 * 정체 run 청소 (EVAL_CRON에서 호출). 한 번에 최대 100개.
 * - queued/running: started_at과 마지막 단계 활동이 모두 60분보다 오래됨 → failed "실행 시간 초과(60분)"
 *   (PIPELINE.send 실패로 queued에 남은 run, 실행 중 워커가 죽어 running에 남은 run이 여기서 정리된다.)
 * - waiting_approval: started_at과 마지막 단계 활동이 모두 7일보다 오래됨 → cancelled
 */
export async function sweepStaleWorkflowRuns(env: Env): Promise<{ failed: number; cancelled: number }> {
  const now = Date.now();
  const lastActivity = "COALESCE((SELECT MAX(COALESCE(s.finished_at, s.started_at)) FROM workflow_run_steps s WHERE s.run_id = r.id), r.started_at)";
  const pick = async (statuses: string, cutoff: string, limit: number) => {
    if (limit <= 0) return [] as string[];
    const { results } = await env.DB.prepare(
      `SELECT r.id FROM workflow_runs r WHERE r.status IN (${statuses}) AND r.started_at < ?1 AND ${lastActivity} < ?1 ORDER BY r.started_at LIMIT ?2`,
    ).bind(cutoff, limit).all<{ id: string }>();
    return results.map((x) => x.id);
  };
  const t = nowIso();
  const staleRunning = await pick("'queued','running'", new Date(now - STALE_RUN_MS).toISOString(), SWEEP_BATCH);
  const staleWaiting = await pick("'waiting_approval'", new Date(now - STALE_APPROVAL_MS).toISOString(), SWEEP_BATCH - staleRunning.length);
  let failed = 0, cancelled = 0;
  for (const id of staleRunning) {
    const r = await env.DB.prepare("UPDATE workflow_runs SET status='failed', error=?, finished_at=? WHERE id=? AND status IN ('queued','running')")
      .bind("실행 시간 초과(60분)", t, id).run();
    if ((r.meta?.changes ?? 0) > 0) {
      failed++;
      await env.DB.prepare("UPDATE workflow_run_steps SET status='failed', error=?, finished_at=? WHERE run_id=? AND status IN ('pending','running')")
        .bind("실행 시간 초과(60분)", t, id).run();
    }
  }
  for (const id of staleWaiting) {
    const r = await env.DB.prepare("UPDATE workflow_runs SET status='cancelled', error=?, finished_at=? WHERE id=? AND status='waiting_approval'")
      .bind("승인 대기 7일 초과로 취소됨", t, id).run();
    if ((r.meta?.changes ?? 0) > 0) {
      cancelled++;
      await env.DB.prepare("UPDATE workflow_run_steps SET status='skipped', finished_at=? WHERE run_id=? AND status='pending'").bind(t, id).run();
    }
  }
  return { failed, cancelled };
}

/** KST 기준 YYYY-MM-DD (하루 실행 상한의 날짜 경계). */
function kstDate(ms = Date.now()): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function dailyRateKey(userId: string, ms = Date.now()): string {
  return `wf:rl:${userId}:${kstDate(ms)}`;
}

/**
 * run 생성 전 가드 (routes POST /:id/runs). 동시 실행 3개, 하루 20회(KV 카운터, TTL 24시간).
 * KV·D1 오류는 통과시킨다 (fail-open, 기존 ask 레이트 리밋과 같은 원칙). KV 카운터는 원자적이지 않아
 * 동시에 몰린 요청은 상한을 조금 넘을 수 있다 (데모 규모에서 허용).
 */
export async function checkWorkflowRateLimit(env: Env, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workflow_runs WHERE owner_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`,
    ).bind(userId, ...ACTIVE).first<{ n: number }>();
    if ((row?.n ?? 0) >= MAX_CONCURRENT_RUNS) return { ok: false, reason: `동시 실행 상한(${MAX_CONCURRENT_RUNS}개)` };
    const key = dailyRateKey(userId);
    const cur = parseInt((await env.CACHE.get(key)) ?? "0", 10) || 0;
    if (cur >= MAX_DAILY_RUNS) return { ok: false, reason: `하루 실행 상한(${MAX_DAILY_RUNS}회)` };
    await env.CACHE.put(key, String(cur + 1), { expirationTtl: 24 * 60 * 60 });
    return { ok: true };
  } catch (e) {
    console.log("[workflow] rate limit check failed, fail-open:", errMsg(e));
    return { ok: true };
  }
}
