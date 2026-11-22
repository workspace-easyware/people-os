-- 로컬 전용 (xlsx-edit-pilot/state). 시험 사용자 u_xltest에 7일 세션.
INSERT OR REPLACE INTO auth_sessions(token_hash, user_id, expires_at) VALUES('43aaa339af99801946ef1dd9cdc65bf986dcc527b3c249804981a13bd177be0b', 'u_xltest', 1796000000000); -- 약 2026-11-30 (ms)
