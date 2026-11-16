Per-user identification / attribution across People OS (user request 2026-11-16). Theme: every piece of data should show WHO it belongs to / who did it, especially for the HR Admin who sees everything. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context (verified by parent):
- Users: hr.jhkang@gmail.com (강준호, hr_admin/coach), coach.jhkang@gmail.com (이구름, user/coach), mercer.jhkang@gmail.com (김불꽃, user/coachee). GET /api/users/coaching (login required) returns id/name/email/coaching_role for active users — reuse it for dropdowns.
- `documents` and `recordings` already have `owner_id` (per-user RAG isolation). `reflections` has `coach_id`/`coachee_id` (migration 0020). BUT `tasks`, `knowledge_gaps`, and `ask_events` have NO user column at all — that is the gap this task closes.
- The viewer (logged-in user) is available as `viewer` in runAsk (opts.viewer) and via `getSessionUser(c.env, cookie)` in API handlers. /api/ask passes viewer to runAsk; /api/personal/ask requires login and passes viewer with pool "personal".
- The DO sessionKey hardening (v_ed92d564) already uses `${viewer.id ?? "anon"}:${sessionId}` for the DO + D1 sessions fallback. Do NOT change that.
- The cache key already includes viewer.id. Do NOT change that.

Migration 0021 (new file migrations/0021_user_attribution.sql — apply remotely with `d1 execute --remote --file ... -y` + record in d1_migrations; do NOT use `migrations apply`; check `d1 migrations list people-os-db --remote` first; tracker is in sync as of 0020):
- `ALTER TABLE tasks ADD COLUMN owner_id TEXT;` (nullable; existing tasks stay NULL = "미지정").
- `ALTER TABLE knowledge_gaps ADD COLUMN user_id TEXT;` (nullable; existing gaps stay NULL = "익명").
- `ALTER TABLE ask_events ADD COLUMN user_id TEXT;` (nullable; existing traces stay NULL = "익명").

