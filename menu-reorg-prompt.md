Menu reorganization + Library file-list enhancement for People OS. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context (current state — verify by reading public/index.html before changing):
- Sidebar nav has a menu labelled "전사·요약" (data-tab="upload", public/index.html ~line 81). Its section heading is "음성 파일 전사" (~line 128).
- The upload tab mixes: voice file upload (audioFile input + "전사하기" button ~line 132), "샘플 전사본 불러오기" button (id loadSample, ~line 140), title input (docTitle) + textarea (docContent) for pasting transcript/document text (~lines 141-143), "샘플 코칭 전사본 불러오기" button (id loadCoaching, ~line 182), and a "최근 음성 녹음" list (recList, populated from /api/recordings, heading ~line 135) buried below the upload controls.
- The two sample buttons only fill the text box with sample text (via /api/seed) — they do NOT upload or transcribe audio. Users find this confusing because the buttons sit next to the active upload controls.
- The Library shows the user's documents as cards. It is the file browser (R2 has no user separation; access control is via D1 owner_id checked by the Worker — do NOT list the R2 bucket directly).

Task:
1. Rename the sidebar menu label from "전사·요약" to "녹음전사.문서저장" (exact text, with the period). Keep the data-tab="upload" wiring and the section working.
2. Split the upload tab into TWO tabs:
   - Tab "음성파일 전사": audio upload + "전사하기" button + the "최근 음성 녹음" list moved to the TOP of this tab so recent recordings/sessions are visible at a glance without scrolling.
   - Tab "문서 업로드": title input + textarea for pasting text + file upload + the documents list for uploaded files.
   - The tab switch must preserve the existing transcribe/upload/paste behaviour and the recordings list rendering (same /api/recordings source). Default to the voice tab when the menu opens.
3. Sample buttons — keep as demo, make it explicit:
   - Label them clearly as demo samples (e.g. button text "데모용 샘플 전사본 불러오기" and "데모용 샘플 코칭 전사본 불러오기", or keep the button text and add a "데모용 샘플" badge/label next to them).
   - Add a short note next to them: "데모용 샘플입니다. 실제로는 업로드되지 않고 텍스트만 채워집니다." (exact meaning: demo sample, does not actually upload, only fills in text).
   - Do NOT change what the buttons do (still fill the text box via /api/seed).
4. Library — enhance as a file LIST (do NOT build a separate File System menu; the Library IS the file browser):
   - Add a list view (rows, not just cards) showing: name/title, type (전사본 / 업로드 문서 / 덱), date, size (where known), and download + delete actions.
   - Add a type filter (전사본 / 업로드 / 덱 / 전체) and sort by date (newest first).
   - Download and delete must go through the existing Worker access check (D1 owner_id) — never expose a direct R2 URL. If a delete endpoint does not exist, add one (owner-only, and also remove the Vectorize vectors + D1 chunks for that document; if that is too large for this task, make delete remove the D1 document + R2 object and note the vector cleanup as a follow-up).
   - Keep the existing card view working if it is cheap to keep; otherwise replace it with the list view and say so in the report.

Constraints:
- Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells. For D1: `cf-wrangler.py d1 execute people-os-db --remote --command "SQL"`. For deploy: `cf-wrangler.py deploy` (run from the project dir). Do NOT use `wrangler dev` piped through head (orphan workerd). Do NOT use pkill -f.
- Do NOT run a full manual eval (POST /api/obs/evals/runs). The daily manual limit is 5/day and 4 are already used (1 left — save it).
- ADMIN_SECRET is in ~/workspace/user/people-os-admin-secret.txt — read the file into a shell variable when you need it, NEVER print or record its value.
- Do NOT do a git snapshot/push (that is the parent's job at C15).
- Keep the Workers-AI-only principle: no external APIs.
- Local curls need the proxy bypassed: `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl ...`.
- Do NOT change the R2 key layout (no user_id/ prefix migration in this task — that is a separate decision, pending).

Verification (report all results):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- Live-check the menu: sidebar shows "녹음전사.문서저장"; opening it shows the two tabs; the voice tab shows the recent recordings list at the top; the document tab shows the paste/upload controls.
- Confirm the sample buttons still fill the text box (via /api/seed) and the "데모용 샘플 / 업로드되지 않음" note is visible.
- Confirm the Library list view renders with type filter + date sort, and download works for an owned document.
- Report: deployment version ID, files changed, and the per-check results. Note anything you deferred (e.g. vector cleanup on delete) explicitly.
