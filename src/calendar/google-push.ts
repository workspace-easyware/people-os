// 캘린더 C6 (2026-11-22): People OS → 구글 쓰기 (2단계). 계획서 calendar-plan.md 3.4·3.5.
// 범위: 소유자가 "구글 캘린더에도 저장"을 켠 **개인 일정만** 그 사람의 구글 기본 캘린더(primary)에 쓴다.
//       팀 일정·구글에서 온 일정은 쓰지 않는다. 연결 = calendar_event_links 행 1개.
// 흐름 (연결 행의 push_status가 할 일을 정한다):
//   PENDING/FAILED  etag 없음 → events.insert (id를 People OS가 미리 정해 보낸다 → 다시 보내도 409로 1개만 생긴다)
//                   etag 있음 → events.patch + If-Match: <etag>
//                       200 → 새 etag 저장, SYNCED
//                       412 → 구글에서 먼저 바뀜: 구글 값을 읽어 People OS 행을 덮어쓰고 알림 (구글이 이긴다)
//                       404/410 → 구글에서 지워짐: People OS 일정을 소프트 삭제하고 알림
//   DELETE_PENDING  events.delete (404/410은 성공으로 본다) → 연결 행 삭제
//   SYNCED          대조: events.get + If-None-Match: <etag>. 304 = 그대로, 200 = 구글 값으로 맞춤, 404/410·cancelled = 소프트 삭제
// 변경 감지는 events.list(updatedMin)이 아니라 "연결된 일정을 events.get으로 하나씩"이다 — updatedMin의 제약을 이 세션에서
// 확인하지 못했고(구글 문서 접근 불가), 계획서가 그 경우의 단순화로 정해 둔 방식이다. 연결 일정이 사용자당 수십 건 이하일 때만 맞다.
// 토큰·응답 본문은 로그에 남기지 않는다 (오류 reason 문자열만).
import { uid } from "../lib";
import { calendarApiBase, getAccessToken, GoogleError, writeCapable, type GoogleEnv } from "./google-oauth";

const FETCH_TIMEOUT_MS = 10_000;
const KST_MS = 9 * 3600_000;
const MAX_EVENT_MS = 31 * 86400_000;
export const MAX_ATTEMPTS = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type LinkRow = {
  event_id: string; user_id: string; google_event_id: string; etag: string | null;
  push_status: "PENDING" | "SYNCED" | "FAILED" | "DELETE_PENDING"; attempts: number;
};

type EvRow = {
  id: string; owner_id: string; visibility: string; title: string; description: string | null; location: string | null;
  all_day: number; start_at: string; end_at: string; start_date: string | null; end_date: string | null;
  version: number; deleted_at: string | null;
};

type GEvent = {
  id?: string; etag?: string; status?: string; summary?: string; description?: string; location?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
};

export type SyncOutcome =
  | "created" | "updated" | "deleted" | "unchanged" | "pulled" | "conflict_pulled" | "google_deleted"
  | "skipped" | "failed";

/** 구글 일정 id: base32hex 문자(0-9, a-v)만 쓴다. 'pos' + 무작위 20바이트의 16진수 = 43자. */
export function newGoogleEventId(): string {
  const b = crypto.getRandomValues(new Uint8Array(20));
  return "pos" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- People OS 일정 ↔ 구글 일정 ----

/** patch로도 쓰므로 종일↔시각 전환 때 반대쪽 필드를 null로 지운다. */
export function toGoogleBody(ev: EvRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: ev.title,
    description: ev.description ?? "",
    location: ev.location ?? "",
    extendedProperties: { private: { peopleOsEventId: ev.id } },
  };
  if (ev.all_day === 1 && ev.start_date && ev.end_date) {
    body.start = { date: ev.start_date, dateTime: null, timeZone: null };
    body.end = { date: ev.end_date, dateTime: null, timeZone: null };
  } else {
    body.start = { dateTime: ev.start_at, timeZone: "Asia/Seoul", date: null };
    body.end = { dateTime: ev.end_at, timeZone: "Asia/Seoul", date: null };
  }
  return body;
}

