-- 아침 다이제스트 실행 기록 (C9, 2026-11-13)
-- 매일 07:00 KST Cron이 전날 문서·리플렉션과 현재 열린 할 일·녹음 현황을
-- 묶어 Workers AI로 브리핑 문장을 만들고 이 테이블에 저장한다.
-- run_date: KST 기준 실행 날짜(YYYY-MM-DD). Cron 재실행·재시도는
-- INSERT OR REPLACE로 같은 날짜 행을 덮어써 멱등하게 동작한다.
-- engine: 'workers-ai' | 'template' (AI 실패 시 템플릿 폴백).
-- body: 브리핑 본문. data_json: GET /api/digest가 그대로 반환하는 스냅샷
-- (counts + documents/tasks/reflections/recordings 목록).
CREATE TABLE IF NOT EXISTS digest_runs (
  run_date TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  engine TEXT NOT NULL DEFAULT 'template',
  body TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
