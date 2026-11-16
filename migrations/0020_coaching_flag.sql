-- 코칭 문서 식별 + 리플렉션 참여자 (2026-11-16).
-- documents.is_coaching: 이 문서가 코칭 세션인지. kind(문서 유형: transcript/file/policy/tacit)와 직교한다 —
--   코칭 전사본도 kind='transcript'이므로 별도 플래그로 구분한다. 기존 문서는 모두 0(코칭 아님).
ALTER TABLE documents ADD COLUMN is_coaching INTEGER NOT NULL DEFAULT 0;
-- recordings.is_coaching: 녹음 업로드 때 받은 플래그를 전사 완료 후 만들어지는 documents 행으로 넘긴다.
ALTER TABLE recordings ADD COLUMN is_coaching INTEGER NOT NULL DEFAULT 0;
-- reflections.coach_id / coachee_id: 누가 코치이고 누가 코칭 대상인지 (users.id, FK 없음 — 스키마 나머지처럼 느슨하게).
-- 작성자 쪽은 항상 서버의 세션 사용자 id, 상대방만 요청의 counterpartId(users에 존재할 때만)에서 온다.
-- 기존 리플렉션·익명 리플렉션은 둘 다 NULL.
ALTER TABLE reflections ADD COLUMN coach_id TEXT;
ALTER TABLE reflections ADD COLUMN coachee_id TEXT;