type LocalFields = {
  title: string; description: string | null; location: string | null; all_day: number;
  start_at: string; end_at: string; start_date: string | null; end_date: string | null;
};

function utcIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

/** 구글 일정 → People OS 필드. People OS 규칙(끝 > 시작, 최대 31일)에 안 맞으면 null. */
export function fromGoogle(g: GEvent): LocalFields | null {
  const title = (typeof g.summary === "string" && g.summary.trim() ? g.summary.trim() : "(제목 없음)").slice(0, 200);
  const description = typeof g.description === "string" && g.description.trim() ? g.description.trim().slice(0, 2000) : null;
  const location = typeof g.location === "string" && g.location.trim() ? g.location.trim().slice(0, 200) : null;
  const s = g.start, e = g.end;
  let startMs: number, endMs: number, allDay = 0, sd: string | null = null, ed: string | null = null;
  if (s?.date && DATE_RE.test(s.date)) {
    sd = s.date;
    ed = e?.date && DATE_RE.test(e.date) ? e.date : new Date(Date.parse(s.date + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
    startMs = Date.parse(sd + "T00:00:00Z") - KST_MS; // 그 날 00:00 KST
    endMs = Date.parse(ed + "T00:00:00Z") - KST_MS;
    allDay = 1;
  } else if (s?.dateTime && e?.dateTime) {
    startMs = Math.floor(Date.parse(s.dateTime) / 1000) * 1000;
    endMs = Math.floor(Date.parse(e.dateTime) / 1000) * 1000;
  } else {
    return null;
  }
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs || endMs - startMs > MAX_EVENT_MS) return null;
  return { title, description, location, all_day: allDay, start_at: utcIso(startMs), end_at: utcIso(endMs), start_date: sd, end_date: ed };
}

function sameFields(ev: EvRow, f: LocalFields): boolean {
  return ev.title === f.title && (ev.description ?? null) === f.description && (ev.location ?? null) === f.location &&
    ev.all_day === f.all_day && ev.start_at === f.start_at && ev.end_at === f.end_at &&
    (ev.start_date ?? null) === f.start_date && (ev.end_date ?? null) === f.end_date;
}

// ---- 구글 호출 (사용자 한 명의 토큰을 여러 호출에 같이 쓴다) ----

type GResult = { status: number; json: GEvent | null; reason: string };

class GClient {
  private token: string | null = null;
  private refreshed = false;
  /** 토큰을 못 얻은 이유 (계정 문제). 있으면 더 부르지 않는다. */
  blocked: string | null = null;
  calls = 0;

  constructor(private env: GoogleEnv, private userId: string) {}

  private async ensure(force = false): Promise<boolean> {
    if (this.blocked) return false;
    if (this.token && !force) return true;
    const r = await getAccessToken(this.env, this.userId, force);
    if (r.state === "not_connected") { this.blocked = "not_connected"; return false; }
    if (r.state === "needs_reconnect") { this.blocked = "needs_reconnect"; return false; }
    if (!writeCapable(r.row.scope)) { this.blocked = "no_write_scope"; return false; }
    this.token = r.accessToken;
    return true;
  }

  async call(method: string, path: string, opts: { body?: unknown; ifMatch?: string; ifNoneMatch?: string } = {}): Promise<GResult> {
    if (!(await this.ensure())) return { status: 0, json: null, reason: this.blocked || "blocked" };
    let r = await this.once(method, path, opts);
    if (r.status === 401 && !this.refreshed) {
      this.refreshed = true;
      if (!(await this.ensure(true))) return { status: 0, json: null, reason: this.blocked || "blocked" };
      r = await this.once(method, path, opts);
    }
    return r;
  }

  private async once(method: string, path: string, opts: { body?: unknown; ifMatch?: string; ifNoneMatch?: string }): Promise<GResult> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
    this.calls++;
    let res: Response;
    try {
      res = await fetch(`${calendarApiBase(this.env)}/calendars/primary/events${path}`, {
        method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return { status: -1, json: null, reason: "fetch_failed" };
    }
    let json: unknown = null;
    try { json = res.status === 204 || res.status === 304 ? null : await res.json(); } catch { json = null; }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json: (json && typeof json === "object" ? json : null) as GEvent | null, reason: "" };
    const j = json as { error?: { errors?: { reason?: string }[]; status?: string } } | null;
    const reason = String(j?.error?.errors?.[0]?.reason || j?.error?.status || `http_${res.status}`).slice(0, 64);
    return { status: res.status, json: null, reason };
  }
}

// ---- 연결 행 갱신 ----

const EV_COLS = "id, owner_id, visibility, title, description, location, all_day, start_at, end_at, start_date, end_date, version, deleted_at";

async function loadEvent(env: GoogleEnv, id: string): Promise<EvRow | null> {
  return env.DB.prepare(`SELECT ${EV_COLS} FROM calendar_events WHERE id = ?`).bind(id).first<EvRow>();
}

async function markFailed(env: GoogleEnv, link: LinkRow, reason: string, countAttempt: boolean): Promise<SyncOutcome> {
  // 삭제 대기는 삭제 대기로 남긴다 (실패했다고 "저장됨"으로 돌아가면 안 된다). 계정 문제(재연결·권한 없음)는 횟수를 세지 않는다.
  await env.DB.prepare(
    `UPDATE calendar_event_links SET push_status = CASE WHEN push_status = 'DELETE_PENDING' THEN 'DELETE_PENDING' ELSE 'FAILED' END,
       attempts = attempts + ?1, last_error = ?2, updated_at = ?3 WHERE event_id = ?4`,
  ).bind(countAttempt ? 1 : 0, reason.slice(0, 64), Date.now(), link.event_id).run();
  console.log(`[calendar/push] failed event=${link.event_id} reason=${reason}`);
  return "failed";
}

/** 보내기 성공. 보낸 뒤에 People OS에서 또 고쳤으면(version이 달라졌으면) PENDING으로 남겨 다음에 다시 보낸다. */
async function markPushed(env: GoogleEnv, link: LinkRow, etag: string | null, pushedVersion: number): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE calendar_event_links SET etag = ?1,
       push_status = CASE WHEN (SELECT version FROM calendar_events WHERE id = ?2) = ?3 THEN 'SYNCED' ELSE 'PENDING' END,
       attempts = 0, last_error = NULL, pushed_at = ?4, checked_at = ?4, updated_at = ?4
     WHERE event_id = ?2 AND push_status <> 'DELETE_PENDING'`,
  ).bind(etag, link.event_id, pushedVersion, now).run();
}

function notifyStmt(env: GoogleEnv, userId: string, type: string, eventId: string, title: string, link: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications (id, user_id, type, ref_type, ref_id, title, body, link, created_at)
     VALUES (?, ?, ?, 'calendar_event', ?, ?, NULL, ?, ?)`,
  ).bind(uid("ntf"), userId, type, eventId, title.slice(0, 300), link, new Date().toISOString());
}

