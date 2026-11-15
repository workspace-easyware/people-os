-- 개인별 RAG 격리 (2026-11-15) — 병행 방식: D1 owner_id + Vectorize user_id 메타데이터 필터.
-- 목적: 개인 문서(전사본·녹음)가 다른 사용자에게 노출되지 않도록 소유자 범위를 기록한다.
-- 가정:
--   - users.id는 crypto.randomUUID() 형식의 UUID 문자열 (auth-routes.ts).
--   - owner_id NULL = 공용(공유) 문서, UUID 값 = 해당 사용자의 개인 문서.
--   - 기존 전사본 16건은 로그인 이전 단일 사용자 프로토타입 시절 것이라 전부 관리자
--     (hr.jhkang@gmail.com) 소유로 본다. 사용자 id는 하드코딩하지 않고 이메일로 조회한다.
--   - Vectorize 쪽 공용 센티넬 "shared"는 앱 코드(lib.ts의 SHARED_USER_ID)에서 관리하며,
--     기존 벡터의 user_id 메타데이터 재색인은 별도 단계(모듈 C)에서 수행한다.
-- 주의사항:
--   - 외래키(REFERENCES)를 달지 않는다. D1은 기본적으로 FK를 강제하지 않고,
--     사용자 삭제가 문서 행에 걸리지 않게 하려고 의도적으로 달지 않았다.
--   - SQLite/D1에서 ALTER TABLE ADD COLUMN은 유효하다. NULL 허용 컬럼을 끝에 추가하므로
--     기존 행은 자동으로 NULL(공용)이 되며, 기존 데이터는 건드리지 않는다.
--   - 이관 UPDATE의 서브쿼리는 스칼라 서브쿼리다. users에 해당 이메일이 없으면 NULL을
--     반환하므로 SET owner_id = NULL이 되어 사실상 no-op이다 (WHERE owner_id IS NULL
--     조건과 겹쳐 행은 그대로 남는다). 따라서 마이그레이션이 실패하지 않고 안전하다.
--   - decks는 생성 당시 소유자 정보가 없어 이관하지 않는다. 기존 덱은 공용(owner_id NULL)으로 둔다.
ALTER TABLE documents ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

ALTER TABLE recordings ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_recordings_owner ON recordings(owner_id);

ALTER TABLE decks ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_decks_owner ON decks(owner_id);

-- 기존 전사본(로그인 이전 단일 사용자 시절 생성) → 관리자 소유로 이관.
UPDATE documents SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE kind = 'transcript' AND owner_id IS NULL;
-- 기존 녹음 원본 → 관리자 소유로 이관 (전사본과 짝을 이루는 녹음 포함).
UPDATE recordings SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE owner_id IS NULL;
-- decks는 이관하지 않음: 생성 당시 소유자 정보가 없어 기존 덱은 공용으로 둔다.
