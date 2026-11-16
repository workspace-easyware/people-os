-- 코치 / 코칭 대상 역할 구분 (2026-11-16).
-- coaching_role은 role(관리자 권한: hr_admin|user)과 직교한다. role 컬럼·CHECK는 건드리지 않는다.
--   coach   — 녹음전사·문서저장, 개인 업무 검색, 할 일, 라이브러리, 코칭 리플렉션(코치용) 전체 메뉴
--   coachee — HR 규정 검색 + 코칭 리플렉션(코칭 대상용: 자기 성찰 포인트 + 액션 플랜)만
-- 리플렉션 모드는 서버가 세션 사용자의 coaching_role로만 정한다 (요청 필드로 바꿀 수 없다).
ALTER TABLE users ADD COLUMN coaching_role TEXT NOT NULL DEFAULT 'coachee' CHECK(coaching_role IN ('coach','coachee'));

-- 리플렉션이 어느 모드로 만들어졌는지 남긴다. 기존 행은 모두 코치 모드였다.
-- coachee 모드: patterns = 자기 성찰 포인트(문자열 배열), next_questions = 액션 플랜(JSON 객체 배열), questions = [].
ALTER TABLE reflections ADD COLUMN mode TEXT NOT NULL DEFAULT 'coach';
