-- 화상회의 V0 (2026-11-19, video-conference-plan.md 2장): RealtimeKit 회의 기록.
-- 회의실 상태(누가 들어와 있는지, 미디어)는 RealtimeKit이 관리한다. People OS는 "이 채팅방에 진행 중인 회의가 있다"만 적는다.
-- 참가 자격은 chat_room_members에서 그대로 읽는다 (hr_admin이라도 멤버가 아니면 못 들어간다).
-- status: active | ended. 채팅방 하나에 active 회의는 1개 (부분 고유 인덱스로 강제).
-- transcript_status: none(아직) | available(웹훅으로 RealtimeKit 전사 링크 받음) | ready(V2: recordings·문서로 들어감) | failed.
-- recording_id: V2에서 전사본이 recordings 행으로 들어간 뒤 연결한다.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rtk_meeting_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  is_coaching INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  recording_id TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'none',
  rtk_session_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_room_active ON meetings(room_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_meetings_rtk ON meetings(rtk_meeting_id);
