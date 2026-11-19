# 화상회의 V0 결과 — RealtimeKit 최소 연결

작성: 2026-11-19 · 범위: 구현 + 로컬 검증. **배포 안 함, 푸시 안 함, 원격 D1 안 건드림.**

## 한 줄 요약

코드는 V0 범위를 다 갖췄고 로컬 검증 15개 항목이 모두 통과했다. 다만 **실제 RealtimeKit과는 아직 한 번도 통신하지 않았다.** 이 세션에는 실제 API 토큰이 없고(Worker 시크릿에만 있음), 외부 주소 호출도 막혀 있어서 RealtimeKit 자리에 목(mock) 서버를 두고 검증했다. 그래서 V0 통과 조건 1·2(실제 회의 생성, 두 브라우저 영상)는 **미확인**이다. 배포 후 사용자가 아래 절차로 확인해야 V1 진행을 정할 수 있다.

## 1. 구현한 것

| 파일 | 내용 |
|---|---|
| `migrations/0038_meetings.sql` (새 파일) | 표 `meetings`. 계획 문서의 컬럼에 `rtk_session_id`를 더했다(전사 조회용). 부분 고유 인덱스 `(room_id) WHERE status='active'`로 "방 하나에 진행 중 회의 1개"를 DB가 강제한다 |
| `src/meet/rtk.ts` (새 파일) | RealtimeKit REST 호출(회의 생성, 참가자 추가, 프리셋·웹훅 목록, 세션 전사 조회)과 웹훅 서명 검증 |
| `src/meet/routes.ts` (새 파일) | Hono 하위 앱 `/api/meet/*` (아래 표) |
| `src/index.ts` | 2곳만 고침: import 1줄, `app.route("/api/meet", meetApp)` 1줄(+주석). 기존 라우트와 경로가 겹치지 않음을 확인했다(`/api/meet` 사용처 없음, catch-all 앞에 등록) |
| `public/meet.html`, `meet.js`, `meet.css` (새 파일) | 별도 화면. `index.html`은 건드리지 않았다 |

`wrangler.toml`은 바꾸지 않았다(routes 포함). `RTK_APP_ID`와 `CF_ACCOUNT_ID`는 이미 `[vars]`에 있다.

### API

| 경로 | 권한 | 동작 |
|---|---|---|
| `POST /api/meet/rooms/:roomId/start` | 세션 + 방 멤버 | 진행 중 회의가 있으면 그대로(200, `created:false`), 없으면 RealtimeKit 회의 생성(`transcribe_on_end: true`, `ai_config.transcription.language: "ko"`) + `meetings` 행(201) |
| `GET /api/meet/rooms/:roomId/active` | 세션 + 방 멤버 | 진행 중 회의 또는 null (V1 채팅 카드용) |
| `GET /api/meet/:id` | 세션 + 방 멤버 | 회의 정보 |
| `POST /api/meet/:id/join` | 세션 + 방 멤버 | 참가자 추가 → `token`을 **응답 본문으로만** 돌려준다. `Cache-Control: no-store`. 끝난 회의는 409 |
| `POST /api/meet/:id/end` | 시작한 사람 또는 coach | `status=ended` |
| `POST /api/meet/webhook` | 세션 없음, `rtk-signature` 서명 | 검증 실패 401. `meeting.started`/`ended`/`transcript`를 `meetings`에 반영 |
| `GET /api/meet/presets`, `/webhooks` | 관리자(hr_admin 세션 또는 X-Admin-Secret) | 앱의 실제 프리셋·웹훅 목록 확인용 (V0용) |

- **방 멤버가 아니면 hr_admin이라도 403.**
- **프리셋**: 시작한 사람 또는 `coaching_role = coach`이면 호스트, 나머지는 참가자.
- `custom_participant_id` = People OS 사용자 id, `name` = 사용자 이름.
- **코칭 DM**: 코치와 코칭 대상의 1:1 방이면 `is_coaching = 1`.
- 동시에 두 사람이 시작을 누르면 고유 인덱스에 걸린 쪽이 먼저 만들어진 회의를 돌려받는다.
- 로그(`logEvent`)에는 식별자와 상태만 남긴다. 토큰과 전사 링크는 남기지 않는다.

### 화면 (`/meet`)

- `/meet`: 내 채팅방 목록에서 [영상 통화]를 누르면 start를 거쳐 `/meet?m=<회의 id>`로 간다. V1에서는 채팅방 헤더 버튼이 이 역할을 맡는다.
- `/meet?m=<id>`: 회의 제목과 "이 회의는 종료 후 자동으로 전사됩니다" 안내를 보여 준다. [참여하기]를 누르면 join → SDK 로드 → `RealtimeKitClient.init({ authToken })` → `<rtk-meeting>` 순서로 들어간다.
- 회의 id는 URL에 실리지만 참가 토큰은 실리지 않는다. 회의 id만으로는 방 멤버가 아니면 아무것도 못 한다.
- 정적 자산은 `/meet.html`을 `/meet`로 307 리다이렉트한다(쿼리는 유지됨). 그래서 화면 안 링크는 처음부터 `/meet`를 쓴다.

## 2. V0 확인 항목별 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | Worker에서 회의·참가자 생성 | **로컬(목) 통과 / 실제 미확인** | 목 서버가 받은 요청이 문서 형식과 같다: `POST .../realtime/kit/<app>/meetings` 본문 `{title, transcribe_on_end:true, ai_config:{transcription:{language:"ko"}}}`, `POST .../meetings/<id>/participants` 본문 `{name, preset_name, custom_participant_id}`, `Authorization: Bearer`. 응답의 `data.id`와 `data.token`은 API 레퍼런스 기준이다. 실제 토큰으로는 호출하지 않았다 |
| 2 | 두 브라우저 영상 연결 | **미확인** | 배포 후 사용자 확인 필요 (4장 절차) |
| 3 | 웹훅 서명 방식 | **확인 + 구현 + 로컬 통과** | 아래 3장 |
| 4 | 프리셋 이름 | **문서로는 미확인. 확인 경로를 만들어 둠** | 아래 3장 |
| 5 | 전사에 녹화가 필요한가 | **문서상 불필요 (실측 미확인)** | 아래 3장 |

### 로컬 검증 (모두 통과)

환경: 새 로컬 D1(`files/workflow-verify/video-conference-v0/state`)에 마이그레이션 0001~0038을 처음부터 모두 적용(✅). 시드: 코치·코칭 대상 DM 방, 그룹방(코칭 대상+멤버), 방 밖의 hr_admin. 목 RealtimeKit Worker(`mock-rtk-worker.js`)를 127.0.0.1:8799에, People OS를 127.0.0.1:8788에 띄웠다. `RTK_API_TOKEN`에는 가짜 값을 `--var`로 넣었다(`.dev.vars`는 건드리지 않음).

| # | 확인 | 기대 | 결과 |
|---|---|---|---|
| 1 | `npx tsc --noEmit` | 통과 | ✅ |
| 2 | 0038 포함 전체 마이그레이션을 새 DB에 적용 | 성공 | ✅ |
| 3 | 코칭 대상이 DM 방에서 start | 201, `is_coaching:true` | ✅ |
| 4 | 코치가 같은 방에서 start | 200, 같은 회의(`created:false`) | ✅ |
| 5 | 코치 join | 호스트 프리셋, `Cache-Control: no-store` | ✅ |
| 6 | 방 밖의 hr_admin join | 403 | ✅ |
| 7 | 익명 join | 401 | ✅ |
| 8 | 그룹방 start → 일반 멤버 join | 참가자 프리셋, `is_coaching:false` | ✅ |
| 9 | 서명 없는 웹훅 | 401 | ✅ |
| 10 | 위조 서명 웹훅 | 401 | ✅ |
| 11 | 올바른 서명의 `meeting.ended` | 200 → `status=ended`, `rtk_session_id` 저장 | ✅ |
| 12 | 올바른 서명의 `meeting.transcript` | 200 → `transcript_status=available` | ✅ |
| 13 | 끝난 회의 join | 409 | ✅ |
| 14 | 참가자가 end / 시작한 사람이 end | 403 / 200 | ✅ |
| 15 | end 뒤 같은 방에서 다시 start · `/api/meet/presets`(관리자 200, 일반 사용자 403) · `/meet` 화면 200 | 기대대로 | ✅ |

