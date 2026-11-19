# Plaud 빈 목록 진단 코드 (Sonnet)

## 목표
People OS에서 Plaud 녹음 목록이 비어 나오는 원인을 확정하는 진단 코드를 넣고 배포한다. 사용자가 "지금 바로 해서 원인 찾고 정상 운영되도록 해보자"고 승인했다. 진단은 1단계다. 원인 확정 후 실제 수정은 별도 단계로 한다.

## 배경 (진단 결과 요약)
- People OS Plaud 연결은 "연결됨"이고, D1 `plaud_accounts`의 이메일은 Muse 커넥터 계정과 같다 (`google-1096...@plaud.ai`). 토큰 유효(만료 2026-11-20), refresh_token 있음.
- Muse 커넥터로 `list_files`를 부르면 녹음 20건이 나온다 (`{"type":"list","data":[20건]}`). Plaud 웹에도 27건이 보인다. Cloud Sync는 문제가 아니다.
- 그런데 Worker의 `GET /api/plaud/files`는 `ok:true`에 빈 `files`를 돌려준다. 파싱(`normalizeFiles`)은 실제 응답 모양에 대해 정상임을 Node 테스트로 확인했다. `structuredContent` 가설은 틀렸다 (`list_files`에 outputSchema가 없어 서버가 `structuredContent`를 안 준다).
- **가장 유력한 원인**: Worker 토큰이 Muse 토큰의 workspace(`ws_h7z1XH0bw4`, 녹음 20건이 있는 곳)와 다른 빈 workspace에 묶여 있을 가능성. `get_current_user`는 계정 수준이라 되고, `list_files`는 workspace 범위라 비는 것이다. 단, Worker는 `get_current_user`에서 `workspace_id`를 저장하지 않아 D1만으로는 대조할 수 없다. 그래서 진단이 필요하다.

## 할 일
1. **마이그레이션 `0034_plaud_workspace.sql`을 새로 만든다.** `plaud_accounts`에 `workspace_id TEXT` 컬럼을 추가한다. 기존 마이그레이션(0001~0033)은 절대 수정하지 않는다.
2. **`workspace_id`를 저장한다.**
   - `src/plaud/routes.ts`의 `/complete`에서 `get_current_user` 결과의 `workspace_id`(있으면)를 `plaud_accounts`에 저장한다.
   - **이미 연결된 사용자는 `/complete`를 다시 안 거치므로, `/files`에서도 `get_current_user`를 한 번 불러 `workspace_id`를 저장한다.** (목록을 열 때마다 저장하면 된다. 실패해도 목록 조회는 계속 진행한다 — 진단이 목록을 막으면 안 된다.)
   - `get_current_user` 응답에 `workspace_id` 필드가 어떤 이름인지 모르면, 응답 객체의 키를 확인해 workspace를 가리키는 필드(`workspace_id`·`workspaceId`·`ws_id` 등)를 찾아 저장한다. 없으면 NULL로 둔다.
3. **`/files`에서 `list_files` 원시 결과의 구조만 서버 로그로 남긴다.** 최상위 키 목록과 `data` 배열 길이만 로그한다. **녹음 제목·전사·요약 등 내용은 절대 로그에 넣지 않는다.** 예: `[plaud] list_files keys=type,data,page,page_size data_len=0`.
4. **`npx tsc --noEmit` 통과, `cf-wrangler.py deploy`로 1회 배포한다.** 배포 버전 ID를 기록한다. **배포는 직렬로 한 번만.**

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로. 기존 마이그레이션(0001~0033) 수정 금지. `wrangler.toml`의 routes 항목은 제거 상태 유지. Turnstile 설정(`TURNSTILE_SITEKEY`·`TURNSTILE_SECRET`)은 건드리지 않는다.
- **원격 D1에 0034를 적용하기 전에 `migrations list --remote`로 0033까지 적용됐는지 확인한다.** 0034만 새로 적용한다.
- **진단 코드는 임시 성격이다.** 원인 확정 후에는 로그만 남기고 정리한다는 점을 RESULT.md에 적는다.
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 검증
- `npx tsc --noEmit` 통과.
- 배포 후 라이브에서 health 200, `/plaud.js` 200, `/api/plaud/files` 로그인 없이 401을 확인한다.
- **실제 목록 열기는 사용자의 브라우저에서 한다.** 이 세션은 로그인 세션이 없어서 실제 목록을 열어볼 수 없다. 대신 코드만으로 `/files`가 `workspace_id` 저장과 구조 로깅을 하는지 확인한다.

## 산출물
- `files/workflow-verify/plaud-integration/RESULT.md`에 이번 진단 섹션을 추가한다 (마이그레이션 0034, 저장 위치, 로그 형식, 배포 버전 ID).
- `files/people-os/workflow-agent-builder-PROGRESS.md`의 "Plaud 연동" 항목에 진단 배포를 한 줄 추가한다.

## 보고 형식 (최종 응답)
- 마이그레이션 0034 적용 여부, 배포 버전 ID.
- `workspace_id`를 어디에 저장했는지 (`/complete`·`/files`), 로그 형식.
- 사용자가 브라우저에서 할 일: People OS 녹음전사 탭에서 Plaud 목록 새로고침 1회 (이때 `workspace_id`가 저장되고 로그가 남는다).
- 그 뒤 내가 확인할 것: D1의 `workspace_id`가 `ws_h7z1XH0bw4`인지, 로그의 `data_len`이 0인지.
- RESULT.md 경로.
