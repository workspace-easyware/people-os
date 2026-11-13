-- Vectorize 시딩 상태 (C5 Phase 2, 2026-11-13)
-- bge-m3 lazy 시딩 결과를 남긴다: vector_seeded:bge-m3:people-os-index-m3
-- (JSON: {seeded, dims, upserted, at}), 실패는 vector_seed_error:... 키에.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
