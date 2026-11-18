// 워크플로우 스케줄 + 이벤트 트리거 (WF-8, 2026-11-18, migration 0028).
//
// - 스케줄: wrangler.toml의 "*/15 * * * *" 크론이 runDueSchedules를 부른다. cron 표현식은 KST 기준.
//   Worker는 UTC로 돌므로 toKst()로 바꾼 뒤 매칭한다.
// - 15분 슬롯 규칙: 틱 시각을 15분 단위로 **내림**해서 매칭한다.
//   09:07 틱 → 09:00으로 내림 → "0 9 * * *"와 맞는다. 09:16 틱 → 09:15 → 안 맞는다.
//   (크론이 몇 분 늦게 와도 같은 슬롯이면 맞는다. 분이 15의 배수가 아닌 cron, 예: "7 9 * * *"는 영영 안 맞는다 — v1 한계.)
// - 중복 방지: last_run_at이 현재 슬롯 안에 있으면 건너뛴다. 갱신은 조건부 UPDATE(원자적 claim)라
//   크론이 동시에 두 번 돌아도 run은 1개다.
// - 모든 실패는 삼킨다(로그만). 스케줄 하나가 틀려도 전체 크론·전사 파이프라인이 죽으면 안 된다.
import { createRun } from "./store";
import { checkWorkflowRateLimit, stepMessage } from "./engine";
import type { Env } from "./types";

export const SLOT_MS = 15 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const EVENT_NAMES = ["transcript_completed"] as const;
const MAX_SCHEDULES_PER_TICK = 100;

/** UTC 시각 → "KST 벽시계 시각을 UTC 필드에 담은" Date. getUTC*()로 읽으면 KST 값이다. (UTC 00:00 → 09:00) */
export function toKst(d: Date): Date {
  return new Date(d.getTime() + KST_OFFSET_MS);
}

/** 시각을 15분 슬롯 시작으로 내린다 (UTC 기준 내림 = KST 기준 내림, 오프셋이 15분의 배수라서). */
export function slotStart(d: Date): Date {
  return new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS);
}

