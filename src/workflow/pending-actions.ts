// 비동기 승인 P2 (2026-11-21): 대기 동작(workflow_pending_actions, 0042) 목록·결정·실행.
// - 목록·결정은 routes.ts의 GET /pending-actions, POST /pending-actions/decide가 부른다.
// - 실행은 큐 소비자(index.ts queue())가 workflow-action 메시지마다 processWorkflowAction을 부른다. processWorkflowStep과 별개다.
//
// 상태 전이 (전부 조건부 UPDATE — 경합·재전달에도 한 번만):
//   queued → approved (결정 API) → executing (소비자 점유) → executed | failed
//   queued → rejected (결정 API)          queued → expired (15분 크론, P1)
// 실행은 at-most-once다: 노드를 부른 뒤에 기록이 실패하면 행은 executing에 남는다 (다시 실행하지 않는다).
import { executeNode } from "./nodes";
import { logEvent } from "../obs/log";
import { DEFERRABLE_NODES, type Env, type NodeContext, type NodeType, type WorkflowActionMessage } from "./types";

export const PENDING_ACTION_STATUSES = ["queued", "approved", "executing", "executed", "rejected", "failed", "expired"] as const;
export const DECIDE_MAX_IDS = 50;

type Row = {
  id: string; run_id: string; step_index: number; turn: number | null; owner_id: string; node_type: string;
  args_json: string; simulated_output_json: string | null; status: string; result_json: string | null; error: string | null;
  created_at: string; decided_at: string | null; executed_at: string | null;
};

const nowIso = () => new Date().toISOString();
function parse(s: string | null | undefined): unknown {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 승인함에 보일 인자 요약. 메일 본문은 앞부분만, 웹훅 헤더는 **키만** (값은 토큰일 수 있다 — 공유 경로 redactShared와 같은 원칙).
 * 실행에는 args_json 원본을 쓴다.
 */
export function summarizeArgs(nodeType: string, args: unknown): Record<string, unknown> {
  const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  if (nodeType === "send_email") {
    const body = str(a.body ?? a.text);
    return { to: a.to ?? null, subject: str(a.subject), bodyPreview: clip(body, 200), bodyLength: body.length };
  }
  if (nodeType === "webhook") {
    const h = a.headers && typeof a.headers === "object" && !Array.isArray(a.headers) ? Object.keys(a.headers as object) : [];
    const body = a.body === undefined || a.body === null ? "" : str(a.body);
    return { method: a.method === undefined ? "POST" : str(a.method), url: str(a.url), headerKeys: h, bodyPreview: clip(body, 200) };
  }
  return {};
}

/** 실행 결과 요약 (웹훅 응답 본문은 길 수 있다 — 앞부분만). */
function summarizeResult(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v ?? null;
  const o = { ...(v as Record<string, unknown>) };
  if (typeof o.body === "string") o.body = clip(o.body, 500);
  if (o.json !== undefined) delete o.json;
  return o;
}

export function toListItem(r: Row & { workflow_id?: string | null; workflow_name?: string | null }, withOwner: boolean) {
  const item: Record<string, unknown> = {
    id: r.id, run_id: r.run_id, workflow_id: r.workflow_id ?? null, workflow_name: r.workflow_name ?? null,
    step_index: r.step_index, turn: r.turn, node_type: r.node_type,
    args: summarizeArgs(r.node_type, parse(r.args_json)),
    simulated_output: parse(r.simulated_output_json),
    status: r.status, result: summarizeResult(parse(r.result_json)), error: r.error,
    created_at: r.created_at, decided_at: r.decided_at, executed_at: r.executed_at,
  };
  if (withOwner) item.owner_id = r.owner_id;
  return item;
}

/** 목록. 본인 것만 (hr_admin은 전부). status·run_id 필터, 최신순. */
export async function listPendingActions(env: Env, u: { id: string; role: string }, f: { status?: string; runId?: string; limit?: number }) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const admin = u.role === "hr_admin";
  if (!admin) { where.push("a.owner_id = ?"); binds.push(u.id); }
  if (f.status) { where.push("a.status = ?"); binds.push(f.status); }
  if (f.runId) { where.push("a.run_id = ?"); binds.push(f.runId); }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT a.*, r.workflow_id AS workflow_id, w.name AS workflow_name
       FROM workflow_pending_actions a
       LEFT JOIN workflow_runs r ON r.id = a.run_id
       LEFT JOIN workflows w ON w.id = r.workflow_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
  ).bind(...binds, limit).all<Row & { workflow_id: string | null; workflow_name: string | null }>();
  return results.map((r) => toListItem(r, admin));
}

export type DecideResult = { id: string; status: string; code: 200 | 404 | 409 | 500; error?: string };

/**
 * 결정. id마다 본인 행만 (남의 id는 없는 id와 같이 404 — 존재를 흘리지 않는다. hr_admin도 남의 동작은 결정하지 못한다: 실행자는 소유자다).
 * queued인 행만 결정할 수 있다 (아니면 409). 승인은 queued→approved 뒤 workflow-action 메시지를 넣는다 — 전송이 실패하면 queued로 되돌린다.
 */
