// 캘린더 C5 (2026-11-22): 일정 알림. 계획서 calendar-plan.md 4.1.
// Cron(15분, index.ts scheduled()의 "*/15" 분기) → D1 notifications 기록 → Resend 메일. 결재 알림과 같은 표·같은 종 아이콘.
// - 대상: remind_minutes가 있고, 삭제·취소가 아니고, (시작 - remind_minutes분) <= 지금 < 시작 인 일정.
//   종일 일정의 "당일 오전 9시"(remind_minutes < 0)는 알림 시각이 시작(00:00 KST)보다 뒤라, 알림 시각부터 2시간 동안을 대상으로 본다.
// - 받는 사람: 개인 일정 = 소유자 (종 알림 + 메일). 팀 일정 = 활성 사용자 전원 (종 알림만, 메일 없음).
//   구글 일정은 D1에 없으므로 이 크론이 볼 수 없다 — People OS는 구글 일정을 알리지 않는다 (구글이 이미 알린다).
// - 중복 방지: calendar_reminder_log(event_id, occurrence_start, user_id) PK에 INSERT OR IGNORE하고,
//   같은 batch의 다음 문장이 "이번 실행(run_id)이 넣은 로그 행"에만 notifications를 만든다. 크론이 겹치거나 다시 돌아도 한 번만 알린다.
// - 메일: 제목·시각·링크만 (본문 미포함). RESEND_API_KEY가 없으면 건너뛰고 D1 기록만 남긴다.
// 결재 모듈(src/approval/notify.ts)은 고치지 않고 sendEmail만 같이 쓴다.
import { EMAIL_DOMAIN, sendEmail } from "../email/send";
import { uid } from "../lib";
import { pushNotification, type PushEnv } from "../notifications/push";

export type CalendarNotifyEnv = PushEnv & { DB: D1Database; RESEND_API_KEY?: string; APP_ORIGIN?: string };

const KST_MS = 9 * 3600_000;
const MIN_MS = 60_000;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
/** remind_minutes 상한(40320분 = 28일, routes.ts validate) — 이보다 먼 일정은 볼 필요가 없다. */
const LOOKAHEAD_MS = 28 * 86400_000;
/** remind_minutes 하한(-1440분) + 뒤늦은 알림 허용 2시간 — 이미 시작한 종일 일정을 찾는 범위. */
const LOOKBACK_MS = 26 * 3600_000;
const LATE_GRACE_MS = 2 * 3600_000;
const MAX_EVENTS_PER_TICK = 100;
const MAX_MAILS_PER_TICK = 10;
const MAX_PUSH_PER_TICK = 20;
const DEFAULT_ORIGIN = "https://peopleos.site";

type DueRow = {
  id: string; owner_id: string; visibility: string; title: string; all_day: number;
  start_at: string; start_date: string | null; remind_minutes: number;
};

function utcIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

/** "11/20(금) 14:00" (KST). 종일이면 "11/20(금) 종일". */
export function reminderWhen(r: { all_day: number; start_at: string; start_date: string | null }): string {
  const k = new Date(Date.parse(r.start_at) + KST_MS);
  const day = `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${WEEKDAYS[k.getUTCDay()]})`;
  if (r.all_day === 1) return `${day} 종일`;
  return `${day} ${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

export function reminderTitle(r: { title: string; all_day: number; start_at: string; start_date: string | null }): string {
  const when = reminderWhen(r);
  const max = 300 - "[일정]  · ".length - when.length;
  return `[일정] ${r.title.slice(0, Math.max(10, max))} · ${when}`;
}

export function eventLink(eventId: string): string {
  return `/#calendar/${encodeURIComponent(eventId)}`;
}

/** 지금 알려야 하는 일정인가. */
export function isDue(r: { start_at: string; remind_minutes: number }, nowMs: number): boolean {
  const start = Date.parse(r.start_at);
  if (Number.isNaN(start)) return false;
  const remindAt = start - r.remind_minutes * MIN_MS;
  if (nowMs < remindAt) return false;
  // 보통은 시작 전까지만. 알림 시각이 시작보다 뒤(종일 "당일 오전 9시")면 알림 시각부터 2시간.
  const until = r.remind_minutes < 0 ? remindAt + LATE_GRACE_MS : start;
  return nowMs < until;
}

