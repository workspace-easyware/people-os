-- 브라우저 회귀 수정 로컬 검증 데이터 (bf-state 전용, 원격에 쓰지 않는다)
INSERT OR IGNORE INTO users (id, email, name, role, status, coaching_role, created_at) VALUES
  ('u_bf_admin', 'bf.admin@example.test', '관리자BF', 'hr_admin', 'active', 'coach', '2026-11-21T00:00:00Z'),
  ('u_bf_coach', 'bf.coach@example.test', '코치BF', 'user', 'active', 'coach', '2026-11-21T00:00:00Z'),
  ('u_bf_coachee', 'bf.coachee@example.test', '대상BF', 'user', 'active', 'coachee', '2026-11-21T00:00:00Z');
-- 토큰 a7984282…cc8c (bf-seed.txt sha256) → token_hash
INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES
  ('b9272df9413bcaa9d37799d14fac4b6acb07b3aeba614e596cbc01d3c10d87dd', 'u_bf_admin', 1795265789630);
-- 같은 제목·본문 전사본 3개 + 다른 전사본 1개 (코칭 드롭다운 중복 확인)
INSERT OR IGNORE INTO documents (id, title, kind, content, owner_id, created_at) VALUES
  ('doc_bf_t1', '샘플 전사본', 'transcript', '같은 본문입니다. 코칭 세션 내용.', 'u_bf_admin', '2026-11-13 00:30:12'),
  ('doc_bf_t2', '샘플 전사본', 'transcript', '같은 본문입니다. 코칭 세션 내용.', 'u_bf_admin', '2026-11-13 00:35:12'),
  ('doc_bf_t3', '샘플 전사본', 'transcript', '같은 본문입니다. 코칭 세션 내용.', 'u_bf_admin', '2026-11-13 00:40:12'),
  ('doc_bf_t4', '다른 전사본', 'transcript', '다른 본문입니다.', 'u_bf_admin', '2026-11-14 00:40:12');
-- 라이브러리 편집 버튼: 원본 형식별 업로드 문서 (R2 객체는 없어도 목록 표시는 된다)
INSERT OR IGNORE INTO documents (id, title, kind, content, owner_id, created_at, source_r2_key, extract_status) VALUES
  ('doc_bf_pptx', '덱 업로드', 'upload', 'x', 'u_bf_admin', '2026-11-15 00:00:00', 'uploads/u_bf_admin/doc_bf_pptx.pptx', 'ready'),
  ('doc_bf_xlsx', '엑셀 업로드', 'upload', 'x', 'u_bf_admin', '2026-11-15 00:00:01', 'uploads/u_bf_admin/doc_bf_xlsx.XLSX', 'ready'),
  ('doc_bf_docx', '워드 업로드', 'upload', 'x', 'u_bf_admin', '2026-11-15 00:00:02', 'uploads/u_bf_admin/doc_bf_docx.docx', 'ready'),
  ('doc_bf_pdf', 'PDF 업로드', 'upload', 'x', 'u_bf_admin', '2026-11-15 00:00:03', 'uploads/u_bf_admin/doc_bf_pdf.pdf', 'ready');
