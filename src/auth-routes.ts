// 인증 API (2026-11-15) — Talent Navigator(부트스트랩·역할·계정 관리) + 일잇(이메일·페퍼·설정 링크) 참고.
// index.ts에서 "/api"에 mount한다. 경로는 mount 기준 상대 경로.
// - POST /bootstrap — 최초 HR admin 생성 (BOOTSTRAP_SECRET, 사용자 0명일 때만 1회)
// - POST /auth/login · /auth/logout · GET /auth/me
// - POST /auth/set-password — 설정 링크(1회용·24시간)로 비밀번호 설정 + 계정 활성화
// - POST /auth/issue-link — hr_admin이 구성원에게 설정 링크 발급
// - POST /auth/change-password — 본인 비밀번호 변경 (현재 비밀번호 확인, 타 세션 무효화)
// - GET/POST /admin/users · PATCH /admin/users/:id · POST /admin/users/:id/reset — hr_admin 계정 관리
// 하드코드 기본 비밀번호는 쓰지 않는다 (일잇 resetPassword의 'ileet-work-skills' 방식은 제외).
// 비밀번호 초기화는 설정 링크 재발급으로만 한다.
import { Hono } from "hono";
import type { Context } from "hono";
import {
  clearLoginFailures,
  clearSessionCookie,
  createSession,
  getSessionUser,
  hashPassword,
  isAdminRequest,
  issueSetupLink,
  loginAttemptKey,
  loginBlocked,
  passwordOk,
  randomToken,
  recordLoginFailure,
  revokeSessions,
  sha256hex,
  timingSafeEqual,
  type AuthEnv,
  type SessionUser,
} from "./auth";

export const authApp = new Hono<{ Bindings: AuthEnv }>();

type C = Context<{ Bindings: AuthEnv }>;

function fail(c: C, status: number, error: string) {
  return c.json({ ok: false, error }, status as 400);
}

