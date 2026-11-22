-- 큰 덱·워크북·문서 Queue 처리 (2026-11-22): 파일이 커서 CPU 수 초가 걸리는 구조화 문서 작업(ops·replace 편집, 정의로 만드는 Word 문서)의 상태.
-- POST /api/pptx/edit·/api/xlsx/edit·/api/docx/edit·/api/docx/create가 예상 CPU(src/doc-load.ts)가 큰 요청을 받으면 여기 행을 만들고
-- 전용 Queue(people-os-doc-jobs, type "doc-job")에 넣은 뒤 202로 돌려준다. 화면은 GET /api/doc-jobs/:id를 2초마다 물어본다. 흐름은 src/doc-jobs.ts.
-- Word AI 지시 작업(docx_jobs, 0043)과 같은 패턴이지만 결과가 덱일 수도 있고 재시도 기준이 달라 테이블을 나눴다.
-- kind: pptx_edit | xlsx_edit | docx_edit | docx_create.  status: queued → running → done | failed (일시적인 실패는 queued로 되돌려 다시 시도 — attempts가 시도 횟수).
-- result_id: 작업을 만들 때 미리 정하는 결과 id (pptx_edit은 새 덱 id, 그 밖은 새 문서 id). 같은 작업이 두 번 돌아도 같은 R2 키·같은 행(INSERT OR IGNORE)이라 결과는 1개다.
-- source_ref: 원본 ("deck:<id>" | "doc:<id>", 생성은 NULL).  est_ms: 요청 때 계산한 예상 CPU(ms) — 실제 값과 견줘 임계값을 손보는 데 쓴다.
-- input_json: 요청 본문 + 요청한 사람 (사용자가 쓴 글이 들어 있다 — 7일 뒤 15분 크론이 행을 지운다). result_json: 끝난 뒤 화면에 보여 줄 결과 (예전 201 응답과 같은 모양).
CREATE TABLE IF NOT EXISTS doc_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  owner_id TEXT,
  result_id TEXT NOT NULL,
  source_ref TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  error_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  est_ms INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_jobs_owner_status ON doc_jobs(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_doc_jobs_status_created ON doc_jobs(status, created_at);
