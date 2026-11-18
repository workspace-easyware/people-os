// 결재 상태머신 (2026-11-17, groupware-approval-plan.md 4.6). 문서·결재선의 모든 쓰기는 이 파일만 한다.
//
// 전이표 (easy-ware ALLOWED_FROM의 부분집합 + 빈틈 보완):
//   SUBMIT              기안자          DRAFT, RECALLED → IN_PROGRESS  결재선 초기화 + 첫 결재자 APPROVING + 알림
//   REQUEST_RE_APPROVAL 기안자          RECALLED        → IN_PROGRESS  (재상신) SUBMIT과 같은 처리 — 첫 결재자를 다시 APPROVING
//   APPROVE             현재 결재자      IN_PROGRESS     → IN_PROGRESS  다음 결재자 APPROVING + 알림
//                                                     → COMPLETED    마지막이면 채번 + 기안자 알림 + 후처리(hooks.ts)
//   REJECT              현재 결재자      IN_PROGRESS     → REJECTED     의견 필수, 남은 결재선 SKIPPED, 기안자 알림
//   RECALL              기안자          IN_PROGRESS     → RECALLED     결재선 전체 PENDING 초기화, 현재 결재자 알림
//   FORCE_REJECT        hr_admin        COMPLETED       → REJECTED     의견 필수, 기안자 알림
//
// 원자성·경합: 액션마다 D1 batch() 한 번. batch의 첫 문장은 "전제 조건이 맞을 때만" 감사 행을 넣고(INSERT … SELECT … WHERE 전제),
// 나머지 문장은 모두 `EXISTS(그 감사 행)`을 조건으로 건다. 판정 문장은 `UPDATE … WHERE status = 'APPROVING'`(결재) 또는
// `UPDATE … WHERE status IN (…) [AND version = ?]`(문서)이며, 그 변경 행 수가 1이 아니면 409로 답한다.
// D1 batch는 트랜잭션으로 직렬 실행되므로, 같은 결재 칸을 두 요청이 동시에 승인하면 한 건만 감사 행이 생기고 다른 건은 아무것도 바꾸지 않는다.
//
// 상신 후에는 본문·결재선을 바꿀 수 없다 (editDraft는 DRAFT/RECALLED에서만). 고치려면 회수한다.
import { uid } from "../lib";
import { makeNotify, notificationStmt, type NotifySpec } from "./notify";
import { pushNotification, type PushEnv } from "../notifications/push";
import { ApprovalError, type Action, type DocRow, type DocStatus, type RouteRow, type RouteSpec } from "./types";

export type Actor = { id: string; role: "hr_admin" | "user" };
export type RequestMeta = { ip: string | null; userAgent: string | null };

export const ALLOWED_FROM: Record<Action, DocStatus[]> = {
  SUBMIT: ["DRAFT", "RECALLED"],
  REQUEST_RE_APPROVAL: ["RECALLED"],
  APPROVE: ["IN_PROGRESS"],
  REJECT: ["IN_PROGRESS"],
  RECALL: ["IN_PROGRESS"],
  FORCE_REJECT: ["COMPLETED"],
};

export const EDITABLE: DocStatus[] = ["DRAFT", "RECALLED"];

export type ActionResult = { action: Action; before: DocStatus; after: DocStatus; notifications: NotifySpec[]; runHook: boolean };

function approvers(routes: RouteRow[]): RouteRow[] {
  return routes.filter((r) => r.role === "APPROVER").sort((a, b) => a.step_no - b.step_no);
}

export function currentRoute(routes: RouteRow[]): RouteRow | undefined {
  return approvers(routes).find((r) => r.status === "APPROVING");
}

/** 이 사용자가 지금 이 문서에 할 수 있는 액션 (UI 버튼용 — 서버 판정은 performAction이 다시 한다). */
export function availableActions(doc: DocRow, routes: RouteRow[], actor: Actor): Action[] {
  const out: Action[] = [];
  const isDrafter = doc.drafter_id === actor.id;
  const cur = currentRoute(routes);
  if (isDrafter && ALLOWED_FROM.SUBMIT.includes(doc.status)) out.push("SUBMIT");
  if (isDrafter && ALLOWED_FROM.REQUEST_RE_APPROVAL.includes(doc.status)) out.push("REQUEST_RE_APPROVAL");
  if (isDrafter && ALLOWED_FROM.RECALL.includes(doc.status)) out.push("RECALL");
  if (doc.status === "IN_PROGRESS" && cur && cur.actor_user_id === actor.id) out.push("APPROVE", "REJECT");
  if (actor.role === "hr_admin" && ALLOWED_FROM.FORCE_REJECT.includes(doc.status)) out.push("FORCE_REJECT");
  return out;
}