async function readJson(c: C): Promise<Record<string, unknown>> {
  try {
    const text = await c.req.text();
    if (text.length > 8192) return {};
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 상태 변경 POST의 Origin 검사 (SameSite=Strict 쿠키와 함께 CSRF를 막는다). */
function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

function publicUser(u: { id: string; email: string; name: string; role: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

/** hr_admin 세션 사용자. 시크릿 경로(X-Admin-Secret)는 사용자가 없어 null을 돌려준다. */
async function adminUser(c: C): Promise<SessionUser | null> {
  return getSessionUser(c.env, c.req.header("cookie"));
}

async function requireAdmin(c: C): Promise<SessionUser | "secret" | null> {
  const u = await adminUser(c);
  if (u && u.role === "hr_admin") return u;
  if (await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret"))) return "secret";
  return null;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

// ---- 부트스트랩: 최초 HR admin 1회 생성 ---------------------------------------

authApp.post("/bootstrap", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const body = await readJson(c);
  const secret = typeof body.secret === "string" ? body.secret : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!c.env.BOOTSTRAP_SECRET || secret !== c.env.BOOTSTRAP_SECRET) return fail(c, 403, "초기 설정 정보를 확인해 주세요.");
  if (!isValidEmail(email) || !name || name.length > 100 || !passwordOk(password)) {
    return fail(c, 400, "이메일·이름·비밀번호(12~128자)를 확인해 주세요.");
  }
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) return fail(c, 409, "이미 관리자가 있습니다.");
  const salt = randomToken();
  const digest = await hashPassword(password, salt, c.env.PASSWORD_PEPPER);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users(id, email, name, password_hash, password_salt, role, status, created_at) VALUES(?, ?, ?, ?, ?, 'hr_admin', 'active', ?)",
  )
    .bind(id, email, name, digest, salt, new Date().toISOString())
    .run();
  return c.json({ ok: true, user: { id, email, name, role: "hr_admin" } }, 201, {
    "set-cookie": await createSession(c.env, id),
    "cache-control": "no-store",
  });
});

// ---- 로그인·로그아웃·내 정보 --------------------------------------------------

authApp.post("/auth/login", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const body = await readJson(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || password.length > 128) return fail(c, 401, "이메일 또는 비밀번호를 확인해 주세요.");
  const key = await loginAttemptKey(email, c.req.header("cf-connecting-ip"));
  if (await loginBlocked(c.env, key)) return fail(c, 429, "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.");
  const account = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<{
    id: string; email: string; name: string; password_hash: string | null; password_salt: string | null; role: string; status: string;
  }>();
  let digest = "";
  try {
    digest = await hashPassword(password, account?.password_salt || "invalid-account-salt", c.env.PASSWORD_PEPPER);
  } catch {
    return fail(c, 503, "로그인 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.");
  }
  if (
    !account || account.status !== "active" || !account.password_hash ||
    !timingSafeEqual(digest, account.password_hash)
  ) {
    await recordLoginFailure(c.env, key);
    return fail(c, 401, "이메일 또는 비밀번호를 확인해 주세요. 처음 접속한다면 관리자에게 비밀번호 설정 링크를 요청하세요.");
  }
  await clearLoginFailures(c.env, key);
  return c.json({ ok: true, user: publicUser(account) }, 200, {
    "set-cookie": await createSession(c.env, account.id),
    "cache-control": "no-store",
  });
});

authApp.post("/auth/logout", async (c) => {
  const user = await getSessionUser(c.env, c.req.header("cookie"));
  if (user) {
    const token = (c.req.header("cookie") || "").match(/(?:^|;\s*)people_os_session=([a-f0-9]+)/)?.[1];
    if (token) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
  }
  return c.json({ ok: true }, 200, { "set-cookie": clearSessionCookie(), "cache-control": "no-store" });
});

authApp.get("/auth/me", async (c) => {
  const user = await getSessionUser(c.env, c.req.header("cookie"));
  if (!user) return fail(c, 401, "로그인이 필요합니다.");
  return c.json({ ok: true, user }, 200, { "cache-control": "no-store" });
});

// ---- 비밀번호 설정 링크 -------------------------------------------------------

authApp.post("/auth/set-password", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const body = await readJson(c);
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!passwordOk(password)) return fail(c, 400, "비밀번호는 12~128자로 입력하세요.");
  const link = await c.env.DB.prepare(
    "SELECT * FROM password_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256hex(token), Date.now())
    .first<{ token_hash: string; user_id: string }>();
  if (!link) return fail(c, 400, "만료되었거나 이미 사용한 설정 링크입니다. 관리자에게 새 링크를 요청하세요.");
  const account = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(link.user_id).first<{
    id: string; email: string; name: string; role: string; status: string;
  }>();
  if (!account || account.status === "inactive") return fail(c, 403, "이용할 수 없는 계정입니다.");
  const salt = randomToken();
  let digest: string;
  try {
    digest = await hashPassword(password, salt, c.env.PASSWORD_PEPPER);
  } catch {
    return fail(c, 503, "로그인 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.");
  }
  const usedAt = Date.now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE password_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .bind(usedAt, link.token_hash, Date.now()),
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, status = 'active' WHERE id = ? AND EXISTS (SELECT 1 FROM password_links WHERE token_hash = ? AND used_at = ?)",
    ).bind(digest, salt, link.user_id, link.token_hash, usedAt),
    c.env.DB.prepare(
      "DELETE FROM auth_sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM password_links WHERE token_hash = ? AND used_at = ?)",
    ).bind(link.user_id, link.token_hash, usedAt),
  ]);
  if (result[0].meta.changes !== 1) return fail(c, 400, "이미 사용된 설정 링크입니다.");
  return c.json({ ok: true, user: publicUser(account) }, 200, {
    "set-cookie": await createSession(c.env, link.user_id),
    "cache-control": "no-store",
  });
});

authApp.post("/auth/issue-link", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const admin = await requireAdmin(c);
  if (!admin) return fail(c, 401, "로그인이 필요합니다.");
  const body = await readJson(c);
  const userId = typeof body.userId === "string" ? body.userId : "";
  const target = await c.env.DB.prepare("SELECT id, email, status FROM users WHERE id = ?").bind(userId).first<{
    id: string; email: string; status: string;
  }>();
  if (!target) return fail(c, 404, "계정을 찾을 수 없습니다.");
  if (target.status === "inactive") return fail(c, 403, "비활성 계정은 설정 링크를 발급할 수 없습니다.");
  const issuedBy = admin === "secret" ? "admin-secret" : admin.id;
  const setupPath = await issueSetupLink(c.env, target.id, issuedBy);
  return c.json({ ok: true, setupPath }, 200, { "cache-control": "no-store" });
});

