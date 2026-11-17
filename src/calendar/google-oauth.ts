// 캘린더 C3 (2026-11-17): 구글 OAuth 2.0 (웹 서버 흐름 + PKCE S256), 1단계 읽기 전용. 계획서 calendar-plan.md 2장.
// - 인가: https://accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent)
// - 토큰 교환·갱신: https://oauth2.googleapis.com/token
// - 폐기: https://oauth2.googleapis.com/revoke (연결 해제 시)
// 토큰·인가 코드·client_secret은 로그·응답에 절대 넣지 않는다. 구글 오류는 오류 코드 문자열(예: invalid_grant)만 다룬다.
// calendar_google_accounts / calendar_oauth_states는 이 파일과 routes.ts의 구글 경로만 만진다.
import { decryptToken, encryptToken, b64urlEncode, CryptoError, tokenKeyValid } from "./crypto";

export type GoogleEnv = {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GCAL_TOKEN_KEY?: string;
  /**
   * 로컬 검증 전용: 토큰·폐기 엔드포인트를 모의 서버로 돌린다. http://localhost:<포트> 또는
   * http://127.0.0.1:<포트> 형식만 인정하고 그 밖의 값은 무시한다 (운영에 잘못 넣어도 구글 대신
   * 외부 주소로 토큰이 나가지 않는다). 설정되면 localhost 콜백 주소도 허용 목록에 들어간다.
   */
  GCAL_DEV_GOOGLE_ORIGIN?: string;
};

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const REQUEST_SCOPES = ["openid", "email", READ_SCOPE];
/** 일정 읽기에 충분한 스코프 (include_granted_scopes로 더 넓은 권한이 합쳐져 와도 읽기는 된다). */
const READ_CAPABLE = [
  READ_SCOPE,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
];

export const CALLBACK_PATH = "/api/calendar/google/callback";
/** 구글 콘솔에 등록된 리디렉션 URI (글자 하나까지 정확히 대조한다). */
const REDIRECT_ALLOWLIST = [
  "https://peopleos.site/api/calendar/google/callback",
  "https://people-os.workspace-easyware.workers.dev/api/calendar/google/callback",
];

export const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export class GoogleError extends Error {
  /** kind: invalid_grant = 사용자 재연결 필요, http/network/bad_response = 일시 오류 또는 설정 문제 */
  constructor(public kind: "invalid_grant" | "http" | "network" | "bad_response", public code: string) {
    super(`google ${kind}: ${code}`);
  }
}

// ---- 설정 ----

const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;

function devOrigin(env: GoogleEnv): string | null {
  const v = env.GCAL_DEV_GOOGLE_ORIGIN;
  return v && DEV_ORIGIN_RE.test(v) ? v : null;
}

/** 시크릿 3개가 모두 있고 키가 32바이트일 때만 true (fail-closed). */
export function googleConfigured(env: GoogleEnv): boolean {
  return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && tokenKeyValid(env.GCAL_TOKEN_KEY);
}

/** C4: Calendar API 기본 주소. 로컬 검증용 모의 서버가 설정돼 있으면 그쪽(<origin>/calendar/v3/...)을 쓴다. */
export function calendarApiBase(env: GoogleEnv): string {
  const d = devOrigin(env);
  return (d ? d : "https://www.googleapis.com") + "/calendar/v3";
}

function tokenUrl(env: GoogleEnv): string {
  const d = devOrigin(env);
  return d ? d + "/token" : GOOGLE_TOKEN_URL;
}

function revokeUrl(env: GoogleEnv): string {
  const d = devOrigin(env);
  return d ? d + "/revoke" : GOOGLE_REVOKE_URL;
}

/** 요청이 들어온 출처 + 고정 경로. 허용 목록과 정확히 일치하지 않으면 null. */
export function redirectUriFor(env: GoogleEnv, requestUrl: string): string | null {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return null;
  }
  const uri = origin + CALLBACK_PATH;
  return redirectAllowed(env, uri) ? uri : null;
}

export function redirectAllowed(env: GoogleEnv, uri: string): boolean {
  if (REDIRECT_ALLOWLIST.includes(uri)) return true;
  if (devOrigin(env)) return /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/api\/calendar\/google\/callback$/.test(uri);
  return false;
}

// ---- PKCE / state ----

export function randomUrlToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(d));
}

export function buildAuthUrl(env: GoogleEnv, p: { redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.GOOGLE_CLIENT_ID || "",
    redirect_uri: p.redirectUri,
    scope: REQUEST_SCOPES.join(" "),
    state: p.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

// ---- 구글 호출 ----

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
};

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: TokenResponse | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleError("network", "fetch_failed");
  }
  let json: TokenResponse | null = null;
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function tokenError(status: number, json: TokenResponse | null): GoogleError {
  const code = json && typeof json.error === "string" ? json.error.slice(0, 64) : `http_${status}`;
  return new GoogleError(code === "invalid_grant" ? "invalid_grant" : "http", code);
}

