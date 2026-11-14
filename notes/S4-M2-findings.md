# S4 M2 — findings & verification notes (VERIFICATION draft)

Owner: M2 (trace sink · Traces API · Traces UI). Date: 2026-11-14.
Scope of evidence: **type-level + local harness only**. Nothing was deployed, no remote
migration was run, no live Workers AI / AI Gateway call was made (see §6 for what is still open).

Legend: ✅ confirmed · ⚠️ assumed / not yet confirmed · ❌ not supported

---

## 1. O3 — Workers AI binding: `usage`, `aiGatewayLogId`, `GatewayOptions.metadata`

Source: `node_modules/@cloudflare/workers-types` **4.20260702.1** (`index.d.ts`).

| Item | Type-level evidence | Status |
|---|---|---|
| `env.AI.aiGatewayLogId` | `declare abstract class Ai { aiGatewayLogId: string \| null; ... }` | ✅ type · ⚠️ runtime |
| `GatewayOptions.metadata` | `metadata?: Record<string, number \| string \| boolean \| null \| bigint>` (also `collectLog`, `eventId`, `cacheKey`, `cacheTtl`, `requestTimeoutMs`, `retries`) | ✅ type · ⚠️ runtime |
| `usage` on llama-4-scout | `Ai_Cf_Meta_Llama_4_Scout_17B_16E_Instruct_Output.usage?: { prompt_tokens?, completion_tokens?, total_tokens? }` (optional) | ✅ type · ⚠️ runtime |
| `AiGatewayLog` type | `{ id, provider, model, model_type?, path, duration, status_code, success, cached, tokens_in?, tokens_out?, metadata?, step?, cost?, custom_cost?, request_size, response_size, created_at: Date, ... }` | ✅ type |
| Binding-side log read | `env.AI.gateway(id).getLog(logId): Promise<AiGatewayLog>` and `patchLog(logId, {score, feedback, metadata})` | ✅ type · ⚠️ runtime |

**Runtime population is NOT verified.** Local `wrangler dev --local` cannot reach Workers AI
without remote auth, so the harness used a fake `AI` object that mimics these fields. Still to do,
with one live call (admin path like `/api/debug-ai`, at M6): (a) is `usage` present on a
llama-4-scout response through the gateway, (b) is `env.AI.aiGatewayLogId` a non-null string after
`run()` with `gateway` options, (c) does `gateway.metadata` show up on the gateway log.

Fallbacks are already in place and tested locally:
- `usage` missing → `ask_events.prompt_tokens/completion_tokens` stay **NULL** (shown as `—`, never 0);
  cost sync backfills them from the gateway log `tokens_in/out` (`costs.ts`, COALESCE, answer-tag logs only).
- `aiGatewayLogId` missing → `aig_log_ids` stays `[]`; sync matches logs by `metadata.eventId` instead.
- Concurrency risk (§7.3): `aiGatewayLogId` is per-binding "last value" — under concurrent requests in
  one isolate it can be overwritten, so metadata matching is the primary path and log ids are secondary.

**New option found (recommendation for M6):** `env.AI.gateway("people-os").getLog(logId)` returns an
`AiGatewayLog` (with `cost`, `tokens_in/out`) through the **binding** — no `AIG_LOGS_TOKEN` needed.
If it works at runtime, cost sync could avoid the REST token entirely. It needs the log id, so it
inherits the concurrency risk above. Not implemented in M2 (unverified at runtime). Worth one live test.

### Handoff to M6-α (runAsk owner) — metadata is not sent yet
`runAsk` (src/ask-pipeline.ts) still calls `aiGatewayOptions({skipCache, tag})`, so **no
`metadata.eventId` is sent today**. M2 added `aiGatewayOptionsWithMeta({skipCache, tag, metadata})`
(additive; `aiGatewayOptions` output is byte-identical — verified in harness `/__gw`). For the
metadata match path to work, runAsk needs to (1) create `eventId` before the AI calls (today it is
created after), and (2) pass `aiGatewayOptionsWithMeta({..., metadata: { eventId, tag }})`.
Put `tag` in metadata too: the REST log type has no `tags` field, and `costs.ts` reads `metadata.tag`
first (used to keep judge/verdict tokens out of the answer-token backfill). Max 5 metadata keys (helper trims).

## 2. O4 — AI Gateway logs REST API (`GET /accounts/{account_id}/ai-gateway/gateways/people-os/logs`)

