-- 조문 단위 근거 청킹 (C5, 2026-11-13)
-- 규정 본문을 제N조 단위로 나눠 저장한다. Vectorize 색인과 /api/ask의
-- 근거 단위를 정책 통째가 아니라 조문으로 바꾼다.
-- article: 조문 라벨 (예: "제12조 연차휴가"), ord: 문서 안 순서.
CREATE TABLE chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, article TEXT NOT NULL, text TEXT NOT NULL, ord INTEGER NOT NULL);
