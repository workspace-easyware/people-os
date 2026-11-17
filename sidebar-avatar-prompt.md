Fix the collapsed-sidebar user chip in People OS so it becomes a circle avatar with the first letter of the user's name. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context (verified by parent):
- The sidebar (public/index.html, `<aside class="sidebar" id="sidebar">`) has a bottom `.user-chip` div (id="userChip") containing `.who` (`<b id="userChipName">` + `<span id="userChipMeta">`) and a "로그아웃" button (onclick="doLogout()"). It is shown (display:flex) when logged in, hidden otherwise (public/index.html ~703-711).
- The collapse button (`#collapseBtn`, "« 접기") toggles `.sidebar.collapsed` (public/index.html ~1190-1195, persisted in localStorage). The collapsed sidebar is 48px wide (`--sidebar-w-collapsed: 48px`).
- The problem: `.user-chip` has NO CSS rules at all in public/styles.css, and there is no `.sidebar.collapsed .user-chip` rule. So when the sidebar collapses, the nav labels and logo hide and nav buttons centre, but the user chip (name + meta + 로그아웃 button) stays full-width and does not collapse — it overflows / looks broken.
- The user wants the trendy collapsed style: when collapsed, the user chip becomes a circle with the first letter of the user's name (like a profile avatar), instead of the full name + logout button.

Task:
1. In public/index.html, inside the `.user-chip` div, add a circle avatar element that is shown only when the sidebar is collapsed. Use a `<button class="user-avatar" id="userAvatar" type="button" onclick="doLogout()" title="">` (a button so it is keyboard-accessible and clickable). Its text content is the first letter of the user's name. Its `title` attribute should be the user's name + " · 로그아웃" (so hovering shows who it is and that clicking logs out). The logout must remain reachable when collapsed — clicking the avatar calls doLogout(), which is the existing logout function.
2. In the JS that renders the user chip (public/index.html ~703-711, where userChipName/userChipMeta are set), also set the avatar: `$('userAvatar').textContent = (currentUser.name || '?').trim().charAt(0)` and `$('userAvatar').title = currentUser.name + ' · 로그아웃'`. Guard against an empty name (fallback '?').
3. In public/styles.css, add styling:
   - `.user-chip`: the expanded (uncollapsed) chip — a flex row at the bottom of the sidebar, with a top border, padding, gap; `.who` as a column (name bold, meta small + muted, ellipsis overflow); the 로그아웃 button as a small bordered button. Match the existing design tokens (use the --color-*, --line, --radius-*, --text-* variables already in styles.css; the logo `<b>` uses var(--color-primary) background with white text — use the same navy for the avatar circle).
   - `.user-avatar`: hidden by default (`display:none`), a 32px circle (border-radius:50%), navy background (var(--color-primary)), white text, centred, font-weight bold, cursor pointer, flex:none. It must fit inside the 48px collapsed sidebar with a little margin.
   - `.sidebar.collapsed .user-chip`: centre the chip (justify-content:center, padding adjusted), hide `.who` and the 로그아웃 button (`display:none`), and show the avatar (`display:grid; place-items:center` or flex). The collapsed chip must NOT overflow the 48px sidebar width.
   - Do NOT change the collapse behaviour of the nav, logo, or collapse button. Do NOT change doLogout().
4. Keep the expanded (uncollapsed) appearance as it is today (name + meta + 로그아웃 button) — only add the missing base styling so it looks tidy, and do not change the text content.

Verification (do all of these; report each result):
- `npx tsc --noEmit` — 0 errors (the change is HTML/CSS/JS in the static files; tsc covers the TS, but run it anyway to confirm nothing broke).
- Deploy, report the deployment version ID.
- Verify the live page (curl the deployed index.html + styles.css) contains: the `user-avatar` element, the `.sidebar.collapsed .user-chip` rule, and the `.user-avatar` CSS. Report the exact strings found.
- Do NOT run a full manual eval. Do NOT change any other feature. Do NOT do a git snapshot/push (that is the parent's job).

Constraints:
- Use the cf-wrangler helper for deploy: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). For live curl checks to the deployed URL, use PLAIN `curl` (no env -u proxy prefix). For localhost, use `env -u http_proxy ... curl`.
- The avatar must show the FIRST LETTER of the user's name (Korean name → first syllable, e.g. "강준호" → "강"). Use charAt(0) on the trimmed name.
- The collapsed avatar must be clickable to log out (doLogout) and must have a title tooltip with the name + 로그아웃.
- Do NOT change the DO sessionKey, the cache key, or any auth/RAG logic. This is a pure UI/CSS change.

Verification (report all results):
- `npx tsc --noEmit` result.
- Deployment version ID.
- Live-page checks (user-avatar element, collapsed user-chip CSS rule, avatar CSS) with the exact strings found.
- Anything you could not live-verify (with the reason). Note: the parent will do the browser visual check (collapsed sidebar screenshot) after your deploy.
