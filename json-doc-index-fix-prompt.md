Fix the POST /api/documents JSON path so text-input documents create chunks and appear in personal RAG search. Project dir: ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os

Context (verified by parent):
- The JSON path (POST /api/documents, content-type JSON) currently inserts the document into D1 + R2 but NEVER calls indexDocument, so no chunks are created and the document is invisible to RAG. This is a known bug (the file-upload path calls indexDocument; the JSON path does not).
- `indexDocument(env, doc)` is at src/index.ts:862. Signature: indexDocument(env, {id, title, markdown, kind?, ownerId?}) → {chunks, upserted, indexError?}. It splits markdown into chunks, deletes old chunks for the doc, inserts new chunks into D1, embeds via Workers AI, upserts vectors to Vectorize with metadata {user_id: vectorUserIdForDoc(ownerId) ("shared" sentinel when null), pool: poolForDoc(kind, ownerId)}, and best-effort sends a build-tree queue message for kind transcript/file.
- The file-upload path calls it at src/index.ts:636: `indexDocument(c.env, { id, title, markdown: extracted, kind: "file", ownerId })`.
- The JSON path (src/index.ts ~515-545) already computes `ownerId` correctly: asUserId (hr_admin only, via resolveAsUser) → as.target.id; else kind==='transcript' → viewer?.id ?? null; else body.personal===true → viewer?.id ?? null; else null (shared). It also computes `isCoaching`. It inserts into D1 documents and stores content in R2. It just never indexes.
- Personal pool isolation is enforced by indexDocument via ownerId → Vectorize user_id metadata, and by the ask pipeline's user_id filter. Do NOT change the isolation logic — just pass the already-computed ownerId to indexDocument.

Task:
1. In the JSON path of POST /api/documents (after the D1 INSERT succeeds), call `indexDocument(c.env, { id, title, markdown: body.content, kind, ownerId })`. Include the result in the 201 response: add `chunks`, `upserted`, and (only when present) `indexError` to the returned JSON. The document row must still be created even if indexing fails (indexDocument already returns indexError instead of throwing for the embedding/upsert part; the D1 chunk insert inside indexDocument is the part that must happen). Do NOT break the existing response fields (id, title, is_coaching, asUser, r2Stored, fallback).
2. The fix must work for BOTH shared and personal documents: the ownerId passed to indexDocument is the same ownerId already computed (asUserId / viewer / null). Do not hardcode "shared" and do not ignore asUserId.
3. Also handle the transcription path if it has the same gap: when a recording finishes transcribing and creates a document, confirm that document gets indexed (check src/index.ts ~1796 — there is already an indexDocument call there for the recording completion; verify it is actually reached and do not duplicate it).

Verification (do all of these; report each result):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- Create a test document via the JSON path (POST /api/documents, JSON, a distinctive title/content you can search for, e.g. title "JSON 경로 테스트 — 청크 확인용", content with a unique phrase like "JSON 경로 청크 확인 문장 20261116"). Use kind "transcript" and personal=true so it is a personal document. Do this WITHOUT a user session if needed (anonymous → owner null = shared) OR, if you can, as a logged-in user. Report which one you did and the owner_id of the created document.
- Confirm in D1: the document has chunk rows in `chunks` (SELECT COUNT(*) FROM chunks WHERE doc_id = ?), and the chunk text contains the unique phrase.
- Confirm Vectorize upsert: the vectors exist for the chunk ids. You can verify indirectly by querying /api/ask (shared pool) with the unique phrase and confirming the document is returned as a source, OR by checking the upserted count in the response. Report the method and result.
- Confirm retrieval: ask a question containing the unique phrase via /api/ask (shared pool, if the test doc is shared) and confirm the document is cited/grounded. If the test doc is personal (owner set), confirm via /api/personal/ask — but that requires a login session you do not have; if you cannot call it, verify the isolation at the data level instead: confirm the vector metadata has user_id = the owner's id (not "shared") and that a shared-pool ask for the unique phrase does NOT return the personal document. Report clearly which checks you ran and which need the parent's/user's browser.
- Confirm isolation: a shared-pool ask for the personal test document's unique phrase must NOT return it (if the test doc is personal). A personal-pool ask (if you can run one) must return it.
- Clean up: DELETE the test document via /api/documents/:id (or D1 + Vectorize delete) after verification, so no test data remains. Report the cleanup.

Constraints:
- Use the cf-wrangler helper for ALL remote work: ~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py (run it directly, never via python3). Plain `npx wrangler` needs CLOUDFLARE_API_TOKEN and will fail in non-interactive shells. For D1: `cf-wrangler.py d1 execute people-os-db --remote --command "SQL"` or `--file migrations/<f>.sql -y`. For deploy: `cf-wrangler.py deploy` (run from the project dir). Do NOT use `wrangler dev` piped through head (orphan workerd). Do NOT use pkill -f.
- For live curl checks to the deployed URL, use PLAIN `curl` (no env -u proxy prefix) — plain curl works through the proxy for public workers.dev URLs, and settings.json has `Bash(curl *workspace-easyware.workers.dev*)`. For localhost, use `env -u http_proxy ... curl` (only `curl *localhost*` is allowed).
- Do NOT run a full manual eval (POST /api/obs/evals/runs). The daily manual limit is 5/day and 4 are already used (1 left — save it). Do NOT re-run evals.
- ADMIN_SECRET is in ~/workspace/user/people-os-admin-secret.txt — read the file into a shell variable when you need it, NEVER print or record its value. You do NOT have any user's password; do not create accounts, set passwords, or mint sessions. For live verification as a logged-in user, verify via D1 + the admin API only; the parent will do the browser check.
- Do NOT do a git snapshot/push (that is the parent's job).
- Keep the Workers-AI-only principle: no external APIs. Do NOT change the isolation logic (owner_id / Vectorize user_id filter / asUserId).
- Do NOT change the DO sessionKey or the cache key.

Verification (report all results):
- `npx tsc --noEmit` — 0 errors.
- Deploy, report the deployment version ID.
- The test document: its id, title, owner_id, the chunk count in D1, the upserted count in the response, and whether retrieval worked (shared and/or personal) + whether isolation held (shared pool did not return a personal doc).
- Report: deployment version ID, files changed, D1/Vectorize verification, retrieval results, isolation results, cleanup confirmation, and anything you could not live-verify (with the reason).
