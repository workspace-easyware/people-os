# 캘린더 C5(알림) + C6(구글 쓰기) 결과 (2026-11-22, Fable 5.2)

## 요약

- **C5 일정 알림은 라이브에서 동작한다.** 실제 일정으로 15분 크론이 종 알림을 만들고 메일까지 도착했다.
- **C6 구글 쓰기는 코드·마이그레이션·화면까지 라이브에 있고, 실제 구글 쓰기는 한 번도 돌리지 않았다.** 사용자의 구글 재동의(쓰기 스코프)가 있어야 돌릴 수 있다. 흐름은 로컬 가짜 구글로만 확인했다.
- **구글 문서는 이 세션에서 열지 못했다** (WebFetch·WebSearch 권한 거부). 스코프·`updatedMin`·etag·일정 id 규칙은 전부 미확인이고, 그에 맞춰 보수적으로 골랐다 (아래 "미확인").
- 라이브 버전: People OS **`74bc26f6-aff7-4c35-a341-c44f85506833`** (그 직전 `40ce9197`도 이 세션 배포). 문서 편집 Worker는 건드리지 않았다 (`1dd93ed7` 그대로).
- D1 마이그레이션: **`0045_calendar_c5c6.sql`** (원격 적용 + `d1_migrations` 기록 확인).
- 커밋·태그·푸시는 하지 않았다. `ARCHITECTURE.md`·`VERIFICATION.md`도 건드리지 않았다.

## 설계

### C5 — 알림 흐름

`Cron(*/15) → scheduled() WORKFLOW_CRON 분기 → runCalendarTick → runCalendarReminders → D1 batch(로그 + notifications) → 종 푸시 → Resend 메일`

- **새 크론을 더하지 않았다.** `*/15 * * * *`는 WF-8(워크플로우 스케줄) 때 이미 `wrangler.toml`에 있었고 `scheduled()`에 분기도 있었다. 캘린더 틱은 그 분기 안에 `waitUntil` 한 줄로 얹었다. 그래서 다이제스트로 떨어질 길이 없고, 계정의 Cron Trigger 수도 그대로다.
- 대상: `remind_minutes IS NOT NULL`, 삭제 아님, `status = 'CONFIRMED'`, `시작 − remind_minutes분 <= 지금 < 시작`.
  - 종일 일정의 "당일 오전 9시"(`remind_minutes = -540`)는 알림 시각이 시작(00:00 KST)보다 뒤라 위 조건으로는 영영 안 걸린다. 이 경우만 "알림 시각부터 2시간"을 대상으로 본다.
- 받는 사람: 개인 일정 = 소유자(활성일 때만), 종 알림 + 메일. 팀 일정 = 활성 사용자 전원, 종 알림만. 구글 일정은 D1에 없으므로 알릴 수 없다 (의도한 동작).
- 중복 방지: `calendar_reminder_log`에 `run_id` 컬럼을 더했다. 틱마다 고유한 `run_id`로 `INSERT OR IGNORE`하고, 같은 batch의 다음 문장이 **그 `run_id`를 가진 로그 행에만** `notifications`를 만든다. 크론이 겹치거나 다시 돌아도 한 번만 알린다. 일정당 문장 2개라 사용자 수와 무관하다.
- 알림 행: `type = 'CALENDAR_REMINDER'`, `ref_type = 'calendar_event'`, `title = "[일정] <제목> · 12/1(화) 14:15"`(종일은 `· 12/1(화) 종일`), `link = "/#calendar/<id>"`.
- 메일: 제목·시각·링크만. 발신 `"People OS 일정" <calendar@peopleos.site>`. 링크 앞부분은 새 var `APP_ORIGIN = "https://peopleos.site"`. `RESEND_API_KEY`가 없으면 건너뛰고 D1 기록만 남긴다.
- 틱당 상한: 일정 100건, 종 푸시 20건, 메일 10건. **상한을 넘은 메일은 나중에 다시 보내지 않는다** (종 알림은 남는다).
- 청소: KST 04:00 틱에 하루 한 번 — 60일 지난 알림 로그, 30일 지난 소프트 삭제 일정(구글 연결 행이 남아 있으면 건너뜀), 하루 지난 OAuth state.
- 화면: 알림 선택지는 기존 그대로 15분/30분/1시간/1일 전(종일: 당일 9시/전날 9시)이고, 폼에 "알림은 15분 간격으로 확인해 보냅니다" 한 줄을 더했다.

