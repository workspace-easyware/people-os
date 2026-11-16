You are implementing personal-RAG observability for People OS (Cloudflare Workers + D1 + R2 + Vectorize + Workers AI). Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context (already done, do NOT redo):
- Tree-as-metadata is live (deployment v3e85e542). Migration 0017, src/tree.ts, origin 'metadata' traces exist.
- runAsk in src/ask-pipeline.ts accepts origin?: "user" | "eval" | "personal" | "metadata" (line 477), default 'user'. The 'personal' type exists but nothing passes it yet.
- /api/personal/ask is at src/index.ts:968. It calls runAsk WITHOUT an origin, so personal traces are recorded as origin='user' — indistinguishable from HR-window questions. That is the bug to fix.
- Eval items live in D1 table eval_items (columns: id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref, prereq, active, created_at, updated_at). The HR golden set is dataset ds_core_v1 (6 active items). The only personal item is gi_s01_nokia_transcript (tagged placeholder).

Task:
1. Pass origin='personal' in the /api/personal/ask handler when it calls runAsk. Verify no other caller is affected (HR window stays 'user', eval stays 'eval', metadata stays 'metadata').
2. Create a personal golden set of 5-8 eval items in a NEW dataset ds_personal_v1 (do NOT add them to ds_core_v1 — the eval runner runs ds_core_v1 against the shared pool with no viewer, so personal items would fail there). Read the actual personal transcripts from D1 (documents where owner_id is set and kind='transcript') to craft realistic questions. Include:
   - 3-4 transcript-content questions (answerable from a specific transcript, with expected_answer grounded in that transcript).
   - 1-2 no-evidence questions (questions with no answer in any personal document; expected_verdict 'ungrounded').
   - 1-2 cross-user leak isolation checks (a question whose answer lives only in a document the asking user does NOT own — verify it returns no personal content for that user; if you cannot set up a second user cleanly, document the check as manual instead of faking it).
   - Keep the existing gi_s01_nokia_transcript item (check which dataset it is in now; move or copy it into ds_personal_v1 if it is in ds_core_v1).
   - Each item needs: id (gi_p01_..., gi_p02_...), question, expected_answer, expected_sources (chunk/doc ids if known, else empty), expected_verdict ('grounded' for answerable, 'ungrounded' for no-evidence), tags, source ('golden'), active=1.
3. Do NOT build an automated personal eval runner (that needs a viewer-aware run path — a bigger design decision). Just create the dataset + items so they are ready. Note this clearly in your report.

Constraints:
- Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells. For D1: `cf-wrangler.py d1 execute people-os-db --remote --command "SQL"`. For deploy: `cf-wrangler.py deploy` (run from the project dir). Do NOT use `wrangler dev` piped through head (orphan workerd). Do NOT use pkill -f.
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
- Confirm the new dataset ds_personal_v1 exists in D1 with 5-8 active items (SELECT from eval_items WHERE dataset_id='ds_personal_v1').
- For 2-3 of the new personal items, call /api/personal/ask with the item's question and confirm the answer matches the expected_answer (grounded) or correctly reports no evidence (for no-evidence items). Report each check.
- Report: deployment version ID, files changed, D1 counts, trace confirmation, and the per-item verification results. Also clearly note that automated personal eval runs are deferred (need viewer-aware runner).
