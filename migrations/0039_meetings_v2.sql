-- 화상회의 V1+V2 (2026-11-19, video-conference-plan.md 6장·9장 결정 4번).
-- transcribe: 이 회의를 회의 후 전사할지 (코칭 DM은 항상 1, 그 외는 시작할 때 고른다. 기본 1).
-- transcript_attempts·transcript_error: 15분 크론이 RealtimeKit에서 전사를 다시 가져올 때의 시도 횟수와 마지막 오류.
-- transcript_status 값(0038 주석에 더해): processing(가져오는 중) | empty(발화 없음) | off(전사 안 함).
-- recordings: provider='realtimekit', object_key='meetings/<회의 id>/<세션>.json' 행을 쓴다 (새 컬럼 없음).
ALTER TABLE meetings ADD COLUMN transcribe INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN transcript_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN transcript_error TEXT;
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, transcript_status);