function appOrigin(env: CalendarNotifyEnv): string {
  const v = (env.APP_ORIGIN || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(v) ? v : DEFAULT_ORIGIN;
}

export type ReminderRunResult = { runId: string; due: number; notified: number; mailed: number; mailSkipped: number };

/** 15분 크론 한 틱. now는 event.scheduledTime (시험에서는 임의 시각). 던지지 않는다 — 호출자가 catch하지만 여기서도 단계별로 막는다. */
export async function runCalendarReminders(env: CalendarNotifyEnv, now: Date): Promise<ReminderRunResult> {
  const nowMs = now.getTime();
  const runId = uid("crn");
  const out: ReminderRunResult = { runId, due: 0, notified: 0, mailed: 0, mailSkipped: 0 };

  const rows = await env.DB.prepare(
    `SELECT id, owner_id, visibility, title, all_day, start_at, start_date, remind_minutes
     FROM calendar_events
     WHERE remind_minutes IS NOT NULL AND deleted_at IS NULL AND status = 'CONFIRMED'
       AND start_at > ?1 AND start_at <= ?2
     ORDER BY start_at LIMIT 500`,
  ).bind(utcIso(nowMs - LOOKBACK_MS), utcIso(nowMs + LOOKAHEAD_MS)).all<DueRow>();
  const due = (rows.results || []).filter((r) => isDue(r, nowMs)).slice(0, MAX_EVENTS_PER_TICK);
  out.due = due.length;
  if (!due.length) return out;

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const r of due) {
    // 1) 로그: 개인 = 소유자(활성일 때만), 팀 = 활성 사용자 전원. 이미 있는 행은 무시된다 (run_id도 그대로).
    stmts.push(
      r.visibility === "team"
        ? env.DB.prepare(
            `INSERT OR IGNORE INTO calendar_reminder_log (event_id, occurrence_start, user_id, run_id)
             SELECT ?1, ?2, u.id, ?3 FROM users u WHERE u.status = 'active'`,
          ).bind(r.id, r.start_at, runId)
        : env.DB.prepare(
            `INSERT OR IGNORE INTO calendar_reminder_log (event_id, occurrence_start, user_id, run_id)
             SELECT ?1, ?2, u.id, ?3 FROM users u WHERE u.id = ?4 AND u.status = 'active'`,
          ).bind(r.id, r.start_at, runId, r.owner_id),
    );
    // 2) 알림: 이번 실행이 방금 넣은 로그 행에만.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO notifications (id, user_id, type, ref_type, ref_id, title, body, link, created_at)
         SELECT 'ntf_' || lower(hex(randomblob(10))), l.user_id, 'CALENDAR_REMINDER', 'calendar_event', ?1, ?2, NULL, ?3, ?4
         FROM calendar_reminder_log l WHERE l.event_id = ?1 AND l.occurrence_start = ?5 AND l.run_id = ?6`,
      ).bind(r.id, reminderTitle(r), eventLink(r.id), nowIso, r.start_at, runId),
    );
  }
  await env.DB.batch(stmts);

  // 이번 실행이 만든 알림 (푸시·메일 대상). 개인 일정만 메일을 보낸다.
  const made = await env.DB.prepare(
    `SELECT n.id, n.user_id, n.title, n.link, n.created_at, e.visibility, u.email
     FROM calendar_reminder_log l
     JOIN notifications n ON n.type = 'CALENDAR_REMINDER' AND n.ref_id = l.event_id AND n.user_id = l.user_id AND n.created_at = ?2
     JOIN calendar_events e ON e.id = l.event_id
     JOIN users u ON u.id = l.user_id
     WHERE l.run_id = ?1 LIMIT 2000`,
  ).bind(runId, nowIso).all<{ id: string; user_id: string; title: string; link: string | null; created_at: string; visibility: string; email: string }>();
  const list = made.results || [];
  out.notified = list.length;

  // 종 아이콘 실시간 푸시 (실패는 무시 — 폴링이 폴백). 팀 일정은 사람 수만큼이라 틱당 20건까지만 민다
  // (같은 틱에 워크플로우·구글 대조도 돈다 — 호출당 하위 요청 한도를 넘기지 않게). 나머지는 화면의 폴링으로 보인다.
  await Promise.all(list.slice(0, MAX_PUSH_PER_TICK).map((n) => pushNotification(env, n.user_id, {
    id: n.id, type: "CALENDAR_REMINDER", title: n.title, body: null, link: n.link, created_at: n.created_at,
  })));

  const mails = list.filter((n) => n.visibility !== "team");
  if (!mails.length) return out;
  if (!env.RESEND_API_KEY) {
    console.log(`[calendar:notify] RESEND_API_KEY 없음 — 메일 ${mails.length}건 건너뜀 (D1 기록만)`);
    out.mailSkipped = mails.length;
    return out;
  }
  const origin = appOrigin(env);
  for (const n of mails.slice(0, MAX_MAILS_PER_TICK)) {
    try {
      await sendEmail(env, {
        from: `"People OS 일정" <calendar@${EMAIL_DOMAIN}>`,
        to: [n.email],
        subject: n.title,
        text: `${n.title}\n\n일정 열기: ${origin}${n.link || "/#calendar"}\n\n내용은 People OS에서 로그인 후 확인하세요.`,
      });
      await env.DB.prepare("UPDATE notifications SET emailed_at = ? WHERE id = ?").bind(new Date().toISOString(), n.id).run();
      out.mailed++;
    } catch (e) {
      console.log("[calendar:notify] 메일 실패:", n.id, e instanceof Error ? e.message : String(e));
    }
  }
  out.mailSkipped = mails.length - out.mailed;
  return out;
}

/**
 * 하루 한 번 청소 (계획 4.1): 60일 지난 알림 로그, 30일 지난 소프트 삭제 일정(구글 연결 행이 남아 있으면 건너뜀 — 삭제 전파가 아직 안 끝났다),
 * 하루 지난 OAuth state. 멱등.
 */
export async function sweepCalendar(env: { DB: D1Database }, now: Date): Promise<void> {
  const nowMs = now.getTime();
  const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " "); // datetime('now') 형식
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calendar_reminder_log WHERE created_at < ?").bind(sqlTime(nowMs - 60 * 86400_000)),
    env.DB.prepare(
      `DELETE FROM calendar_events WHERE deleted_at IS NOT NULL AND deleted_at < ?
         AND NOT EXISTS (SELECT 1 FROM calendar_event_links l WHERE l.event_id = calendar_events.id)`,
    ).bind(sqlTime(nowMs - 30 * 86400_000)),
    env.DB.prepare("DELETE FROM calendar_oauth_states WHERE created_at < ?").bind(nowMs - 86400_000),
  ]);
}

/** 청소를 돌릴 틱인가: KST 04:00 (UTC 19:00) 틱 하나. */
export function isSweepTick(now: Date): boolean {
  return now.getUTCHours() === 19 && now.getUTCMinutes() < 15;
}
