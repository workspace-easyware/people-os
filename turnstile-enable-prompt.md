# Turnstile 키 발급 + 활성화 (Sonnet)

## 목표
People OS에 Cloudflare Turnstile을 켠다. 질문 기능(`/api/ask`)의 봇 보호용이다. 사용자가 "응 해줘"로 승인했다.

## 현재 상태 (2026-11-19 확인됨)
- Worker 시크릿 목록에 `TURNSTILE_SECRET`이 없다. `wrangler.toml`의 `TURNSTILE_SITEKEY`는 주석 처리돼 있다. 둘 다 없어서 Turnstile은 완전히 꺼져 있다 (fail-open).
- 코드는 이미 완성돼 있다. `src/index.ts`의 `verifyTurnstile`은 비밀 키와 사이트 키가 **둘 다** 있어야 검증을 켠다. 한쪽만 있으면 fail-open. `/api/ask`만 게이트한다. siteverify는 5초 타임아웃, 호출 실패 시 fail-open. 프런트(`public/index.html`의 `initTurnstile`)는 사이트 키가 있을 때만 위젯을 띄우고 토큰을 질문에 붙인다.
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로. 기존 마이그레이션(0001~0033) 수정 금지. `wrangler.toml`의 routes 항목은 제거 상태 유지.

## 할 일
1. **Turnstile 사이트 만들기** — Cloudflare API로 만든다. 계정 ID는 `44501085a1a83d8c0f838a44c1800144`. API 토큰은 `cf-wrangler.py` 헬퍼가 주입하는 것을 쓰거나, 헬퍼가 쓰는 방식을 따라라. (plain `npx wrangler`는 비대화형에서 토큰이 필요해서 쓰지 않는다.)
   - 사이트 이름은 "People OS"로 한다. 모드는 managed(기본값)로 한다.
   - **도메인을 3개 모두 등록해야 한다**: `peopleos.site`, `www.peopleos.site`, `people-os.workspace-easyware.workers.dev`. www를 빼먹으면 www에서 질문이 403으로 막힌다 (Plaud 리디렉션 오류와 같은 함정).
   - API가 도메인을 하나만 받으면, 대시보드 문서를 확인해 여러 도메인을 한 사이트에 넣는 방법을 찾아라. 한 사이트에 3개 도메인을 넣는 것이 목표다. 안 되면 그 사실을 RESULT에 적고 멈추지 말고 대안을 제시해라.
   - 만들 때 받는 **사이트 키(sitekey, 공개 값)**와 **비밀 키(secret, 비공개)**를 받아둔다.
2. **비밀 키 설정** — `TURNSTILE_SECRET`을 Worker 시크릿으로 설정한다. `cf-wrangler.py secret put TURNSTILE_SECRET` 또는 대시보드 방식 중 되는 쪽으로 한다. **비밀 키 값은 채팅·파일·로그에 절대 적지 않는다.**
3. **사이트 키 설정** — `wrangler.toml [vars]`의 주석 처리된 `TURNSTILE_SITEKEY` 줄을 살려서 사이트 키를 넣는다. (사이트 키는 공개 값이라 vars에 넣어도 된다.)
4. **재배포** — `cf-wrangler.py deploy`로 1회 배포한다. 배포 버전 ID를 기록한다. **배포는 직렬로 한 번만.**

## 검증
- `npx tsc --noEmit` 통과.
- 배포 후 라이브에서 `GET /api/config`를 확인해 `turnstileEnabled`가 true이고 `turnstileSitekey`가 null이 아닌지 본다.
- **실제 질문 흐름은 사용자 브라우저에서 확인한다.** 다만 라이브에서 로그인 없이 `/api/ask`에 토큰 없이 질문을 보내면 403 "봇 확인이 아직 끝나지 않았습니다"가 나오는지 확인해 Turnstile 게이트가 실제로 켜졌는지 본다. (토큰 없이 403이 나오면 게이트가 켜진 것이다.)
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 산출물
- `files/workflow-verify/turnstile/RESULT.md`에 이번 작업 내용·검증 결과를 적는다 (사이트 키·비밀 키 값은 적지 않는다. 도메인 3개 등록 여부는 적는다).
- `files/people-os/workflow-agent-builder-PROGRESS.md`에 "Turnstile 활성화" 항목을 한 줄 추가한다.

## 보고 형식 (최종 응답)
- Turnstile 사이트 생성 여부, 등록한 도메인 3개.
- 비밀 키 설정 여부, 사이트 키 설정 여부.
- 배포 버전 ID + 라이브 확인 결과 (`/api/config` turnstileEnabled, 토큰 없는 질문 403 여부).
- 사용자가 브라우저에서 확인할 것 (질문 창에 위젯이 뜨는지, 질문이 정상 동작하는지, 광고 차단기가 Turnstile 스크립트를 막지 않는지).
- RESULT.md 경로.