테스트 서버 두 개는 종료했고, 8788·8799 포트가 비어 있는 것도 확인했다.

## 3. 확인한 사실 (문서, 2026-11-19)

### 웹훅 서명 방식

- 헤더는 `rtk-signature`. 값은 **원문 요청 본문**에 대한 RSA-SHA256(RSASSA-PKCS1-v1_5) 서명을 Base64로 인코딩한 것이다.
- 공개키(PEM)는 `https://api.realtime.cloudflare.com/.well-known/webhooks.json`의 `data.publicKey`에 있다. **공유 비밀(시크릿)이 아니라 공개키 방식**이라 Worker에 웹훅용 시크릿을 새로 넣을 필요가 없다. 계획 문서의 "웹훅 검증용 시크릿"은 필요 없다.
- 구현: 공개키는 1시간 동안 메모리에 캐시한다. 검증에 실패했을 때 캐시가 5분 이상 됐으면 키를 한 번 다시 받는다(위조 요청이 키 재조회를 계속 일으키지 못하게). 파싱하기 전의 바이트로 검증하고, 키를 못 받으면 503을 돌려준다(RealtimeKit이 재시도할 수 있게).
- 등록 방법: 대시보드, 또는 `POST .../realtime/kit/<app>/webhooks` `{name, url, events[], enabled}`.
- 이벤트: `meeting.started`, `meeting.ended`(reason `HOST_ENDED_MEETING` 또는 `ALL_PARTICIPANTS_LEFT`), `meeting.participantJoined/Left`, `recording.statusUpdate`, `meeting.transcript`, `meeting.summary` 등.
- **실제 공개키 주소에서 키를 받아 오는 것은 이 세션에서 확인하지 못했다**(외부 호출 막힘). 배포 후 첫 웹훅에서 확인한다.

### 프리셋 이름

- 문서에는 "대시보드에서 앱을 만들면 기본 프리셋이 생긴다"고만 적혀 있고, 이름은 나와 있지 않다. 예제에 나온 이름(`webinar-host`, `group-call-host` 등)은 예시일 뿐이다.
- 코드 기본값: 호스트 `group_call_host`, 참가자 `group_call_participant`. 이 이름은 **추정**이다(Dyte 시절 기본 이름).
- 이름이 다르면 코드를 고치지 않고 `wrangler.toml [vars]`에 `RTK_PRESET_HOST`와 `RTK_PRESET_PARTICIPANT`를 넣으면 된다.
- **실제 이름 확인 방법**: 배포 후 hr_admin으로 로그인한 브라우저에서 `https://peopleos.site/api/meet/presets`를 연다. 또는 RealtimeKit 대시보드 → people-os 앱 → Presets에서 본다.

### 전사에 녹화가 필요한가

- 전사 문서에 따르면 회의 생성 때 `transcribe_on_end: true`만 주면 되고, 녹화가 필요하다는 말은 없다. 녹화용 외부 저장소 설정은 전사에 쓰이지 않는다고만 적혀 있다.
- **판단: 녹화 불필요.** 따라서 내보내기 요금(녹화 분당 단가)이 붙지 않는다. 실측은 V2에서 한다.
- 전사 결과를 받는 방법은 두 가지다: `meeting.transcript` 웹훅의 `transcriptDownloadUrl`(만료 시각이 있음), 또는 `GET .../sessions/<session_id>/transcript`. 형식은 CSV, JSON, SRT, VTT. CSV 행에는 시작 시각, peer id, user id, **custom participant id**, 이름, 텍스트가 들어 있어서 화자를 People OS 사용자로 되돌릴 수 있다. 보관 기간은 7일.
- 대비해 둔 것: `meetings.rtk_session_id`를 웹훅으로 저장해 두므로 V2에서 크론으로 다시 조회할 수 있다.

## 4. 브라우저 검증 절차 (사용자)

### 배포 전에 할 일

1. **원격 D1에 0038 적용**: 먼저 `cf-wrangler.py d1 migrations list people-os-db --remote`로 상태를 확인한다(AGENTS.md 규칙). 그다음 `d1 execute --remote --file migrations/0038_meetings.sql -y` + `INSERT INTO d1_migrations(name) VALUES ('0038_meetings.sql')`, 또는 `migrations apply`를 쓴다. **XAI 세션이 0037을 적용했는지 먼저 확인한다.**
2. 시크릿 `RTK_API_TOKEN`이 있는지 확인한다: `cf-wrangler.py secret list`.
3. API 토큰 권한: "Realtime" 관련 권한(Realtime Admin 등)이 있어야 한다. 없으면 start가 502를 돌려주고, 응답의 `detail`에 RealtimeKit 오류가 실린다.
4. 배포한다(별도 작업).

### 확인 순서

1. **프리셋**: hr_admin 브라우저에서 `https://peopleos.site/api/meet/presets`를 연다. 목록에 `group_call_host`와 `group_call_participant`가 없으면 실제 이름을 `RTK_PRESET_HOST`/`RTK_PRESET_PARTICIPANT` vars에 넣고 다시 배포한다.
2. **브라우저 A**(로컬 크롬, 계정 1)와 **브라우저 B**(시크릿 창 또는 다른 브라우저, 계정 2)를 준비한다. 두 계정은 **이미 같은 채팅방의 멤버여야 한다**(1:1 대화를 한 번이라도 나눈 사이). 시크릿 창은 쿠키가 따로라서 다른 계정으로 로그인할 수 있다.
3. A: `https://peopleos.site/meet` → 상대 방의 [영상 통화] → [참여하기] → 카메라·마이크 허용 → RealtimeKit 설정 화면에서 입장.
4. B: `https://peopleos.site/meet` → 같은 방의 [영상 통화]. 진행 중인 회의가 있으면 같은 회의로 들어간다. A가 주소창의 `/meet?m=...`를 B에게 보내도 된다.
5. **통과 기준**: 서로의 영상이 보이고 소리가 들린다. 콘솔에서 `window.__meet`을 보면 역할과 프리셋을 확인할 수 있다. 같은 PC에서 두 창을 띄우면 하울링이 생기므로 한쪽은 음소거하거나 이어폰을 쓴다.
6. **웹훅**(선택, V2 준비): RealtimeKit 대시보드에 `https://peopleos.site/api/meet/webhook`을 `meeting.started`, `meeting.ended`, `meeting.transcript` 이벤트로 등록한다. 통화를 끝내고 몇 분 뒤 원격 D1에서 `SELECT status, transcript_status, rtk_session_id FROM meetings ORDER BY started_at DESC LIMIT 1`이 `ended`, `available`, 세션 id인지 본다. Workers Logs에서 `event = "meet.webhook"`을 검색해도 된다. `meet.webhook_rejected`가 보이면 서명 검증 실패다.

### 실패하면 보는 곳

| 증상 | 원인 후보 |
|---|---|
| start가 502 `RealtimeKit POST meetings 실패 (HTTP 401/403)` | 토큰 권한 부족 또는 시크릿 없음 |
| join이 502 (participants) | 프리셋 이름 불일치 → 1번 단계 |
| "SDK를 불러오지 못했습니다" | jsDelivr 차단 또는 SDK 경로 변경 |
| 입장은 되는데 상대가 안 보임 | 네트워크(UDP 차단 또는 TURN). 다른 망에서 다시 시도 |

## 5. 남은 것 / 주의

