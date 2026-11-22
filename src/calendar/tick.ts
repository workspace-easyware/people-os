// 캘린더 C5·C6 (2026-11-22): 15분 크론 틱 한 번에 캘린더가 하는 일. index.ts scheduled()의 "*/15 * * * *" 분기가 부른다.
//   1) 일정 알림 (C5, notify.ts)
//   2) 구글 연결 일정: 밀린 보내기 + 구글 쪽 변경 대조 (C6, google-push.ts) — 구글 시크릿이 없으면 건너뛴다
//   3) 하루 한 번(KST 04:00 틱) 청소
// 단계 하나가 실패해도 다음 단계는 돈다.
import { googleConfigured, type GoogleEnv } from "./google-oauth";
import { runGoogleSyncTick } from "./google-push";
import { isSweepTick, runCalendarReminders, sweepCalendar, type CalendarNotifyEnv } from "./notify";

export type CalendarTickEnv = CalendarNotifyEnv & GoogleEnv;

export async function runCalendarTick(env: CalendarTickEnv, now: Date): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message : String(e) };
      console.error(`[calendar:tick] ${name} failed`, e instanceof Error ? e.message : String(e));
    }
  };
  await step("reminders", () => runCalendarReminders(env, now));
  if (googleConfigured(env)) await step("google", () => runGoogleSyncTick(env, now));
  if (isSweepTick(now)) await step("sweep", () => sweepCalendar(env, now).then(() => "done"));
  const r = out.reminders as { due?: number; notified?: number; mailed?: number } | undefined;
  const g = out.google as { processed?: number } | undefined;
  if ((r && r.due) || (g && g.processed)) {
    console.log(`[calendar:tick] reminders due=${r?.due ?? 0} notified=${r?.notified ?? 0} mailed=${r?.mailed ?? 0} google=${g?.processed ?? 0}`);
  }
  return out;
}
