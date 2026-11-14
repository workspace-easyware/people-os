# S4 M4 — findings (judge · verdict · runner · guards)

Date: 2026-11-14. Scope: verification of M4's files `src/obs/{judge,verdict,guards,runner,gaps,prompts,routes-evals}.ts` against S4-OBSERVABILITY-EVAL-PLAN.md §6 and §9.4.
Verification was local only (a throwaway harness worker, `wrangler dev --local --port 8789`, with its own local D1 built by migrations 0001–0014). The harness has been deleted. Nothing was deployed, and no remote migrations were run.

## O1 — Cloudflare Clef (verdict engine)

**Catalog (verified by the orchestrator, not re-derived here):** `wrangler ai models` (wrangler 4.162.0) lists `@cf/cloudflare/clef`, plus `clef-omni` and `clef-flash`. The catalog entry: 27B multimodal decision model, 65,536-token context, $0.24 per million input tokens, no output charge, 209.3 ms median latency. Documented binding shape:

```
env.AI.run("@cf/cloudflare/clef", { model: "clef", state: string,
  questions: { <id>: { type: "noul"|"choice"|"score", instructions: string, criteria?: {<option>: string} | string[] } } })
→ response.answers.<id>   (1–64 questions per request; choice = chosen option + per-option probabilities + confidence)
```

The installed `@cloudflare/workers-types` 4.20260702.1 has no Clef entry (0 matches), so the types cannot confirm it.

**Live probe (exactly 1 call): FAILED. It never reached Cloudflare.**

- Path: the harness worker's `env.AI` binding under `wrangler dev --local`, using the project-local wrangler **3.114.17**. It is not 4.162.0.
- Input: `model: "clef"`, `state` = a short HR Q&A case (연차 3일 전 신청 question, answer, and 제12조 evidence), and one `choice` question `verdict` with criteria for `grounded / partial / ungrounded / off_topic`.
- Result after 12 ms:
  `InferenceUpstreamError: Error: Not logged in. at requireLoggedIn (…/people-os/node_modules/wrangler/wrangler-dist/cli.js:93107) at performApiFetch … at AIFetcher …`
- Meaning: wrangler's local AI proxy needs an authenticated wrangler session or `CLOUDFLARE_API_TOKEN`. This session has neither, and the stored-token wrapper is outside this session's allowed directories. The failure is in the proxy's auth check. It says nothing about whether the model exists or what its input shape is. The response shape (`answers.verdict`) is **still unobserved**.

**Decision: `CLEF_VERIFIED = false`, and the verdict engine stays `llm-fallback`** (llama-4-scout, a 4-way JSON enum classification).

What did change in `verdict.ts`, all behind the `CLEF_VERIFIED` gate, so runtime behaviour is unchanged:

- `buildClefInput()` now sends the documented shape `{model:"clef", state, questions:{verdict:{type:"choice", instructions, criteria:{grounded,partial,ungrounded,off_topic}}}}`. Before, it sent `{messages}`, which does not match the documentation.
- New `parseClefAnswer()` reads `answers.verdict` (or `response.answers.verdict`) tolerantly, because the field names are undocumented and unobserved. It accepts a plain string, `{choice|answer|option|value|label}`, or the arg-max of `probabilities`. Any value outside the four options returns null.
- `detectVerdictEngine()` probes with a real one-item case instead of `"probe"` and parses with `parseClefAnswer`. `classifyVerdict()` uses `parseClefAnswer` on the clef path.

**To flip it:** with a logged-in binding (for example the deployed worker, or `wrangler dev` with a token), make one call to `buildClefInput()` and check that `parseClefAnswer()` returns a verdict. Then set `CLEF_VERIFIED = true`. If the real field names differ, adjust `parseClefAnswer` only. Runs record the engine in `config_json.verdict_engine` once per run, so engines never mix within a run.

## O2 — llama-4-scout JSON mode

- **workers-types (4.20260702.1):** `Ai_Cf_Meta_Llama_4_Scout_17B_16E_Instruct_{Prompt,Messages}` both have `response_format?: { type?: "json_object" | "json_schema"; json_schema?: unknown }` (index.d.ts:8420, 8462–8465, 8602). The declared output is `response: string` (index.d.ts:8891). In JSON mode the binding may return `response` as an already-parsed object, so the parser accepts both.
- **Live behaviour: not observed.** Any live call through the harness binding fails with the same "Not logged in" error as O1. I did not make a llama call, because it would only have repeated that auth failure.
- **Code behaviour (verified with fake AI responses in the harness):**
  - The judge sends `response_format: {type:"json_schema", json_schema: JUDGE_JSON_SCHEMA}` and `temperature: 0` first.
  - If the call is rejected (throws), the next attempt uses the prompt-only path: same schema described in the system prompt, no `response_format`, and the first `{…}` is extracted, with code fences stripped.
  - A parse failure is retried once. After 2 attempts the result is `error='judge_parse'` and no score.
  - `config_json.judge_json_mode = "json_schema+prompt-fallback"`. Per-item `judge_reason` gets the prefix `[json_mode=prompt]` when the fallback was used.
  - The verdict fallback works the same way: json_schema first, and a prompt-only retry if the call throws.
