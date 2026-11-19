# 화상회의 V0 검증 — RealtimeKit 최소 연결 확인

사용자가 "바로 구현 시작해. 나는 준비 되었다"고 했다. 내일(11-20)로 예정했던 V0 검증을 지금 시작한다. V0가 통과하면 11-21 V1(통화), 11-22~23 V2(전사 연계)로 간다. V0가 실패하면 화상회의는 공모전 뒤로 미룬다.

## 배경

- 계획 문서: `files/people-os/video-conference-plan.md` — 반드시 먼저 읽고 따를 것. 통합 방식은 **RealtimeKit SDK (B안)**.
- RealtimeKit 준비 완료: 앱 "people-os" 생성됨. App ID `f0325814-1db2-4c8e-ba6f-18443d12be13`는 `wrangler.toml`의 `[vars]`에 `RTK_APP_ID`로 있음. API 토큰 "people-os-realtime"은 Worker 시크릿 `RTK_API_TOKEN`으로 저장됨 (값은 채팅·파일에 기록하지 말 것).
- People OS 프런트는 빌드 없는 순수 HTML+JS. 화면은 별도 페이지 `public/meet.html` + `meet.js`로 만든다 (`index.html`에 SDK를 넣지 않는다).
- D1 표 `meetings`는 마이그레이션 번호를 구현 시점의 다음 빈 번호로 쓴다 (0037이 XAI용이라 화상회의는 **0038** 예정).
- 토큰은 URL에 싣지 않고 쿠키로 `POST /api/meet/:id/join`에서 발급한다. SDK는 버전 고정해 `public/vendor/`에 두는 쪽이 안전하다.
- 권한: 만들 수 있는 사람·들어갈 수 있는 사람 모두 그 채팅방 멤버만. 시작한 사람 또는 coach는 호스트 프리셋. `custom_participant_id`에 People OS 사용자 id를 넣어 전사 화자를 이름으로 복원한다.

## V0에서 확인할 것 (통과 조건)

1. **Worker에서 회의·참가자 생성**: RealtimeKit REST로 회의 생성 + 참가 토큰 발급이 되는지.
2. **두 브라우저 영상 연결**: `meet.html`에서 두 브라우저(사용자 로컬 PC 크롬 + 다른 브라우저 또는 시크릿 창)가 같은 회의에 들어가 서로 영상을 보는지.
3. **웹훅 서명 방식**: RealtimeKit 웹훅 서명 검증 방식을 확인한다 (웹훅 등록은 `https://peopleos.site/api/meet/webhook`).
4. **프리셋 이름**: 호스트·참가자 프리셋 이름을 확인한다.
5. **전사 녹화 필요 여부**: 회의 후 전사에 녹화가 필요한지 확인한다.

## 할 일

1. 계획 문서를 읽고 V0 범위의 최소 구현을 한다: Worker 회의 생성·토큰 발급 API, `meetings` 마이그레이션(0038), `public/meet.html` + `meet.js` 최소 화면, 웹훅 엔드포인트(서명 검증 포함).
2. 로컬 검증: `npx tsc --noEmit` 통과, 로컬 wrangler dev로 API 동작 확인.
3. 배포하지 않는다. GitHub 푸시도 하지 않는다. 배포는 V0 브라우저 검증이 끝난 뒤 별도로 한다.
4. 결과: `files/workflow-verify/video-conference-v0/RESULT.md`를 만든다. 내용: 구현한 것, V0 확인 항목별 결과 (통과/실패/미확인), 웹훅 서명 방식·프리셋 이름·전사 녹화 필요 여부, 브라우저 검증에 필요한 것 (사용자가 두 브라우저로 확인할 절차), V1으로 갈 수 있는지 판단.

## 주의

- 이 세션은 구현 + 로컬 검증까지. 브라우저 두 개로 영상 연결 확인은 사용자가 직접 하거나 별도 브라우저 작업으로 한다.
- `wrangler.toml`의 routes 항목은 건드리지 않는다.
- RealtimeKit 토큰 값은 어디에도 기록하지 않는다.
- XAI 세션과 파일이 겹치지 않게 `src/index.ts`를 바꿀 때는 기존 라우트와 충돌하지 않는지 확인한다.
