// 캘린더 API C1 (2026-11-17). index.ts에서 "/api/calendar"에 mount한다 (경로는 mount 기준 상대).
// 전부 로그인 필수 (익명 401). 세션 쿠키만 본다 — isAdminRequest를 쓰지 않으므로 X-Admin-Secret만으로는 401.
//   GET    /events?from=&to=   기간(최대 62일) 안의 내 개인 + 팀 일정 (source:'local', editable, owner_name)
//   POST   /events             만들기 (owner_id는 세션)
//   GET    /events/:id         상세
//   PATCH  /events/:id         수정 (version 불일치 409)
//   DELETE /events/:id         소프트 삭제
// 권한: 개인 = 소유자만 (남의 것은 404). 팀 = 읽기·만들기 전원, 수정·삭제는 작성자 또는 hr_admin 세션.
// 스키마 누락(migration 0025 미적용)은 503.
//
// 구글 연결 C3 (2026-11-17, migration 0026) — 1단계 읽기 전용. 계획서 2장. 세션만 인정(X-Admin-Secret만으로는 401).
//   POST /google/connect     세션 + originOk. state(sha256만 저장, 1회용·10분·사용자 결합) + PKCE → { url }
//   GET  /google/callback    세션 확인 안 함 (SameSite=Strict 쿠키가 구글→콜백 이동에 안 실린다).
//                            code·state를 서버에서 읽지 않고, 최소 HTML이 같은 출처 fetch로 /google/complete를 부른다.
//   POST /google/complete    세션 + originOk. state 검증 → code 교환 → 토큰 암호화 저장
//   GET  /google/status      세션. connected / needs_reconnect / not_connected + 마스킹 이메일·스코프
//   POST /google/disconnect  세션 + originOk. 구글 폐기 + 행 삭제
// 구글 일정 읽기 C4 (복사 없음 — D1에 저장하지 않는다):
//   GET  /google/events?from=&to=  세션. 기간 규칙은 /events와 같다(최대 62일). 연결 안 됨 409 NOT_CONNECTED,
//                            NEEDS_RECONNECT면 200 + 빈 목록 + status, 구글 오류 502 + google_error.
//   PATCH/PUT/DELETE /events/g:<id>  403 (구글 일정은 읽기 전용)
// 시크릿(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET·GCAL_TOKEN_KEY) 중 하나라도 없으면 /google/*는 503 (fail-closed).
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, sha256hex, type SessionUser } from "../auth";
import { uid } from "../lib";
import { decryptToken, encryptToken } from "./crypto";
import { readGoogleEvents } from "./google-events";
import {
  buildAuthUrl, disconnect, exchangeCode, getAccessToken, GoogleError, googleConfigured, maskEmail, pkceChallenge,
  randomUrlToken, readIdToken, redirectAllowed, redirectUriFor, saveConnection, scopeSufficient, STATE_TTL_MS,
  type GoogleEnv,
} from "./google-oauth";

export type CalendarEnv = GoogleEnv;

type C = Context<{ Bindings: CalendarEnv }>;
export const calendarApp = new Hono<{ Bindings: CalendarEnv }>();

const SCHEMA_MSG = "캘린더 스키마가 아직 적용되지 않았습니다 (migration 0025/0026)";
const VISIBILITIES = ["private", "team"];
const CATEGORIES = ["general", "meeting", "coaching", "training", "deadline"];
const MAX_BODY = 256 * 1024;
const MAX_RANGE_MS = 62 * 86400_000;
const MAX_EVENT_MS = 31 * 86400_000;
const KST_MS = 9 * 3600_000; // 한국은 일광절약시간이 없어 UTC+9 고정
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

class CalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 캘린더 테이블 누락만 503으로 본다. users 등 다른 누락은 진짜 오류(500). */
function isSchemaMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(m) && /calendar_/i.test(m);
}

calendarApp.onError((e, c) => {
  if (e instanceof CalError) return c.json({ ok: false, error: e.message }, e.status as 400);
  if (isSchemaMissing(e)) return c.json({ ok: false, error: SCHEMA_MSG }, 503);
  console.log("[calendar] error:", e instanceof Error ? e.stack || e.message : String(e));
  return c.json({ ok: false, error: "캘린더 처리 중 오류가 발생했습니다." }, 500);
});

/** 상태 변경 요청은 같은 출처에서만 (Origin 헤더가 있으면 일치해야 한다). */
function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

