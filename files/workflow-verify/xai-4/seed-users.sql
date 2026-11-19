-- XAI-4 로컬 검증용: hr_admin 1명(tokA) + 일반 사용자 1명(tokB). 토큰 해시는 wf1/seed-users.sql과 같다. 로컬 전용.
INSERT INTO users(id,email,name,role,status,created_at) VALUES
 ('u_a','a@test.local','에이','hr_admin','active','2026-11-19'),
 ('u_b','b@test.local','비','user','active','2026-11-19');
INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
 ('ddd824ea9d68a96a66f14bf72963ddb076a4e3f4996b43fbe55fda7eaf06e075','u_a',4102444800000),
 ('44291ee5bd396a4e810d8ac727d6f8289af6273719a5a543d2f342e3939ba1b7','u_b',4102444800000);
