// Plaud 연동 (2026-11-19): Plaud MCP OAuth 2.1 (PKCE S256, 동적 등록된 공개 클라이언트) + 사용자별 토큰 저장.
// 구글 캘린더(src/calendar/google-oauth.ts)와 같은 패턴. 토큰·인가 코드는 로그·응답에 절대 넣지 않는다.
// - authorize https://mcp.plaud.ai/authorize · token https://mcp.plaud.ai/token · resource https://mcp.plaud.ai/mcp
// - 클라이언트는 DCR(RFC 7591)로 등록한 공개 클라이언트(token_endpoint_auth_method=none). client_id는 비밀이 아니라
//   wrangler.toml [vars] PLAUD_CLIENT_ID. 서버가 시크릿을 요구하는 클라이언트로 바꿀 때만 PLAUD_CLIENT_SECRET(시크릿)을 쓴다.
import { b64urlEncode, CryptoError, decryptToken, encryptToken, tokenKeyValid } from "../calendar/crypto";

export type PlaudEnv = {
  DB: D1Database;
  PLAUD_CLIENT_ID?: string;
  PLAUD_CLIENT_SECRET?: string;
  /** 토큰 암호화 키 — 구글 캘린더와 같은 시크릿(32바이트 base64)을 쓴다. 용도(AAD)가 달라 서로 호환되지 않는다. */
  GCAL_TOKEN_KEY?: string;
  /** 로컬 검증 전용 모의 서버 (http://localhost|127.0.0.1:<포트>). 그 밖의 값은 무시한다. */
  PLAUD_DEV_ORIGIN?: string;
};

const PLAUD_ORIGIN = "https://mcp.plaud.ai";
export const PLAUD_RESOURCE = "https://mcp.plaud.ai/mcp";
export const CALLBACK_PATH = "/api/plaud/callback";
const REDIRECT_ALLOWLIST = [
  "https://peopleos.site/api/plaud/callback",
  "https://www.peopleos.site/api/plaud/callback",
  "https://people-os.workspace-easyware.workers.dev/api/plaud/callback",
];
export const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;

export class PlaudError extends Error {
  /** invalid_grant = 재연결 필요(연결 해제 상태로 돌린다), http/network/bad_response = 일시 오류 또는 설정 문제 */
  constructor(public kind: "invalid_grant" | "http" | "network" | "bad_response", public code: string) {
    super(`plaud ${kind}: ${code}`);
  }
}

export function devOrigin(env: PlaudEnv): string | null {
  const v = env.PLAUD_DEV_ORIGIN;
  return v && DEV_ORIGIN_RE.test(v) ? v : null;
}
export function plaudBase(env: PlaudEnv): string {
  return devOrigin(env) ?? PLAUD_ORIGIN;
}

/** client_id와 토큰 키가 모두 있을 때만 true (fail-closed → 503). */
export function plaudConfigured(env: PlaudEnv): boolean {
  return !!env.PLAUD_CLIENT_ID && tokenKeyValid(env.GCAL_TOKEN_KEY);
}

export function redirectAllowed(env: PlaudEnv, uri: string): boolean {
  if (REDIRECT_ALLOWLIST.includes(uri)) return true;
  if (devOrigin(env)) return /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/api\/plaud\/callback$/.test(uri);
  return false;
}
export function redirectUriFor(env: PlaudEnv, requestUrl: string): string | null {
  try {
    const uri = new URL(requestUrl).origin + CALLBACK_PATH;
    return redirectAllowed(env, uri) ? uri : null;
  } catch {
    return null;
  }
}

export function randomUrlToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(d));
}

export function buildAuthUrl(env: PlaudEnv, p: { redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.PLAUD_CLIENT_ID || "",
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    resource: PLAUD_RESOURCE,
  });
  return `${plaudBase(env)}/authorize?${q.toString()}`;
}

// ---- 토큰 엔드포인트 ----

