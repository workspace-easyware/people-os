-- Plaud 전사 없는 녹음 → People OS Whisper 전사 (2026-11-19).
-- plaud_imports에 전사 중인 녹음(recordings.id)과 문서 머리말(출처)을 연결한다. 전사가 끝나 문서가 생기면 doc_id를 채운다.
-- 되돌리기: ALTER TABLE plaud_imports DROP COLUMN recording_id; ALTER TABLE plaud_imports DROP COLUMN header;
ALTER TABLE plaud_imports ADD COLUMN recording_id TEXT;
ALTER TABLE plaud_imports ADD COLUMN header TEXT;
CREATE INDEX IF NOT EXISTS idx_plaud_imports_recording ON plaud_imports(recording_id);
