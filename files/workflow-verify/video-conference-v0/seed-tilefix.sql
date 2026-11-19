-- 타일 미표시 수정 로컬 검증용 세션 (2026-11-19). 로컬 D1 전용. 원 토큰: v0tilefix-coach / v0tilefix-coachee
INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES
 ('fc573d9da746383d2bcaf0983a3a379c065ec1a667be77ddfbe56a98c97ddd77', 'u_v0_coach', 1795686409062),
 ('ff21b0a72b009f003815ae22ad5355473a085eadbe554f7169d107af63cf14fd', 'u_v0_coachee', 1795686409062);
