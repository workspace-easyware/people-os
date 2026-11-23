// 할 일 Google Tasks 패리티 (2026-11-23, migration 0046): 목록 > 할 일 > 하위 작업.
// 이 파일은 순수 로직만 둔다 — 입력 검증, 반복 규칙의 다음 날짜 계산, 화면 순서 만들기. 라우트는 src/index.ts에 있다.
// 날짜는 전부 "YYYY-MM-DD" 문자열(KST 달력 날짜)로 다루고, 계산은 UTC 자정 기준 "1970-01-01부터의 일수"로 한다 (시간대 영향 없음).

export const TASK_TITLE_MAX = 200;
export const TASK_DETAILS_MAX = 2000;
export const LIST_TITLE_MAX = 100;
export const DEFAULT_LIST_TITLE = "내 할 일 목록";
export const UNASSIGNED_LIST_TITLE = "미지정 할 일";
export const TASK_SORTS = ["myorder", "date", "deadline", "starred", "title"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

// 반복 규칙. Google Tasks의 사용자 지정 반복 다이얼로그와 같은 항목이다.
//   every 1~100 + unit. week는 weekdays(0=일 … 6=토), month는 day(1~31 | "last") 또는 nth(1~4 | "last") + weekday.
//   ends: never | on(until 날짜까지) | after(occurrences 회, 1~1000).
//   start: 반복 시작일 — 서버가 규칙을 저장할 때 그 할 일의 due_date로 채운다 (간격·주차 계산의 기준점).
export type RepeatRule = {
  every: number;
  unit: "day" | "week" | "month" | "year";
  weekdays?: number[];
  day?: number | "last";
  nth?: number | "last";
  weekday?: number;
  ends: "never" | "on" | "after";
  until?: string;
  occurrences?: number;
  start: string;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** "YYYY-MM-DD" → 1970-01-01부터의 일수. 형식이 틀리거나 없는 날짜(2월 30일 등)면 null. */
export function dateToDays(s: string): number | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

export function daysToDate(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(v: unknown): v is string {
  return typeof v === "string" && dateToDays(v) !== null;
}

export function isValidTime(v: unknown): v is string {
  return typeof v === "string" && TIME_RE.test(v);
}

/** 오늘 날짜 (KST). */
export function kstToday(now: number = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

function dowOf(days: number): number {
  return (((days + 4) % 7) + 7) % 7; // 1970-01-01은 목요일(4)
}

function lastDayOfMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

function ymdDays(y: number, m0: number, d: number): number {
  return Math.round(Date.UTC(y, m0, d) / DAY_MS);
}

/**
 * 반복 규칙 입력 검증. start = 그 할 일의 due_date (반복은 날짜가 있어야 설정할 수 있다).
 * 통과하면 필요한 키만 남긴 규칙을, 아니면 error를 돌려준다.
 */
export function validateRepeatRule(raw: unknown, start: string): { rule: RepeatRule } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "repeat_rule must be an object" };
  const r = raw as Record<string, unknown>;
  const startDays = dateToDays(start);
  if (startDays === null) return { error: "repeat_rule: 시작 날짜(due_date)가 필요합니다" };
  if (!isInt(r.every) || r.every < 1 || r.every > 100) return { error: "repeat_rule.every must be 1~100" };
  if (r.unit !== "day" && r.unit !== "week" && r.unit !== "month" && r.unit !== "year") return { error: "repeat_rule.unit must be day|week|month|year" };
  const rule: RepeatRule = { every: r.every, unit: r.unit, ends: "never", start };

  if (r.unit === "week") {
    const wd = r.weekdays === undefined || r.weekdays === null ? [dowOf(startDays)] : r.weekdays;
    if (!Array.isArray(wd) || wd.length < 1 || wd.length > 7 || !wd.every((n) => isInt(n) && n >= 0 && n <= 6) || new Set(wd).size !== wd.length) {
      return { error: "repeat_rule.weekdays must be an array of distinct 0~6" };
    }
    rule.weekdays = [...(wd as number[])].sort((a, b) => a - b);
  } else if (r.unit === "month") {
    const hasNth = r.nth !== undefined && r.nth !== null;
    const hasDay = r.day !== undefined && r.day !== null;
    if (hasNth && hasDay) return { error: "repeat_rule: month는 day 또는 nth+weekday 중 하나만 지정합니다" };
    if (hasNth) {
      if (!(r.nth === "last" || (isInt(r.nth) && r.nth >= 1 && r.nth <= 4))) return { error: "repeat_rule.nth must be 1~4 or \"last\"" };
      if (!isInt(r.weekday) || r.weekday < 0 || r.weekday > 6) return { error: "repeat_rule.weekday must be 0~6" };
      rule.nth = r.nth as number | "last";
      rule.weekday = r.weekday;
    } else if (hasDay) {
      if (!(r.day === "last" || (isInt(r.day) && r.day >= 1 && r.day <= 31))) return { error: "repeat_rule.day must be 1~31 or \"last\"" };
      rule.day = r.day as number | "last";
    } else {
      rule.day = new Date(startDays * DAY_MS).getUTCDate(); // 지정이 없으면 시작일의 날짜
    }
  }

  const ends = r.ends === undefined || r.ends === null ? "never" : r.ends;
  if (ends !== "never" && ends !== "on" && ends !== "after") return { error: "repeat_rule.ends must be never|on|after" };
  rule.ends = ends;
  if (ends === "on") {
    if (!isValidDate(r.until)) return { error: "repeat_rule.until must be YYYY-MM-DD" };
    if (r.until < start) return { error: "repeat_rule.until은 시작 날짜보다 빠를 수 없습니다" };
    rule.until = r.until;
  } else if (ends === "after") {
    if (!isInt(r.occurrences) || r.occurrences < 1 || r.occurrences > 1000) return { error: "repeat_rule.occurrences must be 1~1000" };
    rule.occurrences = r.occurrences;
  }
  return { rule };
}

/** 저장된 repeat_rule JSON을 읽는다. 깨졌으면 null (반복 없음으로 다룬다). */
export function parseRepeatRule(json: string | null | undefined): RepeatRule | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as { start?: unknown };
    if (!o || typeof o.start !== "string") return null;
    const v = validateRepeatRule(o, o.start);
    return "rule" in v ? v.rule : null;
  } catch {
    return null;
  }
}

