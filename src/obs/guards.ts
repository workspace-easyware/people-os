// S4 M4 — 평가 실행 비용 가드. 설계: S4-OBSERVABILITY-EVAL-PLAN.md §6.4 "비용 가드".
// 값은 상수 + D1 meta 테이블 덮어쓰기 (eval_max_items, eval_manual_daily, eval_cost_cap_usd, eval_enabled).
import type { ObsEnv } from "./types";

export const MAX_ITEMS_PER_RUN = 30;
export const MANUAL_RUNS_PER_DAY = 5;
export const LOCK_TTL_MS = 30 * 60 * 1000;
export const CRON_SKIP_DAYS = 7;
export const RUN_COST_CAP_USD = 0.5;
export const STALE_RUN_MINUTES = 60;
export const ITEM_GAP_MS = 300;
export const SAMPLE_JUDGE_PER_DAY = 20;
export const TRACE_JUDGE_PER_DAY = 20;
export const LOW_SCORE_THRESHOLD = 0.6;

export const META_EVAL_LOCK = "eval_lock";
export const META_EVAL_ENABLED = "eval_enabled";

// 비용 추정 단가 — **미검증 추정치** (이 세션은 가격 페이지를 열 수 없었다). 가드용 상한
// 계산에만 쓰고 화면 비용 표시는 M2 pricing.ts·AI Gateway 로그가 맡는다.
// llama-4-scout: 입력 $0.27/M, 출력 $0.85/M 로 가정 (확인 필요 — notes/S4-M4-findings.md).
export const EST_PRICE_IN_PER_M = 0.27;
export const EST_PRICE_OUT_PER_M = 0.85;
// 호출 1회 기본 토큰 추정 (usage가 없을 때).
export const EST_TOKENS = {
  ask: { in: 1500, out: 350 },
  judge: { in: 1800, out: 350 },
  verdict: { in: 1300, out: 60 },
} as const;

export function estimateCallUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn * EST_PRICE_IN_PER_M + tokensOut * EST_PRICE_OUT_PER_M) / 1_000_000;
}

/** 실행 시작 전 상한 추정: 항목마다 ask + verdict + judge 를 모두 부른다고 가정한다(최악). */
export function estimateRunUsd(items: number): number {
  const t = EST_TOKENS;
  return items * (estimateCallUsd(t.ask.in, t.ask.out) + estimateCallUsd(t.judge.in, t.judge.out) + estimateCallUsd(t.verdict.in, t.verdict.out));
}

export type GuardConfig = { enabled: boolean; maxItems: number; manualPerDay: number; costCapUsd: number };

