-- 로그인 (2026-11-15) — Talent Navigator(Worker) 뼈대 + 일잇(이메일·페퍼·설정 링크) 참고.
-- 역할: hr_admin(인사팀 관리자: 관측·평가 + 사용자 계정 관리) / user(일반 사용자).
-- 비밀번호는 PBKDF2-SHA256 10만 회 + PASSWORD_PEPPER HMAC (auth.ts). 토큰은 SHA-256 해시만 저장.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('hr_admin','user')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','inactive')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS password_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  issued_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_links_user ON password_links(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