/** 그 달에서 규칙이 가리키는 날짜 (일수). 31일이 없는 달의 "31일"은 그 달 마지막 날로 당긴다. */
function monthCandidate(rule: RepeatRule, y: number, m0: number, startDom: number): number {
  const last = lastDayOfMonth(y, m0);
  if (rule.nth !== undefined && rule.weekday !== undefined) {
    if (rule.nth === "last") {
      const lastDays = ymdDays(y, m0, last);
      return lastDays - ((dowOf(lastDays) - rule.weekday + 7) % 7);
    }
    const firstDays = ymdDays(y, m0, 1);
    return firstDays + ((rule.weekday - dowOf(firstDays) + 7) % 7) + (rule.nth - 1) * 7;
  }
  const day = rule.day === "last" ? last : Math.min(typeof rule.day === "number" ? rule.day : startDom, last);
  return ymdDays(y, m0, day);
}

/** 규칙의 일정 가운데 after(일수)보다 뒤이고 start 이후인 첫 날짜. Ends는 보지 않는다. */
export function nextOccurrenceDays(rule: RepeatRule, after: number): number | null {
  const start = dateToDays(rule.start);
  if (start === null) return null;
  const every = rule.every;
  if (rule.unit === "day") {
    if (after < start) return start;
    return start + (Math.floor((after - start) / every) + 1) * every;
  }
  if (rule.unit === "week") {
    const weekStart = start - dowOf(start); // 시작 주의 일요일
    const days = new Set(rule.weekdays && rule.weekdays.length ? rule.weekdays : [dowOf(start)]);
    const from = Math.max(after + 1, start);
    for (let d = from; d < from + 7 * (every + 1); d++) {
      if (Math.floor((d - weekStart) / 7) % every === 0 && days.has(dowOf(d))) return d;
    }
    return null;
  }
  const s = new Date(start * DAY_MS);
  const sy = s.getUTCFullYear(), sm = s.getUTCMonth(), sd = s.getUTCDate();
  const a = new Date(Math.max(after, start) * DAY_MS);
  if (rule.unit === "month") {
    const diff = (a.getUTCFullYear() - sy) * 12 + (a.getUTCMonth() - sm);
    const k0 = Math.max(0, Math.floor(diff / every) - 1);
    for (let k = k0; k < k0 + 5; k++) {
      const idx = sm + k * every;
      const cand = monthCandidate(rule, sy + Math.floor(idx / 12), idx % 12, sd);
      if (cand > after && cand >= start) return cand;
    }
    return null;
  }
  // year: 시작일과 같은 월·일 (2월 29일은 평년에 2월 28일)
  const k0 = Math.max(0, Math.floor((a.getUTCFullYear() - sy) / every) - 1);
  for (let k = k0; k < k0 + 5; k++) {
    const y = sy + k * every;
    const cand = ymdDays(y, sm, Math.min(sd, lastDayOfMonth(y, sm)));
    if (cand > after && cand >= start) return cand;
  }
  return null;
}

