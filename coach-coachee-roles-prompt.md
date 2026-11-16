Coach vs Coachee role distinction for People OS. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context:
- Users table (migrations/0015_auth.sql): id, email, name, password_hash, password_salt, role ('hr_admin'|'user'), status ('pending'|'active'|'inactive'), created_at. Role is about ADMIN privilege, not coaching.
- Current users: hr.jhkang@gmail.com (hr_admin), coach.jhkang@gmail.com (user, active), mercer.jhkang@gmail.com (user, active, id a06b2c76-bb16-49ae-ba9f-3fa3f7539881). Mercer was just created as a Coachee; it has NO transcripts or documents and only searches HR regulations.
- Coaching reflection is POST /api/coaching/reflect. It currently produces a COACH-oriented output (questions, patterns, next_questions for the coach to use). There is no coachee version yet.
- Frontend menus are role-based (hr_admin sees observability + user management; regular users see HR RAG, personal transcription, personal RAG, tasks, library, personal search). The menu rendering reads the user from /api/auth/me.
- Admin user management is PATCH /api/admin/users/:id (accepts role + status) and the admin User Management tab in the frontend.

Task:
1. Migration 0018: add `coaching_role` column to users: TEXT NOT NULL DEFAULT 'coachee' CHECK(coaching_role IN ('coach','coachee')). This is ORTHOGONAL to `role` (admin privilege). Do NOT change the `role` column or its CHECK.
2. Set coaching_role values (via D1 after the migration, or via the updated PATCH endpoint): hr.jhkang@gmail.com → 'coach'; coach.jhkang@gmail.com → 'coach'; mercer.jhkang@gmail.com → 'coachee'. Verify with a SELECT.
3. Update GET /api/auth/me (and the login response user object) to include coaching_role so the frontend can render role-based menus.
4. Update PATCH /api/admin/users/:id to accept coaching_role ('coach'|'coachee') alongside role + status. Keep the existing guard (an admin cannot change their own role/status; extend it to coaching_role as well).
5. Update the admin User Management tab in the frontend to include a "코칭 역할" dropdown (코치 / 코칭 대상) in the user edit/create form, wired to the PATCH endpoint. Do NOT create a separate Permission Management menu — role assignment lives in User Management (deliberate decision).
6. Role-based menus in the frontend (read coaching_role from /api/auth/me):
   - Coach (coaching_role='coach'): keep the CURRENT full menus (HR 규정 RAG, 녹음전사.문서저장, 개인 업무 검색, 해야할 일, 라이브러리, 코칭 리플렉션).
   - Coachee (coaching_role='coachee'): show ONLY "HR 규정 RAG" (search) and "코칭 리플렉션" (coachee version). HIDE 녹음전사.문서저장, 개인 업무 검색, 해야할 일, 라이브러리 (the coachee has no personal transcripts/documents). If hiding a menu is a large refactor, hide them by not rendering those nav buttons for coachee and guarding the routes/tabs so a direct hash navigation to a hidden tab falls back to the HR RAG tab.
   - hr_admin sees the admin menus (observability + user management) regardless of coaching_role.
7. Coachee coaching reflection (POST /api/coaching/reflect): determine the mode from the logged-in user's coaching_role (from the session/viewer, never from a client-supplied field).
   - Coach mode (current behaviour, unchanged): input = coaching session transcript; output = questions, patterns, next_questions.
   - Coachee mode (NEW): input = the same coaching session transcript (pasted text, or a sample — the coachee may have no transcripts of their own); output = self-reflection points (자기 성찰 포인트) + an action plan (액션 플랜). Use a different LLM prompt for the coachee that asks for: 2-4 self-reflection points grounded in the transcript, and a concrete action plan (2-4 actions with a suggested timeframe). Return it in a distinct JSON shape (e.g. { mode: 'coachee', reflection_points: [...], action_plan: [...] }) and render it distinctly in the frontend (label it as the coachee's self-reflection + action plan, not the coach's questions).
   - The reflection endpoint must NOT let a user pick the other role's mode via a request field (the mode comes from the server-side coaching_role only).
8. Deploy. Report the deployment version ID.

Constraints:
- Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells. For D1: `cf-wrangler.py d1 execute people-os-db --remote --command "SQL"` (the settings.json Bash rule covers the absolute /home/hatch/... path only). For deploy: `cf-wrangler.py deploy` (run from the project dir). Do NOT use `wrangler dev` piped through head (orphan workerd). Do NOT use pkill -f.
- For live curl checks to the deployed URL, use PLAIN `curl` (no env -u proxy prefix) — plain curl works through the proxy for public workers.dev URLs, and settings.json has `Bash(curl *workspace-easyware.workers.dev*)`. For localhost, use `env -u http_proxy ... curl` (only `curl *localhost*` is allowed).
- Do NOT run a full manual eval (POST /api/obs/evals/runs). The daily manual limit is 5/day and 4 are already used (1 left — save it). Do NOT re-run evals to chase a higher score (Goodhart rule).
- ADMIN_SECRET is in ~/workspace/user/people-os-admin-secret.txt — read the file into a shell variable when you need it, NEVER print or record its value.
- Do NOT create any new user accounts and do NOT set or change any password. Mercer already exists (id a06b2c76-bb16-49ae-ba9f-3fa3f7539881). You do NOT have mercer's password and must not try to obtain, reset, or mint a session for it. For live verification as mercer, verify via D1 (coaching_role value) and via the admin API only; the parent will do the logged-in browser check.
- Do NOT do a git snapshot/push (that is the parent's job at C15).
- Keep the Workers-AI-only principle: no external APIs.

Verification (report all results):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- D1: SELECT email, role, coaching_role, status FROM users ORDER BY email — confirm hr.jhkang=hr_admin/coach, coach.jhkang=user/coach, mercer=user/coachee.
- GET /api/auth/me as hr.jhkang (use the admin secret where the API allows, or verify the me response shape by code inspection + a D1 check) — confirm coaching_role is returned.
- Live-check the deployed frontend JS/HTML: confirm the coachee menu gating exists (e.g. the nav rendering branches on coaching_role) and the User Management form has a coaching_role field.
- Call POST /api/coaching/reflect as a coach (hr.jhkang session if you can obtain one via the admin flow, otherwise verify the prompt branching by code inspection) and confirm the coach output shape is unchanged. For the coachee prompt, verify by code inspection that a coachee gets the self-reflection + action-plan prompt and output shape, and that the mode cannot be overridden by a request field.
- Report: deployment version ID, files changed, D1 verification, and anything you could not live-verify (with the reason).
