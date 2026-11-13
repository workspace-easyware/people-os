-- 전사 진행 상황 표시 (2026-11-13)
-- 긴 오디오는 구간별 전사라 수 분이 걸린다. 백그라운드 처리 중 진행 문구를
-- 남기는 컬럼. transcript_status: 'ready' | 'pending' | 'processing'.
ALTER TABLE recordings ADD COLUMN progress TEXT;
