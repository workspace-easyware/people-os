// S4 M2 — 비용 동기화: AI Gateway 로그 REST API → trace_costs (설계서 §7.3).
//
// 필요한 설정 (§C.2 — 값은 코드·문서·명령줄에 넣지 않는다):
//   CF_ACCOUNT_ID  : wrangler.toml [vars] (비밀 아님, M6이 추가)
//   AIG_LOGS_TOKEN : `wrangler secret put AIG_LOGS_TOKEN` (AI Gateway 읽기 권한만)
// 둘 중 하나라도 없으면 {ok:false, error, hint}로 거절하고 아무것도 쓰지 않는다 — 앱은 정상.
//
// 로그 → 이벤트 대조 순서:
//   1) log.metadata.eventId (게이트웨이 사용자 메타데이터 — aiGatewayOptionsWithMeta로 실은 경우)
//   2) ask_events.aig_log_ids 안의 로그 id (runAsk가 env.AI.aiGatewayLogId로 모은 것)
//   3) 둘 다 없으면 event_id NULL로 저장 (게이트웨이 전체 비용 합계에는 들어간다)
// 비용: log.cost가 양수면 그대로(estimated=0). 없거나 0인데 토큰이 있으면 pricing.ts로
// 추정(estimated=1). 토큰도 없으면 cost_usd NULL(estimated=1) — 절대 0으로 채우지 않는다.
// (Workers AI 호출의 cost는 게이트웨이에 비어 있거나 0으로 올 수 있다 — findings §2.)
import { aiGatewayLogsUrl, AI_GATEWAY_ID } from "../ai-gateway";
import { chunk, obsSchemaReady, parseJson, runBatch } from "./db";
import { estimateCostUsd, priceFor } from "./pricing";
import type { ObsEnv } from "./types";

export const COSTS_LAST_SYNC_KEY = "obs_costs_last_sync";
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 20; // 1회 최대 1,000건 — 남으면 다음 동기화가 이어 받는다
/** 답 생성 호출 태그 (ai-gateway.ts tags). 토큰 backfill은 이 태그(또는 태그 모름)만. */
const ANSWER_TAGS = new Set(["ask", "eval-ask"]);

export type SyncResult =
  | { ok: true; synced: number; estimated: number; matched: number; unmatched: number; tokensBackfilled: number; pages: number; since: string; until: string; truncated: boolean }
  | { ok: false; error: string; hint?: string; status?: number };

/** 게이트웨이 로그 1건 (REST 응답 result[] 항목). workers-types의 AiGatewayLog와 같은 필드명. */
export type GatewayLog = {
  id: string;
  provider?: string;
  model?: string;
  model_type?: string;
  path?: string;
  duration?: number;
  status_code?: number;
  success?: boolean;
  cached?: boolean;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost?: number | null;
  custom_cost?: boolean;
  metadata?: Record<string, unknown> | string | null;
  created_at?: string;
  // 응답에 있으면 쓴다 (문서·타입에 없는 필드는 보장하지 않음)
  tags?: string[] | string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function metaOf(log: GatewayLog): Record<string, unknown> {
  const m = log.metadata;
  if (!m) return {};
  if (typeof m === "string") return parseJson<Record<string, unknown>>(m, {});
  return typeof m === "object" ? (m as Record<string, unknown>) : {};
}

function tagOf(log: GatewayLog, meta: Record<string, unknown>): string | null {
  if (typeof meta.tag === "string") return meta.tag;
  if (Array.isArray(log.tags) && typeof log.tags[0] === "string") return log.tags[0];
  if (typeof log.tags === "string" && log.tags) return log.tags;
  return null;
}

/** log → trace_costs 값. 순수 함수 (단위 테스트·dev 픽스처용). */
export function costRowFromLog(log: GatewayLog, eventId: string | null): {
  aig_log_id: string; event_id: string | null; model: string | null; tag: string | null;
  tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; cached: number | null; duration_ms: number | null; estimated: 0 | 1;
} {
  const meta = metaOf(log);
  const tokensIn = num(log.tokens_in);
  const tokensOut = num(log.tokens_out);
  const gwCost = num(log.cost);
  const hasTokens = (tokensIn ?? 0) > 0 || (tokensOut ?? 0) > 0;
  let cost: number | null = null;
  let estimated: 0 | 1 = 1;
  if (gwCost != null && (gwCost > 0 || (!hasTokens && log.cached === true))) {
    // 게이트웨이가 계산한 값. 캐시 적중(토큰 0)의 0은 실제 0이라 그대로 둔다.
    cost = gwCost;
    estimated = 0;
  } else {
    cost = log.cached === true ? null : estimateCostUsd(log.model, tokensIn, tokensOut);
    estimated = 1;
  }
  return {
    aig_log_id: String(log.id),
    event_id: eventId,
    model: log.model ?? null,
    tag: tagOf(log, meta),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
    cached: log.cached == null ? null : log.cached ? 1 : 0,
    duration_ms: num(log.duration),
    estimated,
  };
}

async function fetchPage(fetcher: FetchLike, url: string, token: string): Promise<{ ok: true; logs: GatewayLog[]; totalPages: number | null } | { ok: false; status: number; error: string }> {
  const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean; result?: GatewayLog[]; errors?: Array<{ message?: string; code?: number }>;
    result_info?: { page?: number; per_page?: number; count?: number; total_count?: number; total_pages?: number };
  } | null;
  if (!res.ok || !body || body.success === false) {
    const msg = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: msg };
  }
  const info = body.result_info || {};
  const totalPages = num(info.total_pages) ?? (num(info.total_count) != null && num(info.per_page) ? Math.ceil(info.total_count! / info.per_page!) : null);
  return { ok: true, logs: Array.isArray(body.result) ? body.result : [], totalPages };
}

