-- 0023_lms.sql — 강의실 (2026-11, 공모전 최소 범위)
CREATE TABLE IF NOT EXISTS lms_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'JOB',          -- JOB | LEGAL | SAFETY | COACHING (표시용)
  thumbnail_url TEXT,                            -- NULL이면 첫 유튜브 강의의 썸네일을 쓴다
  ord INTEGER NOT NULL DEFAULT 0,                -- 목록 정렬
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lms_lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube','r2')),
  youtube_id TEXT,                               -- source='youtube': 11자 영상 ID
  r2_key TEXT,                                   -- source='r2': R2 객체 키 (예: lms/sample.mp4)
  start_sec INTEGER,                             -- 유튜브 챕터 시작 (NULL = 처음부터)
  end_sec INTEGER,                               -- 유튜브 챕터 끝 (NULL = 끝까지)
  duration_sec INTEGER,
  content_type TEXT,                             -- r2: video/mp4 등
  size_bytes INTEGER,                            -- r2: 객체 크기 (Range 계산에 쓴다)
  curator_note TEXT,                             -- 큐레이션 한 줄 ("왜 이 영상인가")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, ord),
  CHECK ((source = 'youtube' AND youtube_id IS NOT NULL AND r2_key IS NULL)
      OR (source = 'r2' AND r2_key IS NOT NULL AND youtube_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_lms_lessons_course ON lms_lessons(course_id, ord);

CREATE TABLE IF NOT EXISTS lms_progress (
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  position_sec INTEGER NOT NULL DEFAULT 0,       -- 마지막 시청 위치 (이어보기, 2순위 기능)
  completed_at TEXT,                             -- NULL = 미완료
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lms_progress_lesson ON lms_progress(lesson_id);
