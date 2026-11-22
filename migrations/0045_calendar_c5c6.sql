-- 캘린더 C5(알림) + C6(구글 쓰기) (2026-11-22). 계획서 calendar-plan.md 4.1 · 3.4.

-- C5: 알림 중복 방지 로그에 "어느 크론 실행이 넣었는가"를 남긴다.
-- 크론은 INSERT OR IGNORE로 로그를 넣고, 같은 batch의 다음 문장이 run_id가 자기 것인 행에만 notifications를 만든다
-- (결재 notificationStmt의 "방금 들어간 행이 있을 때만" 패턴). 크론이 겹치거나 다시 돌아도 알림은 한 번만 생긴다.
ALTER TABLE calendar_reminder_log ADD COLUMN run_id TEXT;

-- C6: People OS 일정 ↔ 구글 일정 연결. 행이 있다 = 그 일정의 "구글 캘린더에도 저장"이 켜져 있다.
-- 개인 일정(소유자 본인의 구글 기본 캘린더)만 연결한다. 팀 일정·구글에서 온 일정은 행을 만들지 않는다.
-- 시각은 epoch ms(INTEGER) — calendar_google_accounts와 같은 관례. 외래키는 두지 않는다 (기존 관례).
CREATE TABLE IF NOT EXISTS calendar_event_links (
  event_id TEXT PRIMARY KEY,                 -- calendar_events.id
  user_id TEXT NOT NULL,                     -- 누구의 구글 계정인가 (= 일정 owner_id)
  google_event_id TEXT NOT NULL,             -- People OS가 미리 정해 보내는 구글 일정 id (재전송해도 1개만 생긴다)
  etag TEXT,                                 -- 마지막으로 본 구글 etag. NULL = 아직 구글에 만든 적 없음
  push_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (push_status IN ('PENDING','SYNCED','FAILED','DELETE_PENDING')),
  attempts INTEGER NOT NULL DEFAULT 0,       -- 연속 실패 횟수 (성공하면 0). 5회가 되면 크론이 더 시도하지 않는다
  last_error TEXT,                           -- 구글 오류 코드 문자열만 (토큰·본문 없음)
  pushed_at INTEGER,                         -- 마지막으로 구글에 반영된 시각
  checked_at INTEGER,                        -- 마지막으로 구글 쪽 변경을 대조한 시각
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_links_google ON calendar_event_links(user_id, google_event_id);
CREATE INDEX IF NOT EXISTS idx_cal_links_status ON calendar_event_links(push_status, updated_at);