/**
 * 반복 할 일을 완료했을 때 다음 회차의 날짜. 없으면 null (Ends: On 날짜를 넘김).
 * 다음 회차는 "지금 회차의 날짜보다 뒤"이면서 "오늘 이후"인 첫 일정이다 — 오래 밀린 할 일을 완료해도 이미 지난 회차를 또 만들지 않는다.
 * Ends: After 횟수 제한은 호출하는 쪽(같은 반복 그룹의 완료 회차 수)이 본다.
 */
export function nextRepeatDate(rule: RepeatRule, dueDate: string, today: string): string | null {
  const due = dateToDays(dueDate);
  const t = dateToDays(today);
  if (due === null || t === null) return null;
  const next = nextOccurrenceDays(rule, Math.max(due, t - 1));
  if (next === null) return null;
  const s = daysToDate(next);
  if (rule.ends === "on" && rule.until && s > rule.until) return null;
  return s;
}

// ---- 화면 순서 ----
export type TaskRow = {
  id: string;
  title: string;
  source: string | null;
  done: number;
  created_at: string;
  done_at: string | null;
  owner_id: string | null;
  owner_name: string;
  list_id: string | null;
  details: string | null;
  due_date: string | null;
  due_time: string | null;
  starred: number;
  starred_at: string | null;
  repeat_rule: string | null;
  repeat_group: string | null;
  parent_id: string | null;
  position: number;
};
export type TaskOut = Omit<TaskRow, "repeat_rule"> & { repeat_rule: RepeatRule | null; indent: 0 | 1 };

export function taskOut(r: TaskRow, indent: 0 | 1 = 0): TaskOut {
  return { ...r, repeat_rule: parseRepeatRule(r.repeat_rule), indent };
}

function cmpStr(a: string | null, b: string | null): number {
  // NULL(날짜 없음)은 뒤로
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function comparator(sort: TaskSort): (a: TaskRow, b: TaskRow) => number {
  const byPos = (a: TaskRow, b: TaskRow) => a.position - b.position || cmpStr(b.created_at, a.created_at);
  if (sort === "date") return (a, b) => cmpStr(a.due_date, b.due_date) || byPos(a, b);
  if (sort === "deadline") {
    // 기한 = 날짜 + 시간. 시간이 없는 할 일은 그날의 끝으로 본다.
    const key = (t: TaskRow) => (t.due_date ? `${t.due_date} ${t.due_time || "24:00"}` : null);
    return (a, b) => cmpStr(key(a), key(b)) || byPos(a, b);
  }
  if (sort === "starred") return (a, b) => b.starred - a.starred || cmpStr(b.starred_at, a.starred_at) || byPos(a, b);
  if (sort === "title") return (a, b) => a.title.localeCompare(b.title, "ko") || byPos(a, b);
  return byPos;
}

/**
 * 응답 순서: 진행 중인 할 일(정렬 기준대로, 하위 작업은 부모 바로 아래 position 순) → 완료된 할 일(최근 완료가 위, 들여쓰기 없음).
 * 부모가 결과에 없거나(별표 필터) 부모가 완료된 하위 작업은 들여쓰지 않고 최상위처럼 놓는다.
 */
export function arrangeTasks(rows: TaskRow[], sort: TaskSort): TaskOut[] {
  const active = rows.filter((r) => !r.done);
  const activeIds = new Set(active.map((r) => r.id));
  const children = new Map<string, TaskRow[]>();
  const tops: TaskRow[] = [];
  for (const r of active) {
    if (r.parent_id && activeIds.has(r.parent_id)) {
      const arr = children.get(r.parent_id);
      if (arr) arr.push(r); else children.set(r.parent_id, [r]);
    } else tops.push(r);
  }
  tops.sort(comparator(sort));
  const out: TaskOut[] = [];
  for (const t of tops) {
    out.push(taskOut(t, 0));
    for (const ch of (children.get(t.id) || []).sort(comparator("myorder"))) out.push(taskOut(ch, 1));
  }
  const done = rows.filter((r) => r.done).sort((a, b) => cmpStr(b.done_at, a.done_at) || a.position - b.position);
  for (const d of done) out.push(taskOut(d, 0));
  return out;
}