- **SDK 버전 고정 못 함.** 이 세션에서 npm 레지스트리와 jsDelivr 조회가 막혀 버전을 확인하지 못했다. 그래서 `meet.js`는 `@latest` CDN을 쓴다(`SDK_CORE_VERSION`/`SDK_UI_VERSION` 상수). V0 브라우저 검증 때 개발자도구 Network 탭에서 실제로 불러온 버전을 보고, V1에서 그 번호로 고정한다. 가능하면 `public/vendor/realtimekit/`에 내려받는다. UI 키트 loader가 청크를 동적으로 불러오므로 폴더 전체가 필요하다.
- `ai_config` 필드가 회의 생성 API에서 받아들여지는지는 전사 문서 기준으로만 확인했다. 실제 호출에서 400이 나면 이 필드부터 의심한다.
- 회의 종료 처리: `meeting.ended`(모두 나감) 웹훅이 안 오면 DB에서 `active`로 남는다. 다음 start가 끝난 RealtimeKit 회의를 다시 쓰게 되는데, RealtimeKit 회의는 재입장할 수 있어 동작은 할 것으로 보이지만 확인하지는 않았다. V1에서 크론 정리나 "통화 종료" 버튼으로 막는다.
- 로컬 검증 파일: `mock-rtk-worker.js`, `mock-rtk.toml`, `seed.sql`, `webhook-*.json`, `state/`(로컬 D1). 모두 로컬 전용이다. `state/`는 지워도 된다.

## 6. V1으로 갈 수 있는가

**코드 기준으로는 갈 수 있다. 다만 진행 여부는 배포 후 4장의 브라우저 확인(통과 조건 2)이 끝나야 정할 수 있다.**

V0 실패 조건(계정 권한, SDK 문제)은 실제 RealtimeKit과 통신해야만 드러나는데, 이 세션에서는 그 부분을 확인할 수 없었다. 사용자가 두 브라우저로 서로의 영상을 보면 V1(채팅 헤더 버튼, 카드, 알림)로 바로 넘어간다. V1에 필요한 서버 부분(start, active, join, end)은 이미 있다. 그러면 V1에 남는 일은 `chat.js` 버튼과 카드, `ChatRoom` 이벤트, `NotificationHub` 푸시, SDK 버전 고정이다.

## 7. 배포 (2026-11-19)

| 항목 | 결과 |
|---|---|
| 원격 D1 상태 (적용 전) | 0037 적용됨, 미적용은 0038뿐 |
| 0038 적용 | `d1 execute --remote --file migrations/0038_meetings.sql -y` 성공 (5행 기록, 오류 없음) |
| 추적 기록 | `INSERT INTO d1_migrations(name) VALUES ('0038_meetings.sql')` 성공. `migrations list`가 "No migrations to apply" |
| 시크릿 | `RTK_API_TOKEN` 있음 (값은 확인·기록하지 않음) |
| 배포 | `cf-wrangler.py deploy` 성공. **버전 ID `2de19be5-c650-45e5-bd09-647cca0955c3`**. `wrangler.toml` routes는 건드리지 않음 |
| 롤백 지점 | 직전 라이브 `7d0739f3` (XAI 4종). 0038은 새 표만 추가하므로 롤백해도 DB 쪽 영향 없음 |
| 프리셋 확인 | **미실시.** `/api/meet/presets`는 관리자 전용인데 이 세션에는 관리자 자격이 없음. `RTK_PRESET_*` vars는 넣지 않았고 코드 기본값(`group_call_host` / `group_call_participant`) 그대로임 |
| 라이브 확인 (`GET /meet` 200, 익명 start 401, 서명 없는 웹훅 401) | **미실시.** 이 세션에서 curl 실행이 승인 대기로 막힘 |

### 브라우저 검증에 남은 것
1. hr_admin 브라우저에서 `https://peopleos.site/api/meet/presets` 확인. 기본 이름과 다르면 `RTK_PRESET_HOST`/`RTK_PRESET_PARTICIPANT`를 `wrangler.toml [vars]`에 넣고 재배포.
2. 두 브라우저 영상 연결 (4장 절차). 이때 실제 RealtimeKit 통신(start 502 여부, `ai_config` 400 여부)도 처음 확인됨.
3. RealtimeKit 대시보드에 웹훅 등록: `https://peopleos.site/api/meet/webhook` (`meeting.started`, `meeting.ended`, `meeting.transcript`).
4. 개발자도구 Network 탭에서 SDK 실제 버전 확인 → V1에서 고정.

## 8. 타일 미표시 수정 (2026-11-19, **배포됨 `4b1877d5`**)

### 배포 (2026-11-19)

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | ✅ 통과 |
| 배포 | `cf-wrangler.py deploy` 성공. **버전 ID `4b1877d5-f46c-42d7-8640-bf2802986523`**. 프런트엔드 3개 파일만 바뀌었고, DB 마이그레이션은 없다. `wrangler.toml` routes는 건드리지 않았다 |
| 롤백 지점 | `2de19be5-c650-45e5-bd09-647cca0955c3` (V0 첫 배포) |
| 라이브 `GET /meet` (workers.dev) | ✅ 200, 1003바이트. `<rtk-meeting id="rtk" mode="fill" show-setup-screen="true" hidden>` |
| 라이브 `/meet.css` | ✅ `flex-direction: column`, `100dvh`, `#meet-main … position: relative`, `position: absolute; inset: 0`, `min-height: 320px`, `rtk-meeting[hidden] { display: none; }` |
| 라이브 `/meet.js` | ✅ `meet-panel.hidden = true`, `mode = "fill"`, `hidden = false`, rAF 2번 대기 → `rtkEl.meeting = meeting`, 500ms 뒤 `Event("resize")`, `window.__meetDiag` |
| `GET /api/meet/rooms/<DM방>/active` | 익명 401 (로그인 필요, 정상). 이 세션에는 사용자 세션이 없어서 원격 D1을 직접 조회했다. 회의 `meet_mwndgsg3_tncn4r`(방 `chat:dm:3ac2999d…:a06b2c76…`, 코칭)는 **`status=active`**(09:53:05 시작, `ended_at` 없음)이다 |

**주의:** `meet_mwndgsg3_tncn4r`은 DB에 아직 `active`로 남아 있다. RealtimeKit 쪽에서 회의가 이미 사라졌다면 이 방에서 start를 누를 때 이 회의를 다시 받고(`created:false`), join은 502가 난다(위 하네스 관찰과 같은 상황). 그때는 만든 사람이 end를 호출한 뒤 새로 start한다.

---

라이브(`2de19be5`)에서 참가·미디어는 정상인데 화면에 참가자 타일이 그려지지 않았다. 원래 Opus 세션(19:42 시작)은 파일 수정까지 마치고 런타임 재시작으로 끊겼다. 이 절은 이어받은 세션이 상태를 확인하고 로컬 검증을 마친 결과다. 배포는 그 뒤 별도 세션에서 했다(위 "배포" 표). `wrangler.toml` routes는 건드리지 않았다.

### 증상 (라이브 진단, 원본 `video-conference-tile-fix-prompt.md`)

- `stage.status`와 `self.stageStatus`가 모두 `ON_STAGE`였다. 스테이지가 빈 상태가 아니었다.
- 참가에 성공했고 preset `group_call_host`가 동작했다. 상대 오디오·비디오를 구독 중이었고 viewMode는 `ACTIVE_GRID`였다.
- 미디어도 흘렀다: 오디오 32kbps, 비디오 198kbps, 손실 0%.
- 콘솔 오류는 favicon 404뿐이었고 Network 실패도 없었다.
- DOM에 타일 요소는 있는데 화면에는 그려지지 않았다.

### 원인

1. **rtk-meeting에 확정된 높이가 없었다.** 높이를 `html→body→main→rtk-meeting`의 `height:100%` 연쇄에 맡겼는데, 이 연쇄가 중간에 끊겨 rtk-meeting과 그 안의 스테이지 그리드 높이가 0으로 계산됐다. UI 키트는 받은 크기로 그리드와 타일 크기를 계산하므로, 높이 0인 그리드에는 타일이 그려지지 않는다.
2. **`hidden`이 듣지 않았다.** 저자 스타일 `rtk-meeting { display:block }`이 UA의 `[hidden]{display:none}`을 이겨서, 빈 rtk-meeting이 처음부터 패널 아래에 깔려 있었다.

### 바꾼 파일