async function requireUser(c: C): Promise<SessionUser> {
  const v = await getSessionUser(c.env, c.req.header("cookie"));
  if (!v) throw new CalError(401, "로그인이 필요합니다.");
  c.header("cache-control", "no-store");
  return v;
}

async function requireWriter(c: C): Promise<SessionUser> {
  if (!originOk(c)) throw new CalError(403, "허용되지 않는 요청입니다.");
  return requireUser(c);
}

async function readJson(c: C): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new CalError(413, "요청이 너무 큽니다.");
  let v: unknown;
  try {
    v = JSON.parse(text || "{}");
  } catch {
    throw new CalError(400, "JSON 형식이 올바르지 않습니다.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CalError(400, "JSON 객체가 필요합니다.");
  return v as Record<string, unknown>;
}

// ---- 시각 ----

/** 'YYYY-MM-DDTHH:MM:SSZ' 엄격 검사. 존재하지 않는 날짜(2월 30일 등)도 거부. 통과하면 epoch ms. */
function parseUtc(v: unknown, label: string): number {
  if (typeof v !== "string" || !TIME_RE.test(v)) throw new CalError(400, `${label}는 YYYY-MM-DDTHH:MM:SSZ 형식이어야 합니다.`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== v) {
    throw new CalError(400, `${label}가 올바른 시각이 아닙니다.`);
  }
  return ms;
}

/** 종일 일정의 KST 날짜 'YYYY-MM-DD'. ms가 KST 자정이 아니면 null. */
function kstMidnightDate(ms: number): string | null {
  const k = ms + KST_MS;
  if (k % 86400_000 !== 0) return null;
  return new Date(k).toISOString().slice(0, 10);
}

// ---- 행 ----

type EventRow = {
  id: string; owner_id: string; visibility: string; title: string; description: string | null;
  location: string | null; category: string; all_day: number; start_at: string; end_at: string;
  start_date: string | null; end_date: string | null; timezone: string; rrule: string | null;
  exdates: string | null; remind_minutes: number | null; status: string; version: number;
  created_at: string; updated_at: string; owner_name?: string | null;
};

const SELECT_COLS =
  "e.id, e.owner_id, e.visibility, e.title, e.description, e.location, e.category, e.all_day, e.start_at, e.end_at, " +
  "e.start_date, e.end_date, e.timezone, e.rrule, e.exdates, e.remind_minutes, e.status, e.version, e.created_at, e.updated_at, " +
  "u.name AS owner_name";

function canEdit(v: SessionUser, r: { owner_id: string; visibility: string }): boolean {
  if (r.owner_id === v.id) return true;
  return r.visibility === "team" && v.role === "hr_admin";
}

function present(v: SessionUser, r: EventRow) {
  return {
    id: r.id, source: "local" as const, owner_id: r.owner_id, owner_name: r.owner_name ?? null,
    visibility: r.visibility, title: r.title, description: r.description, location: r.location,
    category: r.category, all_day: r.all_day === 1, start_at: r.start_at, end_at: r.end_at,
    start_date: r.start_date, end_date: r.end_date, timezone: r.timezone, rrule: r.rrule, exdates: r.exdates,
    remind_minutes: r.remind_minutes, status: r.status, version: r.version,
    created_at: r.created_at, updated_at: r.updated_at, editable: canEdit(v, r),
  };
}

/** 볼 수 있는 살아 있는 일정 한 건. 없거나 남의 개인 일정이면 null (호출자가 404). */
async function loadVisible(c: C, v: SessionUser, id: string): Promise<EventRow | null> {
  return c.env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM calendar_events e LEFT JOIN users u ON u.id = e.owner_id
     WHERE e.id = ?1 AND e.deleted_at IS NULL AND (e.owner_id = ?2 OR e.visibility = 'team')`,
  ).bind(id, v.id).first<EventRow>();
}

// ---- 입력 검증 ----

type Fields = {
  title: string; description: string | null; location: string | null; category: string; visibility: string;
  all_day: boolean; start_at: string; end_at: string; remind_minutes: number | null;
};

function optStr(v: unknown, max: number, label: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new CalError(400, `${label}는 문자열이어야 합니다.`);
  const t = v.trim();
  if (t.length > max) throw new CalError(400, `${label}는 ${max}자 이하여야 합니다.`);
  return t || null;
}

/** 합쳐진(기존 + 변경) 값을 검증하고 저장용 파생값(start_date/end_date)을 만든다. */
function validate(f: Fields): { start_date: string | null; end_date: string | null } {
  if (typeof f.title !== "string" || !f.title.trim()) throw new CalError(400, "제목을 입력하세요.");
  if (f.title.trim().length > 200) throw new CalError(400, "제목은 200자 이하여야 합니다.");
  if (!VISIBILITIES.includes(f.visibility)) throw new CalError(400, "visibility는 private 또는 team이어야 합니다.");
  if (!CATEGORIES.includes(f.category)) throw new CalError(400, `category는 ${CATEGORIES.join("/")} 중 하나여야 합니다.`);
  const s = parseUtc(f.start_at, "start_at");
  const e = parseUtc(f.end_at, "end_at");
  if (e <= s) throw new CalError(400, "end_at은 start_at보다 뒤여야 합니다.");
  if (e - s > MAX_EVENT_MS) throw new CalError(400, "일정은 최대 31일까지입니다.");
  if (f.remind_minutes !== null && (!Number.isInteger(f.remind_minutes) || f.remind_minutes < -1440 || f.remind_minutes > 40320)) {
    throw new CalError(400, "remind_minutes가 올바르지 않습니다.");
  }
  if (!f.all_day) return { start_date: null, end_date: null };
  const sd = kstMidnightDate(s);
  const ed = kstMidnightDate(e);
  if (!sd || !ed) throw new CalError(400, "종일 일정의 start_at·end_at은 KST 자정(UTC 15:00:00Z)이어야 합니다.");
  return { start_date: sd, end_date: ed };
}

function parseRemind(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number") throw new CalError(400, "remind_minutes는 정수여야 합니다.");
  return v;
}

function parseAllDay(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0) return false;
  if (v === true || v === 1) return true;
  throw new CalError(400, "all_day는 true/false여야 합니다.");
}

// ---- 라우트 ----

calendarApp.get("/events", async (c) => {
  const v = await requireUser(c);
  const from = parseUtc(c.req.query("from"), "from");
  const to = parseUtc(c.req.query("to"), "to");
  if (to <= from) throw new CalError(400, "to는 from보다 뒤여야 합니다.");
  if (to - from > MAX_RANGE_MS) throw new CalError(400, "조회 기간은 최대 62일입니다.");
  const rows = await c.env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM calendar_events e LEFT JOIN users u ON u.id = e.owner_id
     WHERE e.deleted_at IS NULL AND e.start_at < ?2 AND e.end_at > ?1
       AND (e.owner_id = ?3 OR e.visibility = 'team')
     ORDER BY e.start_at, e.id LIMIT 1000`,
  ).bind(c.req.query("from"), c.req.query("to"), v.id).all<EventRow>();
  return c.json({ ok: true, events: (rows.results || []).map((r) => present(v, r)) });
});

