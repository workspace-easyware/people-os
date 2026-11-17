# 캘린더 C4 — 구글 일정 실시간 읽기 — Sonnet 5.5

## 너의 역할
너는 구현 세션이다. People OS 캘린더에 구글 일정 실시간 읽기(1단계, 복사 없음)를 구현한다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 전제
- C1(백엔드)·C2(화면)·C2w(배선)·C3(구글 OAuth) 완료, 배포됨 (v a09ee8f1). 마이그레이션 0026 적용됨 (`calendar_google_accounts`, `calendar_oauth_states`).
- `src/calendar/google-oauth.ts`의 토큰 갱신 함수를 재사용한다. `src/index.ts`는 만지지 마라. `public/calendar.js`는 C3 다음 순서로 C4가 고친다.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `calendar-plan.md` 4장(구글 실시간 읽기), 6장(C4 검증 항목), 8장(사실 기준표 — Calendar API events.list 문서를 먼저 읽어라: `developers.google.com/workspace/calendar/api/v3/reference/events/list`. Fable이 이 문서를 열지 못했으니 C4가 구현 전에 원문을 확인하고, 계획과 다르면 원문을 따르고 그 차이를 보고한다).
- `src/calendar/routes.ts` (구글 경로 추가 위치), `src/calendar/google-oauth.ts` (토큰 갱신·복호화 재사용), `public/calendar.js` (두 번째 이벤트 소스 추가 위치), `src/calendar/crypto.ts` (복호화).

## 구현할 것
1. **구글 이벤트 조회** (`src/calendar/google-events.ts`): `GET https://www.googleapis.com/calendar/v3/calendars/primary/events`로 기간 내 구글 일정을 읽는다. 저장하지 않는다 (복사 없음 — 달력 열 때마다 Worker가 사용자 토큰으로 구글을 바로 읽어 함께 표시). 액세스 토큰 만료 시 C3의 갱신 함수로 갱신. 갱신 실패(`invalid_grant`) 시 계정 상태를 `NEEDS_RECONNECT`로 바꾸고 구글 일정은 빈 목록 + 상태 표시.
2. **라우트** (`src/calendar/routes.ts`에 추가):
   - `GET /google/events?from=&to=` — 세션 필수. 기간은 C1과 같은 규칙(최대 62일). 구글 일정을 People OS 이벤트 형태로 변환해 반환 (`id`는 `g:` 접두, `title`, `start`, `end`, `allDay`, `source: 'google'`, `htmlLink`). 구글 일정은 읽기 전용이라 수정·삭제 API는 제공하지 않는다 (수정 시도 시 403).
   - 구글 API 오류 시 502 + `google_error` 코드. 토큰 없음/연결 안 됨 시 409 `NOT_CONNECTED` + 연결 안내.
3. **화면** (`public/calendar.js`): FullCalendar에 두 번째 이벤트 소스(구글)를 추가. 구글 일정은 다른 색/배지로 표시 (읽기 전용 표시). 구글 연결 상태에 따라: 연결 안 됨이면 구글 소스 없음 + "구글 캘린더 연결" 안내, `NEEDS_RECONNECT`면 다시 연결 안내. 구글 일정 클릭 시 상세는 읽기 전용 (수정·삭제 버튼 없음). 새로고침 제한: 구글 조회는 사용자 클릭(새로고침 버튼) 또는 탭 열 때만 (자동 폴링 금지).
4. **오류 상태 표시**: 구글 API 실패 시 달력 화면에 상태 메시지 ("구글 일정을 불러오지 못했습니다 — 다시 연결해 주세요" 등). 자체 일정은 그대로 표시.

## 제약
- D1에 구글 일정을 저장하지 마라 (1단계는 복사 없음). `calendar_event_links`는 C6(2단계)에서 만든다.
- 원격 D1·R2·배포 금지. 로컬만. 실제 구글 토큰은 로컬 검증에 쓰지 마라 (모의 구글 응답으로 검증).
- `src/index.ts`는 만지지 마라. `public/index.html`은 읽기만 한다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로: 모의 구글 응답으로 기간 조회, 구글 일정 변환(`g:` 접두·읽기 전용), 토큰 만료 시 갱신, 갱신 실패 시 `NEEDS_RECONNECT` + 빈 목록, 구글 API 오류 시 502, 연결 안 됨 시 409, 구글 일정 수정 시도 시 403, 익명 401. **실제 구글 API 호출은 하지 마라** (모의 응답으로 검증).
- 검증 산출물은 `files/calendar-c4-verify/`에 둔다. `/tmp` 금지.
- 끝나면 최종 보고에 구현한 것, Calendar API 문서 원문 확인 결과(계획과 다른 점이 있으면), 로컬 검증 결과를 적어라.
