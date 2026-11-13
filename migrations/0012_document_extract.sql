-- C5 Phase 3: 업로드 문서 파서 라우팅 (2026-11-13)
-- 파일 업로드 문서의 추출 상태를 documents 행에 남긴다.
-- extract_status: ready(추출·색인됨) | failed(추출 실패 — 원본만 저장됨, 색인 안 함).
-- extract_error: failed일 때 사용자에게 보여줄 사유 (한국어).
-- source_r2_key: 원본 파일 R2 키 (docs/<id>/source.<ext>). r2_key는
-- 추출본 docs/<id>/extracted.md를 가리킨다.
ALTER TABLE documents ADD COLUMN extract_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE documents ADD COLUMN extract_error TEXT;
ALTER TABLE documents ADD COLUMN source_r2_key TEXT;
