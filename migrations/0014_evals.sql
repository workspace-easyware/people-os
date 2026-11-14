-- S4 평가·개선 (M1, 2026-11-14)
CREATE TABLE IF NOT EXISTS eval_datasets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS eval_items (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
  question TEXT NOT NULL,
  expected_answer TEXT,                     -- 기대 답 (요지). ungrounded 항목은 NULL 가능
  expected_sources TEXT NOT NULL DEFAULT '[]', -- [{doc_id?, title_like?, article_like?}] — 근거 적중 판정용
  expected_verdict TEXT NOT NULL DEFAULT 'grounded', -- grounded | ungrounded
  tags TEXT NOT NULL DEFAULT '[]',          -- ["policy","tacit","transcript","parser","seed"]
  source TEXT NOT NULL DEFAULT 'seed',      -- seed | gap | trace | manual
  origin_ref TEXT,                          -- gap id / event id
  prereq TEXT,                              -- 사전 조건 메모 (예: "Nokia 전사본 문서가 라이브에 있어야 함")
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_items_dataset ON eval_items(dataset_id, active);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, dataset_version INTEGER NOT NULL,
  trigger TEXT NOT NULL,                    -- manual | cron | regression
  status TEXT NOT NULL DEFAULT 'queued',    -- queued|running|done|partial|failed|aborted|skipped
  config_json TEXT NOT NULL DEFAULT '{}', config_hash TEXT,
  items_total INTEGER NOT NULL DEFAULT 0, items_done INTEGER NOT NULL DEFAULT 0, items_error INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER, pass_rate REAL, avg_judge REAL, retrieval_hit_rate REAL, no_evidence_accuracy REAL,
  verdict_dist_json TEXT, cost_estimate_usd REAL, base_run_id TEXT,
  started_at TEXT, finished_at TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset ON eval_runs(dataset_id, created_at);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, item_id TEXT NOT NULL, event_id TEXT,
  answer TEXT, grounded INTEGER, retrieved_ids TEXT NOT NULL DEFAULT '[]',
  retrieval_hit INTEGER,                    -- 기대 근거가 채택 근거에 있음 (결정적)
  judge_score REAL, judge_dims_json TEXT,   -- {diagnosis:{level,reason}, evidence:{...}, fix:{...}}
  judge_reason TEXT, judge_snapped INTEGER NOT NULL DEFAULT 0, judge_skipped TEXT,
  verdict TEXT, verdict_engine TEXT,
  passed INTEGER, error TEXT, latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, item_id)                   -- 큐 재전달에도 멱등
);
CREATE INDEX IF NOT EXISTS idx_eval_results_item ON eval_results(item_id, created_at);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,  -- 'ask-system'
  version INTEGER NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | active | retired
  note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), activated_at TEXT,
  UNIQUE(name, version)
);
-- v1 = 현재 /api/ask system 프롬프트 원문 (src/index.ts 1222행에서 바이트 그대로 복사, 수정 없음)
INSERT OR IGNORE INTO prompt_versions (id, name, version, body, status, note, activated_at)
VALUES ('pv_ask_system_v1', 'ask-system', 1, '너는 HR 규정 안내 에이전트다. 주어진 근거 문서만을 근거로 한국어로 답하고, 근거에 없는 내용은 지어내지 마라. 근거 문서명을 답에 포함하라.', 'active', 'S4 이전 /api/ask system 프롬프트 원문 (M1 시드)', datetime('now'));

CREATE TABLE IF NOT EXISTS improvement_actions (
  id TEXT PRIMARY KEY, gap_key TEXT NOT NULL,          -- '<kind>:<ref>'
  kind TEXT NOT NULL,                                  -- no_evidence|downvote|low_score|hallucination_risk|regression
  action TEXT NOT NULL,                                -- publish_tacit|fix_document|adjust_prompt|promote|dismiss
  status TEXT NOT NULL DEFAULT 'applied',              -- applied|verified|regressed|dismissed
  question TEXT, gap_id TEXT, event_id TEXT, result_id TEXT, item_id TEXT,
  doc_id TEXT, prompt_version_id TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), verified_run_id TEXT, verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_improvement_actions_gap ON improvement_actions(gap_key);
