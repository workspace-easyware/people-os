-- 답변 감사 기록 (C7, 2026-11-13)
-- /api/ask 호출마다 1행: 질문·답변·근거 id 목록·grounded·엔진·timings·세션·시각.
-- 캐시된 답은 원본 호출의 행을 공유하므로(같은 eventId) 새로 기록하지 않는다.
-- feedback: POST /api/feedback이 👍/👎를 기록한다 ('up' | 'down').
-- 👎는 C5-b에서 지식 공백 큐로 연결한다 (지금은 기록만, 큐 UI는 C5-b).
CREATE TABLE IF NOT EXISTS ask_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT '[]',
  grounded INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT '',
  search_engine TEXT NOT NULL DEFAULT '',
  timings_json TEXT NOT NULL DEFAULT '{}',
  feedback TEXT,
  feedback_comment TEXT,
  feedback_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