// 구글 일정('g:' 접두)은 읽기 전용: 수정·삭제 시도는 403 (익명은 401). 아래 PATCH/DELETE보다 먼저 등록한다.
calendarApp.on(["PATCH", "PUT", "DELETE"], "/events/:id", async (c, next) => {
  const id = c.req.param("id");
  if (id.startsWith("g:") || id.startsWith("g%3A") || id.startsWith("g%3a")) {
    await requireWriter(c);
    throw new CalError(403, "구글 일정은 읽기 전용입니다. 구글 캘린더에서 수정하세요.");
  }
  await next();
});

calendarApp.post("/events", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  if (typeof b.title !== "string") throw new CalError(400, "제목을 입력하세요.");
  const f: Fields = {
    title: b.title.trim(),
    description: optStr(b.description, 2000, "description"),
    location: optStr(b.location, 200, "location"),
    category: b.category === undefined || b.category === null ? "general" : (b.category as string),
    visibility: b.visibility === undefined || b.visibility === null ? "private" : (b.visibility as string),
    all_day: parseAllDay(b.all_day),
    start_at: b.start_at as string,
    end_at: b.end_at as string,
    remind_minutes: parseRemind(b.remind_minutes),
  };
  const d = validate(f);
  const id = uid("cal");
  await c.env.DB.prepare(
    `INSERT INTO calendar_events (id, owner_id, visibility, title, description, location, category, all_day,
       start_at, end_at, start_date, end_date, remind_minutes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(id, v.id, f.visibility, f.title, f.description, f.location, f.category, f.all_day ? 1 : 0,
    f.start_at, f.end_at, d.start_date, d.end_date, f.remind_minutes).run();
  const row = await loadVisible(c, v, id);
  return c.json({ ok: true, event: row ? present(v, row) : { id } }, 201);
});

calendarApp.get("/events/:id", async (c) => {
  const v = await requireUser(c);
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) throw new CalError(404, "일정을 찾을 수 없습니다.");
  return c.json({ ok: true, event: present(v, row) });
});

calendarApp.patch("/events/:id", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) throw new CalError(404, "일정을 찾을 수 없습니다.");
  if (!canEdit(v, row)) throw new CalError(403, "수정 권한이 없습니다.");
  if (typeof b.version !== "number" || !Number.isInteger(b.version)) throw new CalError(400, "version이 필요합니다.");
  if (b.version !== row.version) throw new CalError(409, "다른 곳에서 먼저 수정되었습니다. 새로 고친 뒤 다시 시도하세요.");
  // 공개 범위 변경은 작성자만 (hr_admin이 남의 팀 일정을 개인 일정으로 바꿔 숨기는 일을 막는다).
  if (b.visibility !== undefined && b.visibility !== row.visibility && row.owner_id !== v.id) {
    throw new CalError(403, "공개 범위는 작성자만 바꿀 수 있습니다.");
  }
  const f: Fields = {
    title: b.title !== undefined ? (typeof b.title === "string" ? b.title.trim() : (b.title as string)) : row.title,
    description: b.description !== undefined ? optStr(b.description, 2000, "description") : row.description,
    location: b.location !== undefined ? optStr(b.location, 200, "location") : row.location,
    category: b.category !== undefined ? (b.category as string) : row.category,
    visibility: b.visibility !== undefined ? (b.visibility as string) : row.visibility,
    all_day: b.all_day !== undefined ? parseAllDay(b.all_day) : row.all_day === 1,
    start_at: b.start_at !== undefined ? (b.start_at as string) : row.start_at,
    end_at: b.end_at !== undefined ? (b.end_at as string) : row.end_at,
    remind_minutes: b.remind_minutes !== undefined ? parseRemind(b.remind_minutes) : row.remind_minutes,
  };
  const d = validate(f);
  const res = await c.env.DB.prepare(
    `UPDATE calendar_events SET visibility = ?1, title = ?2, description = ?3, location = ?4, category = ?5,
       all_day = ?6, start_at = ?7, end_at = ?8, start_date = ?9, end_date = ?10, remind_minutes = ?11,
       version = version + 1, updated_at = datetime('now')
     WHERE id = ?12 AND version = ?13 AND deleted_at IS NULL`,
  ).bind(f.visibility, f.title, f.description, f.location, f.category, f.all_day ? 1 : 0, f.start_at, f.end_at,
    d.start_date, d.end_date, f.remind_minutes, row.id, row.version).run();
  if (!res.meta.changes) throw new CalError(409, "다른 곳에서 먼저 수정되었습니다. 새로 고친 뒤 다시 시도하세요.");
  const fresh = await loadVisible(c, v, row.id);
  return c.json({ ok: true, event: fresh ? present(v, fresh) : { id: row.id } });
});

calendarApp.delete("/events/:id", async (c) => {
  const v = await requireWriter(c);
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) throw new CalError(404, "일정을 찾을 수 없습니다.");
  if (!canEdit(v, row)) throw new CalError(403, "삭제 권한이 없습니다.");
  await c.env.DB.prepare(
    "UPDATE calendar_events SET deleted_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
  ).bind(row.id).run();
  return c.json({ ok: true });
});

// ======================================================================
// 구글 연결 (C3). 토큰·인가 코드는 응답·로그에 넣지 않는다.
// ======================================================================

const GOOGLE_OFF_MSG = "구글 연동 미설정";
const CONNECT_LIMIT_PER_MIN = 5;

calendarApp.use("/google/*", async (c, next) => {
  if (!googleConfigured(c.env)) {
    c.header("cache-control", "no-store");
    return c.json({ ok: false, error: GOOGLE_OFF_MSG, configured: false }, 503);
  }
  await next();
});

calendarApp.post("/google/connect", async (c) => {
  const v = await requireWriter(c);
  const redirectUri = redirectUriFor(c.env, c.req.url);
  if (!redirectUri) throw new CalError(400, "이 주소에서는 구글 연결을 시작할 수 없습니다 (등록되지 않은 리디렉션 주소).");
  const now = Date.now();
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM calendar_oauth_states WHERE user_id = ? AND created_at > ?",
  ).bind(v.id, now - 60_000).first<{ n: number }>();
  if ((recent?.n || 0) >= CONNECT_LIMIT_PER_MIN) throw new CalError(429, "잠시 후 다시 시도하세요.");
  const state = randomUrlToken(32);
  const verifier = randomUrlToken(32); // 43자 (RFC 7636: 43~128자)
  const verifierEnc = await encryptToken(c.env.GCAL_TOKEN_KEY, v.id, "pkce", verifier);
  await c.env.DB.batch([
    // 하루 지난 state는 정리 (사용 여부 무관)
    c.env.DB.prepare("DELETE FROM calendar_oauth_states WHERE created_at < ?").bind(now - 86400_000),
    c.env.DB.prepare(
      "INSERT INTO calendar_oauth_states (state_hash, user_id, code_verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256hex(state), v.id, verifierEnc, redirectUri, now),
  ]);
  const url = buildAuthUrl(c.env, { redirectUri, state, challenge: await pkceChallenge(verifier) });
  return c.json({ ok: true, url });
});

/** 콜백 페이지. 서버는 query를 읽지 않는다 — 스크립트가 location에서 읽어 /complete로 보낸다. */
function callbackHtml(nonce: string): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>구글 캘린더 연결 — People OS</title>
<style>body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f6f6f7;color:#14233a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center}
a{color:#123863}</style></head>
<body><main><h1 style="font-size:18px;margin:0 0 12px">구글 캘린더 연결</h1>
<p id="m" role="status">연결을 마무리하는 중…</p><p id="b" hidden><a href="/#calendar">캘린더로 돌아가기</a></p></main>
<script nonce="${nonce}">
(function () {
  var p = new URLSearchParams(location.search);
  var code = p.get('code'), state = p.get('state'), err = p.get('error');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var m = document.getElementById('m'), b = document.getElementById('b');
  function fail(t) { m.textContent = t; b.hidden = false; }
  if (err) { fail(err === 'access_denied' ? '구글 캘린더 연결을 취소했습니다.' : '구글이 연결 요청을 거절했습니다.'); return; }
  if (!code || !state) { fail('연결 정보가 없습니다. 캘린더에서 다시 시도하세요.'); return; }
  fetch('/api/calendar/google/complete', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code, state: state })
  }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (j) {
      if (j && j.ok) { m.textContent = '구글 캘린더를 연결했습니다. 캘린더로 이동합니다…'; location.replace('/#calendar'); }
      else fail('연결하지 못했습니다. ' + ((j && j.error) || ''));
    })
    .catch(function () { fail('네트워크 오류로 연결하지 못했습니다.'); });
})();
</script></body></html>`;
}

calendarApp.get("/google/callback", (c) => {
  const nonce = randomUrlToken(16);
  return c.html(callbackHtml(nonce), 200, {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
});

calendarApp.post("/google/complete", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  const code = b.code, state = b.state;
  if (typeof code !== "string" || !code || code.length > 2048) throw new CalError(400, "인가 코드가 올바르지 않습니다.");
  if (typeof state !== "string" || !state || state.length > 256) throw new CalError(400, "연결 요청이 올바르지 않습니다.");
  const now = Date.now();
  // 1회용: 검증과 사용 표시를 한 문장으로 (동시에 두 번 와도 한쪽만 통과). 본인 것·10분 이내·미사용만.
  const st = await c.env.DB.prepare(
    `UPDATE calendar_oauth_states SET used_at = ?1
     WHERE state_hash = ?2 AND user_id = ?3 AND used_at IS NULL AND created_at > ?4
     RETURNING code_verifier, redirect_uri`,
  ).bind(now, await sha256hex(state), v.id, now - STATE_TTL_MS).first<{ code_verifier: string; redirect_uri: string }>();
  if (!st) throw new CalError(400, "연결 요청이 만료되었거나 이미 사용되었습니다. 캘린더에서 다시 연결하세요.");
  if (!redirectAllowed(c.env, st.redirect_uri)) throw new CalError(400, "등록되지 않은 리디렉션 주소입니다.");
  let verifier: string;
  try {
    verifier = await decryptToken(c.env.GCAL_TOKEN_KEY, v.id, "pkce", st.code_verifier);
  } catch {
    throw new CalError(400, "연결 요청을 확인할 수 없습니다. 다시 연결하세요.");
  }
  let t;
  try {
    t = await exchangeCode(c.env, { code, redirectUri: st.redirect_uri, verifier });
  } catch (e) {
    if (e instanceof GoogleError) {
      console.log(`[calendar/google] code exchange failed (${e.kind}: ${e.code}) user=${v.id}`);
      throw new CalError(e.kind === "invalid_grant" ? 400 : 502, `구글 인증을 마치지 못했습니다 (${e.code}). 다시 연결하세요.`);
    }
    throw e;
  }
  if (!scopeSufficient(t.scope)) {
    throw new CalError(400, "캘린더 읽기 권한이 허용되지 않았습니다. 다시 연결하면서 '캘린더 일정 보기'에 체크하세요.");
  }
  if (!t.refreshToken) {
    throw new CalError(400, "구글이 장기 접근 토큰을 주지 않았습니다. 다시 연결하세요.");
  }
  const who = readIdToken(c.env, t.idToken);
  await saveConnection(c.env, v.id, { ...t, refreshToken: t.refreshToken }, who);
  console.log(`[calendar/google] connected user=${v.id}`);
  return c.json({ ok: true, status: "connected", email: maskEmail(who.email) });
});

calendarApp.get("/google/status", async (c) => {
  const v = await requireUser(c);
  let state: "connected" | "needs_reconnect" | "not_connected";
  let email: string | null = null;
  let scope = "";
  let degraded = false;
  try {
    const r = await getAccessToken(c.env, v.id);
    state = r.state;
    if (r.state !== "not_connected") { email = r.row.google_email; scope = r.row.scope || ""; }
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    // 구글 일시 오류: 상태는 그대로 두고 표시만 한다 (토큰은 여전히 유효할 수 있다).
    console.log(`[calendar/google] status refresh failed (${e.kind}: ${e.code}) user=${v.id}`);
    degraded = true;
    const row = await c.env.DB.prepare(
      "SELECT google_email, scope, status FROM calendar_google_accounts WHERE user_id = ?",
    ).bind(v.id).first<{ google_email: string | null; scope: string | null; status: string }>();
    state = !row ? "not_connected" : row.status === "CONNECTED" ? "connected" : "needs_reconnect";
    if (row) { email = row.google_email; scope = row.scope || ""; }
  }
  if (state === "not_connected") return c.json({ ok: true, configured: true, status: state });
  return c.json({
    ok: true, configured: true, status: state, degraded,
    email: maskEmail(email), scope, scopes: scope.split(/\s+/).filter(Boolean),
  });
});

calendarApp.post("/google/disconnect", async (c) => {
  const v = await requireWriter(c);
  const r = await disconnect(c.env, v.id);
  console.log(`[calendar/google] disconnected user=${v.id} existed=${r.existed} revoked=${r.revoked}`);
  return c.json({ ok: true, status: "not_connected", revoked: r.revoked });
});

// ---- C4: 구글 일정 실시간 읽기 (저장 없음) ----

calendarApp.get("/google/events", async (c) => {
  const v = await requireUser(c);
  const fromQ = c.req.query("from"), toQ = c.req.query("to");
  const from = parseUtc(fromQ, "from");
  const to = parseUtc(toQ, "to");
  if (to <= from) throw new CalError(400, "to는 from보다 뒤여야 합니다.");
  if (to - from > MAX_RANGE_MS) throw new CalError(400, "조회 기간은 최대 62일입니다.");
  try {
    const r = await readGoogleEvents(c.env, v.id, fromQ as string, toQ as string);
    if (r.state === "not_connected") {
      return c.json({ ok: false, code: "NOT_CONNECTED", error: "구글 캘린더가 연결되어 있지 않습니다. 캘린더 화면에서 '구글 캘린더 연결'을 눌러 주세요." }, 409);
    }
    if (r.state === "needs_reconnect") {
      return c.json({ ok: true, status: "needs_reconnect", events: [], truncated: false, message: "구글 권한이 만료됐거나 회수됐습니다. 다시 연결해 주세요." });
    }
    return c.json({ ok: true, status: "connected", events: r.events, truncated: r.truncated });
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    console.log(`[calendar/google] events read failed (${e.kind}: ${e.code}) user=${v.id}`);
    return c.json({ ok: false, code: "GOOGLE_ERROR", google_error: e.code, error: "구글 일정을 불러오지 못했습니다." }, 502);
  }
});