**Could not open the API docs in this session** (WebFetch/WebSearch were denied, same as the original
M2 session). So field names are confirmed only **via the `AiGatewayLog` type in workers-types**, which
is the binding's mirror of the same log object. This is strong but indirect evidence.

| Field `costs.ts` reads | Evidence | Status |
|---|---|---|
| `result[].id` | AiGatewayLog.id | ✅ type |
| `cost` | AiGatewayLog.cost?: number | ✅ type · ⚠️ whether Workers AI calls get a non-zero value |
| `tokens_in`, `tokens_out` | AiGatewayLog.tokens_in?/tokens_out? | ✅ type |
| `cached` | AiGatewayLog.cached: boolean | ✅ type |
| `duration` (ms) | AiGatewayLog.duration: number | ✅ type · ⚠️ unit assumed ms |
| `metadata` | AiGatewayLog.metadata?: Record<…> | ✅ type · ⚠️ REST may return it as a JSON **string** — code accepts both |
| `model`, `created_at` | AiGatewayLog.model / created_at | ✅ type |
| `tags` | not in the type | ⚠️ read only if present; prefer `metadata.tag` |
| envelope `{success, result[], errors[], result_info{page, per_page, count, total_count, total_pages?}}` | standard Cloudflare v4 envelope | ⚠️ assumed (code tolerates missing `total_pages`) |
| query `start_date`, `end_date`, `per_page`(≤50), `page`, `order_by=created_at`, `order_by_direction=asc` | from memory of the API reference | ⚠️ **assumed — check against docs before M6** |

Cost handling in `costs.ts` (tested with a fake fetcher, §3):
- `cost > 0` → stored as is, `estimated=0`.
- `cost` missing or `0` with tokens → `pricing.ts` estimate, `estimated=1` (Workers AI may report 0/empty).
- cached hit with 0 tokens and `cost: 0` → real `$0`, `estimated=0`.
- no tokens and no cost → `cost_usd NULL`, `estimated=1` (never filled with 0).

`pricing.ts` unit prices are from memory and **not re-checked** against
https://developers.cloudflare.com/workers-ai/platform/pricing/ (web denied). `checked: null` stays
until someone checks them. The UI always labels these values "추정" (estimated).

**`AIG_LOGS_TOKEN` does not exist yet** (the user creates it at M6 with `wrangler secret put
AIG_LOGS_TOKEN`; `CF_ACCOUNT_ID` goes in `[vars]`). A **live sync could not be tested.** Only the
no-token path and a mocked API were tested.

## 3. Local acceptance results (§9.2) — harness `files/harness-m2` (deleted after the run)

Harness: separate wrangler config (`wrangler dev --local --port 8788`), fresh local D1 with migrations
0001–0014 applied (all ✅), a second D1 with the pre-S4 schema only, `.dev.vars ADMIN_SECRET=test-secret`.
It imported the **real** M2 files from `people-os/src`. AI and Vectorize were fakes (fake log ids,
fake `usage`, 5 Vectorize matches covering kept / below_floor / keyword_gate / dedup / unresolved).