/** 구글 값으로 People OS 행을 덮어쓴다. conflict=true면 "구글에서 먼저 바뀜" 알림을 넣는다 (조용히 버리지 않는다). */
async function applyGoogle(env: GoogleEnv, link: LinkRow, ev: EvRow, g: GEvent, conflict: boolean): Promise<SyncOutcome> {
  const f = fromGoogle(g);
  if (!f) return markFailed(env, link, "google_value_unsupported", true);
  const now = Date.now();
  const etag = typeof g.etag === "string" ? g.etag : null;
  // 대조(conflict=false)는 연결이 여전히 SYNCED일 때만 덮어쓴다 — 그사이 People OS에서 고쳤으면(PENDING) 보내기 쪽 412 경로가 처리한다.
  const guard = conflict ? "" : " AND push_status = 'SYNCED'";
  const stmts: D1PreparedStatement[] = [];
  if (!sameFields(ev, f)) {
    stmts.push(env.DB.prepare(
      `UPDATE calendar_events SET title = ?1, description = ?2, location = ?3, all_day = ?4, start_at = ?5, end_at = ?6,
         start_date = ?7, end_date = ?8, version = version + 1, updated_at = datetime('now')
       WHERE id = ?9 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM calendar_event_links WHERE event_id = ?9${guard})`,
    ).bind(f.title, f.description, f.location, f.all_day, f.start_at, f.end_at, f.start_date, f.end_date, ev.id));
  }
  stmts.push(env.DB.prepare(
    `UPDATE calendar_event_links SET etag = ?1, push_status = 'SYNCED', attempts = 0, last_error = NULL, checked_at = ?2, updated_at = ?2
     WHERE event_id = ?3 AND push_status <> 'DELETE_PENDING'${guard}`,
  ).bind(etag, now, ev.id));
  if (conflict) {
    stmts.push(notifyStmt(env, link.user_id, "CALENDAR_GOOGLE_CONFLICT", ev.id,
      `[일정] 구글에서 먼저 바뀐 일정이라 구글 내용으로 맞췄습니다 · ${f.title}`, `/#calendar/${encodeURIComponent(ev.id)}`));
  }
  await env.DB.batch(stmts);
  return conflict ? "conflict_pulled" : sameFields(ev, f) ? "unchanged" : "pulled";
}

