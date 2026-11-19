-- 로컬 검증 전용: 테스트 사용자 A/B + 세션 (쿠키 토큰 lmsS1tokenA / lmsS1tokenB). 원격에 쓰지 말 것.
INSERT OR IGNORE INTO users(id, email, name, role, status, created_at) VALUES
 ('lms-s1-user-a', 'lms-a@example.test', 'LMS A', 'user', 'active', '2026-11-17T00:00:00Z'),
 ('lms-s1-user-b', 'lms-b@example.test', 'LMS B', 'user', 'active', '2026-11-17T00:00:00Z');
INSERT OR IGNORE INTO auth_sessions(token_hash, user_id, expires_at) VALUES
 ('dc5bad09004e21e78b44da16aac2aaf072a15d59c504f3a41e0f301aefaad3e0', 'lms-s1-user-a', 4102444800000),
 ('50d5e9c8d7830e60ea0710c5490ba0296505bada3b45a12c3a0d9442edcb0af1', 'lms-s1-user-b', 4102444800000);