type TokenResponse = { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
export type Tokens = { accessToken: string; expiresAt: number; refreshToken: string | null };

async function postForm(env: PlaudEnv, form: Record<string, string>): Promise<{ status: number; json: TokenResponse | null }> {
  const body: Record<string, string> = { ...form, client_id: env.PLAUD_CLIENT_ID || "", resource: PLAUD_RESOURCE };
  if (env.PLAUD_CLIENT_SECRET) body.client_secret = env.PLAUD_CLIENT_SECRET;
  let res: Response;
  try {
    res = await fetch(`${plaudBase(env)}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new PlaudError("network", "fetch_failed");
  }
  let json: TokenResponse | null = null;
  try { json = (await res.json()) as TokenResponse; } catch { json = null; }
  return { status: res.status, json };
}

function readTokens(status: number, json: TokenResponse | null): Tokens {
  if (status !== 200) {
    const code = json && typeof json.error === "string" ? json.error.slice(0, 64) : `http_${status}`;
    throw new PlaudError(code === "invalid_grant" ? "invalid_grant" : "http", code);
  }
  if (!json || typeof json.access_token !== "string" || !json.access_token) throw new PlaudError("bad_response", "no_access_token");
  const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + ttl * 1000,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
  };
}

export async function exchangeCode(env: PlaudEnv, p: { code: string; redirectUri: string; verifier: string }): Promise<Tokens> {
  const { status, json } = await postForm(env, {
    grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier,
  });
  return readTokens(status, json);
}

async function refreshTokens(env: PlaudEnv, refreshToken: string): Promise<Tokens> {
  const { status, json } = await postForm(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  return readTokens(status, json);
}

// ---- D1 (계정 행) ----

export type AccountRow = {
  user_id: string; plaud_email: string | null; access_token_enc: string | null; refresh_token_enc: string | null;
  access_expires_at: number | null; created_at: number; updated_at: number;
};

export async function loadAccount(env: PlaudEnv, userId: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    "SELECT user_id, plaud_email, access_token_enc, refresh_token_enc, access_expires_at, created_at, updated_at FROM plaud_accounts WHERE user_id = ?",
  ).bind(userId).first<AccountRow>();
}

export async function saveConnection(env: PlaudEnv, userId: string, t: Tokens, email: string | null): Promise<void> {
  const now = Date.now();
  const accessEnc = await encryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-access", t.accessToken);
  const refreshEnc = t.refreshToken ? await encryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-refresh", t.refreshToken) : null;
  await env.DB.prepare(
    `INSERT INTO plaud_accounts (user_id, plaud_email, access_token_enc, refresh_token_enc, access_expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(user_id) DO UPDATE SET plaud_email = excluded.plaud_email, access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc, access_expires_at = excluded.access_expires_at, updated_at = excluded.updated_at`,
  ).bind(userId, email, accessEnc, refreshEnc, t.expiresAt, now).run();
}

export async function setEmail(env: PlaudEnv, userId: string, email: string | null): Promise<void> {
  await env.DB.prepare("UPDATE plaud_accounts SET plaud_email = ?, updated_at = ? WHERE user_id = ?").bind(email, Date.now(), userId).run();
}

/** 진단용(임시): Plaud workspace id 저장. */
export async function setWorkspaceId(env: PlaudEnv, userId: string, ws: string | null): Promise<void> {
  await env.DB.prepare("UPDATE plaud_accounts SET workspace_id = ? WHERE user_id = ?").bind(ws, userId).run();
}

/** 진단용(임시): get_current_user 응답에서 workspace를 가리키는 필드를 찾는다. 없으면 null. */
export function pickWorkspaceId(u: unknown): string | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  for (const k of ["workspace_id", "workspaceId", "ws_id", "wsId", "current_workspace_id", "default_workspace_id"]) {
    const x = o[k];
    if (typeof x === "string" && x) return x.slice(0, 128);
  }
  const w = o.workspace;
  if (w && typeof w === "object") {
    const id = (w as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id.slice(0, 128);
  }
  return null;
}

/** 연결 해제: 계정 행·진행 중 state 삭제. (Plaud는 폐기 엔드포인트를 알리지 않아 서버 쪽 폐기는 하지 않는다.) */
export async function disconnect(env: PlaudEnv, userId: string): Promise<{ existed: boolean }> {
  const row = await loadAccount(env, userId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plaud_accounts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM plaud_oauth_states WHERE user_id = ?").bind(userId),
  ]);
  return { existed: !!row };
}

export type AccessResult =
  | { state: "not_connected"; expired?: boolean }
  | { state: "connected"; row: AccountRow; accessToken: string };

/**
 * 유효한 액세스 토큰. 만료 2분 전부터 refresh_token으로 갱신한다. 갱신이 invalid_grant이거나 토큰을 복호화할 수 없거나
 * refresh_token이 없는데 만료됐으면 **연결 해제 상태로 돌린다**(행 삭제, expired:true). 네트워크·5xx는 PlaudError(상태 유지).
 * force=true면 (예: MCP 401) 만료 전이라도 갱신한다.
 */
export async function getAccessToken(env: PlaudEnv, userId: string, force = false): Promise<AccessResult> {
  const row = await loadAccount(env, userId);
  if (!row) return { state: "not_connected" };

  if (!force && row.access_token_enc && row.access_expires_at && row.access_expires_at - Date.now() > REFRESH_MARGIN_MS) {
    try {
      return { state: "connected", row, accessToken: await decryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-access", row.access_token_enc) };
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
    }
  }

  const expire = async (why: string): Promise<AccessResult> => {
    console.log(`[plaud] ${why} → disconnected user=${userId}`);
    await disconnect(env, userId);
    return { state: "not_connected", expired: true };
  };
  if (!row.refresh_token_enc) return expire("no refresh token");
  let refresh: string;
  try {
    refresh = await decryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-refresh", row.refresh_token_enc);
  } catch (e) {
    if (!(e instanceof CryptoError)) throw e;
    return expire("refresh token undecryptable");
  }
  let t: Tokens;
  try {
    t = await refreshTokens(env, refresh);
  } catch (e) {
    if (e instanceof PlaudError && e.kind === "invalid_grant") return expire("refresh invalid_grant");
    throw e;
  }
  const now = Date.now();
  const accessEnc = await encryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-access", t.accessToken);
  const refreshEnc = t.refreshToken ? await encryptToken(env.GCAL_TOKEN_KEY, userId, "plaud-refresh", t.refreshToken) : row.refresh_token_enc;
  await env.DB.prepare(
    "UPDATE plaud_accounts SET access_token_enc = ?1, access_expires_at = ?2, refresh_token_enc = ?3, updated_at = ?4 WHERE user_id = ?5",
  ).bind(accessEnc, t.expiresAt, refreshEnc, now, userId).run();
  return { state: "connected", row: { ...row, access_token_enc: accessEnc, access_expires_at: t.expiresAt, refresh_token_enc: refreshEnc, updated_at: now }, accessToken: t.accessToken };
}

/** 'hr.jhkang@gmail.com' → 'hr****@gmail.com' */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "****";
  return email.slice(0, Math.min(2, at)) + "****" + email.slice(at);
}
