-- 사용자 식별 (2026-11-16): 모든 데이터에 "누구의 것 / 누가 했는지"를 남긴다.
-- 세 컬럼 모두 nullable, FK 없음(스키마 나머지처럼 느슨하게). 기존 행은 NULL로 둔다 —
-- 추측해서 채우지 않는다 (화면에는 할 일 "미지정", 공백·트레이스 "익명"으로 보인다).
-- tasks.owner_id: 할 일 소유자 (만든 사람, hr_admin이 대신 만들면 지정한 사용자).
ALTER TABLE tasks ADD COLUMN owner_id TEXT;
-- knowledge_gaps.user_id: 공백을 만든 질문자 (익명·평가는 NULL).
ALTER TABLE knowledge_gaps ADD COLUMN user_id TEXT;
-- ask_events.user_id: 질문한 사용자 (익명·평가는 NULL).
ALTER TABLE ask_events ADD COLUMN user_id TEXT;
