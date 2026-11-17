// 결재 알림 (2026-11-17). D1 notifications 기록 + Resend 메일.
// 기록(INSERT)은 상태 변경과 같은 batch 안에서 일어난다 (machine.ts가 notificationStmt로 넣는다).
// 메일은 batch 커밋 뒤 waitUntil로 보낸다 — 제목·링크만, 본문 미포함 (Cloudflare OS 승인 큐 원칙).
// RESEND_API_KEY가 없으면 메일은 건너뛰고 D1 기록만 남는다 (emailed_at NULL).
import { EMAIL_DOMAIN, sendEmail } from "../email/send";
import { uid } from "../lib";

export type NotifyType =
  | "APPROVAL_REQUEST"    // 결재 차례 (첫 결재자 / 다음 결재자 / 재상신)
  | "APPROVAL_COMPLETED"  // 최종 승인 → 기안자
  | "APPROVAL_REJECTED"   // 반려 → 기안자
  | "APPROVAL_RECALLED"   // 회수 → 현재 결재자
  | "APPROVAL_FORCE_REJECTED"; // hr_admin 강제 반려 → 기안자

export type NotifySpec = { id: string; user_id: string; type: NotifyType; title: string; link: string; ref_id: string };

const PREFIX: Record<NotifyType, string> = {
  APPROVAL_REQUEST: "[결재 요청]",
  APPROVAL_COMPLETED: "[결재 완료]",
  APPROVAL_REJECTED: "[결재 반려]",
  APPROVAL_RECALLED: "[결재 회수]",
  APPROVAL_FORCE_REJECTED: "[결재 강제 반려]",
};

/** 프런트 해시 경로. A2(public/approval.js)가 이 경로로 문서 상세를 연다. */
export function docLink(docId: string): string {
  return `/#approval/${encodeURIComponent(docId)}`;
}

export function makeNotify(type: NotifyType, userId: string, docId: string, docTitle: string): NotifySpec {
  return { id: uid("ntf"), user_id: userId, type, title: `${PREFIX[type]} ${docTitle}`.slice(0, 300), link: docLink(docId), ref_id: docId };
}

/** guardAuditId 감사 행이 있을 때만 기록 (같은 batch에서 상태 변경이 성공했을 때만). */
export function notificationStmt(db: D1Database, n: NotifySpec, now: string, guardAuditId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notifications (id, user_id, type, ref_type, ref_id, title, body, link, created_at)
     SELECT ?, ?, ?, 'approval_document', ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM approval_audit WHERE id = ?)`,
  ).bind(n.id, n.user_id, n.type, n.ref_id, n.title, n.link, now, guardAuditId);
}

/** 기록된 알림을 메일로 보낸다. 실패는 로그만 (알림 기록·결재 결과를 뒤집지 않는다). */
export async function deliverEmails(
  env: { DB: D1Database; RESEND_API_KEY?: string },
  ids: string[],
  origin: string,
): Promise<{ sent: number; skipped: number }> {
  if (!ids.length) return { sent: 0, skipped: 0 };
  if (!env.RESEND_API_KEY) {
    console.log(`[approval:notify] RESEND_API_KEY 없음 — 메일 ${ids.length}건 건너뜀 (D1 기록만)`);
    return { sent: 0, skipped: ids.length };
  }
  const rows = await env.DB.prepare(
    `SELECT n.id, n.title, n.link, u.email FROM notifications n JOIN users u ON u.id = n.user_id
     WHERE n.id IN (${ids.map(() => "?").join(",")}) AND n.emailed_at IS NULL AND u.status = 'active'`,
  ).bind(...ids).all<{ id: string; title: string; link: string | null; email: string }>();
  let sent = 0;
  for (const r of rows.results || []) {
    const url = origin + (r.link || "/");
    try {
      await sendEmail(env, {
        from: `"People OS 결재" <approval@${EMAIL_DOMAIN}>`,
        to: [r.email],
        subject: r.title,
        text: `${r.title}\n\n문서 열기: ${url}\n\n내용은 People OS에서 로그인 후 확인하세요.`,
      });
      await env.DB.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ?").bind(new Date().toISOString(), r.id).run();
      sent++;
    } catch (e) {
      console.log("[approval:notify] 메일 실패:", r.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { sent, skipped: ids.length - sent };
}
