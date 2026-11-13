-- S1 Queues 파이프라인 상태 (2026-11-13)
-- 전사 완료 이후 단계(요약 → 색인)는 Cloudflare Queues 소비자가 처리한다.
-- recordings 행에 파이프라인 단계를 남겨 화면이 대기→전사→요약→색인을 표시한다.
-- jobs 테이블(계획서 B.2)은 여러 파이프라인이 생기는 B2에서 도입하고,
-- S1은 녹음 1건당 파이프라인 1개라 recordings 확장으로 최소 변경한다.
-- pipeline_stage: 'queued' | 'transcribing' | 'summarizing' | 'indexing' | 'done' | 'failed'
--   queued: 업로드 직후(전사 대기) 또는 전사 완료 후(요약 대기)
--   transcribing: advanceRecording이 구간 전사 중
--   summarizing/indexing: 큐 소비자가 처리 중
--   done: 요약·색인 완료 / failed: 재시도(max_retries) 후에도 실패 — 전사본은
--   D1/R2에 그대로 있고, POST /api/recordings/:id/pipeline-retry로 다시 큐에 넣는다.
ALTER TABLE recordings ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE recordings ADD COLUMN pipeline_error TEXT;
