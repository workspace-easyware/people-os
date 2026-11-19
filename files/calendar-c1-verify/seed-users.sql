-- 검증용 사용자 3명 + 세션 (토큰 tokA / tokB / tokH 의 sha256). 로컬 전용.
INSERT INTO users(id,email,name,role,status,created_at) VALUES
 ('u_a','a@test.local','에이','user','active','2026-11-17'),
 ('u_b','b@test.local','비','user','active','2026-11-17'),
 ('u_h','h@test.local','에이치알','hr_admin','active','2026-11-17');
INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
 ('ddd824ea9d68a96a66f14bf72963ddb076a4e3f4996b43fbe55fda7eaf06e075','u_a',4102444800000),
 ('44291ee5bd396a4e810d8ac727d6f8289af6273719a5a543d2f342e3939ba1b7','u_b',4102444800000),
 ('445a91802a574a013c5b43f5932c50e6b38b78dc28482cdb4f620210b1321877','u_h',4102444800000);
