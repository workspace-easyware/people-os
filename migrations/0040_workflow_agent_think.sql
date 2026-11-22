-- Think 전면 도입 T1 (2026-11-20): agent 단계의 런타임 기록 + Think 결과 전달함.
-- 행 1개 = run 1개의 agent 단계 1개. 런타임은 그 단계가 처음 시작될 때 정해지고 끝까지 바뀌지 않는다 (계획 R11).
-- legacy 런타임(WorkflowAgent DO)은 이 표에 행을 쓰지 않는다 — 행이 없으면 legacy다.
-- Think 런타임: 엔진이 행을 만들고(runtime='think', status='new'), ThinkAgent DO가 턴이 끝날 때 status·result_json을 쓰고
-- workflow-step 메시지로 엔진을 깨운다. 엔진은 submission_id가 메시지와 같을 때만 결과를 읽고 consumed_submission을 남긴다.
CREATE TABLE IF NOT EXISTS workflow_agent_steps (
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  runtime TEXT NOT NULL,                 -- 'think' | 'legacy'
  submission_id TEXT,                    -- 마지막 Think 제출 id (복구 턴에도 같다)
  status TEXT NOT NULL DEFAULT 'new',    -- new | running | completed | approval | failed
  result_json TEXT,                      -- completed: {final, turns, stoppedReason, ...} / approval: {tool, args, ...} / failed: {error}
  consumed_submission TEXT,              -- 엔진이 결과를 처리한 제출 id (DO의 재알림 판단용)
  steps INTEGER NOT NULL DEFAULT 0,      -- 누적 모델 스텝 수 (DO 저장소 값의 사본)
  llm_calls INTEGER NOT NULL DEFAULT 0,  -- 누적 LLM 호출 수 (모델 스텝 + LLM 도구)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_index)
);
