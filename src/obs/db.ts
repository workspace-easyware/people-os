// S4 관측·평가 D1 공용 헬퍼 (M1 소유).
import type { ObsEnv } from "./types";

export const OBS_TABLES = [
  "trace_spans",
  "trace_retrievals",
  "trace_scores",
  "trace_costs",
  "eval_datasets",
  "eval_items",
  "eval_runs",
  "eval_results",
  "prompt_versions",
  "improvement_actions",
] as const;

export const OBS_SCHEMA_ERROR = "obs schema not migrated (0013/0014)";

let schemaReadyCache = false;

/**
 * 0013/0014 테이블이 모두 있는지 확인한다. 있으면 isolate 수명 동안 결과를 캐시한다
 * (없다는 결과는 캐시하지 않아, 마이그레이션 적용 직후 바로 통과한다).
 * ask_events 새 컬럼(0013)은 trace_spans 존재로 갈음한다 — 같은 파일이라 함께 적용된다.
 */
export async function obsSchemaReady(db: D1Database): Promise<boolean> {
  if (schemaReadyCache) return true;
  try {
    const placeholders = OBS_TABLES.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .bind(...OBS_TABLES)
      .all<{ name: string }>();
    if ((results?.length ?? 0) === OBS_TABLES.length) {
      schemaReadyCache = true;
      return true;
    }
  } catch {
    // 조회 실패는 "준비 안 됨"으로 취급한다 — 앱 전체를 죽이지 않는다.
  }
  return false;
}

/** 테스트용: 캐시를 비운다. */
export function resetObsSchemaCache(): void {
  schemaReadyCache = false;
}

/** 라우터가 쓰는 503 본문. */
export function obsSchemaNotReadyBody(): { ok: false; error: string } {
  return { ok: false, error: OBS_SCHEMA_ERROR };
}

export async function obsEnvReady(env: Pick<ObsEnv, "DB">): Promise<boolean> {
  return obsSchemaReady(env.DB);
}

// ---- 공용 쿼리 헬퍼 -----------------------------------------------------------

/** 접두어가 붙은 짧은 id. 예: uid("evt") → "evt_1a2b3c..." */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** JSON 컬럼을 안전하게 읽는다. 파싱 실패·NULL이면 fallback. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** D1 0/1 정수 → boolean (NULL 유지). */
export function intToBool(v: number | null | undefined): boolean | null {
  return v == null ? null : v !== 0;
}

/** boolean → D1 0/1 (undefined/null은 NULL). */
export function boolToInt(v: boolean | null | undefined): number | null {
  return v == null ? null : v ? 1 : 0;
}

/** 한 번에 묶어 실행(원자적). 빈 배열이면 아무것도 하지 않는다. */
export async function runBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  await db.batch(stmts);
}

/** D1은 바인드 변수 수 한도가 있다 — 큰 INSERT를 n개씩 자른다. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** limit 쿼리값을 [1, max] 범위 정수로 맞춘다. */
export function clampLimit(raw: string | number | null | undefined, def = 50, max = 200): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// ---- 커서 인코딩 ----------------------------------------------------------------
// (created_at, id) 쌍을 base64url JSON으로 감싼다. created_at 내림차순 + id 내림차순 정렬 기준.

export type Cursor = { t: string; id: string };

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(c: Cursor): string {
  return toBase64Url(JSON.stringify(c));
}

/** 잘못된 커서는 null (호출자는 첫 페이지로 취급하거나 400을 돌려준다). */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(fromBase64Url(raw)) as Partial<Cursor>;
    if (typeof v.t === "string" && typeof v.id === "string") return { t: v.t, id: v.id };
  } catch {
    // fallthrough
  }
  return null;
}

/**
 * 커서 페이지네이션: limit+1건을 읽어 다음 커서를 만든다.
 * rows는 (created_at DESC, id DESC)로 정렬된 limit+1건 이하여야 한다.
 */
export function paginate<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeCursor({ t: last.created_at, id: last.id }) };
}
