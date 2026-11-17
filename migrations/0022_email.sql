-- 메일함 (2026-11-17, Agentic Inbox 참고 — People OS Worker 안에 통합).
-- 수신: Cloudflare Email Routing(peopleos.site catch-all) → Worker email() 핸들러.
-- 발송: Resend HTTP API (Workers는 SMTP 25번 차단). 보낸 메일도 direction='out'으로 남긴다.
-- owner_id: 수신자/발신자 사용자. NULL이면 공용/미지정 (hr_admin만 본다). FK 없음(스키마 나머지처럼 느슨하게).
-- 원문(.eml)은 파싱 전에 항상 R2 emails/<id>/raw.eml에 먼저 저장한다 (파싱 실패해도 소실 없음).
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  direction TEXT NOT NULL DEFAULT 'in' CHECK(direction IN ('in','out')),
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  cc TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  body_html TEXT,
  received_at TEXT NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  -- 스레딩 폴백용 정규화 제목 (Re:/Fwd:/회신: 제거, 소문자). 1순위는 In-Reply-To/References.
  subject_norm TEXT,
  -- 발송 메일의 Resend id (direction='out').
  provider_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  labels TEXT,
  raw_r2_key TEXT,
  raw_size INTEGER,
  parse_error TEXT,
  -- Phase 2: AI 답장 초안 (저장만 — 발송은 사람이 확인 후 직접).
  ai_draft TEXT,
  ai_draft_at TEXT,
  -- Phase 2: 개인 RAG 색인 시 만든 documents.id.
  indexed_doc_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emails_owner ON emails(owner_id, received_at);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_subject_norm ON emails(owner_id, subject_norm);

CREATE TABLE IF NOT EXISTS email_attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON email_attachments(email_id);