### C6 — 쓰기 흐름

- 범위: 소유자가 일정마다 "구글 캘린더에도 저장"을 켠 **개인 일정만** 본인 구글 기본 캘린더에 쓴다. 팀 일정은 400으로 거절한다. 구글에서 온 일정은 여전히 읽기 전용이다.
- 연결 표 `calendar_event_links` (행이 있다 = 저장이 켜져 있다): `event_id PK, user_id, google_event_id, etag, push_status(PENDING|SYNCED|FAILED|DELETE_PENDING), attempts, last_error, pushed_at, checked_at`, `UNIQUE(user_id, google_event_id)`.
- 보내기: D1을 먼저 고치고 응답한 뒤 `waitUntil`로 구글에 보낸다.
  - 처음: `events.insert`에 People OS가 미리 정한 id(`pos` + 16진수 40자)를 넣는다. 다시 보내면 409가 오고, 그때는 같은 id에 patch한다 → 구글 일정은 1개만 생긴다.
  - 수정: `events.patch` + `If-Match: <etag>`. 412면 구글 값을 읽어 **People OS 행을 구글 값으로 덮어쓰고** 알림(`CALENDAR_GOOGLE_CONFLICT`)을 넣는다. 404/410이면 People OS 일정을 소프트 삭제하고 알림(`CALENDAR_GOOGLE_DELETED`).
  - 삭제·"저장 끄기"·팀 일정으로 변경: `DELETE_PENDING` → `events.delete`(404/410은 성공) → 연결 행 삭제.
  - 보낸 뒤 People OS에서 또 고쳤으면(`version` 불일치) `PENDING`으로 남겨 다시 보낸다.
- 변경 감지: **`updatedMin`을 쓰지 않고 "연결된 일정을 `events.get` + `If-None-Match`로 하나씩"** 으로 했다. `updatedMin` 제약을 확인할 수 없었고, 과제가 그 경우의 단순화로 정해 둔 방식이다. 15분 틱마다 밀린 보내기 3건 + 대조 5건(오래 안 본 순), 그리고 캘린더 화면을 열 때·"구글 새로고침" 때 본인 것 20건(`POST /api/calendar/google/sync`). 연결 일정이 사용자당 수십 건 이하일 때만 맞는 방식이다.
- 중복 표시 방지: `/google/events` 응답에서 연결 표에 있는 구글 id를 뺀다.
- 실패 재시도: 연속 5회 실패하면 크론은 더 시도하지 않는다 (화면의 수동 새로고침은 시도한다). 계정 문제(재연결 필요·쓰기 권한 없음)는 횟수를 세지 않는다.
- 계획서에 없던 보호 2개:
  - **다른 구글 계정으로 바꿔 연결하면 연결 행을 지운다.** 남겨 두면 새 계정에서 전부 404로 보여 People OS 일정을 지우게 된다.
  - 연결 해제는 연결 행만 지운다 (구글에 간 일정은 구글에 남는다 — 확인 문구에 넣었다).

### 스코프 결정

- **쓰기 스코프는 `https://www.googleapis.com/auth/calendar.events`** 로 했다. 더 좁은 `calendar.events.owned`·`calendar.app.created`는 문서를 열 수 없어 이름과 동작을 확인하지 못했다. 확인 안 된 이름을 요청하면 동의 화면이 `invalid_scope`로 막히므로 쓰지 않았다. 확인되면 `google-oauth.ts`의 `WRITE_SCOPE` 상수 하나만 바꾸면 된다 (`calendar.events.owned`는 "쓰기 가능" 판정 목록에 이미 넣어 뒀다).
- **쓰기 스코프는 원하는 사람만 요청한다.** `POST /google/connect`가 `{ "write": true }`일 때만 쓰기 스코프를 더한다. 기본 연결은 지금처럼 읽기 전용이다. 라이브에서 두 URL의 `scope` 값을 확인했다.
- 화면: 구글 칩 패널에 권한 상태("읽기 전용" / "읽기 + 구글에 저장")와 **"구글에 저장 허용 (다시 동의)"** 버튼, 일정 폼에 "구글 캘린더에도 저장" 체크박스(쓰기 권한이 없으면 비활성 + 안내), 일정 상세에 "저장됨 / 반영하는 중 / 반영 실패".

