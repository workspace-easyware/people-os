-- 캘린더 C3 (2026-11-17): 구글 OAuth 연결 (1단계 읽기 전용). 계획서 calendar-plan.md 2.3·2.4.
-- 토큰은 평문 저장 금지: *_enc 컬럼은 전부 src/calendar/crypto.ts의 AES-256-GCM 암호문 'v1.<iv>.<ct>'.
-- 시각은 epoch ms(INTEGER) — auth_sessions·password_links와 같은 관례. 외래키는 두지 않는다 (기존 관례).
-- 이 두 표는 src/calendar/ 밖에서 읽지 않는다 (calendar-plan.md 6.2).

CREATE TABLE IF NOT EXISTS calendar_google_accounts (
  user_id TEXT PRIMARY KEY,                  -- users.id. People OS 사용자당 구글 계정 1개
  google_sub TEXT,                           -- id_token의 sub (표시·식별용)
  google_email TEXT,                         -- id_token의 email (화면에는 마스킹해서만)
  access_token_enc TEXT,                     -- 암호문 (AAD: user_id + 'access'). NEEDS_RECONNECT면 NULL
  refresh_token_enc TEXT NOT NULL,           -- 암호문 (AAD: user_id + 'refresh')
  access_expires_at INTEGER,                 -- epoch ms
  scope TEXT,                                -- 구글이 실제로 부여한 스코프 문자열
  status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED','NEEDS_RECONNECT')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- OAuth 시작 요청. state 원문은 저장하지 않고 sha256만 (세션 토큰과 같은 방식). 1회용·10분·사용자 결합.
CREATE TABLE IF NOT EXISTS calendar_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,               -- PKCE verifier도 암호문으로 (AAD: user_id + 'pkce')
  redirect_uri TEXT NOT NULL,                -- 인가 요청에 쓴 값 (토큰 교환 때 그대로 다시 보낸다)
  created_at INTEGER NOT NULL,               -- epoch ms
  used_at INTEGER                            -- NULL = 미사용
);

CREATE INDEX IF NOT EXISTS idx_cal_oauth_states_user ON calendar_oauth_states(user_id, created_at);
