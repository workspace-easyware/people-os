-- 메일 휴지통 (2026-11-26): 소프트 삭제. deleted_at이 있으면 휴지통, 7일 뒤 15분 크론 틱이 완전 삭제한다.
ALTER TABLE emails ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_emails_deleted ON emails(deleted_at);