async function metaGet(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function numOr(raw: string | null, def: number, min: number, max: number): number {
  if (raw == null) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export async function loadGuardConfig(env: Pick<ObsEnv, "DB">): Promise<GuardConfig> {
  const [enabled, maxItems, manual, cap] = await Promise.all([
    metaGet(env.DB, META_EVAL_ENABLED),
    metaGet(env.DB, "eval_max_items"),
    metaGet(env.DB, "eval_manual_daily"),
    metaGet(env.DB, "eval_cost_cap_usd"),
  ]);
  return {
    enabled: enabled !== "0",
    // 덮어쓰기로도 기본 상한(30)을 넘기지 못하게 한다 — meta 값은 낮추는 용도.
    maxItems: Math.floor(numOr(maxItems, MAX_ITEMS_PER_RUN, 1, MAX_ITEMS_PER_RUN)),
    manualPerDay: Math.floor(numOr(manual, MANUAL_RUNS_PER_DAY, 0, MANUAL_RUNS_PER_DAY)),
    costCapUsd: numOr(cap, RUN_COST_CAP_USD, 0, RUN_COST_CAP_USD),
  };
}

export async function evalEnabled(env: Pick<ObsEnv, "DB">): Promise<boolean> {
  return (await metaGet(env.DB, META_EVAL_ENABLED)) !== "0";
}

// ---- KST 날짜 · 일일 카운터 (KV) ---------------------------------------------------------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstDate(now = Date.now()): string {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 다음 KST 자정까지 남은 초 (Retry-After). */
export function secondsUntilKstMidnight(now = Date.now()): number {
  const kst = now + KST_OFFSET_MS;
  const nextMidnight = Math.floor(kst / 86_400_000 + 1) * 86_400_000;
  return Math.max(1, Math.ceil((nextMidnight - kst) / 1000));
}

export type DailyKind = "manual" | "sample" | "tracejudge";

function dailyKey(kind: DailyKind, now = Date.now()): string {
  return `eval:${kind}:${kstDate(now)}`;
}

export async function dailyCount(env: Pick<ObsEnv, "CACHE">, kind: DailyKind): Promise<number> {
  try {
    const v = await env.CACHE.get(dailyKey(kind));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/** KV get+put이라 동시 호출에 완벽하지 않다 (기존 ask 레이트 리밋과 같은 수준 — 데모 보호용). */
export async function bumpDaily(env: Pick<ObsEnv, "CACHE">, kind: DailyKind, by = 1): Promise<number> {
  const next = (await dailyCount(env, kind)) + by;
  try {
    await env.CACHE.put(dailyKey(kind), String(next), { expirationTtl: 2 * 86_400 });
  } catch {
    /* KV 실패는 무시 — 가드가 느슨해질 뿐 앱은 정상 */
  }
  return next;
}

// ---- 동시 실행 잠금 (meta.eval_lock, CAS) ------------------------------------------------

export type LockValue = { runId: string; expiresAt: number };

export async function readLock(env: Pick<ObsEnv, "DB">): Promise<{ raw: string; value: LockValue } | null> {
  const raw = await metaGet(env.DB, META_EVAL_LOCK);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LockValue;
    if (typeof v.runId === "string" && typeof v.expiresAt === "number") return { raw, value: v };
  } catch {
    /* 깨진 값은 빈 잠금으로 본다 */
  }
  return { raw, value: { runId: "", expiresAt: 0 } };
}

/**
 * 잠금 획득. 다른 실행이 잡고 있고 만료 전이며 그 실행이 아직 queued/running이면 실패(409).
 * 그 외(없음·만료·주인이 이미 끝남)는 compare-and-swap으로 가져온다 — 동시에 두 요청이 와도
 * 한쪽만 이긴다 (INSERT OR IGNORE / UPDATE ... WHERE value = 이전 값).
 */
export async function acquireLock(env: Pick<ObsEnv, "DB">, runId: string, now = Date.now()): Promise<{ ok: true } | { ok: false; holder: string }> {
  const next = JSON.stringify({ runId, expiresAt: now + LOCK_TTL_MS } satisfies LockValue);
  const cur = await readLock(env);
  if (!cur) {
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(META_EVAL_LOCK, next).run();
    if ((ins.meta?.changes ?? 0) === 1) return { ok: true };
    const again = await readLock(env);
    return { ok: false, holder: again?.value.runId || "unknown" };
  }
  if (cur.value.runId && cur.value.expiresAt > now) {
    const holderRun = await env.DB.prepare("SELECT status FROM eval_runs WHERE id = ?").bind(cur.value.runId).first<{ status: string }>();
    if (holderRun && (holderRun.status === "queued" || holderRun.status === "running")) return { ok: false, holder: cur.value.runId };
  }
  const upd = await env.DB.prepare("UPDATE meta SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ?").bind(next, META_EVAL_LOCK, cur.raw).run();
  if ((upd.meta?.changes ?? 0) === 1) return { ok: true };
  const again = await readLock(env);
  return { ok: false, holder: again?.value.runId || "unknown" };
}

/** 자기 잠금만 푼다 (다른 실행이 이미 가져갔으면 건드리지 않는다). */
export async function releaseLock(env: Pick<ObsEnv, "DB">, runId: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM meta WHERE key = ? AND json_extract(value, '$.runId') = ?").bind(META_EVAL_LOCK, runId).run();
  } catch {
    /* 잠금 해제 실패는 만료(30분)로 풀린다 */
  }
}

// ---- Cron 건너뛰기 ---------------------------------------------------------------------

/**
 * config_hash가 직전 cron 실행(건너뛴 것 제외)과 같고 그 실행이 7일 안이면 건너뛴다.
 * 7일이 지나면 설정이 같아도 다시 돌린다 (모델 쪽 변화·드리프트 감지용).
 */
export async function shouldSkipCron(env: Pick<ObsEnv, "DB">, datasetId: string, configHash: string): Promise<{ skip: boolean; lastRunId?: string }> {
  const last = await env.DB.prepare(
    "SELECT id, config_hash, created_at FROM eval_runs WHERE dataset_id = ? AND trigger = 'cron' AND status IN ('done','partial','running','queued') ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(datasetId).first<{ id: string; config_hash: string | null; created_at: string }>();
  if (!last || last.config_hash !== configHash) return { skip: false };
  const ageMs = Date.now() - Date.parse(last.created_at.replace(" ", "T") + "Z");
  return Number.isFinite(ageMs) && ageMs < CRON_SKIP_DAYS * 86_400_000 ? { skip: true, lastRunId: last.id } : { skip: false };
}

// ---- 공용 -------------------------------------------------------------------------------

/** 결정적 JSON (키 정렬) → SHA-256 hex. config_hash용. */
export async function stableHash(obj: unknown): Promise<string> {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(stable(obj)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** X-Admin-Secret 상수 시간 비교 (index.ts adminAllowed와 같은 규칙 — 미설정이면 항상 거부). */
export function adminSecretOk(secret: string | undefined, given: string | undefined): boolean {
  if (!secret || !given || secret.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