authApp.post("/auth/change-password", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const user = await getSessionUser(c.env, c.req.header("cookie"));
  if (!user) return fail(c, 401, "로그인이 필요합니다.");
  const body = await readJson(c);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!passwordOk(next)) return fail(c, 400, "새 비밀번호는 12~128자로 입력하세요.");
  if (!current || current.length > 128) return fail(c, 401, "현재 비밀번호를 확인하세요.");
  const account = await c.env.DB.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").bind(user.id).first<{
    password_hash: string | null; password_salt: string | null;
  }>();
  let currentDigest = "";
  try {
    currentDigest = await hashPassword(current, account?.password_salt || "invalid-account-salt", c.env.PASSWORD_PEPPER);
  } catch {
    return fail(c, 503, "로그인 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.");
  }
  if (!account || !account.password_hash || !timingSafeEqual(currentDigest, account.password_hash)) {
    return fail(c, 401, "현재 비밀번호가 올바르지 않습니다.");
  }
  if (current === next) return fail(c, 400, "현재 비밀번호와 다른 새 비밀번호를 입력하세요.");
  const salt = randomToken();
  const digest = await hashPassword(next, salt, c.env.PASSWORD_PEPPER);
  const result = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ? AND password_hash = ? AND status = 'active'")
      .bind(digest, salt, user.id, account.password_hash),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(user.id),
  ]);
  if (result[0].meta.changes !== 1) return fail(c, 409, "계정 상태가 변경되었습니다. 다시 로그인하여 시도하세요.");
  return c.json({ ok: true }, 200, {
    "set-cookie": await createSession(c.env, user.id),
    "cache-control": "no-store",
  });
});

// ---- HR admin 계정 관리 -------------------------------------------------------

authApp.get("/admin/users", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return fail(c, 401, "로그인이 필요합니다.");
  const rows = await c.env.DB.prepare(
    "SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at, email",
  ).all<{ id: string; email: string; name: string; role: string; status: string; created_at: string }>();
  return c.json({ ok: true, users: rows.results }, 200, { "cache-control": "no-store" });
});

authApp.post("/admin/users", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const admin = await requireAdmin(c);
  if (!admin) return fail(c, 401, "로그인이 필요합니다.");
  const body = await readJson(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = body.role === "hr_admin" ? "hr_admin" : "user";
  if (!isValidEmail(email) || !name || name.length > 100) return fail(c, 400, "이메일·이름을 확인해 주세요.");
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return fail(c, 409, "이미 등록된 이메일입니다.");
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users(id, email, name, role, status, created_at) VALUES(?, ?, ?, ?, 'pending', ?)",
  )
    .bind(id, email, name, role, new Date().toISOString())
    .run();
  const issuedBy = admin === "secret" ? "admin-secret" : admin.id;
  const setupPath = await issueSetupLink(c.env, id, issuedBy);
  return c.json({ ok: true, user: { id, email, name, role, status: "pending" }, setupPath }, 201, {
    "cache-control": "no-store",
  });
});

authApp.patch("/admin/users/:id", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const admin = await requireAdmin(c);
  if (!admin) return fail(c, 401, "로그인이 필요합니다.");
  const id = c.req.param("id");
  const body = await readJson(c);
  const target = await c.env.DB.prepare("SELECT id, role, status FROM users WHERE id = ?").bind(id).first<{
    id: string; role: string; status: string;
  }>();
  if (!target) return fail(c, 404, "계정을 찾을 수 없습니다.");
  if (admin !== "secret" && admin.id === id) return fail(c, 403, "자기 계정의 역할·상태는 바꿀 수 없습니다.");
  const role = body.role === "hr_admin" || body.role === "user" ? body.role : target.role;
  const status = body.status === "active" || body.status === "inactive" || body.status === "pending" ? body.status : target.status;
  await c.env.DB.prepare("UPDATE users SET role = ?, status = ? WHERE id = ?").bind(role, status, id).run();
  if (status === "inactive") await revokeSessions(c.env, id);
  return c.json({ ok: true, user: { id, role, status } }, 200, { "cache-control": "no-store" });
});

authApp.post("/admin/users/:id/reset", async (c) => {
  if (!originOk(c)) return fail(c, 403, "허용되지 않는 요청입니다.");
  const admin = await requireAdmin(c);
  if (!admin) return fail(c, 401, "로그인이 필요합니다.");
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id, status FROM users WHERE id = ?").bind(id).first<{
    id: string; status: string;
  }>();
  if (!target) return fail(c, 404, "계정을 찾을 수 없습니다.");
  if (target.status === "inactive") return fail(c, 403, "비활성 계정은 초기화할 수 없습니다.");
  await revokeSessions(c.env, id);
  const issuedBy = admin === "secret" ? "admin-secret" : admin.id;
  const setupPath = await issueSetupLink(c.env, id, issuedBy);
  return c.json({ ok: true, setupPath }, 200, { "cache-control": "no-store" });
});