### 바뀐 파일

| 파일 | 내용 |
| --- | --- |
| `migrations/0045_calendar_c5c6.sql` (새) | `calendar_reminder_log.run_id`, `calendar_event_links` + 색인 2개 |
| `src/calendar/notify.ts` (새) | C5 알림·메일·청소 |
| `src/calendar/google-push.ts` (새) | C6 보내기·충돌·삭제 전파·대조 |
| `src/calendar/tick.ts` (새) | 15분 틱에서 알림 → 구글 대조 → 청소 |
| `src/calendar/google-oauth.ts` | `WRITE_SCOPE`, `writeCapable`, `buildAuthUrl(write)`, 연결 해제 시 연결 행 삭제 |
| `src/calendar/routes.ts` | `google_sync` 입출력, 연결 행 batch, `/google/sync`, `/google/status`에 `can_write`·건수, 읽기 응답 중복 제거 |
| `src/index.ts` | import 1줄 + `WORKFLOW_CRON` 분기에 `runCalendarTick` 1줄 |
| `wrangler.toml` | `[vars] APP_ORIGIN` (크론은 그대로 3개) |
| `public/calendar.js`, `public/calendar.css` | 구글 저장 체크박스·상태 표시·재동의 안내 |

`npx tsc --noEmit` 0건, `node --check public/calendar.js` 통과.

## 로컬 검증 (`harness/`, `wrangler dev --local`, 새 D1에 마이그레이션 0001~0045 적용)

### C5

| 확인 | 결과 |
| --- | --- |
| `*/15` 크론 5회 실행 뒤 `digest_runs` | 0행 — 다이제스트가 돌지 않는다 |
| 개인 일정(15분 전), 기준 시각에 대상 | 소유자에게 1건, `[일정] 개인 알림 시험 · 12/1(화) 14:15`, `/#calendar/cal_r1` |
| 팀 일정(30분 전) | 활성 사용자 A·B에게 1건씩, 비활성 X는 없음, 메일 대상 아님 |
| 아직 때가 아닌 일정 / 알림 없는 일정 / 삭제된 일정 | 알림 없음 |
| 같은 시각으로 크론 2회 + 15분 뒤 1회 | 일정·사용자당 여전히 1건 (`notified=3 → 0 → 0`) |
| 종일 일정 "당일 오전 9시" | 09:00 KST 틱에 1건 (`· 12/1(화) 종일`), 다음 틱에 중복 없음 |
| `RESEND_API_KEY` 없음 | `메일 1건 건너뜀 (D1 기록만)` 로그, `emailed_at` NULL |
| 종 아이콘 API (`/api/approval/notifications`) | B에게 `CALENDAR_REMINDER`가 보인다 |
| 구글 일정 알림 없음 | 구글 일정은 D1에 저장되지 않아 크론 대상이 될 수 없다 (구조로 보장 — 따로 돌려 본 시험은 없다) |

### C6 (가짜 구글 — 진짜 구글이 아니다)

| 확인 | 결과 |
| --- | --- |
| 구글 미연결 / 읽기 전용 연결에서 `google_sync: true` | 409 + 안내 문구 (각각 "먼저 연결", "쓰기 권한 동의 필요") |
| 팀 일정에 `google_sync: true` | 400 |
| 만들기 | insert 1회, `extendedProperties.private.peopleOsEventId` 포함, 상태 `pending → synced` |
| 수정 | `PATCH` + `If-Match: "1001"`, 구글 일정은 여전히 1개 |
| 중복 표시 | 가짜 구글 목록에 1건 있어도 `/google/events`는 0건 |
| etag 충돌 (구글에서 먼저 고친 뒤 People OS에서 수정) | 412 → People OS 제목·시각이 구글 값으로 바뀜 + `CALENDAR_GOOGLE_CONFLICT` 알림 1건 |
| 재전송 (insert가 구글에는 도착했는데 500 응답) | `failed` → 재시도에서 409 → patch → 구글 일정 1개 |
| 크론 재시도·대조 | 실패한 보내기 1건 생성, 안 바뀐 것 304, 구글에서 바뀐 종일 일정은 People OS로 반영 |
| 구글에서 삭제 | `/google/sync` → People OS 소프트 삭제 + `CALENDAR_GOOGLE_DELETED` 알림, 연결 행 삭제 |
| People OS에서 삭제 / "저장 끄기" | 구글 일정 `cancelled`, 연결 행 삭제. "끄기"는 People OS 일정이 남는다 |
| 다른 사용자 | A의 개인 일정은 B에게 404, B의 `/google/sync`는 `no_write_access` |
| 익명·`X-Admin-Secret`만 | 401 |

