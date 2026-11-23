-- 보안점검 로컬 검증용 시드 (로컬 wrangler dev 전용 — 운영 DB에 쓰지 않는다). 세션 토큰은 로컬 전용 고정 문자열이다.
INSERT OR REPLACE INTO users(id, email, name, role, status, coaching_role, created_at) VALUES
  ('u_admin', 'admin@local.test', '관리자', 'hr_admin', 'active', 'coach', '2026-11-22T00:00:00Z'),
  ('u_a', 'usera@local.test', '사용자A', 'user', 'active', 'coachee', '2026-11-22T00:00:00Z'),
  ('u_b', 'userb@local.test', '사용자B', 'user', 'active', 'coachee', '2026-11-22T00:00:00Z');
INSERT OR REPLACE INTO auth_sessions(token_hash, user_id, expires_at) VALUES
  ('3490f80401886d12f3861ec190f5c16419b26345497a92bc4530e22f5d8b4295', 'u_admin', 4102444800000),
  ('92e18130ebb234a4757b877d7ba5bdc1a973140fe662a9bff9751c7ca38b5b2f', 'u_a', 4102444800000),
  ('1a102d593d13ce35c8897df6d1e41b7b90b23868430ac514513bc931bd791cee', 'u_b', 4102444800000);
