-- 전사 재개 가능 상태 (2026-11-13)
-- waitUntil 백그라운드 작업이 약 2분 뒤에 조용히 죽는 것이 확인됐다
-- (97분 ogg: 3/24 구간까지만 진행, 4구간에서 21분 멈춤).
-- 구간별 전사를 여러 호출에 나눠 이어가려면 완료분 텍스트와 진행 위치를
-- 행에 남겨야 한다. partial=완료 구간 전사본, done_chunks=완료 구간 수,
-- lock_until=동시 실행 방지 잠금(밀리초 epoch, 180초 TTL).
ALTER TABLE recordings ADD COLUMN partial TEXT DEFAULT '';
ALTER TABLE recordings ADD COLUMN done_chunks INTEGER DEFAULT 0;
ALTER TABLE recordings ADD COLUMN lock_until INTEGER;
