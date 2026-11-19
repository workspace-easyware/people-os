-- Whisper 예상 뉴런 표시용: Plaud가 알려주는 녹음 길이(ms). NULL = 길이 모름 (화면에 예상치를 표시하지 않음).
-- 되돌리기: ALTER TABLE recordings DROP COLUMN duration_ms;
ALTER TABLE recordings ADD COLUMN duration_ms INTEGER;
