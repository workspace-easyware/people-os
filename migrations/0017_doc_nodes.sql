-- 트리 메타데이터 (2026-11-16) — Fable 5.2 자문 결론: Vector DB를 유지하고,
-- 트리는 검색기가 아니라 청크에 붙는 메타데이터(섹션 경로, 주제 구간)로만 얇게 도입한다.
-- 질의 시 LLM이 트리를 타고 내려가는 탐색은 하지 않는다.
--
-- doc_nodes: 문서 구조 트리. 파일은 `#` 제목을 결정적으로 파싱(source='heading'),
-- 전사본은 LLM 1회 호출로 주제 구간을 나누고 구조화 요약과 함께 만든다(source='llm-topic').
-- 루트 노드(depth 0)는 문서 요약, 자식 노드(depth 1)는 주제 구간.
-- 검색은 지금처럼 벡터+키워드로 하고, 적중한 청크의 부모 노드 제목·요약을 근거에 덧붙인다.
--
-- 격리: doc_nodes에 owner_id를 복제하지 않는다. documents JOIN + docOwnerClause로만
-- 스코핑해서 소유자 정보의 출처를 하나로 둔다 (Fable 자문).
--
-- HR 규정(kind='policy')에는 트리를 도입하지 않는다. 조문 단위로 이미 깔끔하게
-- 나뉘어 있고, 요약하면 "30일 이내" 같은 정확한 문구가 뭉개진다.
--
-- 문서 삭제 시 노드도 함께 지우는 로직은 이번 범위에서 뺀다. 삭제 순서
-- (노드 → 청크 → 벡터 → documents → R2)는 src/tree.ts 주석에 남긴다
-- (삭제 엔드포인트가 아직 없으므로).
CREATE TABLE IF NOT EXISTS doc_nodes (
  id TEXT PRIMARY KEY,          -- `${doc_id}-node-${ord}`
  doc_id TEXT NOT NULL,
  parent_id TEXT,               -- NULL = 루트
  ord INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  title TEXT NOT NULL,          -- 제목 또는 주제 라벨
  summary TEXT,                 -- 전사본 구간 요약 (파일은 NULL 가능)
  chunk_start INTEGER,          -- chunks.ord 범위 시작
  chunk_end INTEGER,            -- chunks.ord 범위 끝
  source TEXT NOT NULL          -- 'heading' | 'llm-topic'
);
CREATE INDEX IF NOT EXISTS idx_doc_nodes_doc ON doc_nodes(doc_id, ord);

ALTER TABLE chunks ADD COLUMN node_id TEXT;

ALTER TABLE documents ADD COLUMN tree_hash TEXT;

-- 구조화 요약(LLM Wiki 얇은 조각): 전사본 1건당 1개. 결정사항·액션·참석자·태그를
-- JSON으로 저장한다. 루트 요약은 Vectorize에 kind=digest 벡터로도 넣는다.
-- 요약은 길잡이로만 쓰고, 답변 근거는 반드시 원본 청크로 한다.
ALTER TABLE documents ADD COLUMN digest_json TEXT;
