-- A1 검증: 0013·0014·0021·0022가 없는 옛 스키마를 흉내 낸 격리 DB (8.1 "스키마 없는 테이블은 건너뛴다").
--   recordings: 0016까지 (owner_id 있음)  ask_events: 0009 모양 (user_id·origin·status 없음)
--   knowledge_gaps: 0010 모양 (user_id 없음)  digest_runs: 있음  emails·eval_runs: 없음
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT, password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, coaching_role TEXT NOT NULL DEFAULT 'coachee');
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'workers-ai', model TEXT NOT NULL DEFAULT '@cf/openai/whisper',
  object_key TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0, transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending', doc_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), progress TEXT,
  pipeline_stage TEXT NOT NULL DEFAULT 'queued', pipeline_error TEXT, owner_id TEXT);
CREATE TABLE IF NOT EXISTS ask_events (id TEXT PRIMARY KEY, session_id TEXT, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', source_ids TEXT NOT NULL DEFAULT '[]',
  grounded INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', search_engine TEXT NOT NULL DEFAULT '', timings_json TEXT NOT NULL DEFAULT '{}',
  feedback TEXT, feedback_comment TEXT, feedback_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS knowledge_gaps (id TEXT PRIMARY KEY, question TEXT NOT NULL, asked_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  doc_id TEXT, count INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'no-evidence');
CREATE TABLE IF NOT EXISTS digest_runs (run_date TEXT PRIMARY KEY, generated_at TEXT NOT NULL DEFAULT (datetime('now')), engine TEXT NOT NULL DEFAULT 'template',
  body TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}');

INSERT OR REPLACE INTO recordings (id, title, object_key, transcript_status, pipeline_stage, owner_id, created_at) VALUES
  ('av-rec-a', 'AV-A-녹음', 'av/a', 'ready', 'done', 'av-a', '2026-11-17 01:00:00'),
  ('av-rec-b', 'AV-B-녹음', 'av/b', 'ready', 'done', 'av-b', '2026-11-17 01:10:00');
INSERT OR REPLACE INTO ask_events (id, question, grounded, created_at) VALUES
  ('av-ask-old', 'AV-OLD-질문 소유자 컬럼 없음', 1, '2026-11-17 02:00:00');
INSERT OR REPLACE INTO knowledge_gaps (id, question, asked_at) VALUES
  ('av-gap-old', 'AV-OLD-공백 소유자 컬럼 없음', 1763348400000);
INSERT OR REPLACE INTO digest_runs (run_date, generated_at, engine, body) VALUES
  ('2026-11-17', '2026-11-16 22:00:00', 'template', 'AV-SYS 다이제스트');