function kstYear(): string {
  return String(new Date(Date.now() + 9 * 3600_000).getUTCFullYear());
}

function auditInsert(
  db: D1Database, auditId: string, doc: DocRow, actor: Actor, action: string, after: DocStatus | null,
  comment: string | null, meta: RequestMeta, now: string, preSql: string, preBinds: unknown[],
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO approval_audit (id, document_id, actor_user_id, action, before_status, after_status, comment, ip, user_agent, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${preSql}`,
  ).bind(auditId, doc.id, actor.id, action, doc.status, after, comment, meta.ip, meta.userAgent, now, ...preBinds);
}

const GUARD = "EXISTS (SELECT 1 FROM approval_audit WHERE id = ?)";

/** 상태 전이 단일 관문. 실패는 ApprovalError(4xx). */
export async function performAction(
  db: D1Database, doc: DocRow, routes: RouteRow[], actor: Actor, action: Action, rawComment: unknown, meta: RequestMeta,
  pushEnv?: PushEnv, // DO-2: 있으면 batch 커밋 성공 뒤 각 알림을 실시간 푸시 (없으면 건너뜀 — 폴링이 폴백)
): Promise<ActionResult> {
  const comment = typeof rawComment === "string" && rawComment.trim() ? rawComment.trim().slice(0, 2000) : null;
  if (!ALLOWED_FROM[action].includes(doc.status)) {
    throw new ApprovalError(409, `현재 상태(${doc.status})에서는 ${action}을(를) 할 수 없습니다.`);
  }
  const now = new Date().toISOString();
  const auditId = uid("aud");
  const isDrafter = doc.drafter_id === actor.id;
  const stmts: D1PreparedStatement[] = [];
  const notifications: NotifySpec[] = [];
  let after: DocStatus;
  let verdictIndex: number; // 변경 행 수로 성공을 판정할 문장
  let runHook = false;

  switch (action) {
    case "SUBMIT":
    case "REQUEST_RE_APPROVAL": {
      if (!isDrafter) throw new ApprovalError(403, "기안자만 상신할 수 있습니다.");
      const first = approvers(routes)[0];
      if (!first) throw new ApprovalError(400, "결재자가 없습니다. 결재선을 지정한 뒤 상신하세요.");
      after = "IN_PROGRESS";
      const from = ALLOWED_FROM[action];
      const pre = `EXISTS (SELECT 1 FROM approval_documents WHERE id = ? AND version = ? AND status IN (${from.map(() => "?").join(",")}))`;
      stmts.push(auditInsert(db, auditId, doc, actor, action, after, comment, meta, now, pre, [doc.id, doc.version, ...from]));
      verdictIndex = stmts.length;
      stmts.push(db.prepare(
        `UPDATE approval_documents SET status = 'IN_PROGRESS', submitted_at = ?, completed_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND ${GUARD}`,
      ).bind(now, now, doc.id, doc.version, auditId));
      // 결재선 전체 초기화 후 첫 결재자 활성화 (easy-ware 재상신 빈틈 보완: 재상신도 반드시 첫 결재자부터)
      stmts.push(db.prepare(
        `UPDATE approval_routes SET status = 'PENDING', acted_at = NULL, comment = NULL, reminded_at = NULL WHERE document_id = ? AND ${GUARD}`,
      ).bind(doc.id, auditId));
      stmts.push(db.prepare(`UPDATE approval_routes SET status = 'APPROVING' WHERE id = ? AND ${GUARD}`).bind(first.id, auditId));
      notifications.push(makeNotify("APPROVAL_REQUEST", first.actor_user_id, doc.id, doc.title));
      break;
    }

    case "APPROVE":
    case "REJECT": {
      const mine = approvers(routes).find((r) => r.status === "APPROVING" && r.actor_user_id === actor.id);
      if (!mine) throw new ApprovalError(403, "지금 결재할 차례가 아닙니다.");
      if (action === "REJECT" && !comment) throw new ApprovalError(400, "반려 의견을 입력하세요.");
      const next = action === "APPROVE"
        ? approvers(routes).find((r) => r.step_no > mine.step_no && r.status === "PENDING")
        : undefined;
      after = action === "REJECT" ? "REJECTED" : next ? "IN_PROGRESS" : "COMPLETED";
      const pre = "EXISTS (SELECT 1 FROM approval_routes WHERE id = ? AND status = 'APPROVING') " +
        "AND EXISTS (SELECT 1 FROM approval_documents WHERE id = ? AND status = 'IN_PROGRESS')";
      stmts.push(auditInsert(db, auditId, doc, actor, action, after, comment, meta, now, pre, [mine.id, doc.id]));
      // 판정 문장: 같은 결재 칸을 두 요청이 동시에 처리하면 여기서 한 건만 1행을 바꾼다.
      verdictIndex = stmts.length;
      stmts.push(db.prepare(
        `UPDATE approval_routes SET status = ?, acted_at = ?, comment = ? WHERE id = ? AND status = 'APPROVING' AND ${GUARD}`,
      ).bind(action === "APPROVE" ? "APPROVED" : "REJECTED", now, comment, mine.id, auditId));
      if (action === "REJECT") {
        stmts.push(db.prepare(
          `UPDATE approval_documents SET status = 'REJECTED', version = version + 1, updated_at = ? WHERE id = ? AND ${GUARD}`,
        ).bind(now, doc.id, auditId));
        stmts.push(db.prepare(
          `UPDATE approval_routes SET status = 'SKIPPED' WHERE document_id = ? AND status = 'PENDING' AND ${GUARD}`,
        ).bind(doc.id, auditId));
        notifications.push(makeNotify("APPROVAL_REJECTED", doc.drafter_id, doc.id, doc.title));
      } else if (next) {
        stmts.push(db.prepare(
          `UPDATE approval_documents SET version = version + 1, updated_at = ? WHERE id = ? AND ${GUARD}`,
        ).bind(now, doc.id, auditId));
        stmts.push(db.prepare(
          `UPDATE approval_routes SET status = 'APPROVING' WHERE id = ? AND status = 'PENDING' AND ${GUARD}`,
        ).bind(next.id, auditId));
        notifications.push(makeNotify("APPROVAL_REQUEST", next.actor_user_id, doc.id, doc.title));
      } else {
        // 최종 승인: 완료 + 채번(AP-YYYY-00001, 같은 문장 안에서 원자적으로) + 후처리 상태 결정
        const year = kstYear();
        stmts.push(db.prepare(
          `UPDATE approval_documents SET status = 'COMPLETED', completed_at = ?, version = version + 1, updated_at = ?,
             doc_number = 'AP-' || ? || '-' || printf('%05d', COALESCE((SELECT MAX(CAST(substr(doc_number, 9) AS INTEGER))
               FROM approval_documents WHERE doc_number LIKE ?), 0) + 1),
             hook_status = CASE WHEN ref_type IS NULL THEN 'NONE' ELSE 'PENDING' END
           WHERE id = ? AND ${GUARD}`,
        ).bind(now, now, year, `AP-${year}-%`, doc.id, auditId));
        notifications.push(makeNotify("APPROVAL_COMPLETED", doc.drafter_id, doc.id, doc.title));
        runHook = true;
      }
      break;
    }

    case "RECALL": {
      if (!isDrafter) throw new ApprovalError(403, "기안자만 회수할 수 있습니다.");
      after = "RECALLED";
      const cur = currentRoute(routes);
      const pre = "EXISTS (SELECT 1 FROM approval_documents WHERE id = ? AND status = 'IN_PROGRESS')";
      stmts.push(auditInsert(db, auditId, doc, actor, action, after, comment, meta, now, pre, [doc.id]));
      verdictIndex = stmts.length;
      stmts.push(db.prepare(
        `UPDATE approval_documents SET status = 'RECALLED', version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'IN_PROGRESS' AND ${GUARD}`,
      ).bind(now, doc.id, auditId));
      stmts.push(db.prepare(
        `UPDATE approval_routes SET status = 'PENDING', acted_at = NULL, comment = NULL, reminded_at = NULL WHERE document_id = ? AND ${GUARD}`,
      ).bind(doc.id, auditId));
      if (cur) notifications.push(makeNotify("APPROVAL_RECALLED", cur.actor_user_id, doc.id, doc.title));
      break;
    }

    case "FORCE_REJECT": {
      if (actor.role !== "hr_admin") throw new ApprovalError(403, "hr_admin만 강제 반려할 수 있습니다.");
      if (!comment) throw new ApprovalError(400, "강제 반려 사유를 입력하세요.");
      after = "REJECTED";
      const pre = "EXISTS (SELECT 1 FROM approval_documents WHERE id = ? AND version = ? AND status = 'COMPLETED')";
      stmts.push(auditInsert(db, auditId, doc, actor, action, after, comment, meta, now, pre, [doc.id, doc.version]));
      verdictIndex = stmts.length;
      stmts.push(db.prepare(
        `UPDATE approval_documents SET status = 'REJECTED', version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'COMPLETED' AND ${GUARD}`,
      ).bind(now, doc.id, auditId));
      notifications.push(makeNotify("APPROVAL_FORCE_REJECTED", doc.drafter_id, doc.id, doc.title));
      break;
    }

    default:
      throw new ApprovalError(400, "알 수 없는 액션입니다.");
  }

  for (const n of notifications) stmts.push(notificationStmt(db, n, now, auditId));
  const res = await db.batch(stmts);
  if ((res[verdictIndex]?.meta?.changes ?? 0) !== 1) {
    throw new ApprovalError(409, "다른 사용자가 먼저 처리했거나 문서가 바뀌었습니다. 새로고침 후 다시 시도하세요.");
  }
  // DO-2: D1 batch가 성공(상태 변경 확인)한 뒤에만, batch 밖에서 푸시. pushNotification은 던지지 않는다.
  if (pushEnv) {
    await Promise.all(notifications.map((n) => pushNotification(pushEnv, n.user_id, {
      id: n.id, type: n.type, title: n.title, body: null, link: n.link, created_at: now,
    })));
  }
  return { action, before: doc.status, after, notifications, runHook };
}

/** 본문은 일반 텍스트 + 줄바꿈만 (1단계 sanitize). body_html은 서버가 만든다. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}

function routeInsert(db: D1Database, docId: string, step: number, r: RouteSpec, guardAuditId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO approval_routes (id, document_id, step_no, role, actor_user_id, actor_dept_id, source, status)
     SELECT ?, ?, ?, 'APPROVER', ?, ?, ?, 'PENDING' WHERE ${GUARD}`,
  ).bind(uid("apr"), docId, step, r.user_id, r.dept_id, r.source, guardAuditId);
}

