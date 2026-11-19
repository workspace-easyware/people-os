-- 로컬 검증 전용 (결재 A1, 2026-11-17). 원격에 쓰지 말 것.
-- 쿠키 토큰: apprA1tokenHR(로컬 hr_admin 7610f8aa…) / apprA1tokenMGR(부서장) / apprA1tokenDRF(기안자) /
--            apprA1tokenOUT(같은 부서, 결재선 밖) / apprA1tokenND(부서 없음)
INSERT OR IGNORE INTO users(id, email, name, role, status, created_at) VALUES
 ('appr-a1-mgr', 'appr-mgr@example.test', '결재 부서장', 'user', 'active', '2026-11-17T01:00:00Z'),
 ('appr-a1-drafter', 'appr-drafter@example.test', '결재 기안자', 'user', 'active', '2026-11-17T01:00:01Z'),
 ('appr-a1-out', 'appr-out@example.test', '결재 외부인', 'user', 'active', '2026-11-17T01:00:02Z'),
 ('appr-a1-nodept', 'appr-nodept@example.test', '결재 무소속', 'user', 'active', '2026-11-17T01:00:03Z');
INSERT OR IGNORE INTO auth_sessions(token_hash, user_id, expires_at) VALUES
 ('d369d54818005f36cb80934fbab79535225a589b8689c8eb80d171150f6c170d', '7610f8aa-bf09-46ff-834f-aa89f18a4136', 4102444800000),
 ('facdeb1063f9e5568d391f93125fa1f92e32e38a1b98408da9adfdde6c72832a', 'appr-a1-mgr', 4102444800000),
 ('7d503ff8208e839ffeb2b2a7b65b4c0aa3b5e0ef0cac7848daffc022f2beee40', 'appr-a1-drafter', 4102444800000),
 ('8d1ea633d9ad1d548087482ccaacc11321cc767be752bc4ed96a1a1dd11f3efc', 'appr-a1-out', 4102444800000),
 ('2d74db933db8e9f09fbd9fe137f00d04dd0819ddabe2026054cc23db67506c98', 'appr-a1-nodept', 4102444800000);
-- 소속: 기안자·외부인·부서장은 인사팀. 부서장 지정은 검증 중 관리 API(PUT/POST /api/approval/admin/...)로 한다.
UPDATE users SET department_id = 'dept_hr' WHERE id IN ('appr-a1-mgr', 'appr-a1-drafter', 'appr-a1-out');
