-- 라이브 스모크 임시 계정 (비밀번호 없음 = 로그인 불가) + 1시간 세션. 끝나면 remote-cleanup.sql로 지운다.
INSERT INTO users(id, email, name, role, status, created_at, coaching_role) VALUES('u_docxtblfix_tmp', 'docx-tablefix-tmp@example.invalid', '표 고치기 스모크 (임시)', 'user', 'active', '2026-11-21T00:00:00Z', 'coach');
INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES('6f160dcf738f172f850f8a57dc65889cf7ef5a6d6b401345d4fe09455ddc0778', 'u_docxtblfix_tmp', 1795247231000);