| 파일 | 변경 |
|---|---|
| `public/meet.css` | body를 세로 flex로 바꾸고 높이를 `100vh`/`100dvh`로 잡았다. `.meet-top`은 `flex:0 0 auto`이다. `#meet-main`은 `flex:1 1 auto; min-height:0; position:relative`로 남은 공간을 차지한다. `rtk-meeting`은 `position:absolute; inset:0; width/height:100%; min-height:320px`로 항상 확정된 크기를 갖는다. `rtk-meeting[hidden]{display:none}`을 명시했다. |
| `public/meet.html` | `<rtk-meeting id="rtk" mode="fill" show-setup-screen="true" hidden>`. 부모 크기를 채우는 `fill` 모드를 명시했고, 처음에는 숨겨 둔다. |
| `public/meet.js` | `enter()`의 순서를 바꿨다: 패널 숨김 → `rtkEl.mode="fill"` → `rtkEl.hidden=false` → requestAnimationFrame 2번 대기(레이아웃 확정) → `rtkEl.meeting = meeting`. 500ms 뒤 `resize` 이벤트를 한 번 더 보내 그리드가 크기를 다시 재게 한다. 진단 헬퍼 `window.__meetDiag()`를 추가했다. 이 헬퍼는 스테이지 상태, 참가자 수와 viewMode, 뷰포트, `#meet-main`·`rtk-meeting` 박스를 보여 준다. 섀도 DOM 안쪽의 `rtk-header`·`rtk-stage`·`rtk-grid`·`rtk-participant-tile`·`rtk-controlbar`·`video` 박스와, jsDelivr 기준 SDK `latest` 버전도 함께 보여 준다. 토큰과 쿠키는 다루지 않는다. |

서버 코드(`src/`)는 바꾸지 않았다.

### 로컬 검증 (V0 하네스 재사용: 앱 127.0.0.1:8788, 목 RealtimeKit 127.0.0.1:8799, `state/` 로컬 D1)

| # | 확인 | 결과 |
|---|---|---|
| 1 | 세 파일에 수정이 온전히 들어 있는지 (위 표의 모든 항목) | ✅ 빠진 부분 없음. 추가로 고친 것도 없음 |
| 2 | `npx tsc --noEmit` | ✅ 통과 |
| 3 | `/meet`·`/meet.css`·`/meet.js` 서빙 | ✅ 모두 200. 크기가 디스크 파일과 같음(1003 / 2484 / 9326바이트) |
| 4 | 서빙된 CSS에 수정이 들어 있는지 | ✅ `flex-direction: column`, `100dvh`, `position: absolute; inset: 0`, `min-height: 320px`, `rtk-meeting[hidden] { display: none; }` |
| 5 | 서빙된 JS에 수정이 들어 있는지 | ✅ `meet-panel.hidden = true`, `mode = "fill"`, `hidden = false`, rAF 2번 대기, 대기 뒤 `meeting` 할당, `Event("resize")`, `window.__meetDiag` |
| 6 | 서빙된 HTML | ✅ `mode="fill" show-setup-screen="true" hidden` |
| 7 | 세션 쿠키로 start (코칭 대상, DM 방) | ✅ 201 `created:true`, `is_coaching:true` |
| 8 | 세션 쿠키로 join (코치, 코칭 대상) | ✅ 둘 다 200, `Cache-Control: no-store`, role `host`(코치이거나 회의를 만든 사람이면 host), preset `group_call_host`, 토큰은 응답 본문에 있음(값은 출력·기록하지 않음) |
| 9 | 익명 join | ✅ 401 |
| 10 | **실제 타일 렌더링** | ⚠️ **로컬 미확인.** 이 VM에는 헤드리스 브라우저가 없고 실제 RealtimeKit 미디어도 없다(목 Worker는 REST만 흉내 낸다). 레이아웃 수정이 실제로 타일을 그리게 하는지는 배포 후 브라우저에서만 확인할 수 있다 |

검증용 세션은 `seed-tilefix.sql`(로컬 D1 전용 테스트 세션 2개)이다. 검증 뒤 두 서버를 종료했고, 8788·8799 포트가 비어 있는 것을 확인했다.

**하네스 관찰 (참고):** 끊긴 세션이 만든 회의 `meet_mwnfbx35_ni8025`는 로컬 D1에 아직 `active`로 남아 있었다. 그런데 목 Worker는 회의를 메모리에만 두기 때문에 재시작 뒤에는 그 회의를 몰랐다. 그래서 start가 이 회의를 다시 돌려줬고(200 `created:false`), join은 502(`meeting not found`)를 냈다. 만든 사람이 end(200)한 뒤 새로 start하니 정상 동작했다. 이것은 하네스 때문에 생긴 일이다. 다만 5장의 주의 사항과 같은 모양이다. 실제 서비스에서도 DB에는 `active`인데 RealtimeKit 쪽 회의가 없으면 join이 계속 502가 된다. V1의 크론 정리나 "통화 종료" 버튼으로 막을 대상이다.

### 배포 후 브라우저에서 다시 확인할 절차

배포는 별도 작업이다. 프론트엔드 파일만 바뀌었으므로 DB 마이그레이션은 필요 없다.

1. 배포한 뒤 두 기기에서 **강력 새로고침**한다(이전 meet.css/meet.js 캐시 제거). 휴대폰에서는 탭을 닫았다가 다시 연다.
2. **노트북**(계정 1): `https://peopleos.site/meet` → 상대 방의 [영상 통화] → [참여하기] → 카메라·마이크 허용 → 설정 화면에서 입장.
3. **휴대폰**(계정 2, 같은 채팅방 멤버): `https://peopleos.site/meet` → 같은 방의 [영상 통화] → [참여하기]. 노트북 주소창의 `/meet?m=...`를 보내 줘도 된다.
4. **통과 기준 (눈으로 확인)**:
   - 두 기기 모두 자기 타일과 상대 타일이 보인다.
   - 상대 영상이 움직이고 소리가 들린다.
   - 아래쪽 컨트롤바가 화면 안에 있다.
   - 휴대폰을 세로·가로로 돌려도 타일이 다시 맞춰진다.
5. **진단 (노트북 개발자도구 콘솔)**: `await __meetDiag()`
   - `stage.status`가 `ON_STAGE`이고 `participants.joined`가 1 이상이다.
   - `rtk-meeting`의 `w`·`h`가 0이 아니다(높이는 대략 뷰포트 높이에서 상단바를 뺀 값). `display`는 `block`, `hidden`은 `false`이다.
   - `inner["rtk-grid"]`와 `inner["rtk-participant-tile"]`의 `w`·`h`가 모두 0이 아니다. 타일 수는 참가자 수와 같다.
   - `inner.video`의 크기가 0이 아니다.
   - `sdkLatest`에 나온 버전 번호를 적어 둔다. V1에서 SDK 버전을 고정할 때 쓴다.
6. 휴대폰 콘솔을 쓸 수 없으면 노트북 쪽 진단과 눈으로 본 결과만으로 판정한다. 휴대폰을 USB로 연결하면 Chrome `chrome://inspect`(Android)나 Safari 웹 속성(iOS)으로 같은 명령을 실행할 수 있다.

**여전히 안 보이면 볼 곳:**

| 진단 결과 | 의미 |
|---|---|
| `rtk-meeting.h`가 0 | CSS가 반영되지 않았다(캐시, 배포 누락). Network 탭에서 meet.css 응답에 `inset: 0`이 있는지 본다 |
| `rtk-meeting`은 정상인데 `rtk-grid.h`가 0 | UI 키트 내부 레이아웃 문제다. 창 크기를 바꿔 보고, 그때 타일이 나타나면 첫 측정 시점 문제이므로 resize를 더 늦게 보내도록 고친다 |
| 박스는 다 정상인데 `rtk-participant-tile`이 0개 | 렌더링 문제가 아니라 참가자·스테이지 상태 문제다. `participants.joined`와 viewMode를 본다 |
| 타일은 있는데 검은 화면 | 미디어 문제다(카메라 권한, 상대 비디오 꺼짐, 네트워크/TURN). 4장의 "실패하면 보는 곳"을 본다 |
# RESULT.md 8절 덧붙일 내용 — 타일 미표시 2차 수정 (2026-11-19)

