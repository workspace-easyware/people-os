-- 0029 워크플로우 공유·템플릿 (WF-9, 2026-11-18). 공유 = 보기/복사만. 실행·run 조회는 항상 소유자.
-- 공유 행이 없는 상태가 곧 "본인만"이다 (별도 scope 없음).
CREATE TABLE IF NOT EXISTS workflow_shares (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,              -- 공유한 사람 (워크플로우 소유자)
  scope TEXT NOT NULL CHECK (scope IN ('department', 'all')),
  permission TEXT NOT NULL CHECK (permission IN ('view', 'copy')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflow_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_wf_shares_workflow ON workflow_shares(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_shares_owner ON workflow_shares(owner_id);

ALTER TABLE workflows ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
