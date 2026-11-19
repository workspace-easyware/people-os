-- 전체 점검 (2026-11-18): 채팅 방의 최신 메시지 seq 캐시.
-- 방 목록 API(GET /api/chat/rooms)가 미읽음 수를 내려고 방마다 Durable Object를 깨워 최신 seq를 묻던 것(최대 200방)을
-- D1 한 번 조회로 줄인다. 메시지 전송 때 앱이 MAX(기존, 새 seq)로 갱신한다.
-- NULL = 아직 모름 (0032 이전부터 있던 방) → 앱이 그 방만 기존처럼 DO에 한 번 묻고 값을 채운다.
ALTER TABLE chat_rooms ADD COLUMN last_seq INTEGER;
