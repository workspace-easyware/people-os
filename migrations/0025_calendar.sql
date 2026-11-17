-- 캘린더 C1 (2026-11-17): 자체 일정 + 알림 중복 방지 로그. 계획서 calendar-plan.md 1.2·4.1.
-- 시각은 UTC 'YYYY-MM-DDTHH:MM:SSZ' 고정 형식 (문자열 비교 = 시간 비교). 표시는 항상 Asia/Seoul.
-- 외래키는 두지 않는다 (기존 관례). owner_id = users.id.

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,                       -- uid('cal')
  owner_id TEXT NOT NULL,                    -- users.id (항상 세션에서)
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team')),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general','meeting','coaching','training','deadline')),
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,                    -- UTC. 종일이면 그 날 00:00 KST
  end_at TEXT NOT NULL,                      -- UTC, 포함하지 않는 끝. 종일이면 마지막 날 다음 날 00:00 KST
  start_date TEXT,                           -- 종일일 때만 (KST 날짜)
  end_date TEXT,                             -- 종일일 때만, 포함하지 않는 끝
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  rrule TEXT,                                -- C7 전까지 항상 NULL
  exdates TEXT,                              -- C7 전까지 항상 NULL
  remind_minutes INTEGER,                    -- NULL = 알림 없음
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED')),
  version INTEGER NOT NULL DEFAULT 0,        -- 낙관적 잠금
  deleted_at TEXT,                           -- 소프트 삭제
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cal_events_owner ON calendar_events(owner_id, start_at);
CREATE INDEX IF NOT EXISTS idx_cal_events_team ON calendar_events(start_at)
  WHERE visibility = 'team' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cal_events_remind ON calendar_events(start_at)
  WHERE remind_minutes IS NOT NULL AND deleted_at IS NULL;

-- 알림 중복 방지 (C5가 사용). 단일 일정은 occurrence_start = start_at.
CREATE TABLE IF NOT EXISTS calendar_reminder_log (
  event_id TEXT NOT NULL,
  occurrence_start TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, occurrence_start, user_id)
);
