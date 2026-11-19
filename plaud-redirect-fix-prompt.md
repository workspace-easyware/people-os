# Plaud 연결 리디렉션 주소 수정 (Sonnet)

## 문제
사용자가 `https://www.peopleos.site`에서 "Plaud 연결"을 눌렀더니 오류가 뜬다.
"연결을 시작하지 못했습니다. 이 주소에서는 Plaud 연결을 시작할 수 없습니다 (등록되지 않은 리디렉션 주소)."

원인: DCR로 등록한 redirect URI가 2개뿐이다.
- `https://peopleos.site/api/plaud/callback`
- `https://people-os.workspace-easyware.workers.dev/api/plaud/callback`

그런데 사용자는 `www.peopleos.site`에 있다. 프런트가 현재 origin으로 redirect URI를 만들어서 `https://www.peopleos.site/api/plaud/callback`로 요청하는데, 이 주소가 등록돼 있지 않아 Plaud가 거부한다.

## 고칠 것
- DCR(`POST https://mcp.plaud.ai/register`)을 다시 실행해, redirect URI 3개를 모두 포함한 새 클라이언트를 등록한다.
  - `https://peopleos.site/api/plaud/callback`
  - `https://www.peopleos.site/api/plaud/callback`
  - `https://people-os.workspace-easyware.workers.dev/api/plaud/callback`
- 새 client_id를 `wrangler.toml [vars]`의 `PLAUD_CLIENT_ID`에 넣는다. (client_id는 공개 식별자라 시크릿이 아니다. 기존에도 같은 방식으로 넣었다.)
- 기존 클라이언트는 그대로 둔다. (이미 미사용 클라이언트가 하나 더 있는 상태라, 하나 더 늘어도 무해하다.)
- `cf-wrangler.py deploy`로 재배포한다. 배포 버전 ID를 기록한다.

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로.
- **기존 마이그레이션 파일(0001~0033)은 수정하지 않는다.** 새 테이블이 필요하면 새 마이그레이션을 만든다 (이 수정에서는 필요 없을 것이다).
- **기존 API·동작을 바꾸지 않는다.** redirect URI 목록만 늘린다.
- **wrangler.toml의 routes 항목은 제거 상태 유지.**
- **배포는 직렬로 한 번만.** `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지).
- 토큰·시크릿 값은 채팅·파일·로그에 적지 않는다.

## 검증
- `npx tsc --noEmit` 통과. 프런트 JS는 `node --check` 통과.
- 로컬에서: `www` origin으로 연결 URL을 만들었을 때 redirect URI가 `https://www.peopleos.site/api/plaud/callback`로 정확히 들어가는지 확인한다.
- 배포 후 라이브에서: `GET /api/plaud/status`가 401 없이 동작하는지(로그인 필요), `/plaud.js`가 새 버전인지 확인한다. **실제 Plaud 동의 흐름은 사용자 브라우저에서 확인한다.**
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 산출물
- 검증 산출물을 `files/workflow-verify/plaud-integration/RESULT.md`에 추가할 것 (이번 수정 내용·검증 결과).
- `files/people-os/workflow-agent-builder-PROGRESS.md`의 "Plaud 연동" 항목에 이번 수정을 한 줄 추가할 것.

## 보고 형식 (최종 응답)
- 고친 내용 (새 client_id 등록 여부, redirect URI 3개).
- 배포 버전 ID + 라이브 확인 결과.
- 사용자가 브라우저에서 다시 확인할 것.
- RESULT.md 경로.