> 이 세션은 `files/workflow-verify/`를 읽거나 쓸 권한이 없었다 (작업 디렉터리 people-os만 허용).
> 아래 내용을 `files/workflow-verify/video-conference-v0/RESULT.md` 8절 끝에 그대로 붙인다.

### 8.x 2차 수정 — 섀도 DOM 안쪽 스테이지 높이 0 (**배포됨 `9a538542`**, 2026-11-19 11:04 UTC)

**원인 (추정 근거 포함)**
- 1차 수정 뒤 진단: `rtk-meeting` 627×841 **display:block**, `rtk-header` h48, `rtk-controlbar` h56, `rtk-stage`·`rtk-grid` h0, 타일·video 0×0.
- `meet.css`에 `rtk-meeting { display:block }`이 있었다. 이 규칙은 1차 수정 전부터 있었다. 바깥 문서의 저자 스타일은 컴포넌트 섀도 스타일의 `:host` 규칙보다 우선한다 (CSS Scoping 캐스케이드). 그래서 UI 키트가 `:host`에 준 세로 flex 레이아웃이 block으로 덮였다.
- 호스트가 block이면 stage의 `flex:1`은 효과가 없다. 그러면 stage 높이는 내용 높이가 되는데, 그리드 타일은 `position:absolute`라 내용 높이가 0이다. 이 경우 header·controlbar는 자기 내용 높이만큼 보이고 stage만 0이 된다. 진단과 정확히 일치한다.
- 한계: 이 세션은 웹 접근(WebFetch·WebSearch, jsDelivr curl)이 막혀 UI 키트 2.1.0 소스의 `:host` 선언을 직접 확인하지 못했다. 그래서 아래의 런타임 안전망을 함께 넣었다.

**바꾼 파일**
- `public/meet.css`: `rtk-meeting`에서 `display:block`을 뺐다. 위치와 크기(`position:absolute; inset:0; width/height:100%; min-height:320px`)만 남기고 display는 `:host`에 맡긴다. `rtk-meeting[hidden]{display:none}`은 유지한다 (숨김은 계속 동작한다).
- `public/meet.js`:
  - SDK를 `latest`에서 **`2.1.0`으로 고정**했다 (core·ui 둘 다, 사용자 진단의 sdkLatest 값 기준).
  - `watchStageLayout()` 안전망: 입장 후 20초 동안 1초마다 확인한다. 호스트 높이가 0보다 큰데 `rtk-stage` 높이가 0이면, stage의 레이아웃 부모를 세로 flex로 만들고 stage에 `flex:1 1 auto; min-height:0`을 인라인으로 준다. 이 처리는 열린 shadowRoot 안쪽에서만 한다. 보정이 일어나면 `console.warn("[meet] rtk-stage 높이 0 → 레이아웃 보정")`을 남기고 `window.__meet.layoutFix`에 기록한다. 주 수정이 맞으면 이 코드는 아무것도 하지 않는다.
  - `__meetDiag()` 확장: `rtk-meeting.flexDirection`, `stageParent`(stage의 부모 태그·박스, 섀도 루트 바로 아래인지), `layoutFix`, `sdkPinned`.
- `meet.html`은 바꾸지 않았다. `wrangler.toml`도 건드리지 않았다.

**로컬 검증**
- `npx tsc --noEmit` 통과, `node --check public/meet.js` 통과.
- `wrangler dev --local --port 8799`에서 `/meet` 200 text/html, `/meet.css`·`/meet.js`가 수정본(2차 수정 주석, `display` 없는 rtk-meeting 규칙, `2.1.0`, `watchStageLayout`)으로 서빙되는 것을 확인했다.
- 세션 없이 `POST /api/meet/x/join`을 보내면 401 `로그인이 필요합니다.`가 돌아온다 (인증 게이트 정상).
- **하지 못한 것**: 세션 쿠키를 쓰는 start/join 확인. V0 하네스와 목 서버가 `files/workflow-verify/` 아래에 있어 이 세션에서는 읽을 수도 실행할 수도 없었다. 서버 코드(`src/`)는 이번에 바뀌지 않았으므로 V0의 start/join 결과는 그대로 유효하다.
- 헤드리스 브라우저가 없어 실제 타일 렌더링은 로컬에서 보지 못했다.

**배포 후 브라우저 확인 절차**
1. 두 계정으로 `/meet?m=<id>`에 들어가 참여한다 (강력 새로고침으로 캐시를 비운다. meet.css·meet.js가 바뀌었다).
2. 콘솔: `JSON.stringify((await __meetDiag()), null, 1)`
3. 합격 기준:
   - `rtk-meeting.display`가 `block`이 **아님** (UI 키트의 :host 값, 예: `flex`)
   - `inner.rtk-stage[0].h > 0`, `inner.rtk-grid[0].h > 0`
   - `inner.rtk-participant-tile[*]`의 w·h > 0, `inner.video[*]`의 w·h > 0
   - `sdkPinned` = 2.1.0 / 2.1.0
   - `layoutFix`가 `null`이면 CSS 수정만으로 해결된 것이다. 값이 있으면 안전망이 고친 것이므로, `stageParent`와 `parentDisplayBefore`를 기록해 3차에서 정식으로 고친다.
4. 그래도 h가 0이면 `stageParent` 출력을 첨부한다. 그러면 섀도 DOM 안쪽 구조를 확정할 수 있다.

**배포 (2026-11-19)**
- 버전 ID: **`9a538542-28bf-4642-bb62-99ed3f6293bc`** (100%). 롤백 지점 `4b1877d5`, 그 전 `2de19be5`.
- 배포 전 `npx tsc --noEmit` 통과. `cf-wrangler.py deploy`로 배포했다. 바뀐 정적 자산은 `/meet.css`·`/meet.js` 2개다 (40개는 이미 올라가 있었다). DB 마이그레이션 없음, `wrangler.toml` 변경 없음, GitHub 푸시 안 함.
- 라이브 확인 (workers.dev):
  - `/meet` 200.
  - `/meet.css` (3067 B, 로컬과 같음): `rtk-meeting { position:absolute; inset:0; width:100%; height:100%; min-height:320px; }`. `display:block` 없음. `rtk-meeting[hidden] { display:none; }` 있음.
  - `/meet.js` (11716 B, 로컬과 같음): `SDK_CORE_VERSION`·`SDK_UI_VERSION` = `"2.1.0"`. `watchStageLayout`, `layoutFix`, `sdkPinned` 포함.
- 주의: 배포 약 10초 뒤 첫 확인에서는 엣지가 **이전 자산**을 돌려줬다 (`CF-Cache-Status: HIT`, 9326 B, `latest`). 쿼리 문자열을 바꿔도 같았다. 잠시 뒤 `Cache-Control: no-cache` 헤더를 붙여 다시 받았을 때 새 자산이 나왔다. 사용자 브라우저에서도 처음에는 옛 파일이 나올 수 있으니 강력 새로고침 후 `__meetDiag()`의 `sdkPinned`가 2.1.0인지 먼저 본다.
- 실제 타일 렌더링은 위 "배포 후 브라우저 확인 절차"로 사용자 브라우저에서 확인한다.

## 9. V1+V2 — 채팅 연동 + 전사 파이프라인 (2026-11-19, **배포 안 함, 푸시 안 함, 원격 D1 안 건드림**)

### 9.0 시작 전 기준점 커밋 — **못 함**

지시대로 `git add -A` + `git commit -m "video-conference V0 + tile fix"`를 하려 했지만, 이 세션에서는 `git add`가 승인 대기("requires approval")로 막혀 실행되지 않았다. **기준점 커밋은 없다.** 작업 트리에는 V0 미커밋 수정과 이번 V1+V2 수정이 섞여 있다. 사용자가 직접 커밋해야 한다(9.6 참고).
- 대신 `.gitignore`에 검증 하네스의 로컬 miniflare 상태(`files/**/state/v3/`, `files/**/state-*/v3/`, sqlite·blob 수십 개)를 제외하는 줄을 넣었다. 커밋할 때 바이너리가 섞이지 않게 하려는 것이다.

