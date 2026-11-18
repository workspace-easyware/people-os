-- 0027 워크플로우 빌더 코어 (WF-1, 2026-11-18). 제안서 4.1.1. 로컬 재적용 안전을 위해 IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | paused
  definition_json TEXT NOT NULL,        -- { version: 1, steps: [...] }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- queued | running | waiting_approval | succeeded | failed | cancelled
  input_json TEXT NOT NULL,
  output_json TEXT,
  current_step INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_owner ON workflow_runs(owner_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id, started_at);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  node_type TEXT NOT NULL,
  node_name TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending | running | succeeded | failed | skipped
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(run_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON workflow_run_steps(run_id, step_index);
