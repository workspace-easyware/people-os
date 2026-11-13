-- 음성 전사 입력 (2026-11-13)
-- Plaud Transcribe Studio recordings 테이블 형태를 따르되 Cloudflare 네이티브로:
-- provider/model은 Workers AI Whisper, user_id 없음(프로토타입 단일 사용자).
-- transcript_status: 'ready' | 'pending' (Plaud의 plaud-audio-pending-transcript 패턴).
-- pending 행은 전사본이 비어 있고, retry 시에만 업데이트하며 R2 키/크기는 유지한다.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'workers-ai',
  model TEXT NOT NULL DEFAULT '@cf/openai/whisper',
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  doc_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
