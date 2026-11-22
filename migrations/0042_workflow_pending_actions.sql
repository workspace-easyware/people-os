-- 비동기 승인 + 시뮬레이션 P1 (2026-11-21): 승인 대기 동작 대기열.
-- approvalMode "deferred" 단계(send_email·webhook)는 run을 멈추지 않고 여기 동작을 1개 쌓는다. 승인·거절·실행은 P2.
-- id는 결정적: wfpa_<runId>_<stepIndex> (agent면 _t<turn>, P2). 중복 방지는 PRIMARY KEY(id) + INSERT OR IGNORE로 한다 —
-- UNIQUE(run_id, step_index, turn)은 turn이 NULL인 행끼리는 SQLite에서 서로 다르게 취급돼 중복을 막지 못한다.
-- status: queued | approved | executing | executed | rejected | failed | expired
CREATE TABLE IF NOT EXISTS workflow_pending_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  turn INTEGER,
  owner_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  args_json TEXT NOT NULL,
  simulated_output_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  executed_at TEXT,
  UNIQUE(run_id, step_index, turn)
);
CREATE INDEX IF NOT EXISTS idx_wf_pending_actions_run ON workflow_pending_actions(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_pending_actions_owner_status ON workflow_pending_actions(owner_id, status);
