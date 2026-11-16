// 로그인·세션·역할 (2026-11-15) — Talent Navigator(Worker) 뼈대 + 일잇(이메일·페퍼·설정 링크) 참고.
// 역할: 'hr_admin'(인사팀 관리자: 관측·평가 + 사용자 계정 관리) / 'user'(일반 사용자).
// 비밀번호: PBKDF2-SHA256 10만 회 + PASSWORD_PEPPER HMAC (일잇 방식). 토큰은 SHA-256 해시만 D1에 저장.
// 세션 쿠키: HttpOnly · Secure · SameSite=Strict, 7일 (일잇과 동일).

export type UserRole = "hr_admin" | "user";
/** 코칭 역할 (migration 0018). role(관리자 권한)과 직교한다. */
export type CoachingRole = "coach" | "coachee";

export function normalizeCoachingRole(v: unknown): CoachingRole {
  return v === "coach" ? "coach" : "coachee";
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  coaching_role: CoachingRole;
};

/** auth가 쓰는 바인딩. index.ts의 Env는 이를 포함한다(구조적 타이핑). */
export type AuthEnv = {
  DB: D1Database;
  ADMIN_SECRET?: string;
  /** 비밀번호 해시용 페퍼. 미설정 시 비밀번호 연산은 실패한다 (fail-closed). */
  PASSWORD_PEPPER?: string;
  /** 최초 HR admin 생성용. 미설정 시 부트스트랩은 거부된다 (fail-closed). */
  BOOTSTRAP_SECRET?: string;
};

export const SESSION_COOKIE = "people_os_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일
const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24시간
const LOGIN_MAX_FAILURES = 8; // Talent Navigator와 동일 (15분 창)
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const enc = new TextEncoder();

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** 상수 시간 비교 (타이밍 공격 방지). 길이가 다르면 즉시 false. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** X-Admin-Secret 상수 시간 비교 (미설정이면 항상 거부 — fail-closed). */
export function secretMatches(secret: string | undefined, given: string | undefined | null): boolean {
  if (!secret || !given) return false;
  return timingSafeEqual(secret, given);
}

/** index.ts adminAllowed와 같은 규칙. obs 라우트(routes-datasets)가 import한다. */
export function adminAllowed(env: Pick<AuthEnv, "ADMIN_SECRET">, given: string | undefined | null): boolean {
  return secretMatches(env.ADMIN_SECRET, given);
}

/** 비밀번호 해시: PBKDF2-SHA256 10만 회(256bit) 후 PASSWORD_PEPPER로 HMAC. 페퍼 미설정 시 throw. */
export async function hashPassword(password: string, salt: string, pepper: string | undefined): Promise<string> {
  if (!pepper) throw new Error("로그인 설정이 준비되지 않았습니다.");
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 },
    key,
    256,
  );
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, bits);
  return Array.from(new Uint8Array(sig))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function passwordOk(p: unknown): p is string {
  return typeof p === "string" && p.length >= 12 && p.length <= 128;
}

function cookieValue(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return cookieValue("", 0);
}

function sessionTokenFromCookie(cookieHeader: string | undefined | null): string {
  if (!cookieHeader) return "";
  const part = cookieHeader
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(SESSION_COOKIE + "="));
  return part ? part.slice(SESSION_COOKIE.length + 1) : "";
}

/** 세션 쿠키로 로그인 사용자를 찾는다. 만료·비활성 계정은 null. */
export async function getSessionUser(
  env: Pick<AuthEnv, "DB">,
  cookieHeader: string | undefined | null,
): Promise<SessionUser | null> {
  const token = sessionTokenFromCookie(cookieHeader);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.name, u.role, u.coaching_role FROM auth_sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
  )
    .bind(await sha256hex(token), Date.now())
    .first<{ id: string; email: string; name: string; role: string; coaching_role: string | null }>();
  if (!row || (row.role !== "hr_admin" && row.role !== "user")) return null;
  return {
    id: row.id, email: row.email, name: row.name, role: row.role as UserRole,
    coaching_role: normalizeCoachingRole(row.coaching_role),
  };
}

/** 세션을 만들고 쿠키 문자열을 돌려준다. */
export async function createSession(env: Pick<AuthEnv, "DB">, userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)")
    .bind(await sha256hex(token), userId, Date.now() + SESSION_TTL_MS)
    .run();
  return cookieValue(token, Math.floor(SESSION_TTL_MS / 1000));
}

/** 해당 사용자의 세션을 전부 무효화한다 (비밀번호 변경·초기화 시). */
export async function revokeSessions(env: Pick<AuthEnv, "DB">, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(userId).run();
}

/**
 * HR admin 요청인지 확인한다 — 이중 게이트.
 * (1) 유효한 hr_admin 세션, 또는 (2) X-Admin-Secret ↔ ADMIN_SECRET.
 * (2)는 기존 운영 경로(평가 실행기·수동 API 호출)가 그대로 동작하게 유지한다.
 */
export async function isAdminRequest(
  env: Pick<AuthEnv, "DB" | "ADMIN_SECRET">,
  cookieHeader: string | undefined | null,
  secretHeader: string | undefined | null,
): Promise<boolean> {
  if (secretMatches(env.ADMIN_SECRET, secretHeader)) return true;
  const user = await getSessionUser(env, cookieHeader);
  return user !== null && user.role === "hr_admin";
}

/** 로그인 시도 제한 키: 이메일 + IP 해시 (Talent Navigator 방식). */
export async function loginAttemptKey(email: string, ip: string | undefined): Promise<string> {
  return sha256hex(email + "|" + (ip || "unknown"));
}

export async function loginBlocked(env: Pick<AuthEnv, "DB">, key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT failures, expires_at FROM login_attempts WHERE key = ? AND expires_at > ?")
    .bind(key, Date.now())
    .first<{ failures: number; expires_at: number }>();
  return !!row && row.failures >= LOGIN_MAX_FAILURES;
}

export async function recordLoginFailure(env: Pick<AuthEnv, "DB">, key: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO login_attempts(key, failures, expires_at) VALUES(?, 1, ?) " +
      "ON CONFLICT(key) DO UPDATE SET failures = CASE WHEN expires_at < ? THEN 1 ELSE failures + 1 END, " +
      "expires_at = CASE WHEN expires_at < ? THEN excluded.expires_at ELSE expires_at END",
  )
    .bind(key, now + LOGIN_WINDOW_MS, now, now)
    .run();
}

export async function clearLoginFailures(env: Pick<AuthEnv, "DB">, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

/** 비밀번호 설정 링크를 만든다 (1회용, 24시간). 미사용 기존 링크는 지운다. */
export async function issueSetupLink(
  env: Pick<AuthEnv, "DB">,
  userId: string,
  issuedBy: string,
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM password_links WHERE user_id = ? AND used_at IS NULL").bind(userId),
    env.DB.prepare(
      "INSERT INTO password_links(token_hash, user_id, expires_at, issued_by, created_at) VALUES(?, ?, ?, ?, ?)",
    ).bind(await sha256hex(token), userId, now + SETUP_LINK_TTL_MS, issuedBy, now),
  ]);
  return "/#setup=" + token;
}