로컬에서 **하지 않은 것**: 브라우저에서 화면을 직접 눌러 보지 않았다 (`node --check`와 API 응답까지만). 계정 전환 시 연결 행 삭제, 5회 실패 뒤 중단, 종일↔시각 전환 patch는 코드만 있고 시험하지 않았다.

## 라이브 검증

| 확인 | 결과 |
| --- | --- |
| `GET /api/health` (peopleos.site) | 200, 배포 전과 같은 본문 |
| 익명 `GET /api/auth/me` | 401 (배포 전과 같음) |
| 익명 `GET /api/calendar/events`, `/google/status` | 401 (배포 전과 같음) |
| 로그인 `GET /api/calendar/events` (workers.dev) | 200, 시험 일정 2건 + 새 필드 `google_sync:false` |
| `calendar.js` | 200, 44,334바이트, 새 코드 포함 |
| **C5 실제 알림** — 20:58Z 시작·15분 전 일정, 20:45Z 틱 | `notifications` 1행 (`CALENDAR_REMINDER`, `[일정] C5 라이브 알림 시험 A · 11/22(일) 05:58`, `/#calendar/<id>`), `calendar_reminder_log` 1행 |
| **C5 메일** | `emailed_at = 20:45:30Z` (Resend 수락). 받는 주소가 내부 주소라 3초 뒤 받은편지함에 `in` 행으로 도착 — 발신 `People OS 일정 <calendar@peopleos.site>`, 본문은 제목·`https://peopleos.site/#calendar/<id>` 링크·안내 한 줄 |
| C5 두 번째 일정 (21:10Z 시작, 21:00Z 틱, 새 버전 `74bc26f6`) | (아래 "21:00 틱" 참조) |
| C6 `google_sync: true` (구글 미연결) | 409 "먼저 구글 캘린더를 연결하세요", 일정은 만들어지지 않음 |
| C6 `/google/connect {write:true}` | `scope=openid email calendar.events.readonly calendar.events` |
| C6 `/google/connect {}` | `scope=openid email calendar.events.readonly` (읽기 전용 유지) |
| C6 `/google/sync` (쓰기 권한 없음) | 200 `skipped: no_write_access` |
| 원격 스키마 | `d1_migrations` 최신 = 0045, `calendar_reminder_log.run_id` 있음, `calendar_event_links` 0행 |

라이브에서 **하지 않은 것**:
- **구글 쓰기 전체** (재동의 전이라 과제 지시대로 하지 않았다).
- **팀 일정 알림** — 라이브에서 돌리면 실제 사용자 4명의 종에 시험 알림이 뜨므로 하지 않았다. 로컬에서만 확인했다.

### 21:00 틱 (런타임 재시작으로 세션이 끊긴 뒤 Merlin이 확인)

- 두 번째 일정(21:10Z 시작, 15분 전)도 21:00:29Z 틱에 알림이 만들어졌다: `CALENDAR_REMINDER`, `[일정] C5 라이브 알림 시험 B · 11/22(일) 06:10`, `calendar_reminder_log` 1행. 메일도 도착했다 (`in` 행 `em_mwqw6v8w_o65pxz`, 발신 `People OS 일정 <calendar@peopleos.site>`).
- 즉 C5 라이브 검증은 일정 2건 모두 통과 (20:45 틱 A + 21:00 틱 B).

## 임시 데이터 정리 (런타임 재시작으로 세션이 끊긴 뒤 Merlin이 직접 정리)

- 삭제: 시험 일정 2건(`cal_mwqvil14_ippkf7` A, `cal_mwqvim08_2li0uv` B) · 알림 2건 · `calendar_reminder_log` 2행 · 시험 메일 2건(`em_mwqvnk84_chrm7v`, `em_mwqw6v8w_o65pxz`, D1 행 + R2 `raw.eml` 2개) · 임시 사용자 `u_c5c6_test`(c5c6-test@peopleos.site) · 세션 1개.
- 확인 쿼리: **events 0 / notifs 0 / logs 0 / mails 0 / tmpuser 0 / tmpsess 0 / calendar_event_links 0 / calendar_google_accounts 0**.
- 남겨 둠: 11-18 시험 일정 `[테스트] 일정 시각 확인용`(`cal_mwm5wheb_9fcbvc`) — 이번 세션 것이 아니라 건드리지 않았다.
- 남은 흔적: AI Gateway 로그와 Workers Logs 이벤트.