/** 구글에서 지워진 연결 일정: People OS 행을 소프트 삭제(30일 뒤 청소)하고 알림 1건. */
async function applyGoogleDeleted(env: GoogleEnv, link: LinkRow, ev: EvRow | null): Promise<SyncOutcome> {
  const stmts: D1PreparedStatement[] = [];
  if (ev && !ev.deleted_at) {
    stmts.push(env.DB.prepare(
      "UPDATE calendar_events SET deleted_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    ).bind(ev.id));
    stmts.push(notifyStmt(env, link.user_id, "CALENDAR_GOOGLE_DELETED", ev.id,
      `[일정] 구글 캘린더에서 삭제된 일정을 People OS에서도 삭제했습니다 · ${ev.title}`, "/#calendar"));
  }
  stmts.push(env.DB.prepare("DELETE FROM calendar_event_links WHERE event_id = ?").bind(link.event_id));
  await env.DB.batch(stmts);
  return "google_deleted";
}

function gone(r: GResult): boolean {
  return r.status === 404 || r.status === 410;
}

/** 계정 문제(토큰 없음·권한 없음)인가 — 횟수를 세지 않는다. */
function accountProblem(r: GResult): boolean {
  return r.status === 0;
}

// ---- 연결 1건 처리 ----

async function syncLink(env: GoogleEnv, g: GClient, link: LinkRow, ev: EvRow | null): Promise<SyncOutcome> {
  const path = "/" + encodeURIComponent(link.google_event_id);
  const wantDelete = link.push_status === "DELETE_PENDING" || !ev || !!ev.deleted_at || ev.visibility !== "private" || ev.owner_id !== link.user_id;

  if (wantDelete) {
    if (link.etag) {
      const r = await g.call("DELETE", path);
      if (!(r.status >= 200 && r.status < 300) && !gone(r)) return markFailed(env, link, r.reason, !accountProblem(r));
    }
    await env.DB.prepare("DELETE FROM calendar_event_links WHERE event_id = ?").bind(link.event_id).run();
    return "deleted";
  }
  const e = ev as EvRow;

  if (link.push_status === "SYNCED") {
    // 대조: 구글 쪽이 바뀌었는가.
    const r = await g.call("GET", path, link.etag ? { ifNoneMatch: link.etag } : {});
    if (r.status === 304 || (r.status === 200 && r.json && r.json.etag === link.etag && r.json.status !== "cancelled")) {
      await env.DB.prepare("UPDATE calendar_event_links SET checked_at = ? WHERE event_id = ?").bind(Date.now(), link.event_id).run();
      return "unchanged";
    }
    if (gone(r) || (r.status === 200 && r.json?.status === "cancelled")) return applyGoogleDeleted(env, link, e);
    if (r.status === 200 && r.json) return applyGoogle(env, link, e, r.json, false);
    // 대조 실패는 상태를 바꾸지 않는다 (다음 틱에 다시 본다).
    console.log(`[calendar/push] check failed event=${link.event_id} reason=${r.reason}`);
    return "skipped";
  }

  // 보내기 (PENDING / FAILED)
  const body = toGoogleBody(e);
  if (!link.etag) {
    let r = await g.call("POST", "", { body: { id: link.google_event_id, ...body } });
    let outcome: SyncOutcome = "created";
    if (r.status === 409) {
      // 같은 id가 이미 있다 = 앞선 시도가 구글에는 도착했는데 기록을 못 했다. 지금 내용으로 덮어쓴다 (두 개가 생기지 않는다).
      r = await g.call("PATCH", path, { body: { ...body, status: "confirmed" } });
      outcome = "updated";
    }
    if (r.status !== 200 || !r.json) return markFailed(env, link, r.reason || `http_${r.status}`, !accountProblem(r));
    await markPushed(env, link, typeof r.json.etag === "string" ? r.json.etag : null, e.version);
    return outcome;
  }
  const r = await g.call("PATCH", path, { body, ifMatch: link.etag });
  if (r.status === 200 && r.json) {
    await markPushed(env, link, typeof r.json.etag === "string" ? r.json.etag : null, e.version);
    return "updated";
  }
  if (r.status === 412) {
    // 구글에서 그사이 바뀌었다 → 구글이 이긴다.
    const cur = await g.call("GET", path);
    if (gone(cur) || (cur.status === 200 && cur.json?.status === "cancelled")) return applyGoogleDeleted(env, link, e);
    if (cur.status === 200 && cur.json) return applyGoogle(env, link, e, cur.json, true);
    return markFailed(env, link, cur.reason || "conflict_read_failed", !accountProblem(cur));
  }
  if (gone(r)) return applyGoogleDeleted(env, link, e);
  return markFailed(env, link, r.reason || `http_${r.status}`, !accountProblem(r));
}

async function safeSync(env: GoogleEnv, g: GClient, link: LinkRow, ev: EvRow | null): Promise<SyncOutcome> {
  try {
    return await syncLink(env, g, link, ev);
  } catch (e) {
    const reason = e instanceof GoogleError ? e.code : "internal_error";
    console.log(`[calendar/push] error event=${link.event_id} ${e instanceof GoogleError ? e.code : e instanceof Error ? e.message : String(e)}`);
    try { return await markFailed(env, link, reason, true); } catch { return "failed"; }
  }
}

const LINK_COLS = "l.event_id, l.user_id, l.google_event_id, l.etag, l.push_status, l.attempts";

/** 일정 1건을 지금 구글에 반영한다 (만들기·수정·삭제 직후 waitUntil로 부른다). 던지지 않는다. */
export async function pushEvent(env: GoogleEnv, eventId: string): Promise<SyncOutcome> {
  try {
    const link = await env.DB.prepare(`SELECT ${LINK_COLS} FROM calendar_event_links l WHERE l.event_id = ?`).bind(eventId).first<LinkRow>();
    if (!link || link.push_status === "SYNCED") return "skipped";
    return await safeSync(env, new GClient(env, link.user_id), link, await loadEvent(env, eventId));
  } catch (e) {
    console.log(`[calendar/push] pushEvent error event=${eventId} ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

export type SyncSummary = { processed: number; outcomes: Record<string, number>; googleCalls: number };

async function runLinks(env: GoogleEnv, links: LinkRow[]): Promise<SyncSummary> {
  const sum: SyncSummary = { processed: 0, outcomes: {}, googleCalls: 0 };
  if (!links.length) return sum;
  const ids = links.map((l) => l.event_id);
  const evs = await env.DB.prepare(
    `SELECT ${EV_COLS} FROM calendar_events WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<EvRow>();
  const byId = new Map((evs.results || []).map((e) => [e.id, e]));
  const clients = new Map<string, GClient>();
  for (const link of links) {
    let g = clients.get(link.user_id);
    if (!g) { g = new GClient(env, link.user_id); clients.set(link.user_id, g); }
    const o = await safeSync(env, g, link, byId.get(link.event_id) || null);
    sum.processed++;
    sum.outcomes[o] = (sum.outcomes[o] || 0) + 1;
  }
  for (const g of clients.values()) sum.googleCalls += g.calls;
  return sum;
}

/**
 * 15분 크론 틱: 밀린 보내기(최대 3건) + 구글 쪽 변경 대조(오래 안 본 순 최대 5건).
 * 한 틱의 구글 호출·D1 쿼리를 작게 유지한다 (Free: 호출당 외부 요청 50개 — 같은 틱에 워크플로우·알림도 돈다).
 * 연결된 계정(CONNECTED)의 것만 본다. 방금 고친 것(60초 이내)은 요청 쪽 waitUntil이 처리 중일 수 있어 건너뛴다.
 */
export async function runGoogleSyncTick(env: GoogleEnv, now: Date): Promise<SyncSummary> {
  const nowMs = now.getTime();
  const pending = await env.DB.prepare(
    `SELECT ${LINK_COLS} FROM calendar_event_links l
     JOIN calendar_google_accounts a ON a.user_id = l.user_id AND a.status = 'CONNECTED'
     WHERE l.push_status IN ('PENDING','FAILED','DELETE_PENDING') AND l.attempts < ?1 AND l.updated_at < ?2
     ORDER BY l.updated_at LIMIT 3`,
  ).bind(MAX_ATTEMPTS, nowMs - 60_000).all<LinkRow>();
  const check = await env.DB.prepare(
    `SELECT ${LINK_COLS} FROM calendar_event_links l
     JOIN calendar_google_accounts a ON a.user_id = l.user_id AND a.status = 'CONNECTED'
     WHERE l.push_status = 'SYNCED' AND COALESCE(l.checked_at, 0) < ?1
     ORDER BY COALESCE(l.checked_at, 0) LIMIT 5`,
  ).bind(nowMs - 10 * 60_000).all<LinkRow>();
  return runLinks(env, [...(pending.results || []), ...(check.results || [])]);
}

/** 사용자 한 명의 연결 일정을 지금 맞춘다 (캘린더 화면을 열 때·새로고침 버튼). 30초 안에 본 것은 다시 보지 않는다. */
export async function syncUserLinks(env: GoogleEnv, userId: string): Promise<SyncSummary> {
  const nowMs = Date.now();
  const rows = await env.DB.prepare(
    `SELECT ${LINK_COLS} FROM calendar_event_links l
     WHERE l.user_id = ?1 AND (
       (l.push_status IN ('PENDING','FAILED','DELETE_PENDING') AND l.updated_at < ?2)
       OR (l.push_status = 'SYNCED' AND COALESCE(l.checked_at, 0) < ?3))
     ORDER BY CASE WHEN l.push_status = 'SYNCED' THEN 1 ELSE 0 END, COALESCE(l.checked_at, 0) LIMIT 20`,
  ).bind(userId, nowMs - 10_000, nowMs - 30_000).all<LinkRow>();
  return runLinks(env, rows.results || []);
}