// ── cron 파서 ──
type Field = Set<number>;
const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src: string, min: number, max: number): Field | null {
  const out: Field = new Set();
  if (!src) return null;
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number, hi: number;
    if (m[1] === "*") { lo = min; hi = max; }
    else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-").map(Number);
      lo = a; hi = b;
    } else {
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : max; // "5/10" = 5부터 max까지 10 간격
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

type ParsedCron = { f: Field[]; domStar: boolean; dowStar: boolean };

function parseCron(cron: unknown): ParsedCron | null {
  if (typeof cron !== "string") return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const f: Field[] = [];
  for (let i = 0; i < 5; i++) {
    const p = parseField(parts[i], RANGES[i][0], RANGES[i][1]);
    if (!p) return null;
    f.push(p);
  }
  if (f[4].has(7)) f[4].add(0); // 요일 7 = 일요일
  return { f, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

/** 형식만 본다 ("지금 맞는가"가 아님). API 검증용. */
export function isValidCron(cron: unknown): boolean {
  return parseCron(cron) !== null;
}

/**
 * 5필드 cron(분 시 일 월 요일)이 nowKst(KST 벽시계 Date — toKst 결과)와 맞는지.
 * 지원: * 숫자 , - /  (이름 JAN·MON 미지원). 형식이 틀리면 throw하지 않고 false.
 * 일·요일을 둘 다 제한하면 표준 cron처럼 OR.
 */
export function matchesCron(cron: string, nowKst: Date): boolean {
  try {
    const p = parseCron(cron);
    if (!p) return false;
    const [minF, hourF, domF, monF, dowF] = p.f;
    if (!minF.has(nowKst.getUTCMinutes()) || !hourF.has(nowKst.getUTCHours()) || !monF.has(nowKst.getUTCMonth() + 1)) return false;
    const domOk = domF.has(nowKst.getUTCDate()), dowOk = dowF.has(nowKst.getUTCDay());
    if (!p.domStar && !p.dowStar) return domOk || dowOk;
    return domOk && dowOk;
  } catch {
    return false;
  }
}

// ── 실행 ──
type ScheduleRow = {
  id: string; workflow_id: string; owner_id: string; last_run_at: string | null; cron: string | null; wf_owner: string | null;
};

/** run 생성 + 첫 단계 큐 투입. 속도 제한 초과면 null. */
async function launch(env: Env, ownerId: string, workflowId: string, input: Record<string, unknown>): Promise<string | null> {
  const rl = await checkWorkflowRateLimit(env, ownerId);
  if (!rl.ok) return null;
  const run = await createRun(env.DB, ownerId, workflowId, input);
  try {
    await env.PIPELINE.send(stepMessage(run.id, 0));
  } catch (e) {
    // run은 queued로 남고 정체 청소(sweepStaleWorkflowRuns)가 60분 뒤 failed로 정리한다 (routes.ts와 같은 방식).
    console.error("workflow schedule enqueue failed", run.id, e instanceof Error ? e.message : String(e));
  }
  return run.id;
}

export async function runDueSchedules(env: Env, now: Date): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0;
  try {
    const slot = slotStart(now);
    const slotIso = slot.toISOString();
    const slotKst = toKst(slot);
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.workflow_id, s.owner_id, s.last_run_at, s.cron, w.owner_id AS wf_owner
         FROM workflow_schedules s LEFT JOIN workflows w ON w.id = s.workflow_id
        WHERE s.enabled = 1 AND s.trigger_type = 'schedule' AND w.status = 'active' ORDER BY s.created_at, s.id LIMIT ?`,
    ).bind(MAX_SCHEDULES_PER_TICK).all<ScheduleRow>();
    for (const s of results) {
      try {
        if (!s.cron || !matchesCron(s.cron, slotKst)) continue;
        if (!s.wf_owner || s.wf_owner !== s.owner_id) continue; // 워크플로우 삭제·소유자 변경: 조용히 건너뜀
        if (s.last_run_at && Date.parse(s.last_run_at) >= slot.getTime()) continue; // 이 슬롯에 이미 돌았다
        // 원자적 claim: 같은 슬롯에서 동시에 두 번 불려도 한쪽만 UPDATE에 성공한다.
        const claim = await env.DB.prepare(
          "UPDATE workflow_schedules SET last_run_at = ?, updated_at = datetime('now') WHERE id = ? AND enabled = 1 AND (last_run_at IS NULL OR last_run_at < ?)",
        ).bind(now.toISOString(), s.id, slotIso).run();
        if ((claim.meta?.changes ?? 0) < 1) continue;
        const runId = await launch(env, s.owner_id, s.workflow_id, {});
        if (!runId) {
          // 속도 제한 — run을 만들지 않았으니 claim을 되돌린다.
          await env.DB.prepare("UPDATE workflow_schedules SET last_run_at = ? WHERE id = ?").bind(s.last_run_at, s.id).run();
          skipped++;
          continue;
        }
        created++;
      } catch (e) {
        console.error("workflow schedule failed", s.id, e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    // 0028 미적용(no such table) 등 — 크론이 죽지 않게 삼킨다.
    console.error("runDueSchedules failed", e instanceof Error ? e.message : String(e));
  }
  return { created, skipped };
}

export async function runEventTriggers(env: Env, event: string, input: Record<string, unknown>, ownerId: string): Promise<number> {
  let created = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.workflow_id, s.owner_id, w.owner_id AS wf_owner
         FROM workflow_schedules s LEFT JOIN workflows w ON w.id = s.workflow_id
        WHERE s.enabled = 1 AND s.trigger_type = 'event' AND s.event = ? AND s.owner_id = ? AND w.status = 'active'
        ORDER BY s.created_at, s.id LIMIT ?`,
    ).bind(event, ownerId, MAX_SCHEDULES_PER_TICK).all<{ id: string; workflow_id: string; owner_id: string; wf_owner: string | null }>();
    for (const s of results) {
      try {
        if (!s.wf_owner || s.wf_owner !== s.owner_id) continue;
        const runId = await launch(env, s.owner_id, s.workflow_id, input);
        if (!runId) continue; // 속도 제한: 건너뜀
        await env.DB.prepare("UPDATE workflow_schedules SET last_run_at = ?, updated_at = datetime('now') WHERE id = ?").bind(new Date().toISOString(), s.id).run();
        created++;
      } catch (e) {
        console.error("workflow event trigger failed", s.id, e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    console.error("runEventTriggers failed", e instanceof Error ? e.message : String(e));
  }
  return created;
}