/** 기안(DRAFT 생성): 문서 + 결재선 + 감사 행을 batch 한 번으로. */
export async function createDraft(
  db: D1Database, actor: Actor, input: { formId: string; title: string; bodyText: string; isUrgent: boolean; routes: RouteSpec[] },
  meta: RequestMeta,
): Promise<string> {
  const id = uid("apd");
  const auditId = uid("aud");
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO approval_documents (id, form_id, drafter_id, title, body_html, body_text, status, is_urgent, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, 0, ?, ?)`,
    ).bind(id, input.formId, actor.id, input.title, textToHtml(input.bodyText), input.bodyText, input.isUrgent ? 1 : 0, now, now),
    db.prepare(
      `INSERT INTO approval_audit (id, document_id, actor_user_id, action, before_status, after_status, comment, ip, user_agent, created_at)
       VALUES (?, ?, ?, 'CREATE', NULL, 'DRAFT', NULL, ?, ?, ?)`,
    ).bind(auditId, id, actor.id, meta.ip, meta.userAgent, now),
  ];
  input.routes.forEach((r, i) => stmts.push(routeInsert(db, id, i + 1, r, auditId)));
  await db.batch(stmts);
  return id;
}

/** 수정: DRAFT/RECALLED에서 기안자만. version이 맞을 때만 (낙관적 잠금). routes를 주면 결재선을 통째로 바꾼다. */
export async function editDraft(
  db: D1Database, doc: DocRow, actor: Actor,
  patch: { title?: string; bodyText?: string; isUrgent?: boolean; routes?: RouteSpec[] },
  meta: RequestMeta,
): Promise<void> {
  if (doc.drafter_id !== actor.id) throw new ApprovalError(403, "기안자만 수정할 수 있습니다.");
  if (!EDITABLE.includes(doc.status)) throw new ApprovalError(409, "상신한 문서는 수정할 수 없습니다. 고치려면 먼저 회수하세요.");
  const now = new Date().toISOString();
  const auditId = uid("aud");
  const title = patch.title ?? doc.title;
  const bodyText = patch.bodyText ?? doc.body_text ?? "";
  const isUrgent = patch.isUrgent ?? !!doc.is_urgent;
  const pre = `EXISTS (SELECT 1 FROM approval_documents WHERE id = ? AND version = ? AND status IN ('DRAFT','RECALLED'))`;
  const stmts: D1PreparedStatement[] = [
    auditInsert(db, auditId, doc, actor, "EDIT", doc.status, patch.routes ? "결재선 변경 포함" : null, meta, now, pre, [doc.id, doc.version]),
    db.prepare(
      `UPDATE approval_documents SET title = ?, body_text = ?, body_html = ?, is_urgent = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('DRAFT','RECALLED') AND ${GUARD}`,
    ).bind(title, bodyText, textToHtml(bodyText), isUrgent ? 1 : 0, now, doc.id, doc.version, auditId),
  ];
  if (patch.routes) {
    stmts.push(db.prepare(`DELETE FROM approval_routes WHERE document_id = ? AND ${GUARD}`).bind(doc.id, auditId));
    patch.routes.forEach((r, i) => stmts.push(routeInsert(db, doc.id, i + 1, r, auditId)));
  }
  const res = await db.batch(stmts);
  if ((res[1]?.meta?.changes ?? 0) !== 1) {
    throw new ApprovalError(409, "문서가 그 사이에 바뀌었습니다. 새로고침 후 다시 시도하세요.");
  }
}