export type ExchangedTokens = {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  scope: string;
  idToken: string | null;
};

function readTokens(json: TokenResponse | null): ExchangedTokens {
  if (!json || typeof json.access_token !== "string" || !json.access_token) throw new GoogleError("bad_response", "no_access_token");
  const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + ttl * 1000,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    scope: typeof json.scope === "string" ? json.scope : "",
    idToken: typeof json.id_token === "string" ? json.id_token : null,
  };
}

export async function exchangeCode(env: GoogleEnv, p: { code: string; redirectUri: string; verifier: string }): Promise<ExchangedTokens> {
  const { status, json } = await postForm(tokenUrl(env), {
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: env.GOOGLE_CLIENT_ID || "",
    client_secret: env.GOOGLE_CLIENT_SECRET || "",
    code_verifier: p.verifier,
  });
  if (status !== 200) throw tokenError(status, json);
  return readTokens(json);
}

async function refreshTokens(env: GoogleEnv, refreshToken: string): Promise<ExchangedTokens> {
  const { status, json } = await postForm(tokenUrl(env), {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID || "",
    client_secret: env.GOOGLE_CLIENT_SECRET || "",
  });
  if (status !== 200) throw tokenError(status, json);
  return readTokens(json);
}

/** 구글 폐기 요청. 성공(200)이면 true, 그 밖(이미 무효·네트워크 오류)은 false — 호출자는 계속 진행한다. */
export async function revokeToken(env: GoogleEnv, token: string): Promise<boolean> {
  try {
    const { status } = await postForm(revokeUrl(env), { token });
    return status === 200;
  } catch {
    return false;
  }
}

export function scopeSufficient(scope: string): boolean {
  const granted = scope.split(/\s+/).filter(Boolean);
  return READ_CAPABLE.some((s) => granted.includes(s));
}

/**
 * id_token 페이로드에서 sub·email만 읽는다. 토큰 엔드포인트에서 TLS로 직접 받은 값이라 서명 검증 대신
 * aud(=client_id)·iss만 확인한다 (로그인 수단으로 쓰지 않는다 — 표시용).
 */
export function readIdToken(env: GoogleEnv, idToken: string | null): { sub: string | null; email: string | null } {
  if (!idToken) return { sub: null, email: null };
  try {
    const part = idToken.split(".")[1] || "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const p = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const audOk = p.aud === env.GOOGLE_CLIENT_ID;
    const issOk = p.iss === "https://accounts.google.com" || p.iss === "accounts.google.com";
    if (!audOk || !issOk) return { sub: null, email: null };
    return {
      sub: typeof p.sub === "string" ? p.sub.slice(0, 255) : null,
      email: typeof p.email === "string" ? p.email.slice(0, 320) : null,
    };
  } catch {
    return { sub: null, email: null };
  }
}

// ---- D1 (계정 행) ----

export type AccountRow = {
  user_id: string;
  google_sub: string | null;
  google_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string;
  access_expires_at: number | null;
  scope: string | null;
  status: "CONNECTED" | "NEEDS_RECONNECT";
  created_at: number;
  updated_at: number;
};

export async function loadAccount(env: GoogleEnv, userId: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    "SELECT user_id, google_sub, google_email, access_token_enc, refresh_token_enc, access_expires_at, scope, status, created_at, updated_at " +
      "FROM calendar_google_accounts WHERE user_id = ?",
  ).bind(userId).first<AccountRow>();
}

/** 새 연결 저장 (같은 사용자의 기존 행은 덮어쓴다). 토큰은 여기서 암호화된다. */
export async function saveConnection(
  env: GoogleEnv, userId: string, t: ExchangedTokens & { refreshToken: string }, who: { sub: string | null; email: string | null },
): Promise<void> {
  const now = Date.now();
  const refreshEnc = await encryptToken(env.GCAL_TOKEN_KEY, userId, "refresh", t.refreshToken);
  const accessEnc = await encryptToken(env.GCAL_TOKEN_KEY, userId, "access", t.accessToken);
  await env.DB.prepare(
    `INSERT INTO calendar_google_accounts (user_id, google_sub, google_email, access_token_enc, refresh_token_enc,
       access_expires_at, scope, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'CONNECTED', ?8, ?8)
     ON CONFLICT(user_id) DO UPDATE SET google_sub = excluded.google_sub, google_email = excluded.google_email,
       access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
       access_expires_at = excluded.access_expires_at, scope = excluded.scope, status = 'CONNECTED',
       updated_at = excluded.updated_at`,
  ).bind(userId, who.sub, who.email, accessEnc, refreshEnc, t.expiresAt, t.scope, now).run();
}

async function markNeedsReconnect(env: GoogleEnv, userId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE calendar_google_accounts SET status = 'NEEDS_RECONNECT', access_token_enc = NULL, access_expires_at = NULL, updated_at = ? WHERE user_id = ?",
  ).bind(Date.now(), userId).run();
}