### 9.1 구현한 것

**V1 — 채팅 연동**

| # | 요구 | 구현 |
|---|---|---|
| 1 | 채팅방 헤더 [영상 통화] | `chat.js` 방 머리글에 [영상 통화] 버튼과 "전사" 체크박스를 넣었다. 누르면 `POST /api/meet/rooms/:roomId/start {transcribe}`을 부르고 `/meet?m=<id>`를 새 탭으로 연다. 팝업 차단을 피하려고 클릭하는 순간 빈 탭을 먼저 열고, 응답이 오면 주소를 넣는다. 진행 중인 통화가 있으면 버튼 이름이 [통화 참여]로 바뀐다. 아직 메시지가 없는 DM 방은 D1에 방 행이 없어 403이 난다. 이때는 "먼저 메시지를 한 번 주고받은 뒤에…"라고 안내한다 |
| 2 | 통화 중 카드 | `ChatRoom` DO `/event`가 받는 종류에 `meeting_started`·`meeting_ended`를 더했다(`ROOM_EVENT_TYPES`). 방 안에 "● 영상 통화 진행 중 · 전사됨 · 코칭 [참여]" 카드를 그린다. 방을 열 때는 `GET /active`로, 열려 있는 동안은 소켓 이벤트로, 소켓이 다시 연결될 때도 `GET /active`로 맞춘다 |
| 3 | 알림 | 새 회의를 만들면 시작한 사람을 뺀 방 멤버에게 `notifications` 행(`MEETING_STARTED`, 링크 `/meet?m=<id>`)을 넣고 `pushNotification()`(NotificationHub)을 보낸다. 알림 클릭 처리(`approval.js` `ntfClick`)는 `/meet…` 링크를 해시 탭이 아닌 새 탭으로 열도록 고쳤다 |
| 4 | 종료 흐름 | `POST /:id/end`(시작한 사람 또는 coach, V0 규칙 그대로)가 `meeting_ended`를 브로드캐스트해 카드를 닫는다. RealtimeKit 회의도 `PATCH /meetings/<id> {status:"INACTIVE"}`로 바꿔 아무도 다시 들어오지 못하게 한다(best-effort). `meet.html`에는 권한이 있는 사람에게만 [모두에게 통화 종료] 버튼이 보인다(`GET /:id`의 `can_end`). 웹훅 `meeting.ended`나 크론이 회의를 닫을 때도 같은 함수(`markMeetingEnded`)를 써서 카드가 닫힌다 |
| 5 | 오래된 회의 정리 | **(a)와 (b) 둘 다 했다.** (a) `start`가 기존 active 회의를 돌려주기 전에 `GET /meetings/<id>`로 확인한다. 404이거나 INACTIVE면 그 행을 ended로 닫고 새로 만든다. 조회 자체가 실패하면(네트워크) 판단하지 않고 기존 회의를 돌려준다. 추가로 `join`이 RealtimeKit 404를 받으면 502 대신 **410**을 주고 행을 닫는다. (b) 15분 크론: 시작한 지 20분이 지난 active 회의를 확인한다. RealtimeKit에 회의가 없거나, INACTIVE이거나, LIVE 세션이 없으면 ended로 바꾼다 |
| 6 | 전사 안내 문구 | `meet.html` 입장 화면: "🔴 이 회의는 전사됩니다. 통화가 끝나면 참가자별 음성이 한국어로 전사되어 (코치/회의를 시작한 사람)의 녹음전사 목록에 화자 이름과 함께 저장되고, 요약·검색에 쓰입니다. 입장하면 이에 동의한 것으로 봅니다." 전사하지 않는 회의에는 "이 회의는 전사되지 않습니다."를 보여 준다 |
| 7 | 전사 on/off | `start` 본문 `{transcribe?: boolean}`을 받는다. 기본값은 켜짐이다. **코칭 DM(`is_coaching`)이면 서버가 무조건 켠다.** 고르는 곳은 채팅 머리글 체크박스(코칭 DM에서는 "전사 (코칭: 항상)"으로 잠김)와 `/meet` 방 목록 화면 체크박스다. 끈 회의는 RealtimeKit에 `transcribe_on_end:false`로 만들고(`ai_config`도 넣지 않는다) `transcript_status='off'`로 둔다 |

**V2 — 전사 연계** (`src/meet/transcript.ts` 새 파일)

| # | 요구 | 구현 |
|---|---|---|
| 1 | `meeting.transcript` 웹훅 | 서명 검증은 V0 그대로다. 웹훅에는 바로 200으로 답하고, 내려받기와 문서 만들기는 `waitUntil`에서 한다. 실패하면 `meetings.transcript_error`에 적고 크론이 다시 가져온다. 전사가 왔다는 것은 회의가 끝났다는 뜻이므로 회의도 닫는다 |
| 2 | 화자 이름 | 문서로 확인한 JSON 형식(`[{startTime, endTime, sentence, peerData:{cpi, displayName,…}}]`)과 CSV(머리글 없는 6열)를 둘 다 읽는다. `cpi`(= People OS 사용자 id)를 `users.name`으로 바꾸고, 못 찾으면 `displayName`을 쓴다. 시작 시각 순으로 정렬하고, 같은 화자가 이어 말한 문장은 한 줄로 합쳐 `이름: 발화` 형태로 만든다 |
| 3 | recordings 행 | `provider='realtimekit'`, `model='@cf/openai/whisper-large-v3-turbo'`, `transcript_status='ready'`. 원본은 R2 `meetings/<회의 id>/transcript.json`에 둔다(같은 회의의 두 번째 세션부터는 `transcript-<…>.json`). 소유자는 시작한 사람, **코칭 회의면 방의 코치**다. `duration_ms`는 발화 시각 범위로 채운다 |
| 4 | 기존 파이프라인 | `advanceRecording`의 완료 분기를 `finishTranscript()`로 떼어냈다(문서 생성 → recordings ready → `PIPELINE` 큐). 업로드 녹음과 회의 전사가 **같은 함수**를 쓴다. 회의 쪽에는 `setMeetHooks`로 주입한다(메일·Plaud 훅과 같은 방식). `meetings.recording_id`를 채운다 |
| 5 | 채팅방 안내 | 방에 시스템 메시지(보낸 사람 "People OS", `sender_id='system:people-os'`)로 "📝 영상 통화 전사본이 준비됐습니다 — "<제목>". <소유자>님의 녹음전사 목록에 저장됐고…"를 남긴다. 일반 메시지와 같은 경로라 DO 저장, 방 소켓, 로비 배지, `last_seq`가 모두 갱신된다. `chat.js`는 이 메시지를 가운데 한 줄로 그린다. 소유자에게는 `MEETING_TRANSCRIPT` 알림(링크 `/#upload`)도 간다 |
| 6 | 크론 폴백 | 15분 크론(`*/15`, 워크플로우 분기)에 `sweepMeetings()`를 더했다. 끝났는데 전사가 없는 회의 중 7일 안·종료 2분 뒤인 것을 고른다. `GET /sessions?associated_id=<회의>`로 끝난 세션을 찾고, 세션마다 `GET /sessions/<id>/transcript?format=JSON`의 `transcript_download_url`로 가져온다. 아직 없으면 시도 횟수를 올리고, 96회(24시간) 뒤에는 `failed`로 둔다. 세션이 하나도 없는 회의(아무도 안 들어옴)는 종료 1시간 뒤 `empty`가 된다. RealtimeKit이 설정되지 않았으면 아무것도 하지 않는다 |
| 7 | 코칭 표시 | recordings·documents 둘 다 `is_coaching`을 회의 값 그대로 넘긴다(0020과 같은 의미). 문서 머리말에도 "· 코칭"이 붙는다 |

**멱등성**: recordings id를 `rec_<회의 id>_<세션 id>`로 정한다. 그래서 웹훅이 다시 오거나 웹훅과 크론이 겹쳐도 행은 1개다. 문서 만들기는 `lock_until` 잠금(advanceRecording과 같은 방식) 안에서 `doc_id`가 비어 있을 때만 한다. 알림 id도 결정적이다.

