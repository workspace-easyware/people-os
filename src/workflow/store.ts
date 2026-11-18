// 워크플로우 D1 헬퍼 (WF-1). 모든 조회는 owner_id로 거른다 (없거나 타인 소유면 null).
import { uid } from "../lib";
import type { RunStatus, StepStatus, WorkflowDefinition, WorkflowStatus } from "./types";

type DB = D1Database;

export type WorkflowRow = {
  id: string; owner_id: string; name: string; description: string; status: WorkflowStatus;
  definition: WorkflowDefinition; created_at: string; updated_at: string;
  /** WF-9: 1이면 hr_admin이 지정한 조직 템플릿 (전원이 보고 복사할 수 있다). */
  is_template: number;
};
export type RunRow = {
  id: string; workflow_id: string; owner_id: string; status: RunStatus; input: Record<string, unknown>;
  output: unknown; current_step: number; error: string | null; started_at: string; finished_at: string | null;
};
export type RunStepRow = {
  id: number; run_id: string; step_index: number; node_type: string; node_name: string; status: StepStatus;
  input: unknown; output: unknown; error: string | null; started_at: string | null; finished_at: string | null;
};

const now = () => new Date().toISOString();
function parse(s: unknown): unknown {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function toWorkflow(r: Record<string, unknown>): WorkflowRow {
  return {
    id: r.id as string, owner_id: r.owner_id as string, name: r.name as string,
    description: (r.description as string) ?? "", status: r.status as WorkflowStatus,
    definition: parse(r.definition_json) as WorkflowDefinition,
    created_at: r.created_at as string, updated_at: r.updated_at as string,
    is_template: (r.is_template as number) ?? 0,
  };
}
function toRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string, workflow_id: r.workflow_id as string, owner_id: r.owner_id as string,
    status: r.status as RunStatus, input: (parse(r.input_json) as Record<string, unknown>) ?? {},
    output: parse(r.output_json), current_step: (r.current_step as number) ?? 0,
    error: (r.error as string) ?? null, started_at: r.started_at as string, finished_at: (r.finished_at as string) ?? null,
  };
}
function toStep(r: Record<string, unknown>): RunStepRow {
  return {
    id: r.id as number, run_id: r.run_id as string, step_index: r.step_index as number,
    node_type: r.node_type as string, node_name: r.node_name as string, status: r.status as StepStatus,
    input: parse(r.input_json), output: parse(r.output_json), error: (r.error as string) ?? null,
    started_at: (r.started_at as string) ?? null, finished_at: (r.finished_at as string) ?? null,
  };
}