| # | Check | Result |
|---|---|---|
| ① | runAsk + `hooks.traceSink` (grounded) → ask_events 1 row (9 base columns in pre-S4 format) + trace columns (origin, status, prompt_version, model, tokens 812/64, latency_ms, knowledge_epoch, trace_r2_key, aig_log_ids) + 8 spans + 7 retrievals incl. dropped + R2 `traces/<eventId>.json` (`application/json`, customMetadata eventId/origin, prompt messages + raw response) | ✅ |
| ① | no-evidence run → status `no_evidence`, gap_id set, 6 spans (no llm), tokens NULL; eval run → origin `eval`, eval_run_id, tag `eval-ask`; Vectorize-failure run → d1 fallback span, R2 written synchronously when no ctx | ✅ |
| ① | `/api/ask` response body keys unchanged (answer, cached, engine, eventId, grounded, ok, question, searchEngine, sessionId, sessionVia, sources, timings) | ✅ |
| ② | injected batch + R2 failure → base row kept, trace columns NULL, `trace_r2_key` NULL, record() did not throw; injected base-insert failure → no child rows, no throw; no DB binding → no throw; pre-S4 DB → base row only, logged "obs schema not migrated" | ✅ |
| ③ | list: cursor pagination limit=3 over 12 user rows (7 with identical `created_at`) → 4 pages, no overlap, no gap, last `nextCursor:null`; filters origin user/eval/all, status, feedback up/down/none, risk (latest verdict ungrounded/off_topic), q (LIKE-escaped), from/to (date-only = KST midnight); invalid origin/status/feedback/cursor/from → 400 | ✅ |
| ③ | masking: mask self-test 0 failures (RRN, phones, email, account, tokens, dates untouched); email + phone in question/answer/prompt/raw response/feedback comment/score comment → absent from public and admin responses (grep count 0); present only with admin + `?unmask=1` | ✅ |
| ④ | detail: spans in time order, retrievals by stage then rank, `unresolvedCount` from gate attrs, thresholds, tokens, cost (`source:"pricing"`, estimated) before sync; prompt block `restricted: admin_only` for public, masked messages for admin (O5 recommendation); 404 for unknown id | ✅ |
| ⑤ | `aiGatewayLogId` / `usage` / `metadata`: type-level ✅, runtime ⚠️ (§1); fallbacks tested | partial (runtime open) |
| ⑥ | `POST /api/obs/costs/sync` without admin → 401; admin without token → 400 `{ok:false, error:"AIG_LOGS_TOKEN not set", hint}`; app stays healthy afterwards; mocked API: URL/Bearer header correct, matching by log id + metadata, 403 surfaced as error | ✅ |
| — | 503 guard: `/traces`, `/traces/:id`, `/summary`, `/costs/sync` against the pre-S4 DB → `503 {ok:false, error:"obs schema not migrated (0013/0014)"}`; migrated routes unaffected | ✅ |
| ⑦ | traces UI from `dev-traces.html` fixtures | ⚠️ **not rendered in a browser** — Node and the built-in browser could not run against the local server in this session. Assets serve (JS/CSS 200, `.html` → 307 to the pretty path). `traces.js` field reads checked by hand against the real detail/list JSON above (names match). **M6-β: open `/obs/dev-traces.html` once in a browser.** |

Human score: `POST /traces/:id/scores {value:0.7}` → 200; value 3 → 400.

## 4. Bugs found and fixed (M2 files only)

1. **`routes-traces.ts` `/summary` cost was `null` before any sync while the detail showed an estimate.**
   With no `AIG_LOGS_TOKEN` (the situation until M6), the KPI strip showed `—` even though tokens were
   known. Fix: the summary now applies the same per-event rule as the detail (`summarizeEventCost`):
   gateway logs if present, otherwise tokens × pricing (estimated). Verified: 7d user summary
   `cost {usd: 0.000941, estimated: true, logs: 2}`.
2. **`costs.ts` token backfill could take judge/verdict tokens.** Any generation-model log matched to an
   event (e.g. a future `eval-judge` call carrying `metadata.eventId` of the judged trace) could fill NULL
   `prompt_tokens/completion_tokens` with judge tokens. Fix: backfill only from logs whose tag is
   unknown or `ask` / `eval-ask`.

`npx tsc --noEmit` passes after both fixes.

## 5. Notes for other modules / known limits (no change made)

- **`unresolved` outcome**: not in the M1 enum. runAsk drops these candidates and records only a count
  (`gate` span `attrs.unresolved`); the detail API exposes it as `unresolvedCount` and the UI shows
  "원문 없음 N건". The sink accepts `'unresolved'` if a later runAsk sends it (column has no CHECK).
- If the trace batch fails but R2 succeeds, the R2 blob is orphaned (key not stored). Harmless; noted.
- `obsSchemaReady` caches only "ready" per isolate. After migration the guard opens immediately; it never
  re-closes in a running isolate (fine — migrations aren't rolled back).
- `tokensBackfilled` counts attempted backfills, not rows actually changed (COALESCE may no-op).
- The previous M2 session left a scratch harness at `people-os/.wrangler/m2h/` (gitignored). Removed in this run, along with `files/harness-m2/`.

## 6. Still open (must be done live, M6)

1. One live grounded `/api/ask` on the deployed worker → check `usage`, `aiGatewayLogId`, gateway log metadata (O3).
2. Create `AIG_LOGS_TOKEN` (AI Gateway read) + `CF_ACCOUNT_ID` var → one `POST /api/obs/costs/sync` → confirm
   REST field names and query params (§2) and whether Workers AI logs carry `cost` (O4).
3. Check `pricing.ts` against the Workers AI pricing page and set `checked`.
4. M6-α: send `aiGatewayOptionsWithMeta` with `metadata: { eventId, tag }` from runAsk (§1 handoff).
5. Open `/obs/dev-traces.html` in a browser (fixtures + `?live=1`).
