// 워크플로우 공유·템플릿 판정 (WF-9, 2026-11-18). 제안서 4.2.3.
// 원칙: 공유는 "보기/복사"만 연다. 실행·run 조회·승인·스케줄은 항상 소유자 (routes.ts가 getWorkflow(owner)로 막는다).
// 판정은 요청 시점에 D1에서 읽는다 (부서를 옮기면 바로 반영된다). SessionUser에는 department가 없다.
import { uid } from "../lib";
import { getWorkflow, toWorkflow, type WorkflowRow } from "./store";

type DB = D1Database;

export type ShareScope = "department" | "all";
export type SharePermission = "view" | "copy";
export const SHARE_SCOPES: readonly ShareScope[] = ["department", "all"];
export const SHARE_PERMISSIONS: readonly SharePermission[] = ["view", "copy"];

export type ShareRow = {
  id: string; workflow_id: string; owner_id: string; scope: ShareScope; permission: SharePermission; created_at: string;
};
export type SharedVia = "department" | "all" | "template";
export type Access = { view: boolean; copy: boolean };

/** 존재 은닉용 — 라우트의 onError가 404로 바꾼다 (403이 아니라 404). */
export class ShareNotFound extends Error {
  constructor(message = "워크플로우를 찾을 수 없습니다.") { super(message); }
}

const SHARE_COLS = "id, workflow_id, owner_id, scope, permission, created_at";

export async function getUserDepartment(db: DB, userId: string): Promise<string | null> {
  const r = await db.prepare("SELECT department_id FROM users WHERE id = ?").bind(userId).first<{ department_id: string | null }>();
  return r?.department_id ?? null;
}

/** 공유 행들 + 보는 사람 기준으로 열리는 권한과 경로를 계산한다 (템플릿·소유자 판정은 호출자가 먼저). */
async function accessFromShares(
  db: DB, viewerId: string, shares: Pick<ShareRow, "owner_id" | "scope" | "permission">[], deptCache: Map<string, string | null>,
): Promise<{ access: Access; via: SharedVia | null }> {
  const deptOf = async (uid_: string) => {
    if (!deptCache.has(uid_)) deptCache.set(uid_, await getUserDepartment(db, uid_));
    return deptCache.get(uid_) ?? null;
  };
  let view = false, copy = false;
  let via: SharedVia | null = null;
  for (const s of shares) {
    let applies = s.scope === "all";
    if (s.scope === "department") {
      const [ownerDept, viewerDept] = await Promise.all([deptOf(s.owner_id), deptOf(viewerId)]);
      applies = ownerDept !== null && viewerDept !== null && ownerDept === viewerDept; // 둘 다 NULL이 아니고 같아야 한다
    }
    if (!applies) continue;
    view = true; // copy는 view를 포함한다
    if (s.permission === "copy") copy = true;
    if (via === null || s.scope === "all") via = s.scope; // 더 넓은 범위(all)를 표시
  }
  return { access: { view, copy }, via };
}

export async function canViewWorkflow(db: DB, viewerId: string, workflow: WorkflowRow): Promise<Access> {
  if (workflow.owner_id === viewerId) return { view: true, copy: true };
  if (workflow.is_template === 1) return { view: true, copy: true };
  const { results } = await db.prepare("SELECT owner_id, scope, permission FROM workflow_shares WHERE workflow_id = ?")
    .bind(workflow.id).all<Pick<ShareRow, "owner_id" | "scope" | "permission">>();
  if (!results.length) return { view: false, copy: false };
  return (await accessFromShares(db, viewerId, results, new Map())).access;
}

/** GET /shared 응답용 판정: 목록 항목마다 shared_via·can_copy를 붙일 수 있게 경로도 돌려준다. */
export async function sharedAccess(db: DB, viewerId: string, workflow: WorkflowRow): Promise<{ access: Access; via: SharedVia | null }> {
  if (workflow.owner_id === viewerId) return { access: { view: true, copy: true }, via: null };
  if (workflow.is_template === 1) return { access: { view: true, copy: true }, via: "template" };
  const { results } = await db.prepare("SELECT owner_id, scope, permission FROM workflow_shares WHERE workflow_id = ?")
    .bind(workflow.id).all<Pick<ShareRow, "owner_id" | "scope" | "permission">>();
  return accessFromShares(db, viewerId, results, new Map());
}