## 남은 문제·미확인

1. **구글 문서 미확인 (전부)** — WebFetch·WebSearch가 권한 거부였다. 아래는 기억에 의존한 가정이고 실제 구글 호출로 검증된 적이 없다.
   - 쓰기 스코프 이름과 범위 (`calendar.events`로 insert·patch·delete·get이 되는가, 더 좁은 스코프가 있는가)
   - 클라이언트가 정하는 일정 id의 허용 문자(0-9, a-v로 가정)와 중복 시 409
   - `If-Match` 불일치 시 412, `If-None-Match` 일치 시 304
   - patch에서 `start.date: null`로 종일↔시각을 전환할 수 있는가
   - 삭제된 일정을 `events.get`하면 404/410 또는 `status: "cancelled"`로 오는가
   가정이 틀리면 연결 행이 `FAILED` + `last_error`(구글 reason 문자열)로 남으므로 첫 실호출에서 드러난다.
2. **C4 `events.list` 가정은 이번에도 검증하지 못했다.** 라이브 `calendar_google_accounts`가 0행이다 (지금 구글을 연결한 사용자가 없다). 재동의로 연결한 뒤 달력에 구글 일정이 보이는지가 첫 검증이다. 400/403이면 이 가정부터 의심한다.
3. **C6 재동의 뒤 할 일 (사용자 → 이후 세션)**
   1. (권장) Google Cloud 콘솔 → 데이터 액세스에 `.../auth/calendar.events` 스코프 추가. Testing 상태에서 콘솔 등록 없이 요청만으로 되는지는 확인하지 못했다.
   2. People OS → 캘린더 → 구글 칩 → **"읽기 + 구글에 저장 허용"** → 구글 동의. 패널의 권한이 "일정 읽기 + People OS 개인 일정을 구글에 저장"으로 바뀌는지 확인.
   3. 개인 일정을 "구글 캘린더에도 저장"으로 만들고 → 구글 캘린더에 1건 생겼는지, People OS 달력에 두 번 보이지 않는지.
   4. People OS에서 수정 → 구글 반영. 구글에서 수정 → "구글 새로고침" 뒤 People OS 반영.
   5. 구글에서 고친 직후 People OS에서 수정 → 구글 값으로 맞춰지고 종 알림.
   6. 양쪽 삭제, "저장 끄기".
   7. 실패하면 `SELECT event_id, push_status, attempts, last_error FROM calendar_event_links`.
4. **크론 사용량** — 새 트리거를 더하지 않아 이 Worker는 그대로 3개다 (배포 출력에 schedule 3줄). 저장소 안의 다른 Worker(`pptx-editor`)는 크론이 없다. **계정의 다른 Worker가 쓰는 수는 확인하지 못했다** (wrangler에 계정 전체 트리거 조회가 없고 대시보드를 열 수 없었다).
5. **한 틱의 작업량** — 캘린더 틱은 워크플로우 스케줄·정리 작업과 같은 호출에서 돈다. 계정 요금제의 호출당 하위 요청 한도를 확인하지 못해 상한을 작게 잡았다 (푸시 20, 메일 10, 구글 연결 8건). 사용자가 많아지면 팀 일정 푸시가 20건에서 잘린다 (알림 행은 전원에게 남는다).
6. **알림 정밀도** — 틱 사이에 만든 일정은 알림 시각이 이미 지났어도 다음 틱에 한 번 온다. 시작까지 15분이 안 남은 일정을 "15분 전"으로 만들고 다음 틱이 시작 뒤면 알림이 없다.
7. **구글에서 반복 일정으로 바꾼 연결 일정** — 반복 규칙은 무시하고 첫 회차 값만 가져온다 (반복은 C7).
8. 계획서 2.5의 "다시 연결 필요 알림 1회"와 "비활성 사용자 토큰 청소"는 이번 범위에 넣지 않았다 (C3 범위, 지금도 없음).