**확인한 API (Cloudflare 문서, 2026-11-19 이 세션에서 직접 읽음)**: 전사 JSON·CSV 형식, 웹훅 payload, `GET /sessions/<id>/transcript` 응답 `data.transcript_download_url`, `GET /sessions?associated_id=`(세션 `status` LIVE·ENDED), `GET /meetings/<id>`(`status` ACTIVE·INACTIVE), `PATCH /meetings/<id> {status}`. **미확인**: RealtimeKit이 없는 회의에 대해 실제로 404를 주는지(문서에 오류 예시 없음), INACTIVE로 바꿔도 이미 끝난 세션의 전사가 그대로 만들어지는지.

### 9.2 바꾼 파일

| 파일 | 내용 |
|---|---|
| `migrations/0039_meetings_v2.sql` (새 파일) | `meetings`에 `transcribe`(기본 1), `transcript_attempts`, `transcript_error` 컬럼, 인덱스 `(status, transcript_status)` |
| `src/meet/transcript.ts` (새 파일) | 전사 파싱·화자 변환·가져오기, `markMeetingEnded`, `isMeetingAlive`, `sweepMeetings`, `setMeetHooks` |
| `src/meet/rtk.ts` | `createMeeting(transcribe)`, `getMeeting`, `setMeetingStatus`, `listMeetingSessions`, `getSessionTranscriptUrl`. `RtkError.httpStatus` 추가. 쓰지 않던 `getSessionTranscript` 제거 |
| `src/meet/routes.ts` | start(transcribe, 살아 있는지 확인, 브로드캐스트, 알림), join(404 → 410), end(브로드캐스트 + INACTIVE), webhook(transcript 처리), `GET /:id`에 `can_end`. 상태를 바꾸는 POST에 Origin 검사(채팅과 같은 규칙) |
| `src/chat/room.ts` | `/event` 종류에 `meeting_started`·`meeting_ended` 추가 |
| `src/chat/routes.ts` | 내보내는 헬퍼 `broadcastRoomEvent`, `postSystemMessage` 추가 (기존 라우트는 그대로) |
| `src/index.ts` | **3곳만**: import 1줄, `finishTranscript` 추출(advanceRecording 완료 분기. Plaud 머리말 처리는 그대로), `setMeetHooks` + 15분 크론 1줄. **XAI 관련 코드는 건드리지 않았다** |
| `public/chat.js`, `public/chat.css` | 머리글 버튼·전사 체크박스, 통화 카드, 소켓 이벤트, 시스템 메시지 줄 |
| `public/meet.js`, `public/meet.css` | 전사 안내 문구, [모두에게 통화 종료], 방 목록 화면의 전사 선택 |
| `public/approval.js` | `ntfClick`: `/meet…` 링크는 새 탭으로 |
| `.gitignore` | 하네스 miniflare 상태 제외 |
| 하네스 `mock-rtk-worker.js` | `GET/PATCH /meetings/:id`, `GET /sessions?associated_id=`, `GET /sessions/:id/transcript`, 전사 파일 `/files/transcript/<세션>.json`(문서 JSON 형식, displayName을 일부러 "Coach-Kim"/"Lee"로 둬서 이름 변환을 확인한다), 제어 `/ctl/forget/:id`·`/ctl/session` |
| 하네스 `webhook-transcript-v2.json`, `ws-listen.mjs` | V2 웹훅 본문. `ws-listen.mjs`는 소켓 이벤트를 듣는 스크립트다. 이 세션에서는 `node` 스크립트 실행이 승인 대기로 막혀 **쓰지 못했다** |

`wrangler.toml`은 바꾸지 않았다(routes 포함, 크론은 기존 `*/15`를 그대로 쓴다). 토큰 값은 어디에도 기록하지 않았다(로컬 검증은 `--var RTK_API_TOKEN:fake-local-token`).

### 9.3 로컬 검증 (V0 하네스 재사용: 앱 127.0.0.1:8788, 목 127.0.0.1:8799, `state/` 로컬 D1에 0039를 `d1 execute --local --file`로 적용)

| # | 확인 | 결과 |
|---|---|---|
| 1 | `npx tsc --noEmit`, `node --check` (chat.js·meet.js·approval.js·mock) | ✅ |
| 2 | 0039를 기존 하네스 DB에 적용 | ✅ |
| 3 | **오래된 회의 재현**: 목 재시작으로 RealtimeKit 쪽 회의가 사라진 그룹방 active 행에서 start | ✅ 201 `created:true`(새 회의), 옛 행은 ended(`rtk_missing`) |
| 4 | 오래된 DM 회의에 바로 join (V0에서는 502) | ✅ **410** "이 회의는 더 이상 없습니다…", 행은 ended |
| 5 | 그룹방 start `{transcribe:false}` | ✅ `transcribe:false`, `transcript_status:"off"` |
| 6 | 코칭 DM start `{transcribe:false}` | ✅ 서버가 `transcribe:true`로 강제 |
| 7 | start 시 카드 브로드캐스트 | ✅ DO `/event`가 `meeting_started`를 받음(`meet.card_broadcast ok:true`) |
| 8 | start 시 알림 | ✅ `MEETING_STARTED` 행이 시작한 사람을 뺀 멤버에게만 생김(그룹 → 최멤버, DM → 김코치). 링크 `/meet?m=<id>` |
| 9 | 시작하지 않은 멤버가 end | ✅ 403 |
| 10 | 코치(시작하지 않음)가 end | ✅ 200 → `meeting_ended` 브로드캐스트 ok:true, 목에 `PATCH {status:"INACTIVE"}` 도착, `GET /active` → `null` |
| 11 | **V2 웹훅**: 서명된 `meeting.transcript` → | ✅ 200. recordings `rec_<회의>_sess-v2-a` (`provider=realtimekit`, `ready`, owner=코치, `is_coaching=1`, `duration_ms=24000`), R2 `meetings/<id>/transcript.json`, 문서(`kind=transcript`, owner=코치, `is_coaching=1`), 큐 진입, `meetings.transcript_status=ready`·`recording_id` 채워짐 |
| 12 | 화자 이름 변환 | ✅ RealtimeKit 이름 "Coach-Kim"/"Lee" → `김코치: 안녕하세요, 오늘 코칭 시작하겠습니다. 지난주 목표는 어떻게 됐나요?` / `이코칭: 주간 회의 진행을…` (같은 화자의 연속 문장 합침 확인) |
| 13 | 큐 → 요약 → 색인 | ⚠️ **요약까지 ✅**(`documents.summary` 채워짐, 로컬 요약 폴백). D1 chunks 1개 생성 ✅. **벡터 색인 단계는 로컬에서 실패**: `index failed: Error: Not logged in`(로컬 wrangler가 원격 Workers AI 임베딩에 로그인돼 있지 않음). 코드 문제가 아니라 하네스 환경 한계다. 배포 환경에서는 바인딩이 있다 |
| 14 | 채팅방 "전사본 준비" 메시지 | ✅ 코칭 대상이 DM 메시지를 읽으면 `sender_id=system:people-os`, "📝 영상 통화 전사본이 준비됐습니다 — …김코치님의 녹음전사 목록에 저장됐고…" |
| 15 | 녹음전사 목록 | ✅ 코치 `GET /api/recordings`에 나옴. 코칭 대상에게는 안 나옴(소유자 격리) |
| 16 | 같은 웹훅 재전송 | ✅ 멱등: recordings 1, 문서 1, `MEETING_TRANSCRIPT` 알림 1 |
| 17 | **크론 폴백(웹훅 없음)**: 코칭 대상이 시작하고 종료한 DM 회의 + 목 세션(ENDED, 전사 있음), `ended_at`을 5분 전으로 → `/__scheduled?cron=*/15+*+*+*+*` | ✅ `meet.sweep {ended:1, ingested:1, checked:6, errors:0}`. 전사본은 **시작한 코칭 대상이 아니라 코치** 소유로 들어감(코칭 규칙). 문서 머리말 `## 전사` 뒤 빈 줄 수정도 확인 |
| 18 | 크론의 오래된 active 정리 | ✅ `started_at`을 30분 전으로 돌린 그룹 회의(LIVE 세션 없음) → ended, `transcript_status=off` |
| 19 | 크론: 세션 없는 옛 V0 회의 | ✅ 종료 1시간이 넘은 것은 `empty`, 아닌 것은 `transcript_attempts=1`, `transcript_error="no sessions yet"`. 세션은 있는데 전사가 아직 없는 것은 `"transcript not ready (1 session)"` |
| 20 | **검색** | ⚠️ **로컬 미확인.** 로컬 `/api/ask`는 LLM·벡터 없이 D1 텍스트 경로만 도는데, 전사본 문장을 그대로 넣어도 출처 0건이었다. 같은 질문 경로에 기존 업로드 전사본을 넣어 비교하지는 않았다. chunks는 D1에 있고 소유자 범위도 맞다. 배포 후 브라우저 확인 V2-5에서 본다 |
| 21 | **chat.js 화면(버튼·카드·카드 닫힘·시스템 줄)** | ⚠️ **로컬 미확인.** 헤드리스 브라우저가 없다. 소켓 프레임을 보려 했지만 이 VM의 curl은 WebSocket을 지원하지 않고(exit 1), node 스크립트는 승인 대기로 막혔다. 그래서 서버 쪽에서는 DO `/event`가 새 이벤트 종류를 200으로 받는 것(읽음·반응과 같은 브로드캐스트 경로)까지만 확인했고, 화면 쪽은 코드 리뷰로만 봤다 |
| 22 | 실제 영상·타일 렌더링 | ⚠️ 로컬 불가(V0와 같음) |