const LIST_LIMIT = 200;

/**
 * 내가 볼 수 있는 남의 워크플로우 + 템플릿. 전체 스캔 대신 (공유 행이 있는 것 ∪ 템플릿)으로 후보를 좁힌 뒤 판정한다.
 * 부서 판정의 사용자 조회는 소유자별로 1번만 한다. 내 워크플로우는 제외.
 */
export async function listSharedEntries(db: DB, viewerId: string): Promise<{ workflow: WorkflowRow; via: SharedVia; can_copy: boolean }[]> {
  const { results } = await db.prepare(
    `SELECT w.* FROM workflows w
      WHERE w.owner_id <> ?1
        AND (w.is_template = 1 OR w.id IN (SELECT workflow_id FROM workflow_shares))
      ORDER BY w.updated_at DESC, w.id DESC LIMIT ?2`,
  ).bind(viewerId, LIST_LIMIT).all<Record<string, unknown>>();
  const deptCache = new Map<string, string | null>();
  const out: { workflow: WorkflowRow; via: SharedVia; can_copy: boolean }[] = [];
  for (const raw of results) {
    const workflow = toWorkflow(raw);
    if (workflow.is_template === 1) { out.push({ workflow, via: "template", can_copy: true }); continue; }
    const { results: shares } = await db.prepare("SELECT owner_id, scope, permission FROM workflow_shares WHERE workflow_id = ?")
      .bind(workflow.id).all<Pick<ShareRow, "owner_id" | "scope" | "permission">>();
    const { access, via } = await accessFromShares(db, viewerId, shares, deptCache);
    if (access.view && via) out.push({ workflow, via, can_copy: access.copy });
  }
  return out;
}

export async function listSharedWithMe(db: DB, viewerId: string): Promise<WorkflowRow[]> {
  return (await listSharedEntries(db, viewerId)).map((e) => e.workflow);
}

// ── 공유 행 CRUD (소유자만 — 타인·없음은 ShareNotFound) ──
async function requireOwner(db: DB, ownerId: string, workflowId: string): Promise<void> {
  if (!(await getWorkflow(db, ownerId, workflowId))) throw new ShareNotFound();
}

/** 같은 scope가 이미 있으면 permission만 갱신한다 (upsert). created=true면 신규. */
export async function createShare(
  db: DB, ownerId: string, workflowId: string, scope: ShareScope, permission: SharePermission,
): Promise<{ share: ShareRow; created: boolean }> {
  await requireOwner(db, ownerId, workflowId);
  const existing = await db.prepare("SELECT id FROM workflow_shares WHERE workflow_id = ? AND scope = ?").bind(workflowId, scope).first<{ id: string }>();
  await db.prepare(
    `INSERT INTO workflow_shares(id, workflow_id, owner_id, scope, permission) VALUES(?,?,?,?,?)
     ON CONFLICT(workflow_id, scope) DO UPDATE SET permission = excluded.permission`,
  ).bind(uid("wfsh"), workflowId, ownerId, scope, permission).run();
  const share = (await db.prepare(`SELECT ${SHARE_COLS} FROM workflow_shares WHERE workflow_id = ? AND scope = ?`).bind(workflowId, scope).first<ShareRow>())!;
  return { share, created: !existing };
}

export async function listShares(db: DB, ownerId: string, workflowId: string): Promise<ShareRow[]> {
  await requireOwner(db, ownerId, workflowId);
  const { results } = await db.prepare(`SELECT ${SHARE_COLS} FROM workflow_shares WHERE workflow_id = ? ORDER BY created_at, id`)
    .bind(workflowId).all<ShareRow>();
  return results;
}

export async function deleteShare(db: DB, ownerId: string, workflowId: string, shareId: string): Promise<void> {
  await requireOwner(db, ownerId, workflowId);
  const r = await db.prepare("DELETE FROM workflow_shares WHERE id = ? AND workflow_id = ?").bind(shareId, workflowId).run();
  if ((r.meta?.changes ?? 0) < 1) throw new ShareNotFound("공유를 찾을 수 없습니다.");
}