Task 1 — #upload + #personal: perspective selector (관점 선택).
- Add a "관점" (perspective) selector to the #upload page (document-upload tab + voice-file upload) and the #personal search.
- Regular user: the selector is locked to themselves (their own personal space only). It may be shown as read-only text ("내 개인 공간") or hidden — pick the clearer option.
- HR Admin: a dropdown of all active users (from GET /api/users/coaching). The admin must explicitly select a user; do NOT default to the admin themself. The user's principle: "HR Admin 자신의 업무를 여기에 쌓는 일은 없어야 하고, 개인 업무는 개인 계정에서 처리하는 게 맞다" — the admin acts on behalf of a selected user, not by accumulating work under the admin account.
- Backend: POST /api/documents (JSON + file paths) and POST /api/transcribe accept optional `asUserId` (hr_admin only; must exist in users, else 400). When present, the created document/recording gets owner_id = asUserId (instead of the viewer's id). For a regular user, `asUserId` is ignored (always their own id). POST /api/personal/ask accepts optional `asUserId` (hr_admin only; must exist, else 400). When present, the RAG pool scope is that user's personal documents (the same owner filter the viewer would get, but for asUserId). The DO sessionKey stays the actual requester (viewer.id) — only the RAG pool/scope changes. The personal-search response should include `asUser` (the selected user's name) so the UI can show whose space was searched.
- The #personal search box should show whose perspective it is searching (e.g. "김불꽃의 개인 업무에서 검색" when the admin selected 김불꽃).

Task 2 — #coaching: transcript from #upload.
- The coaching transcript picker ("코칭 전사본 선택" dropdown) currently pulls only coaching-flagged documents from GET /api/documents/coaching. Change it to pull from #upload: return ALL of the user's transcripts (kind='transcript', shared + own; hr_admin sees all), newest first, with coaching-flagged ones listed first and marked with a "코칭" badge. Rename the endpoint's purpose accordingly (keep the same path /api/documents/coaching, but it now returns all transcripts with an `is_coaching` flag on each). The user picks any uploaded transcript as a coaching transcript; the is_coaching flag is a marker, not the source filter.

Task 3 — #tasks: per-user identification.
- POST /api/tasks records the viewer as owner (owner_id = viewer?.id ?? null). Accept optional `ownerId` for hr_admin (to create a task for a user; must exist, else 400).
- GET /api/tasks: hr_admin sees ALL tasks with `owner_name` (LEFT JOIN users on owner_id; null → "미지정"). Regular users see only their own + unowned (owner_id IS NULL) tasks. Add a user filter (query param `?owner=<userId>` or `?owner=unassigned`) for hr_admin; the frontend tasks page gets a user filter dropdown for hr_admin.
- The tasks list shows the owner's name next to each task (for hr_admin; regular users see their own tasks so the name is less critical but still show it).
- /api/home openTasks list: include `owner_name` on each task (same JOIN) so the home page can show it.

Task 4 — #library gaps (답변 대기): tag the asker.
- Record the asker when a gap is created: in ask-pipeline.ts (the knowledge_gaps INSERT) and gaps.ts (the other knowledge_gaps INSERT), set user_id = the viewer (the user who asked the question; null for anonymous/eval). The viewer is available in runAsk as opts.viewer; for the gaps.ts path, pass the viewer through from the caller if needed.
- The gaps API (listGaps) returns `asker_name` on each gap: for knowledge_gaps rows, JOIN users on knowledge_gaps.user_id (null → "익명"); for eval-linked gaps (low_score/regression from eval_results), set asker_name = "평가" (they come from an eval run, not a user question).
- The Library "답변 대기" tab shows "질문자: {asker_name}" on each gap card/row.

Task 5 — #obs/traces: user identification.
- Record the user when a trace is created: in runAsk, the ask_events INSERT (ask-pipeline.ts) and the trace.ts INSERT, set user_id = viewer?.id ?? null. For eval traces (origin='eval'), viewer is null → "평가" is shown by the UI when origin is eval; for anonymous user asks, null → "익명".
- The traces list API returns `user_name` on each trace (LEFT JOIN users on ask_events.user_id). The traces list shows the user's name on each row (with a user filter dropdown for hr_admin). The traces page is visible to everyone, so the distinction must be clear — the user name is shown prominently (not just a tooltip).

Task 6 — #home: per-user distinction (Admin).
- /api/home: for hr_admin, add a `byUser` section: a list of {userId, name, email, documents, tasks, reflections} counts per user (documents = their owned documents, tasks = their owned tasks, reflections = reflections where they are coach or coachee). The frontend home page shows a "사용자별" (per-user) section for hr_admin with these counts. Regular users see the home as now (their own scope).
- The home recent-documents / recent-reflections lists should include the owner's name for hr_admin (JOIN users; the documents list already has owner_id via docOwnerClause — add the name). The home openTasks list already gets owner_name from Task 3.

Constraints:
- Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells. For D1: `cf-wrangler.py d1 execute people-os-db --remote --command "SQL"` or `--file migrations/<f>.sql -y`. For deploy: `cf-wrangler.py deploy` (run from the project dir). Do NOT use `wrangler dev` piped through head (orphan workerd). Do NOT use pkill -f.
- For live curl checks to the deployed URL, use PLAIN `curl` (no env -u proxy prefix) — plain curl works through the proxy for public workers.dev URLs, and settings.json has `Bash(curl *workspace-easyware.workers.dev*)`. For localhost, use `env -u http_proxy ... curl` (only `curl *localhost*` is allowed).
- Do NOT run a full manual eval (POST /api/obs/evals/runs). The daily manual limit is 5/day and 4 are already used (1 left — save it). Do NOT re-run evals.
- ADMIN_SECRET is in ~/workspace/user/people-os-admin-secret.txt — read the file into a shell variable when you need it, NEVER print or record its value. You do NOT have any user's password; do not create accounts, set passwords, or mint sessions. For live verification as a logged-in user, verify via D1 + the admin API only; the parent will do the browser check.
- Do NOT do a git snapshot/push (that is the parent's job at C15).
- Keep the Workers-AI-only principle: no external APIs.
- Do NOT change the DO sessionKey or the cache key.
- Existing data stays NULL for the new user columns (do not backfill guesses — an old task/gap/trace with no recorded user shows as "미지정"/"익명", which is honest).

Verification (report all results):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- D1: confirm `owner_id` on tasks, `user_id` on knowledge_gaps and ask_events; confirm d1_migrations records 0021.
- Live-check the deployed frontend: the perspective selector is on #upload and #personal, the coaching transcript dropdown lists all transcripts (with a 코칭 badge), the tasks list shows owner names, the Library gaps show the asker, the traces list shows the user name, and the home page shows a per-user section for hr_admin.
- Live-check the APIs unauthenticated where safe: GET /api/tasks (should work, tasks are not auth-gated — report what it returns), GET /api/obs/traces (report), GET /api/library (report the gaps asker field). For admin-only checks, use X-Admin-Secret from the file (never print it).
- Report: deployment version ID, files changed, D1 verification, and anything you could not live-verify (with the reason). Note explicitly that existing tasks/gaps/traces show as "미지정"/"익명" (NULL user) and that logged-in flows need the parent's browser check.