검증 뒤 두 서버를 멈췄고, 8788·8799 포트가 비어 있는 것을 확인했다. 하네스 D1에는 위 테스트 행이 남아 있다(로컬 전용).

### 9.4 배포 전에 할 일 (별도 작업)

1. **커밋**(9.0): 사용자가 직접 `git add -A && git commit`. 원하면 V0+타일 수정과 V1+V2를 나눠 커밋한다.
2. **원격 D1에 0039 적용**: 먼저 `cf-wrangler.py d1 migrations list people-os-db --remote`로 상태를 본다(AGENTS.md). XAI 세션이 0039 번호를 썼는지 먼저 확인하고, 겹치면 파일 번호를 바꾼다. 그다음 `d1 execute --remote --file migrations/0039_meetings_v2.sql -y` + `INSERT INTO d1_migrations(name) VALUES ('0039_meetings_v2.sql')`.
   **0039보다 코드를 먼저 배포하면 안 된다.** start가 `transcribe` 컬럼에 INSERT하므로 500이 난다.
3. **웹훅 등록**(진행 중인 브라우저 작업): `https://peopleos.site/api/meet/webhook`, 이벤트 `meeting.started`·`meeting.ended`·`meeting.transcript`. 웹훅이 없어도 15분 크론이 전사를 가져오지만, 최대 15분 늦다.
4. 배포는 `cf-wrangler.py deploy`. `wrangler.toml` 변경은 없다.
5. 라이브 DB에 남아 있는 `meet_mwndgsg3_tncn4r`(8절 주의)는 다음 start나 첫 15분 크론에서 RealtimeKit 상태를 보고 자동으로 닫힌다.

### 9.5 배포 후 브라우저 확인 절차

준비: 같은 1:1 코칭 방의 두 계정(코치 A, 코칭 대상 B)과 그룹방 하나. 두 기기 모두 **강력 새로고침**(chat.js·meet.js·approval.js가 바뀌었다).

**V1**
1. B: 채팅 → A와의 방. 머리글에 [영상 통화]와 "전사 (코칭: 항상)"(잠김)이 보인다.
2. A는 같은 방을 열어 두고, B가 [영상 통화]를 누른다 → 새 탭에 `/meet?m=…`. 입장 화면에 빨간 "🔴 이 회의는 전사됩니다…" 안내가 있다.
3. A 화면: 새로고침 없이 방 안에 "● 영상 통화 진행 중 · 전사됨 · 코칭 [참여]" 카드가 나타나고, 머리글 버튼이 [통화 참여]로 바뀐다. 방을 열어 두지 않은 상태라면 종 알림 "B님이 영상 통화를 시작했습니다"가 오고, 누르면 새 탭으로 회의가 열린다.
4. A: [참여] → 두 사람 영상 연결(V0 기준).
5. A(코치)의 입장 화면 또는 나간 뒤 화면에서 [모두에게 통화 종료] → 확인 → B의 채팅 카드가 닫힌다. 같은 방에서 다시 [영상 통화]를 누르면 새 회의가 열린다.
6. 그룹방: 체크박스를 끄고 시작 → 입장 화면에 "이 회의는 전사되지 않습니다." 그룹의 다른 멤버가 시작한 통화에서는 [모두에게 통화 종료]가 보이지 않는다(코치가 아니면).

**V2**
1. 코칭 방에서 두 사람이 **한국어로 5분** 통화하고 둘 다 나간다(또는 코치가 종료).
2. 몇 분 안에(웹훅이 없으면 최대 15분 + 전사 생성 시간) 방에 "📝 영상 통화 전사본이 준비됐습니다 — "… 영상 통화 2026-11-..". 김코치님의 녹음전사 목록에…" 줄이 뜬다. 코치에게는 "영상 통화 전사본 준비됨" 알림이 온다.
3. 코치: 녹음전사·문서저장 탭 → 목록에 그 항목(provider realtimekit). 열면 `이름: 발화` 줄이 **People OS 이름**으로 나온다. 파이프라인 단계가 요약 → 색인 → done으로 간다.
4. 코칭 대상 계정의 목록에는 나오지 않는다(소유자 = 코치).
5. 코치 계정으로 통화에서 한 말을 질문한다 → 그 전사본이 출처로 잡히는지 본다(로컬 미확인 항목 20).
6. 원격 D1: `SELECT status, transcribe, transcript_status, transcript_attempts, transcript_error, recording_id FROM meetings ORDER BY started_at DESC LIMIT 3`. Workers Logs: `meet.webhook`, `meet.transcript_ready`, `meet.card_broadcast`, `meet.sweep`, `meet.transcript_failed`.

**막히면 볼 곳**

| 증상 | 볼 곳 |
|---|---|
| start 500 | 0039 미적용 (`no such column: transcribe`) |
| 카드가 안 뜸 | Workers Logs `meet.card_broadcast ok:false` → DO `/event` 거부. ok:true인데 안 뜨면 chat.js 캐시(강력 새로고침) |
| 전사가 안 옴 | `meetings.transcript_error`. "transcript not ready"가 계속되면 RealtimeKit 전사 생성 실패 → 대시보드 확인. INACTIVE 전환이 전사를 막는지도 의심한다(9.1 미확인 항목) |
| 화자가 "참가자"로만 나옴 | 전사 JSON에 `peerData.cpi`가 없음 → 원본 `meetings/<id>/transcript.json`(R2)을 보고 필드 이름을 맞춘다 |

### 9.6 남은 것 / 주의

- **기준점 커밋 미실시**(9.0). 지금 작업 트리에 V0+V1+V2가 모두 미커밋 상태다.
- 전사본은 소유자(시작한 사람/코치) 한 명의 개인 RAG에만 들어간다(계획 6장 권장안). 다른 참가자는 채팅방 안내 줄만 보고 전사본 자체는 열 수 없다. 계획의 "읽기 링크"는 만들지 않았다(공유 권한이 필요하다).
- 한 회의에서 모두 나갔다가 다시 들어오면 RealtimeKit 세션이 여러 개가 된다. 첫 `meeting.ended`에서 우리 행이 ended로 바뀌므로 카드는 닫힌다. 세션마다 전사본 1개(recordings 1행)가 생기고, `meetings.recording_id`는 마지막 것을 가리킨다.
- 혼자 들어갔다 나가면 `meeting.ended`(ALL_PARTICIPANTS_LEFT)로 회의가 닫힌다(V0와 같은 동작).
- 시스템 메시지도 미읽음 배지에 1로 센다.
