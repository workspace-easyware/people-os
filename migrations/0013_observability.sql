-- S4 관측 (M1, 2026-11-14) — 트레이스 스키마
-- ask_events 확장: ensureSchema()는 건드리지 않는다. 새 컬럼은 모두 기본값/NULL 허용이라
-- 기존 9컬럼 INSERT(/api/ask)와 /api/feedback·/api/gaps가 그대로 동작한다.
ALTER TABLE ask_events ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';      -- 'user' | 'eval'
ALTER TABLE ask_events ADD COLUMN status TEXT;                              -- 'grounded' | 'no_evidence' | 'error' (NULL = S4 이전 행, grounded 컬럼으로 해석)
ALTER TABLE ask_events ADD COLUMN gap_id TEXT;                              -- 이 호출이 공백 큐에 올린 행
ALTER TABLE ask_events ADD COLUMN eval_run_id TEXT;
ALTER TABLE ask_events ADD COLUMN prompt_version TEXT;
ALTER TABLE ask_events ADD COLUMN model TEXT;
ALTER TABLE ask_events ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE ask_events ADD COLUMN completion_tokens INTEGER;
ALTER TABLE ask_events ADD COLUMN latency_ms INTEGER;
ALTER TABLE ask_events ADD COLUMN knowledge_epoch INTEGER;
ALTER TABLE ask_events ADD COLUMN trace_r2_key TEXT;                        -- traces/<id>.json
ALTER TABLE ask_events ADD COLUMN aig_log_ids TEXT NOT NULL DEFAULT '[]';   -- AI Gateway 로그 id 목록
CREATE INDEX IF NOT EXISTS idx_ask_events_created ON ask_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ask_events_origin_status ON ask_events(origin, status, created_at);

CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL,      -- cache|session|embed|vectorize|gate|d1_merge|llm|session_save
  product TEXT,                                                          -- kv|durable-objects|workers-ai|vectorize|d1
  start_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
  attrs_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_trace_spans_event ON trace_spans(event_id);

CREATE TABLE IF NOT EXISTS trace_retrievals (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, chunk_id TEXT NOT NULL, doc_id TEXT,
  title TEXT, article TEXT, stage TEXT NOT NULL,                         -- 'vectorize' | 'd1'
  rank INTEGER NOT NULL, vector_score REAL, keyword_score REAL,
  outcome TEXT NOT NULL                                                  -- kept|below_floor|keyword_gate|dedup|over_max
);
CREATE INDEX IF NOT EXISTS idx_trace_retrievals_event ON trace_retrievals(event_id);

CREATE TABLE IF NOT EXISTS trace_scores (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
  name TEXT NOT NULL,                       -- user_feedback|judge_score|verdict|human_score|retrieval_hit
  value REAL, label TEXT,                   -- 숫자 점수 또는 범주(verdict)
  source TEXT NOT NULL,                     -- user|judge|verdict|human|rule
  eval_run_id TEXT, comment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trace_scores_event ON trace_scores(event_id, name);

CREATE TABLE IF NOT EXISTS trace_costs (
  aig_log_id TEXT PRIMARY KEY, event_id TEXT, model TEXT, tag TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, cached INTEGER, duration_ms INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,     -- 1 = 게이트웨이 cost 값이 없어 토큰으로 추정
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trace_costs_event ON trace_costs(event_id);
