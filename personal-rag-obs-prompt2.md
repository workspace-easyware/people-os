Continuation of personal-RAG observability for People OS. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

ALREADY DONE (do NOT redo — verify it is still in place):
- src/index.ts line ~990 (/api/personal/ask): passes `origin: "personal"` to runAsk.
- src/ask-pipeline.ts line ~523: `const isUserPath = origin === "user" || origin === "personal"` used in the three places that checked `origin === "user"` (intent router ~624, topic guard ~658, rerank ~815). Without this, 'personal' would silently disable the router/guard/rerank for personal asks.
- `npx tsc --noEmit` passes with 0 errors.

WHY YOU ARE RUNNING: the previous session could not run any remote cf-wrangler command (settings.json had no Bash allow rule for cf-wrangler.py, so every remote call was denied with "This command requires approval"). That rule has NOW been added (`Bash(/home/hatch/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py *)`), so remote commands work in this session. Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells.

REMAINING TASK:
1. Read the personal transcripts from D1 (documents where owner_id IS NOT NULL and kind='transcript') and check the current gi_s01_nokia_transcript eval item (which dataset it is in).
2. Create a personal golden set of 5-8 eval items in a NEW dataset ds_personal_v1 (do NOT add them to ds_core_v1 — the eval runner runs ds_core_v1 against the shared pool with no viewer, so personal items would fail there). Use the actual personal transcripts to craft realistic questions. Include:
   - 3-4 transcript-content questions (answerable from a specific transcript, expected_answer grounded in that transcript).
   - 1-2 no-evidence questions (no answer in any personal document; expected_verdict 'ungrounded').
   - 1-2 cross-user leak isolation checks (a question whose answer lives only in a document the asking user does NOT own — verify it returns no personal content for that user; if you cannot set up a second user cleanly, document the check as manual instead of faking it).
   - Keep the existing gi_s01_nokia_transcript item (move or copy it into ds_personal_v1 if it is in ds_core_v1).
   - Each item: id (gi_p01_..., gi_p02_...), question, expected_answer, expected_sources (chunk/doc ids if known, else empty), expected_verdict ('grounded' for answerable, 'ungrounded' for no-evidence), tags, source ('golden'), active=1. eval_items columns: id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref, prereq, active, created_at, updated_at.
3. Deploy. Report the deployment version ID.
4. Do NOT build an automated personal eval runner (needs a viewer-aware run path — deferred). Just create the dataset + items.

Constraints:
- Do NOT run a full manual eval (POST /api/obs/evals/runs). The daily manual limit is 5/day and 4 are already used (1 left — save it). Do NOT re-run evals to chase a higher score (Goodhart rule).
- ADMIN_SECRET is in ~/workspace/user/people-os-admin-secret.txt — read the file into a shell variable when you need it, NEVER print or record its value.
- The transcripts belong to hr.jhkang@gmail.com (hr_admin). For verification, use that account. Do NOT create a new test user unless necessary; if you do, delete it and its docs afterward.
- Do NOT do a git snapshot/push (that is the parent's job at C15).
- Keep the Workers-AI-only principle: no external APIs.
- Local curls need the proxy bypassed: `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl ...`.

Verification (report all results):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- Call /api/personal/ask as hr.jhkang@gmail.com with a personal question; confirm the trace shows origin='personal' (GET /api/obs/traces?origin=personal with X-Admin-Secret, or query D1 ask_events WHERE origin='personal').
- Confirm ds_personal_v1 exists in D1 with 5-8 active items (SELECT from eval_items WHERE dataset_id='ds_personal_v1').
- For 2-3 of the new personal items, call /api/personal/ask with the item's question and confirm the answer matches the expected_answer (grounded) or correctly reports no evidence (for no-evidence items). Report each check.
- Report: deployment version ID, files changed, D1 counts, trace confirmation, and the per-item verification results. Also clearly note that automated personal eval runs are deferred (need viewer-aware runner).
