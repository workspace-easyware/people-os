-- Think 전면 도입 T3 (2026-11-20): 어시스턴트 턴 요약 (관측 탭 "어시스턴트" 하위 탭용).
-- 행 1개 = 어시스턴트 턴 1개. AssistantAgent DO가 턴이 끝날 때(onSubmissionStatus 종료 상태) 한 번 쓴다 (같은 턴이 다시 오면 덮어쓴다).
-- 대화 내용(질문·답)은 싣지 않는다 — 식별자·상태·숫자·도구 이름만. 원본 상태는 DO SQLite(pos_kv turn:<n>)에 있다.
-- 기존 질문 트레이스(ask_events)와 무관하다.
CREATE TABLE IF NOT EXISTS assistant_turns (
  user_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL,
  status TEXT NOT NULL,                  -- completed | aborted | skipped | error
  stopped_reason TEXT,                   -- max_steps | llm_cap | timeout | repeat_tool | tool_selection_failed | NULL
  steps INTEGER NOT NULL DEFAULT 0,      -- 모델 스텝 누적
  llm_calls INTEGER NOT NULL DEFAULT 0,  -- 모델 스텝 + LLM 도구 호출 (하위 에이전트 호출분 포함)
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tools TEXT,                            -- 마지막 도구 이름 목록 (JSON 배열, 최대 10)
  research_runs INTEGER NOT NULL DEFAULT 0, -- 하위 에이전트(조사) 위임 횟수
  recoveries INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  started_at TEXT,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (user_id, turn_no)
);
CREATE INDEX IF NOT EXISTS idx_assistant_turns_ended ON assistant_turns(ended_at);
