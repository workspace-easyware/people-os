-- S4 judge-v2: 개선 코멘트 (재귀적 자기개선 근거) (2026-11-16).
-- judge_reason = "왜 이 점수인가", judge_comment = "다음에 더 좋게 하려면 무엇을 어떻게 바꿀까".
-- nullable: judge-v2 이전 실행·규칙 판정 항목은 NULL.
ALTER TABLE eval_results ADD COLUMN judge_comment TEXT;