- **Still to check live (M6-β or deploy):** whether llama-4-scout accepts `json_schema` with an `enum` on a number field (`score`). If it rejects that, the prompt path takes over automatically.

## §9.4 acceptance — results (local harness)

79 checks: 38 judge/verdict unit checks, 33 runner/guard checks, 8 real-`runAsk` checks. **All pass.**

| # | Criterion | Result |
|---|---|---|
| ① | judge: score is one of the 11 values; 0.75→0.7 (`snapped`), 0.99→0.9, dimension 0.85→0.8; valid object, code-fenced string, malformed JSON, no JSON, out of range (1.5, −0.1), missing dimension; 1 retry then `judge_parse`; json_schema rejected → prompt path; call failing twice → `judge_call` | PASS |
| ② | verdict: Clef result recorded here; with `CLEF_VERIFIED=false`, detection makes **no** call and returns `llm-fallback`; `classifyVerdict(..., "clef")` still calls llama (engine is never mixed); engine fixed in `config_json` | PASS (Clef unverified, see O1) |
| ③ | rule table §6.1: ungrounded+no_evidence → rule pass (`judge_skipped='rule'`, no judge or verdict call); ungrounded+grounded → fail, verdict recorded, judge not called; grounded+no_evidence → 0.0 fail (`judge_skipped='no_evidence'`); grounded+grounded → verdict then judge; errors excluded from the pass_rate denominator | PASS |
| ④ | guards: second concurrent run → 409 (startRun and HTTP, with holder runId); daily manual limit → 429 + `Retry-After` header; `meta.eval_max_items=2` → truncated to 2; cron with the same config_hash within 7 days → `skipped` and nothing enqueued (also via `runScheduledEval`); same hash after more than 7 days → runs; manual limit does not apply to cron; `eval_enabled=0` → manual 403, cron refused, `runScheduledEval` skipped, HTTP 403, trace-judge 403; run stuck >60 min → `sweepStaleRuns` sets `partial` and releases the lock, after which a new run can start; abort requires `X-Admin-Secret` (403 without it, `aborted` with it) | PASS |
| ⑤ | redelivery of the same message → `duplicate`, no runAsk or AI call, exactly 1 `eval_results` row, `items_done` = 1; **two concurrent deliveries** of the same message → 1 row; a message for a finished run → ignored | PASS |
| ⑥ | last item → finalize `done`, aggregates computed (pass_rate, items_error), lock released. The base_run_id and regression query code ran, but there was no deliberate pass→fail fixture for regression and no verified/regressed transition test | PARTIAL (finalize path covered; regression transitions not exercised) |
| ⑦ | **real `runAsk`** with AI and Vectorize stubbed to fail (no live calls): `knowledge_gaps` count unchanged; D1 `sessions` and `cache` unchanged; every eval `ask_events` row has `origin='eval'` and `eval_run_id`; runAsk received `recordGap/readCache/writeCache/persistSession=false` and `gatewaySkipCache=true` | PASS |
| ⑧ | local run without AI: grounded item → `error='ask_llm_unavailable (engine=local-template)'`, no score; ungrounded item → no_evidence → rule pass; run ends `partial` | PASS |

Bugs found in M4 code during verification: **none.** Both harness failures were fixture mistakes on my side:

1. An HTTP 429 test posted without `datasetId`, so it got a 404 for the default dataset first.
2. An "ungrounded" question matched the test chunk through runAsk's local D1 fallback (minScore 0). This is how `ask-pipeline.ts` behaves locally, not an M4 issue.

The only M4 code change is the gated Clef input/parse update described under O1. `npx tsc --noEmit` passes after it.

## Notes for M6-β

- `processEvalItem` without a `traceSink` writes the 0013 columns on `ask_events` itself (`origin='eval'`, eval_run_id, status, prompt_version, …). With M2's sink attached, the sink does it. Either way, eval rows stay out of user lists.
- Price constants in `guards.ts` (llama-4-scout $0.27/M in, $0.85/M out) are guard-only estimates. They were not checked against the pricing page in this session.
- The project-local wrangler is 3.114.17, while the catalog check used 4.162.0. Live Workers AI checks from this project directory need a logged-in wrangler or `CLOUDFLARE_API_TOKEN`.
