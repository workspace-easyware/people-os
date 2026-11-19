# Plaud 목록 빈 문제 수정 (Sonnet)

## 원인 확정 (진단 로그로 확인됨)
- D1 `plaud_accounts.workspace_id`는 `ws_h7z1XH0bw4`로, 녹음이 있는 워크스페이스와 같다. **워크스페이스 가설은 틀렸다.**
- 서버 로그: `[plaud] list_files keys=text data_len=n/a`.
- 즉 `mcp.call("list_files")`이 `{text: <무언가>}`를 돌려줬다. 이는 `call`의 `JSON.parse(text)`가 실패해서 `{text}` 폴백으로 빠졌다는 뜻이다.
- Muse 커넥터로 받은 `list_files` 응답 text를 보면, JSON 앞에 "The block delimited by <untrusted-user-data-...> below contains user recording data returned verbatim..." 같은 래퍼(프롬프트 인젝션 방어용 마커)가 붙어 있다. Worker가 받는 text도 같은 래퍼가 붙어 있을 가능성이 크고, 그래서 `JSON.parse`가 실패한다.
- `normalizeFiles`는 파싱된 JSON의 `data` 배열을 찾는데, `{text}`에는 `data`가 없어 빈 목록이 된다.

## 할 일
1. **`src/plaud/mcp.ts`의 `call()`을 고친다.** text를 JSON으로 해석할 때 래퍼를 견디게 한다.
   - 먼저 `JSON.parse(text)`를 그대로 시도한다 (깨끗한 JSON이면 그대로 된다).
   - 실패하면, text 안에서 JSON 객체를 추출해서 파싱한다. 가장 바깥쪽 `{`부터 가장 바깥쪽 `}`까지를 잘라내 `JSON.parse`를 다시 시도한다.
   - 그래도 실패하면 기존처럼 `{text}`를 돌려준다 (동작을 바꾸지 않는다).
   - **진단용 로그를 하나 추가한다**: 파싱이 래퍼 경로로 갔을 때만 `[plaud] list_files json extracted from wrapper` 같은 한 줄을 남긴다. text 내용(녹음 제목·전사)은 절대 로그에 넣지 않는다. 첫 100자도 로그에 넣지 않는다.
2. **진단 코드(임시)는 그대로 둔다.** 이번 수정에서는 0034 마이그레이션·`workspace_id` 저장·구조 로깅을 건드리지 않는다. 원인 확정 후 정리하는 건 다음 단계에서 한다.
3. **`npx tsc --noEmit` 통과, `cf-wrangler.py deploy`로 1회 배포한다.** 배포 버전 ID를 기록한다. **배포는 직렬로 한 번만.**

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로. 기존 마이그레이션(0001~0034) 수정 금지. 새 마이그레이션은 만들지 않는다. `wrangler.toml`의 routes 항목은 제거 상태 유지. Turnstile 설정(`TURNSTILE_SITEKEY`·`TURNSTILE_SECRET`)은 건드리지 않는다.
- **`call()`의 다른 동작은 바꾸지 않는다.** `structuredContent` 우선, `isError` 처리, 빈 text 시 `{}` 반환은 그대로 둔다.
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 검증
- `npx tsc --noEmit` 통과.
- 배포 후 라이브에서 health 200, `/plaud.js` 200, `/api/plaud/files` 로그인 없이 401을 확인한다.
- **실제 목록 확인은 사용자의 브라우저에서 한다.** 이 세션은 로그인 세션이 없어서 실제 목록을 열어볼 수 없다.
- 로컬에서 `call()`의 JSON 추출 로직만 단위 테스트한다: 깨끗한 JSON, 래퍼가 붙은 JSON, 둘 다 파싱되는지.

## 산출물
- `files/workflow-verify/plaud-integration/RESULT.md`에 이번 수정 섹션을 추가한다 (원인 확정 내용, 수정 방법, 배포 버전 ID).
- `files/people-os/workflow-agent-builder-PROGRESS.md`의 "Plaud 연동" 항목에 수정 배포를 한 줄 추가한다.

## 보고 형식 (최종 응답)
- 수정 내용 (`call()`의 JSON 추출 로직).
- 배포 버전 ID + 라이브 확인 결과.
- 사용자가 브라우저에서 확인할 것: People OS 녹음전사 탭에서 Plaud 목록 새로고침 → 녹음 20건이 보이는지.
- RESULT.md 경로.
