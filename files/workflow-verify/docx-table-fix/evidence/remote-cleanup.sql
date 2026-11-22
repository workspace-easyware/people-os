-- 라이브 스모크 정리: 임시 세션·사용자 삭제 (문서 4건은 DELETE /api/documents/:id로 먼저 지움)
DELETE FROM auth_sessions WHERE user_id = 'u_docxtblfix_tmp';
DELETE FROM users WHERE id = 'u_docxtblfix_tmp';
