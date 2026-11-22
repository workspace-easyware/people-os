-- Word AI 지시 Queue 이동 (2026-11-22): 자연어 지시로 Word 문서를 만들거나(create) 고치는(edit) 느린 AI 작업의 상태.
-- POST /api/docx/create·/api/docx/edit가 지시(instruction)를 받으면 여기 행을 만들고 전용 Queue(people-os-docx-jobs, type "docx-job")에 넣은 뒤 202로 돌려준다.
-- 화면은 GET /api/docx/jobs/:id를 2초마다 물어본다. 흐름은 src/docx/jobs.ts.
-- status: queued → running → done | failed (일시적인 AI 호출 실패는 queued로 되돌려 다시 시도한다 — attempts가 시도 횟수).
-- doc_id: 작업을 만들 때 미리 정하는 새 문서 id. 같은 작업이 두 번 돌아도 같은 R2 키·같은 documents 행(INSERT OR IGNORE)이라 문서는 1개만 생긴다.
-- input_json: 요청 본문 + 요청한 사람 (지시 글이 들어 있다 — 7일 뒤 15분 크론이 행을 지운다). result_json: 끝난 뒤 화면에 보여 줄 결과.
CREATE TABLE IF NOT EXISTS docx_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  owner_id TEXT,
  doc_id TEXT NOT NULL,
  source_doc_id TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  error_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_docx_jobs_owner_status ON docx_jobs(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_docx_jobs_status_created ON docx_jobs(status, created_at);
