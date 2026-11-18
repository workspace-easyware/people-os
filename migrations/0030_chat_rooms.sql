-- DO-1b (2026-11-18): 채팅 방 목록 인덱스. DO는 훑을 수 없으므로 "내가 속한 방"은 D1이 안다. DO-1c(그룹)가 같은 표를 재사용한다.
-- DM 행: id = 방 키 그대로 ('chat:dm:<a>:<b>'), 첫 메시지가 DO에 저장된 뒤 upsert. 그룹 행: DO-1c가 만든 id.
-- updated_at은 마지막 메시지 시각(ISO8601, 목록 정렬용). 앱이 항상 명시적으로 쓴다.
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
  name TEXT,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_updated ON chat_rooms(updated_at);
