-- 채팅 presence·읽음·반응 (2026-11-18): 메시지별 이모지 반응.
-- room_id = chat_rooms.id (DM은 방 키 'chat:dm:<a>:<b>', 그룹은 chatg_...). message_seq = ChatRoom DO의 메시지 seq.
-- 같은 사람이 같은 메시지에 같은 이모지는 1번만 (토글: 있으면 DELETE, 없으면 INSERT). 이모지 허용 목록은 앱(src/chat/routes.ts REACTION_EMOJIS)이 검사한다.
-- 방이 지워지면 반응도 지운다 (chat_rooms ON DELETE CASCADE). created_at은 ISO8601, 앱이 명시적으로 쓴다.
CREATE TABLE IF NOT EXISTS chat_reactions (
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, message_seq, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_room_seq ON chat_reactions(room_id, message_seq);
