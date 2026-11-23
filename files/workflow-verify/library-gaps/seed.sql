INSERT INTO documents (id, title, kind, content) VALUES ('doc_t1', '출산 전후 재택', 'tacit', '작성자: 인사팀 · 작성일: 2026-11-23
원 질문: 출산 전후 재택 가능해요?

가능합니다.
둘째 줄.');
INSERT INTO knowledge_gaps (id, question, asked_at, status, doc_id, count, source) VALUES
 ('g_open', '열린 질문', 1700000000000, 'open', NULL, 1, 'no-evidence'),
 ('g_res', '출산 전후 재택 가능해요?', 1700000001000, 'resolved', 'doc_t1', 2, 'downvote'),
 ('g_pub', '게시됨 질문', 1700000002000, 'published', 'doc_t1', 1, 'no-evidence');