// ── workflows ──
export async function createWorkflow(
  db: DB, ownerId: string, p: { name: string; description?: string; definition: WorkflowDefinition },
): Promise<WorkflowRow> {
  const id = uid("wf"), t = now();
  await db.prepare(
    "INSERT INTO workflows(id,owner_id,name,description,status,definition_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(id, ownerId, p.name, p.description ?? "", "draft", JSON.stringify(p.definition), t, t).run();
  return (await getWorkflow(db, ownerId, id))!;
}

export async function getWorkflow(db: DB, ownerId: string, id: string): Promise<WorkflowRow | null> {
  const r = await db.prepare("SELECT * FROM workflows WHERE id = ? AND owner_id = ?").bind(id, ownerId).first<Record<string, unknown>>();
  return r ? toWorkflow(r) : null;
}

/** 소유자 검사 없는 조회 — 공유 판정(sharing.ts)·복사 전용. 호출자가 canViewWorkflow로 반드시 거른다. */
export async function getWorkflowById(db: DB, id: string): Promise<WorkflowRow | null> {
  const r = await db.prepare("SELECT * FROM workflows WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return r ? toWorkflow(r) : null;
}

export async function listWorkflows(db: DB, ownerId: string, o: { limit?: number } = {}): Promise<WorkflowRow[]> {
  const limit = Math.min(Math.max(o.limit ?? 100, 1), 100);
  const { results } = await db.prepare("SELECT * FROM workflows WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(ownerId, limit).all<Record<string, unknown>>();
  return results.map(toWorkflow);
}

export async function updateWorkflow(
  db: DB, ownerId: string, id: string,
  patch: { name?: string; description?: string; status?: WorkflowStatus; definition?: WorkflowDefinition; is_template?: boolean },
): Promise<WorkflowRow | null> {
  const cur = await getWorkflow(db, ownerId, id);
  if (!cur) return null;
  // is_template는 라우트가 hr_admin만 통과시킨다. 값이 올 때만 건드린다 (0029 미적용 DB에서도 기존 PATCH가 돌게).
  if (patch.is_template !== undefined) {
    await db.prepare("UPDATE workflows SET is_template=? WHERE id=? AND owner_id=?").bind(patch.is_template ? 1 : 0, id, ownerId).run();
  }
  await db.prepare("UPDATE workflows SET name=?, description=?, status=?, definition_json=?, updated_at=? WHERE id=? AND owner_id=?")
    .bind(
      patch.name ?? cur.name, patch.description ?? cur.description, patch.status ?? cur.status,
      JSON.stringify(patch.definition ?? cur.definition), now(), id, ownerId,
    ).run();
  return getWorkflow(db, ownerId, id);
}

/** runs·steps까지 함께 삭제. 없거나 타인 소유면 false. */
export async function deleteWorkflow(db: DB, ownerId: string, id: string): Promise<boolean> {
  if (!(await getWorkflow(db, ownerId, id))) return false;
  await db.batch([
    db.prepare("DELETE FROM workflow_run_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = ? AND owner_id = ?)").bind(id, ownerId),
    db.prepare("DELETE FROM workflow_runs WHERE workflow_id = ? AND owner_id = ?").bind(id, ownerId),
    db.prepare("DELETE FROM workflows WHERE id = ? AND owner_id = ?").bind(id, ownerId),
  ]);
  return true;
}

// ── runs ──
export async function createRun(db: DB, ownerId: string, workflowId: string, input: Record<string, unknown>): Promise<RunRow> {
  const id = uid("wfrun");
  await db.prepare(
    "INSERT INTO workflow_runs(id,workflow_id,owner_id,status,input_json,current_step,started_at) VALUES(?,?,?,?,?,0,?)",
  ).bind(id, workflowId, ownerId, "queued", JSON.stringify(input ?? {}), now()).run();
  const r = await db.prepare("SELECT * FROM workflow_runs WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return toRun(r!);
}

export async function getRun(db: DB, ownerId: string, runId: string): Promise<(RunRow & { steps: RunStepRow[] }) | null> {
  const r = await db.prepare("SELECT * FROM workflow_runs WHERE id = ? AND owner_id = ?").bind(runId, ownerId).first<Record<string, unknown>>();
  if (!r) return null;
  const { results } = await db.prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index").bind(runId).all<Record<string, unknown>>();
  return { ...toRun(r), steps: results.map(toStep) };
}

export async function listRuns(db: DB, ownerId: string, workflowId: string, o: { limit?: number } = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 100);
  const { results } = await db.prepare(
    "SELECT * FROM workflow_runs WHERE workflow_id = ? AND owner_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
  ).bind(workflowId, ownerId, limit).all<Record<string, unknown>>();
  return results.map(toRun);
}

/** 엔진(WF-3)용 — owner 검사 없음 (runId는 서버 내부에서만 온다). */
export async function updateRun(
  db: DB, runId: string,
  patch: { status?: RunStatus; output?: unknown; current_step?: number; error?: string | null; finished_at?: string | null },
): Promise<void> {
  const sets: string[] = [], vals: unknown[] = [];
  if (patch.status !== undefined) { sets.push("status=?"); vals.push(patch.status); }
  if (patch.output !== undefined) { sets.push("output_json=?"); vals.push(JSON.stringify(patch.output)); }
  if (patch.current_step !== undefined) { sets.push("current_step=?"); vals.push(patch.current_step); }
  if (patch.error !== undefined) { sets.push("error=?"); vals.push(patch.error); }
  if (patch.finished_at !== undefined) { sets.push("finished_at=?"); vals.push(patch.finished_at); }
  if (!sets.length) return;
  await db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id=?`).bind(...vals, runId).run();
}

/** (run_id, step_index) 기준 upsert. 신규 삽입 시 node_type·node_name 필요. */
export async function upsertRunStep(
  db: DB, runId: string, stepIndex: number,
  patch: {
    node_type?: string; node_name?: string; status?: StepStatus; input?: unknown; output?: unknown;
    error?: string | null; started_at?: string | null; finished_at?: string | null;
  },
): Promise<void> {
  const ex = await db.prepare("SELECT id FROM workflow_run_steps WHERE run_id=? AND step_index=?").bind(runId, stepIndex).first();
  if (!ex) {
    await db.prepare(
      "INSERT INTO workflow_run_steps(run_id,step_index,node_type,node_name,status,input_json,output_json,error,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      runId, stepIndex, patch.node_type ?? "", patch.node_name ?? "", patch.status ?? "pending",
      patch.input === undefined ? null : JSON.stringify(patch.input),
      patch.output === undefined ? null : JSON.stringify(patch.output),
      patch.error ?? null, patch.started_at ?? null, patch.finished_at ?? null,
    ).run();
    return;
  }
  const sets: string[] = [], vals: unknown[] = [];
  if (patch.node_type !== undefined) { sets.push("node_type=?"); vals.push(patch.node_type); }
  if (patch.node_name !== undefined) { sets.push("node_name=?"); vals.push(patch.node_name); }
  if (patch.status !== undefined) { sets.push("status=?"); vals.push(patch.status); }
  if (patch.input !== undefined) { sets.push("input_json=?"); vals.push(JSON.stringify(patch.input)); }
  if (patch.output !== undefined) { sets.push("output_json=?"); vals.push(JSON.stringify(patch.output)); }
  if (patch.error !== undefined) { sets.push("error=?"); vals.push(patch.error); }
  if (patch.started_at !== undefined) { sets.push("started_at=?"); vals.push(patch.started_at); }
  if (patch.finished_at !== undefined) { sets.push("finished_at=?"); vals.push(patch.finished_at); }
  if (!sets.length) return;
  await db.prepare(`UPDATE workflow_run_steps SET ${sets.join(", ")} WHERE run_id=? AND step_index=?`).bind(...vals, runId, stepIndex).run();
}