export async function decidePendingActions(env: Env, userId: string, ids: string[], action: "approve" | "reject"): Promise<DecideResult[]> {
  const out: DecideResult[] = [];
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT id, status FROM workflow_pending_actions WHERE id = ? AND owner_id = ?")
      .bind(id, userId).first<{ id: string; status: string }>();
    if (!row) { out.push({ id, status: "not_found", code: 404, error: "대기 동작을 찾을 수 없습니다." }); continue; }
    const t = nowIso();
    const to = action === "approve" ? "approved" : "rejected";
    const upd = await env.DB.prepare("UPDATE workflow_pending_actions SET status = ?, decided_at = ? WHERE id = ? AND owner_id = ? AND status = 'queued'")
      .bind(to, t, id, userId).run();
    if ((upd.meta?.changes ?? 0) === 0) {
      const cur = await env.DB.prepare("SELECT status FROM workflow_pending_actions WHERE id = ?").bind(id).first<{ status: string }>();
      out.push({ id, status: cur?.status ?? row.status, code: 409, error: `이미 결정된 동작입니다 (${cur?.status ?? row.status}).` });
      continue;
    }
    if (action === "approve") {
      try {
        await env.PIPELINE.send({ type: "workflow-action", pendingActionId: id, enqueuedAt: t } satisfies WorkflowActionMessage);
      } catch (e) {
        await env.DB.prepare("UPDATE workflow_pending_actions SET status = 'queued', decided_at = NULL WHERE id = ? AND status = 'approved'").bind(id).run();
        out.push({ id, status: "queued", code: 500, error: `큐 전송 실패 — 다시 시도하세요: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
    }
    logEvent("workflow.pending_action_decided", { pendingActionId: id, action });
    out.push({ id, status: to, code: 200 });
  }
  return out;
}

/**
 * 큐 소비자: 승인된 대기 동작 1개를 실행한다. 노드 실패는 행에 failed로 남기고 끝낸다 (재큐 없음).
 * 엔진 예외(D1 등)는 throw → 큐 재시도. 노드를 부르기 전의 예외면 점유를 approved로 되돌려 재시도가 다시 점유할 수 있게 한다.
 */
export async function processWorkflowAction(env: Env, msg: WorkflowActionMessage): Promise<void> {
  const id = msg?.pendingActionId;
  if (typeof id !== "string" || !id) return;
  // 1. 행 / 방어
  const row = await env.DB.prepare("SELECT * FROM workflow_pending_actions WHERE id = ?").bind(id).first<Row>();
  if (!row || row.status !== "approved") return;
  // 2. 점유 (at-least-once 재전달에도 1회만)
  const claim = await env.DB.prepare("UPDATE workflow_pending_actions SET status = 'executing' WHERE id = ? AND status = 'approved'").bind(id).run();
  if ((claim.meta?.changes ?? 0) === 0) return;

  const finish = async (status: "executed" | "failed", p: { result?: unknown; error?: string }) => {
    await env.DB.prepare("UPDATE workflow_pending_actions SET status = ?, result_json = ?, error = ?, executed_at = ? WHERE id = ? AND status = 'executing'")
      .bind(status, p.result === undefined ? null : JSON.stringify(p.result), p.error ?? null, nowIso(), id).run();
    logEvent("workflow.pending_action_executed", { pendingActionId: id, status, nodeType: row.node_type });
  };

  let ctx: NodeContext;
  let args: Record<string, unknown>;
  try {
    // 3. 실행자 = run 소유자. 엔진 9번과 같은 조건(status='active').
    const u = await env.DB.prepare("SELECT id, email, name, role, coaching_role FROM users WHERE id = ? AND status = 'active'")
      .bind(row.owner_id).first<{ id: string; email: string; name: string | null; role: string; coaching_role: string | null }>();
    if (!u) { await finish("failed", { error: "실행할 사용자(소유자)가 비활성이거나 없습니다." }); return; }
    if (!(DEFERRABLE_NODES as string[]).includes(row.node_type)) { await finish("failed", { error: `지연 실행할 수 없는 노드입니다: ${row.node_type}` }); return; }
    const parsed = parse(row.args_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { await finish("failed", { error: "저장된 인자를 읽을 수 없습니다." }); return; }
    args = parsed as Record<string, unknown>;
    const run = await env.DB.prepare("SELECT workflow_id FROM workflow_runs WHERE id = ?").bind(row.run_id).first<{ workflow_id: string }>();
    ctx = {
      env, user: { id: u.id, email: u.email, role: u.role, coaching_role: u.coaching_role ?? undefined },
      runId: row.run_id, workflowId: run?.workflow_id ?? "", stepIndex: row.step_index, input: {}, stepOutputs: {}, approved: true,
    };
  } catch (e) {
    // 노드 실행 전 엔진 예외: 점유를 되돌리고 재시도에 맡긴다.
    try { await env.DB.prepare("UPDATE workflow_pending_actions SET status = 'approved' WHERE id = ? AND status = 'executing'").bind(id).run(); } catch { /* D1이 죽었으면 executing에 남는다 */ }
    throw e;
  }
  // 4. 실행 — 이미 치환된 args 그대로 (stepOutputs 없이 resolveVars가 다시 돌지만 {{가 없어 무해). 노드가 검증·SSRF를 다시 한다.
  const res = await executeNode(row.node_type as NodeType, ctx, args);
  // 5. 기록 (여기서 D1이 실패하면 throw — 행은 executing에 남고 재전달은 점유에 실패해 다시 실행하지 않는다)
  if (res.status === "succeeded") await finish("executed", { result: res.output ?? null });
  else await finish("failed", { error: res.status === "failed" ? (res.error || "실행에 실패했습니다.") : "승인된 실행인데 노드가 다시 승인을 요구했습니다." });
}
