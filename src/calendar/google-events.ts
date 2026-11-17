// 캘린더 C4 (2026-11-17): 구글 일정 실시간 읽기 (1단계, 복사 없음). 계획서 calendar-plan.md 3.2.
// 구글 events.list를 사용자 토큰으로 바로 읽어 People OS 이벤트 모양으로 바꿔 돌려줄 뿐, D1에 저장하지 않는다.
// 내보내는 필드: id·제목·시각·종일 여부·장소·htmlLink·상태. 설명·참석자·회의 링크는 내보내지 않는다.
import { calendarApiBase, getAccessToken, GoogleError, type AccountRow, type GoogleEnv } from "./google-oauth";

const MAX_PAGES = 4;
const PAGE_SIZE = 250;
const FETCH_TIMEOUT_MS = 10_000;

export type GoogleEventOut = {
  id: string; // 'g:' + 구글 id
  source: "google";
  title: string;
  start: string; // 종일: 'YYYY-MM-DD', 그 밖: UTC 'YYYY-MM-DDTHH:MM:SSZ'
  end: string; // 종일: 'YYYY-MM-DD' (끝 날짜 미포함, 구글과 같음)
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
  editable: false;
};

export type GoogleEventsResult =
  | { state: "not_connected" }
  | { state: "needs_reconnect" }
  | { state: "connected"; events: GoogleEventOut[]; truncated: boolean };

type GEvent = {
  id?: string; status?: string; summary?: string; location?: string; htmlLink?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcIso(dateTime: string): string | null {
  const ms = Date.parse(dateTime);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 19) + "Z";
}

/** 구글 일정 한 건 → People OS 모양. 취소된 일정·시각이 이상한 일정은 null. */
export function convertEvent(g: GEvent): GoogleEventOut | null {
  if (!g || typeof g.id !== "string" || !g.id || g.status === "cancelled") return null;
  const base = {
    id: "g:" + g.id.slice(0, 256),
    source: "google" as const,
    title: (typeof g.summary === "string" && g.summary.trim() ? g.summary.trim() : "(제목 없음)").slice(0, 500),
    location: typeof g.location === "string" && g.location ? g.location.slice(0, 500) : null,
    htmlLink: typeof g.htmlLink === "string" && g.htmlLink.startsWith("https://") ? g.htmlLink : null,
    editable: false as const,
  };
  const s = g.start, e = g.end;
  if (s?.date && DATE_RE.test(s.date)) {
    // 종일: end.date는 미포함(다음 날). 없으면 하루짜리로 본다.
    const end = e?.date && DATE_RE.test(e.date) ? e.date : new Date(Date.parse(s.date + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
    return { ...base, start: s.date, end, allDay: true };
  }
  if (s?.dateTime) {
    const start = utcIso(s.dateTime);
    const end = e?.dateTime ? utcIso(e.dateTime) : start;
    if (!start || !end) return null;
    return { ...base, start, end, allDay: false };
  }
  return null;
}

type Page = { items?: GEvent[]; nextPageToken?: string };

/** 한 쪽 읽기. 401이면 status 401을 돌려 호출자가 토큰을 새로 받게 한다. */
async function fetchPage(env: GoogleEnv, token: string, from: string, to: string, pageToken: string | null): Promise<{ status: number; page: Page | null; reason: string }> {
  const q = new URLSearchParams({
    timeMin: from, timeMax: to, singleEvents: "true", showDeleted: "false", orderBy: "startTime",
    maxResults: String(PAGE_SIZE),
    fields: "nextPageToken,items(id,status,summary,location,htmlLink,start,end)",
  });
  if (pageToken) q.set("pageToken", pageToken);
  let res: Response;
  try {
    res = await fetch(`${calendarApiBase(env)}/calendars/primary/events?${q.toString()}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleError("network", "fetch_failed");
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 200) return { status: 200, page: (json && typeof json === "object" ? json : {}) as Page, reason: "" };
  // 오류 본문의 reason 문자열만 쓴다 (토큰·메시지 전문은 남기지 않는다).
  const j = json as { error?: { errors?: { reason?: string }[]; status?: string } } | null;
  const reason = String(j?.error?.errors?.[0]?.reason || j?.error?.status || `http_${res.status}`).slice(0, 64);
  return { status: res.status, page: null, reason };
}

/** from/to는 'YYYY-MM-DDTHH:MM:SSZ' (RFC3339, 오프셋 포함 — 구글이 요구). */
export async function readGoogleEvents(env: GoogleEnv, userId: string, from: string, to: string): Promise<GoogleEventsResult> {
  let acc = await getAccessToken(env, userId);
  if (acc.state === "not_connected") return { state: "not_connected" };
  if (acc.state === "needs_reconnect") return { state: "needs_reconnect" };
  let token = acc.accessToken;
  let retried = false;
  const out: GoogleEventOut[] = [];
  let pageToken: string | null = null;
  let truncated = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    let r = await fetchPage(env, token, from, to, pageToken);
    if (r.status === 401 && !retried) {
      // 액세스 토큰이 만료·회수됐다: 강제 재발급 후 같은 쪽을 한 번 더.
      retried = true;
      const fresh = await getAccessToken(env, userId, true);
      if (fresh.state === "needs_reconnect") return { state: "needs_reconnect" };
      if (fresh.state === "not_connected") return { state: "not_connected" };
      token = fresh.accessToken;
      r = await fetchPage(env, token, from, to, pageToken);
    }
    if (r.status !== 200 || !r.page) throw new GoogleError("http", r.reason);
    for (const g of r.page.items || []) {
      const c = convertEvent(g);
      if (c) out.push(c);
    }
    pageToken = typeof r.page.nextPageToken === "string" && r.page.nextPageToken ? r.page.nextPageToken : null;
    if (!pageToken) break;
    if (i === MAX_PAGES - 1) truncated = true;
  }
  return { state: "connected", events: out, truncated };
}

export type { AccountRow };
