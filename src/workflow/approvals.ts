// 워크플로우 승인 요청 (WF-3, 2026-11-18). 승인이 필요한 단계에서 엔진이 부른다.
// notifications(0024) 행 1개를 run 소유자에게 만든다. 승인/거절 API는 WF-4, UI는 WF-5.
// link 형식: /#workflow/<workflowId>?run=<runId>  ← WF-5 UI가 이 해시를 지원해야 한다.
// 멱등: 알림 id를 (runId, stepIndex)로 결정적으로 만들고 INSERT OR IGNORE — 재전달돼도 1행.
import type { ApprovalRequest, Env } from "./types";
import { pushNotification } from "../notifications/push";

export function workflowApprovalLink(workflowId: string, runId: string): string {
  return `/#workflow/${encodeURIComponent(workflowId)}?run=${encodeURIComponent(runId)}`;
}

export function workflowApprovalNotificationId(runId: string, stepIndex: number, turn?: number): string {
  // agent 단계(WF-6)는 한 단계 안에서 승인이 여러 번 필요할 수 있어 턴 번호를 붙인다. 일반 단계는 그대로.
  return turn === undefined ? `wfapr_${runId}_${stepIndex}` : `wfapr_${runId}_${stepIndex}_t${turn}`;
}

export async function requestWorkflowApproval(env: Env, req: ApprovalRequest): Promise<void> {
  const run = await env.DB.prepare("SELECT owner_id FROM workflow_runs WHERE id = ?").bind(req.runId).first<{ owner_id: string }>();
  if (!run) return; // 삭제된 run — 알릴 대상 없음
  const wf = await env.DB.prepare("SELECT name FROM workflows WHERE id = ?").bind(req.workflowId).first<{ name: string }>();
  const title = `워크플로우 승인 요청: ${wf?.name ?? req.workflowId} — ${req.nodeName}`;
  const body = `노드: ${req.nodeType}${req.summary ? `\n${req.summary}` : ""}`;
  const id = workflowApprovalNotificationId(req.runId, req.stepIndex, req.turn);
  const link = workflowApprovalLink(req.workflowId, req.runId);
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO notifications(id,user_id,type,ref_type,ref_id,title,body,link,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).bind(id, run.owner_id, "WORKFLOW_APPROVAL", "workflow_run", req.runId, title.slice(0, 300), body.slice(0, 2000), link, now).run();
  // DO-2: INSERT가 실제로 1행 들어갔을 때만(재전달로 무시된 경우 제외), D1 밖에서 푸시. 실패는 무시된다.
  if ((res.meta?.changes ?? 0) === 1) {
    await pushNotification(env, run.owner_id, { id, type: "WORKFLOW_APPROVAL", title: title.slice(0, 300), body: body.slice(0, 2000), link, created_at: now });
  }
}
