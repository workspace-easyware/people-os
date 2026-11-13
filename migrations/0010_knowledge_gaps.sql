-- 지식 공백 큐 (C5-b, 2026-11-13)
-- 근거 없는 질문·👎 피드백 질문을 쌓는다. HR 담당자가 답을 게시하면
-- Markdown 문서(kind='tacit')로 저장·색인하고, 같은 질문을 다시 실행해
-- 근거가 잡히면 resolved, 아니면 open으로 되돌린다 (검증 단계).
-- status: open(대기) | answered(게시됨) | resolved(검증됨).
-- count: 같은 질문이 open 상태로 다시 들어온 횟수.
-- source: 'no-evidence'(근거 없음 경고) | 'downvote'(👎 피드백).
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  doc_id TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'no-evidence'
);

-- 암묵지 문서 작성자 (C5-b): 출처 배지 "사내 암묵지 · 작성자 · 게시일"용.
-- 게시일(publishedAt)은 documents.created_at 날짜로 쓴다.
ALTER TABLE documents ADD COLUMN author TEXT;