export type AccessResult =
  | { state: "not_connected" }
  | { state: "needs_reconnect"; row: AccountRow }
  | { state: "connected"; row: AccountRow; accessToken: string };

/**
 * 유효한 액세스 토큰을 돌려준다 (C4가 구글 API를 부르기 직전에 쓴다).
 * 만료 5분 전부터 리프레시 토큰으로 재발급. 재발급이 invalid_grant이거나 저장된 리프레시 토큰을
 * 복호화할 수 없으면 NEEDS_RECONNECT로 바꾸고 액세스 토큰을 지운다. 네트워크·5xx는 GoogleError를 던진다(상태 유지).
 * force=true면 (예: 구글 API 401) 만료 전이라도 재발급한다.
 */
export async function getAccessToken(env: GoogleEnv, userId: string, force = false): Promise<AccessResult> {
  const row = await loadAccount(env, userId);
  if (!row) return { state: "not_connected" };
  if (row.status !== "CONNECTED") return { state: "needs_reconnect", row };

  if (!force && row.access_token_enc && row.access_expires_at && row.access_expires_at - Date.now() > REFRESH_MARGIN_MS) {
    try {
      const at = await decryptToken(env.GCAL_TOKEN_KEY, userId, "access", row.access_token_enc);
      return { state: "connected", row, accessToken: at };
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
      // 액세스 토큰만 망가졌으면 재발급으로 복구를 시도한다.
    }
  }

  let refresh: string;
  try {
    refresh = await decryptToken(env.GCAL_TOKEN_KEY, userId, "refresh", row.refresh_token_enc);
  } catch (e) {
    if (!(e instanceof CryptoError)) throw e;
    console.log("[calendar/google] refresh token undecryptable → NEEDS_RECONNECT user=" + userId);
    await markNeedsReconnect(env, userId);
    return { state: "needs_reconnect", row: { ...row, status: "NEEDS_RECONNECT", access_token_enc: null } };
  }

  let t: ExchangedTokens;
  try {
    t = await refreshTokens(env, refresh);
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "invalid_grant") {
      console.log("[calendar/google] refresh invalid_grant → NEEDS_RECONNECT user=" + userId);
      await markNeedsReconnect(env, userId);
      return { state: "needs_reconnect", row: { ...row, status: "NEEDS_RECONNECT", access_token_enc: null } };
    }
    throw e;
  }

  const now = Date.now();
  const accessEnc = await encryptToken(env.GCAL_TOKEN_KEY, userId, "access", t.accessToken);
  const refreshEnc = t.refreshToken ? await encryptToken(env.GCAL_TOKEN_KEY, userId, "refresh", t.refreshToken) : row.refresh_token_enc;
  const scope = t.scope || row.scope;
  // 동시에 두 요청이 재발급해도 둘 다 유효하다 — 잠금 없이 나중 값이 남는다 (계획 2.5).
  await env.DB.prepare(
    "UPDATE calendar_google_accounts SET access_token_enc = ?1, access_expires_at = ?2, refresh_token_enc = ?3, scope = ?4, updated_at = ?5 " +
      "WHERE user_id = ?6 AND status = 'CONNECTED'",
  ).bind(accessEnc, t.expiresAt, refreshEnc, scope, now, userId).run();
  return {
    state: "connected",
    row: { ...row, access_token_enc: accessEnc, access_expires_at: t.expiresAt, refresh_token_enc: refreshEnc, scope, updated_at: now },
    accessToken: t.accessToken,
  };
}

/** 연결 해제: 구글에 폐기 요청(실패해도 계속) → 행·진행 중 state 삭제. 폐기 성공 여부를 돌려준다. */
export async function disconnect(env: GoogleEnv, userId: string): Promise<{ existed: boolean; revoked: boolean }> {
  const row = await loadAccount(env, userId);
  let revoked = false;
  if (row) {
    // 리프레시 토큰 폐기가 그 권한 부여 전체를 끊는다. 복호화가 안 되면 액세스 토큰으로라도 시도한다.
    let token: string | null = null;
    try {
      token = await decryptToken(env.GCAL_TOKEN_KEY, userId, "refresh", row.refresh_token_enc);
    } catch {
      try {
        token = row.access_token_enc ? await decryptToken(env.GCAL_TOKEN_KEY, userId, "access", row.access_token_enc) : null;
      } catch {
        token = null;
      }
    }
    if (token) revoked = await revokeToken(env, token);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calendar_google_accounts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM calendar_oauth_states WHERE user_id = ?").bind(userId),
  ]);
  return { existed: !!row, revoked };
}

/** 'hr.jhkang@gmail.com' → 'hr****@gmail.com' */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "****";
  const local = email.slice(0, at);
  return local.slice(0, Math.min(2, local.length)) + "****" + email.slice(at);
}