/**
 * AI Gateway 로그를 읽어 trace_costs에 UPSERT한다. 절대 throw하지 않는다.
 * since 기본값: 직전 동기화 시각(meta) 또는 24시간 전.
 */
export async function syncGatewayCosts(
  env: Pick<ObsEnv, "DB"> & Partial<Pick<ObsEnv, "CF_ACCOUNT_ID" | "AIG_LOGS_TOKEN">>,
  opts: { since?: string; until?: string; maxPages?: number; fetcher?: FetchLike; gatewayId?: string } = {},
): Promise<SyncResult> {
  if (!env.AIG_LOGS_TOKEN) {
    return {
      ok: false,
      error: "AIG_LOGS_TOKEN not set",
      hint: "대시보드에서 AI Gateway 읽기 권한 API 토큰을 만든 뒤 `wrangler secret put AIG_LOGS_TOKEN`으로 넣으세요. 그 전까지 비용은 토큰 기반 추정(\"추정\")으로만 표시됩니다.",
    };
  }
  if (!env.CF_ACCOUNT_ID) {
    return { ok: false, error: "CF_ACCOUNT_ID not set", hint: "wrangler.toml [vars]에 CF_ACCOUNT_ID(계정 id, 비밀 아님)를 넣으세요." };
  }
  try {
    if (!(await obsSchemaReady(env.DB))) return { ok: false, error: "obs schema not migrated (0013/0014)", status: 503 };
    const fetcher: FetchLike = opts.fetcher ?? ((u, i) => fetch(u, i));
    const until = opts.until ?? new Date().toISOString();
    let since = opts.since;
    if (!since) {
      const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(COSTS_LAST_SYNC_KEY).first<{ value: string }>().catch(() => null);
      since = row?.value || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    }
    const maxPages = Math.max(1, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, 100));
    const base = aiGatewayLogsUrl(env.CF_ACCOUNT_ID, opts.gatewayId ?? AI_GATEWAY_ID);

    // 로그 id → eventId 대조표: 기간 안(앞뒤 여유 1시간)의 ask_events.aig_log_ids
    const byLogId = new Map<string, string>();
    const sinceSql = new Date(new Date(since).getTime() - 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const evRows = await env.DB.prepare("SELECT id, aig_log_ids FROM ask_events WHERE created_at >= ? AND aig_log_ids != '[]'")
      .bind(sinceSql).all<{ id: string; aig_log_ids: string }>();
    for (const r of evRows.results || []) for (const lid of parseJson<string[]>(r.aig_log_ids, [])) byLogId.set(lid, r.id);

    let synced = 0, estimated = 0, matched = 0, unmatched = 0, tokensBackfilled = 0, pages = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const qs = new URLSearchParams({
        start_date: since, end_date: until, per_page: String(PER_PAGE), page: String(page),
        order_by: "created_at", order_by_direction: "asc",
      });
      const res = await fetchPage(fetcher, `${base}?${qs}`, env.AIG_LOGS_TOKEN);
      if (!res.ok) {
        if (pages === 0) return { ok: false, error: `AI Gateway logs API: ${res.error}`, status: res.status };
        truncated = true; // 앞 페이지는 이미 저장됨 — 다음 동기화가 이어 받는다
        break;
      }
      pages++;
      const stmts: D1PreparedStatement[] = [];
      for (const log of res.logs) {
        if (!log || !log.id) continue;
        const meta = metaOf(log);
        const eventId = (typeof meta.eventId === "string" && meta.eventId) || byLogId.get(String(log.id)) || null;
        const row = costRowFromLog(log, eventId);
        if (eventId) matched++; else unmatched++;
        if (row.estimated) estimated++;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO trace_costs (aig_log_id, event_id, model, tag, tokens_in, tokens_out, cost_usd, cached, duration_ms, estimated, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(aig_log_id) DO UPDATE SET event_id = COALESCE(excluded.event_id, trace_costs.event_id), model = excluded.model,
               tag = COALESCE(excluded.tag, trace_costs.tag), tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
               cost_usd = excluded.cost_usd, cached = excluded.cached, duration_ms = excluded.duration_ms, estimated = excluded.estimated,
               synced_at = excluded.synced_at`,
          ).bind(row.aig_log_id, row.event_id, row.model, row.tag, row.tokens_in, row.tokens_out, row.cost_usd, row.cached, row.duration_ms, row.estimated),
        );
        // §7.2: 바인딩 응답에 usage가 없어 ask_events 토큰이 NULL이면 생성 모델 로그로 채운다.
        // 답 생성 로그만 쓴다: 태그를 알고 그것이 ask/eval-ask가 아니면(예: eval-judge가 같은
        // eventId 메타데이터를 실은 경우) 건너뛴다 — judge 토큰이 답 토큰으로 들어가면 안 된다.
        const p = priceFor(row.model);
        const answerLog = row.tag == null || ANSWER_TAGS.has(row.tag);
        if (eventId && answerLog && p && p.outPerM > 0 && (row.tokens_in != null || row.tokens_out != null)) {
          stmts.push(
            env.DB.prepare(
              "UPDATE ask_events SET prompt_tokens = COALESCE(prompt_tokens, ?), completion_tokens = COALESCE(completion_tokens, ?) WHERE id = ? AND (prompt_tokens IS NULL OR completion_tokens IS NULL)",
            ).bind(row.tokens_in, row.tokens_out, eventId),
          );
          tokensBackfilled++;
        }
        synced++;
      }
      for (const part of chunk(stmts, 50)) await runBatch(env.DB, part);
      if (res.logs.length < PER_PAGE || (res.totalPages != null && page >= res.totalPages)) break;
      if (page === maxPages) truncated = true;
    }
    if (!truncated) {
      await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(COSTS_LAST_SYNC_KEY, until).run();
    }
    return { ok: true, synced, estimated, matched, unmatched, tokensBackfilled, pages, since, until, truncated };
  } catch (e) {
    return { ok: false, error: `cost sync failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type CostSummary = {
  usd: number | null; // null = 모름 (—로 표시)
  estimated: boolean; // 하나라도 추정이면 true → 화면 "추정"
  source: "gateway" | "pricing" | "none";
  logs: number;
};

/**
 * 이벤트 1건의 비용 요약. trace_costs가 있으면 그 합(하나라도 추정이면 estimated),
 * 없으면 ask_events 토큰 × 단가표 추정, 그것도 없으면 usd null.
 */
export function summarizeEventCost(
  costRows: Array<{ cost_usd: number | null; estimated: number }>,
  fallback: { model: string | null; promptTokens: number | null; completionTokens: number | null },
): CostSummary {
  if (costRows.length > 0) {
    const known = costRows.filter((r) => r.cost_usd != null);
    const usd = known.length ? known.reduce((a, r) => a + (r.cost_usd as number), 0) : null;
    return { usd: usd == null ? null : Math.round(usd * 1e9) / 1e9, estimated: costRows.some((r) => r.estimated === 1) || known.length < costRows.length, source: "gateway", logs: costRows.length };
  }
  const est = estimateCostUsd(fallback.model, fallback.promptTokens, fallback.completionTokens);
  if (est != null) return { usd: est, estimated: true, source: "pricing", logs: 0 };
  return { usd: null, estimated: false, source: "none", logs: 0 };
}
