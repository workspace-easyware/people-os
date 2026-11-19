INSERT OR REPLACE INTO users (id, email, name, role, status, created_at, coaching_role) VALUES
 ('u_v0_coach', 'coach@v0.test', '김코치', 'user', 'active', datetime('now'), 'coach'),
 ('u_v0_coachee', 'coachee@v0.test', '이코칭', 'user', 'active', datetime('now'), 'coachee'),
 ('u_v0_member', 'member@v0.test', '최멤버', 'user', 'active', datetime('now'), 'coachee'),
 ('u_v0_outsider', 'admin@v0.test', '박관리', 'hr_admin', 'active', datetime('now'), 'coachee');
INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES
 ('c20453b3d1d37242b53604ffdae368df996ed278dd0c82dcd59ed493fcea423d', 'u_v0_coach', 1795686409062),
 ('6a21da199de9288f397359d158adf020f2b99e80dc7dd63093ba7c3c73667cfd', 'u_v0_coachee', 1795686409062),
 ('be9a56c1c3bd124806dd3e88e76afc992c8f9a7fdae4a0ece863c74a976c4ca3', 'u_v0_member', 1795686409062),
 ('9ffdf440422c5c21513926eba6689c11118b3c52665d477d37d33ee7ef9e6925', 'u_v0_outsider', 1795686409062);
INSERT OR REPLACE INTO chat_rooms (id, type, name, creator_id) VALUES ('chat:dm:u_v0_coach:u_v0_coachee', 'dm', NULL, 'u_v0_coach'), ('chatg_v0', 'group', 'V0 그룹', 'u_v0_coachee');
INSERT OR REPLACE INTO chat_room_members (room_id, user_id) VALUES
 ('chat:dm:u_v0_coach:u_v0_coachee', 'u_v0_coach'), ('chat:dm:u_v0_coach:u_v0_coachee', 'u_v0_coachee'),
 ('chatg_v0', 'u_v0_coachee'), ('chatg_v0', 'u_v0_member');
