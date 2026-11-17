# 캘린더 C3 — 구글 OAuth — Opus 5.5

## 너의 역할
너는 구현 세션이다. People OS 캘린더에 구글 OAuth 연결(읽기 전용, 1단계)을 구현한다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 전제 (다 갖춰짐)
- C1(백엔드)·C2(화면)·C2w(배선) 완료, 배포됨. `src/calendar/routes.ts`에 구글 경로를 추가한다. `src/index.ts`는 만지지 마라 (구글 경로는 C1이 mount한 `calendarApp` 안에 추가).
- 구글 설정(U1) 완료: 새 프로젝트 "People OS" (ID people-os-515001), Calendar API Enabled, 동의 화면 External/Testing, 스코프 openid·userinfo.email·calendar.events.readonly, 테스트 사용자 hr.jhkang@gmail.com, OAuth 클라이언트 "People OS Web".
- **시크릿 3개 전부 Worker에 저장됨**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GCAL_TOKEN_KEY`(무작위 32바이트 base64). 값은 직접 보지 마라. 로컬 검증은 `.dev.vars`에 테스트용 값을 넣어라 (실제 시크릿은 쓰지 마라).
- 리디렉션 URI (둘 다 등록됨): `https://peopleos.site/api/calendar/google/callback` + `https://people-os.workspace-easyware.workers.dev/api/calendar/google/callback`.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `calendar-plan.md` 2장(구글 OAuth 흐름), 3장(토큰 암호화), 6장(C3 검증 항목), 8장(사실 기준표 — **Google 문서 URL을 먼저 읽어라**: OAuth 웹 서버 흐름 `developers.google.com/identity/protocols/oauth2/web-server`, 캘린더 스코프 `developers.google.com/workspace/calendar/api/auth`. Fable이 이 문서를 열지 못했으니 C3가 구현 전에 원문을 확인하고, 계획과 다르면 원문을 따르고 그 차이를 보고한다).
- `src/calendar/routes.ts` (C1, 구글 경로 추가 위치), `src/index.ts`의 calendarApp mount 부분(읽기만), `public/calendar.js` (연결 상태 칩 추가 위치), `src/auth.ts` (세션 확인 방식), `migrations/0025_calendar.sql` (테이블·마이그레이션 번호 형식 — 다음 번호를 쓴다).

## 구현할 것
1. **마이그레이션** (`migrations/00NN+1_calendar_google.sql` — 다음 번호): `calendar_google_accounts` (user_id PK, google_sub, google_email, access_token_enc, refresh_token_enc, access_expires_at, scope, status, created_at, updated_at), `calendar_oauth_states` (state_hash PK, user_id, code_verifier, redirect_uri, created_at, used_at). 토큰은 평문 저장 금지.
2. **암호화** (`src/calendar/crypto.ts`): Web Crypto AES-256-GCM, 키는 시크릿 `GCAL_TOKEN_KEY`(32바이트 base64 디코드). 암호화마다 무작위 12바이트 IV. AAD에 `user_id` + 용도(`refresh`/`access`)를 넣어 다른 사용자 행에 붙여 넣으면 복호화 실패. 형식 `v1.<base64url IV>.<base64url 암호문>`.
3. **OAuth** (`src/calendar/google-oauth.ts`): 인가 URL(`https://accounts.google.com/o/oauth2/v2/auth`, `access_type=offline` + `prompt=consent`, PKCE S256, scope `openid email https://www.googleapis.com/auth/calendar.events.readonly`), 토큰 교환(`https://oauth2.googleapis.com/token`), 토큰 갱신(만료 전 갱신, 실패 시 `NEEDS_RECONNECT`), 폐기(`https://oauth2.googleapis.com/revoke`, 연결 해제 시).
4. **라우트** (`src/calendar/routes.ts`에 구글 경로 추가, `calendarApp` 안):
   - `POST /google/connect` — 세션 + `originOk` 필수. state 생성(sha256만 D1 저장, 1회용, 10분, 사용자 결합) + PKCE verifier, 인가 URL 반환.
   - `GET /google/callback` — **세션 확인을 하지 않는다** (SameSite=Strict 쿠키가 구글→콜백 이동에는 안 실림). code·state를 받아 최소 HTML만 돌려주고, 그 페이지가 같은 출처 `fetch`로 `POST /google/complete`를 부른다. 쿠키를 `Lax`로 낮추지 마라.
   - `POST /google/complete` — 세션 + `originOk` 필수. state 검증(1회용·10분·본인 것), code를 토큰으로 교환, 토큰 암호화 저장, state 사용 표시.
   - `GET /google/status` — 세션 필수. 연결 상태(`connected`/`needs_reconnect`/`not_connected`), 구글 이메일(마스킹), 스코프.
   - `POST /google/disconnect` — 세션 + `originOk` 필수. 토큰 폐기 + D1 행 삭제.
   - 시크릿 3개 중 하나라도 없으면 `/google/*`는 503 "구글 연동 미설정" (fail-closed). 자체 캘린더는 그대로 동작.
   - 리디렉션 URI는 허용 목록(위 2개)과 정확히 대조. 다른 URI면 거부.
5. **상태 칩 UI** (`public/calendar.js`): 캘린더 화면에 구글 연결 상태 칩 (연결 안 됨 / 연결됨 / 다시 연결 필요). "구글 캘린더 연결" 버튼 → `/google/connect` POST → 인가 URL로 이동. 연결 해제 버튼. 상태는 `/google/status`로 조회.
6. **보안 가드**: `grep -rn "calendar_" src/`로 캘린더 테이블에 닿는 코드가 `src/calendar/`(와 `index.ts`의 크론 호출)뿐인지 확인. 응답·로그에 토큰을 찍지 마라. `/google/*`는 세션만 인정 (`X-Admin-Secret`만으로는 401).

## 제약
- 원격 D1·R2·배포 금지. 로컬만. 실제 구글 토큰은 로컬 검증에 쓰지 마라 (테스트용 가짜 토큰/모의 응답으로 검증).
- `src/index.ts`는 만지지 마라. `public/index.html`은 읽기만 한다.
- `public/calendar.js`는 C3가 고친다 (C2 다음 순서).

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로: 시크릿 없을 때 503, state 재사용 거부, 만료 state 거부, 다른 사용자의 state로 `/complete` 거부, D1에 평문 토큰 없음(`refresh_token_enc`가 `v1.`로 시작), 응답·로그에 토큰 없음, 연결 해제 후 행 삭제, 리프레시 토큰을 망가뜨려 `NEEDS_RECONNECT` 전환. **실제 브라우저에서 구글 동의 → 연결 완료(Strict 쿠키 흐름)는 이 VM에 브라우저가 없어서 못 한다 — 그 사실을 명시하고, 대신 콜백 HTML + `/complete` fetch 흐름을 스텁으로 검증한다.**
- 검증 산출물은 `files/calendar-c3-verify/`에 둔다. `/tmp` 금지.
- 끝나면 최종 보고에 구현한 것, Google 문서 원문 확인 결과(계획과 다른 점이 있으면), 로컬 검증 결과를 적어라.
