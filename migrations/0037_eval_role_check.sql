-- XAI 보완 (2026-11-19): 평가 편향/일관성 축 — 역할별 답 비교 결과.
-- 공용 HR 규정 항목을 역할별(기본 hr_admin·user)로 다시 돌린 결과를 JSON으로 둔다
-- (src/obs/role-check.ts RoleCheckResult). 개인 항목·검사 안 한 항목은 NULL.
-- 기존 통과/실패·judge·verdict 컬럼은 바뀌지 않는다.
ALTER TABLE eval_results ADD COLUMN role_check_json TEXT;
