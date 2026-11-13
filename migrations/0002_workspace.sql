-- Stage 1 작업 공간 + PPTX 덱 (2026-11-13)
-- tasks: 요약 액션 → 할 일 체크리스트 (FlowDesk 노트/작업 모델 참고, D1에 직접 저장)
-- decks: pptxgenjs로 생성한 초안 덱 메타데이터 (파일 본문은 R2 decks/<id>.pptx)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  slides INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
