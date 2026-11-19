-- A1 에이전트 활동 검증용 사용자·세션 (로컬 전용 격리 DB에만 넣는다. 공유 로컬 DB·원격 금지).
-- 세션 토큰 원문: agentverify-admin-token / agentverify-usera-token / agentverify-userb-token
-- token_hash = sha256hex(원문) (auth.ts sessionTokenFromCookie → sha256hex).
INSERT OR REPLACE INTO users (id, email, name, role, status, created_at, coaching_role) VALUES
  ('av-admin', 'av-admin@example.test', 'AV관리자', 'hr_admin', 'active', '2026-11-17T00:00:00Z', 'coach'),
  ('av-a',     'av-a@example.test',     'AV사용자A', 'user',    'active', '2026-11-17T00:00:00Z', 'coach'),
  ('av-b',     'av-b@example.test',     'AV사용자B', 'user',    'active', '2026-11-17T00:00:00Z', 'coach');
INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES
  ('ec510f2e4dccc9d30b77c1471f6508933b18b90207a298f1c58ffd11d7c348ee', 'av-admin', 4102444800000),
  ('29fe08aea94143856e14588b991ce2cb58f5b5728d7187f091eedd4ba85eecab', 'av-a',     4102444800000),
  ('faf951661131168bf2456bbbc907576f13b7d4a96af24e99d658fb38758b5690', 'av-b',     4102444800000);
