// 결재 완료 후처리 (2026-11-17). easy-ware ApprovalLifecycleEvent에 대응한다.
// 결재 완료 batch와 분리해서 실행하고 결과를 approval_documents.hook_status에 남긴다.
//   ref_type NULL  → 완료 batch가 hook_status='NONE'으로 둔다 (1단계 문서는 모두 이 경우).
//   ref_type 있음  → 완료 batch가 'PENDING'으로 두고, 여기서 핸들러를 실행해 'DONE'/'FAILED'로 바꾼다.
//                    핸들러가 아직 없으면 'PENDING'으로 남긴다 (2단계: 크론이 PENDING/FAILED를 다시 시도).
// 핸들러는 같은 문서 ID로 두 번 불려도 결과가 같아야 한다 (멱등).
// 2단계 연동 자리: lms_enrollment(수강 승인), leave(휴가 확정).
import type { DocRow } from "./types";

export type CompletionHandler = (db: D1Database, doc: DocRow) => Promise<void>;

const HANDLERS: Record<string, CompletionHandler> = {
  // lms_enrollment: async (db, doc) => { ... UPDATE lms_enrollments SET status='APPROVED' WHERE id = doc.ref_id ... },
  // leave: async (db, doc) => { ... },
};

export async function runCompletionHook(db: D1Database, docId: string): Promise<void> {
  const doc = await db.prepare("SELECT * FROM approval_documents WHERE id = ?").bind(docId).first<DocRow>();
  if (!doc || doc.status !== "COMPLETED" || !doc.ref_type) return;
  if (doc.hook_status !== "PENDING" && doc.hook_status !== "FAILED") return;
  const handler = HANDLERS[doc.ref_type];
  if (!handler) return; // 아직 연동 없음 → PENDING 유지
  try {
    await handler(db, doc);
    await db.prepare("UPDATE approval_documents SET hook_status = 'DONE', hook_error = NULL, updated_at = ? WHERE id = ? AND status = 'COMPLETED'")
      .bind(new Date().toISOString(), docId).run();
  } catch (e) {
    await db.prepare("UPDATE approval_documents SET hook_status = 'FAILED', hook_error = ?, updated_at = ? WHERE id = ?")
      .bind((e instanceof Error ? e.message : String(e)).slice(0, 500), new Date().toISOString(), docId).run();
  }
}
