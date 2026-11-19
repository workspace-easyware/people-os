-- Plaud 연동 (2026-11-19): Plaud MCP(https://mcp.plaud.ai/mcp) OAuth 연결 + 전사문 가져오기 기록.
-- 구글 캘린더(0026)와 같은 관례: 토큰은 평문 금지(*_enc = src/calendar/crypto.ts AES-256-GCM 'v1.<iv>.<ct>'),
-- 시각은 epoch ms(INTEGER), 외래키 없음. 이 표들은 src/plaud/ 밖에서 읽지 않는다.
-- 되돌리기: DROP TABLE plaud_accounts; DROP TABLE plaud_oauth_states; DROP TABLE plaud_imports;
--          (가져온 문서는 라이브러리에서 문서 삭제로 따로 지운다)

CREATE TABLE IF NOT EXISTS plaud_accounts (
  user_id TEXT PRIMARY KEY,                  -- users.id. People OS 사용자당 Plaud 계정 1개
  plaud_email TEXT,                          -- get_current_user의 email (화면에는 마스킹해서만)
  access_token_enc TEXT,                     -- 암호문 (AAD: user_id + 'plaud-access')
  refresh_token_enc TEXT,                    -- 암호문 (AAD: user_id + 'plaud-refresh'). 서버가 안 줬으면 NULL
  access_expires_at INTEGER,                 -- epoch ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- OAuth 시작 요청. state 원문은 저장하지 않고 sha256만. 1회용·10분·사용자 결합.
CREATE TABLE IF NOT EXISTS plaud_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,               -- PKCE verifier 암호문 (AAD: user_id + 'plaud-pkce')
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plaud_oauth_states_user ON plaud_oauth_states(user_id, created_at);

-- 가져온 녹음. (사용자, Plaud file id)당 1행 → 중복 가져오기 방지. doc_id NULL = 가져오는 중(점유).
CREATE TABLE IF NOT EXISTS plaud_imports (
  user_id TEXT NOT NULL,
  plaud_file_id TEXT NOT NULL,
  doc_id TEXT,                               -- documents.id
  title TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, plaud_file_id)
);
