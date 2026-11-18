-- 0028 워크플로우 스케줄·이벤트 트리거 (WF-8, 2026-11-18). 로컬 재적용 안전을 위해 IF NOT EXISTS.
-- trigger_type='schedule'이면 cron 필수, 'event'면 event 필수 — 이 검사는 API가 한다 (CHECK는 타입만 본다).
CREATE TABLE IF NOT EXISTS workflow_schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'event')),
  cron TEXT,              -- trigger_type='schedule'일 때 5필드 cron (분 시 일 월 요일), KST 기준
  event TEXT,             -- trigger_type='event'일 때 이벤트 이름 (v1은 'transcript_completed'만)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,       -- 마지막으로 run을 만든 시각 (ISO)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wf_schedules_workflow ON workflow_schedules(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_schedules_owner ON workflow_schedules(owner_id);
CREATE INDEX IF NOT EXISTS idx_wf_schedules_trigger ON workflow_schedules(trigger_type, enabled);
