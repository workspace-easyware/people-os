-- C1과 같은 최소 스키마 보강: getSessionUser가 읽는 coaching_role 컬럼 (0018 전체는 reflections가 없어 적용 불가).
ALTER TABLE users ADD COLUMN coaching_role TEXT NOT NULL DEFAULT 'coachee' CHECK(coaching_role IN ('coach','coachee'));
