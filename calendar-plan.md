# People OS 캘린더 + 구글 캘린더 연동 구현 계획

작성: 2026-11-17 (Fable 5.2 계획 세션). 이 문서는 구현 세션(Sonnet 5.5 / Opus 5.5)의 지침서다. 이 세션은 코드·마이그레이션·배포를 건드리지 않았다.

범위(사용자 결정): 개인 일정 + 팀 공유 일정 + 구글 캘린더 연동.

## 핵심 결론

1. **People OS 일정은 D1 한 테이블(`calendar_events`)에 둔다.** 개인/공유는 `owner_id` + `visibility('private'|'team')`로 가른다. 시각은 UTC로 저장하고 화면은 항상 Asia/Seoul로 보여준다.
2. **구글 연동 1단계는 "복사 없는 실시간 읽기"다.** 달력 화면이 열릴 때 Worker가 그 사용자의 토큰으로 구글에서 해당 기간 일정을 바로 읽어 함께 보여준다. 구글 일정 내용을 D1에 저장하지 않으므로 중복·삭제 전파·충돌 문제가 1단계에는 생기지 않는다.
3. **쓰기(양방향)는 2단계로 미룬다.** 2단계에서는 사용자가 일정마다 "구글 캘린더에도 저장"을 켠 것만 구글로 보내고, 연결 표(`calendar_event_links`)와 etag로 중복·충돌을 막는다.
4. **구글 토큰은 D1에 AES-GCM으로 암호화해 저장한다.** 키는 Worker 시크릿에만 둔다. 캘린더 API는 세션 사용자만 받고 `X-Admin-Secret`은 아예 받지 않는다.
5. **화면은 FullCalendar v6 표준 번들(MIT)을 `public/vendor/`에 직접 두고 캘린더 탭을 열 때만 불러온다.** 자체 툴바와 `styles.css` 토큰으로 People OS 모양에 맞춘다.
6. **`index.html` 메뉴 배선은 별도 단계(C2w)로 떼고, 조직관리(Opus)·강의실 설정(Sonnet) 세션이 끝난 뒤에만 한다.**

## 근거 표기

- **[코드]** 이 세션에서 로컬 코드를 읽어 확인.
- **[CF 문서]** 이 세션에서 Cloudflare 공식 문서를 열어 확인 (요약 모델을 거쳐 읽었으므로 숫자는 구현 전에 한 번 더 본다).
- **[일반 지식]** 이 세션에서 원문을 열지 못했다. 구현 전에 원문 확인이 필요하다.

**중요 — Google 문서를 이 세션에서 열지 못했다.** `developers.google.com` 접근과 웹 검색이 권한 거부로 막혔다. 따라서 이 문서의 구글 OAuth·스코프·토큰 수명·동기화 API 내용은 전부 [일반 지식]이다. 8장 사실 기준표에 확인할 URL을 적었다. C3 세션은 구현 전에 그 문서를 먼저 읽어야 한다.

---

## 0. 현재 코드에서 확인한 것 (설계의 전제)

| 항목 | 확인 내용 | 근거 |
| --- | --- | --- |
| 라우트 장착 | Hono 하위 앱을 `app.route("/api/<이름>", <앱>)`으로 붙인다. 캐치올 `app.all("*")` 앞이어야 한다 | [코드] `src/index.ts:1792-1795` |
| 로그인 확인 | 하위 앱마다 자체 `requireViewer`(LMS) / `requireUser`·`requireWriter`(결재)를 두고 `getSessionUser(c.env, cookie)`를 부른다. `getSessionUser`는 쿠키만 본다 | [코드] `src/lms/routes.ts:66`, `src/approval/routes.ts:65-74`, `src/auth.ts:110` |
| 관리자 확인 | `isAdminRequest`는 hr_admin 세션 **또는** `X-Admin-Secret` 일치면 통과한다 | [코드] `src/auth.ts:148-156` |
| 세션 쿠키 | `people_os_session`, `HttpOnly; Secure; SameSite=Strict`, 7일 | [코드] `src/auth.ts:92-94` |
| 상태 변경 보호 | 결재는 `Origin` 헤더가 있으면 자기 출처와 같아야 통과 (`originOk`) | [코드] `src/approval/routes.ts:55-63` |
| 스키마 관례 | `id TEXT PRIMARY KEY`(`uid("접두사")`), 외래키 없음(주석으로만), `created_at TEXT DEFAULT (datetime('now'))`, 상태값 대문자 + `CHECK`, 낙관적 잠금 `version`, 부분 색인 | [코드] `migrations/0023_lms.sql`, `0024_approval.sql`, `src/lib.ts:89` |
| 스키마 누락 처리 | 하위 앱 `onError`에서 자기 테이블 누락만 503으로 바꾼다 | [코드] `src/lms/routes.ts:35-38, 90-94` |
| 알림 | `notifications` 테이블(D1) + Resend 메일(제목·링크만). 종 아이콘이 `notifications`를 읽고, 클릭하면 `link`의 `#` 뒤 해시로 이동한다 | [코드] `src/approval/notify.ts`, `public/approval.js:296-302` |
| 메일 발송 | `sendEmail(env, {...})`, 키는 `RESEND_API_KEY` 시크릿, 발신 도메인 `peopleos.site` | [코드] `src/email/send.ts` |
| Cron | `0 22 * * *`(07:00 KST 다이제스트), `0 18 * * *`(03:00 KST 평가). **`scheduled()`는 평가 cron이 아니면 전부 다이제스트를 돌린다** | [코드] `wrangler.toml`, `src/index.ts:1887-1894` |
| 앱 주소 | 대표 주소는 `https://people-os.workspace-easyware.workers.dev`. `peopleos.site`는 메일 도메인이고, 앱이 그 주소로도 열리는지는 README가 "확인하지 못했다"고 적었다 (다만 `lms-plan.md` 8.2는 `peopleos.site`로 라이브 검증을 적었다 — 서로 어긋남) | [코드] `README.md:5, 213`, `lms-plan.md:522` |
| 프런트 | 번들러 없음. `public/`의 순수 JS 파일을 `index.html`이 `<script>`로 읽는다. 탭은 `TABS` 배열 + `switchTab()` + `<section id="tab-…">`. CSP 헤더 없음 | [코드] `public/index.html:519-575`, `public/_headers`, `package.json` |
| 암호화 유틸 | `src/`에 AES-GCM 등 대칭 암호화 코드가 **없다** (해시·PBKDF2만 있음) | [코드] `grep` 결과 0건 |
| 다음 마이그레이션 번호 | `0024`가 마지막. `0025_agent_actions.sql`이 조건부(A2)로 예약돼 있으나 파일은 아직 없다 | [코드] `migrations/`, `presentation-plan.md:558` |

**기한 연동에 대한 사실**: 지금 스키마에는 달력에 올릴 "기한"이 없다.
- `tasks`: `id, title, source, done, created_at, done_at, owner_id` — 기한 컬럼 없음 [코드 `0002`, `0021`].
- `approval_documents`: `submitted_at`, `completed_at`만 있고 기한 컬럼 없음. `approval_routes.reminded_at`은 독촉 중복 방지용이며 아직 쓰는 크론이 없다 [코드 `0024`].
- 코칭: 일정(예약) 테이블 없음. `reflections`·`recordings`는 만든 시각만 있다 [코드 `0018`].

그래서 1.5절의 연동은 "지금 당장 붙일 것"과 "기한 컬럼이 생긴 뒤 붙일 것"으로 나눴다.

---

## 1. 일정 데이터 모델

### 1.1 마이그레이션 구성

두 파일로 나눈다. 번호는 구현 시점에 `ls migrations`와 원격 `d1 migrations list`로 확인한 다음 빈 번호를 쓴다(`0025`가 비어 있으면 `0025`·`0026`).

- `00NN_calendar.sql` — C1: `calendar_events`, `calendar_reminder_log`
- `00NN+1_calendar_google.sql` — C3: `calendar_google_accounts`, `calendar_oauth_states` (2단계 C6에서 `calendar_event_links` 추가)

나누는 이유: C1·C2(자체 캘린더)는 구글 설정 없이 완결돼야 하고, 구글 쪽이 늦어져도 배포할 수 있어야 한다.

적용 절차는 AGENTS.md의 원격 D1 주의사항을 따른다(`migrations list --remote` 먼저, 어긋나 있으면 파일 단위 `d1 execute --remote --file` + `d1_migrations` 기록). 로컬은 `npx wrangler d1 execute people-os-db --local --file migrations/<파일>.sql`.

### 1.2 `calendar_events` (People OS 자체 일정)

| 컬럼 | 형 | 설명 |
| --- | --- | --- |
| `id` | TEXT PK | `uid("cal")` |
| `owner_id` | TEXT NOT NULL | 만든 사람 `users.id`. 항상 세션에서만 가져온다 (본문·쿼리로 받지 않는다) |
| `visibility` | TEXT NOT NULL DEFAULT `'private'` | `CHECK IN ('private','team')`. private = 본인만, team = 로그인한 전원 |
| `title` | TEXT NOT NULL | 200자 상한 (결재 제목과 같은 값) |
| `description` | TEXT | 2,000자 상한 |
| `location` | TEXT | 200자 상한 |
| `category` | TEXT NOT NULL DEFAULT `'general'` | `'general' \| 'meeting' \| 'coaching' \| 'training' \| 'deadline'` — 표시용(색·배지). 서버가 목록으로 검증 |
| `all_day` | INTEGER NOT NULL DEFAULT 0 | 1 = 종일 |
| `start_at` | TEXT NOT NULL | UTC, `YYYY-MM-DDTHH:MM:SSZ` 고정 형식. 종일이면 그 날 00:00 KST를 UTC로 바꾼 값 |
| `end_at` | TEXT NOT NULL | UTC, 끝 시각(포함하지 않음). 종일이면 마지막 날 다음 날 00:00 KST |
| `start_date` / `end_date` | TEXT | 종일일 때만. KST 날짜 `YYYY-MM-DD`, `end_date`는 포함하지 않는 끝(구글과 같은 규칙) |
| `timezone` | TEXT NOT NULL DEFAULT `'Asia/Seoul'` | 입력 기준 시간대. 지금은 항상 이 값 |
| `rrule` | TEXT | 반복 규칙. **C1에서는 항상 NULL** (1.4) |
| `exdates` | TEXT | 반복에서 뺄 날짜 JSON 배열. C1에서는 NULL |
| `remind_minutes` | INTEGER | 시작 몇 분 전에 알릴지. NULL = 알림 없음 (4장) |
| `status` | TEXT NOT NULL DEFAULT `'CONFIRMED'` | `CHECK IN ('CONFIRMED','CANCELLED')` |
| `version` | INTEGER NOT NULL DEFAULT 0 | 낙관적 잠금 (수정마다 +1, 결재와 같은 방식) |
| `deleted_at` | TEXT | 소프트 삭제. NULL = 살아 있음 |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT `(datetime('now'))` | 기존 관례 |

색인:
- `idx_cal_events_owner(owner_id, start_at)` — 내 일정 기간 조회
- `idx_cal_events_team(start_at) WHERE visibility = 'team' AND deleted_at IS NULL` — 팀 일정 기간 조회 (부분 색인, `0024`의 관례)
- `idx_cal_events_remind(start_at) WHERE remind_minutes IS NOT NULL AND deleted_at IS NULL` — 알림 크론용

결정과 근거:
- **한 테이블에 개인·공유를 함께 둔다.** 기간 조회 한 번으로 화면을 채울 수 있고, 공개 범위를 바꾸는 일이 행 이동이 아니라 값 변경이다. 권한은 조회 SQL의 `WHERE (owner_id = ?세션 OR visibility = 'team')` 한 줄에 모은다.
- **소프트 삭제를 쓴다.** 2단계에서 구글로 삭제를 전파하려면 "지워졌다"는 사실이 남아 있어야 한다. 30일 지난 삭제 행은 크론이 실제로 지운다.
- **`department_id`는 넣지 않는다.** 사용자 결정이 "팀 공유 = 전원"이다. 부서별 공유가 필요해지면 `ALTER TABLE ADD COLUMN department_id`와 `visibility = 'department'`를 더한다 (`departments` 테이블은 이미 있다 [코드 `0024`]).
- **구글에서 읽어 온 일정은 이 테이블에 넣지 않는다.** 1단계는 저장 없이 실시간으로 읽는다 (3장).

기간 조회 조건은 겹침 기준이다: `start_at < ?to AND end_at > ?from`.

### 1.3 시간대 방침

- **저장은 UTC, 표시는 항상 Asia/Seoul.** 브라우저가 다른 시간대에 있어도 KST로 보인다(회사 일정이므로).
- 일정 시각 문자열은 `YYYY-MM-DDTHH:MM:SSZ` 한 형식만 허용한다. 문자열 비교가 곧 시간 비교가 되게 하려는 것이다. (`created_at` 등 기록 시각은 기존대로 `datetime('now')` 형식을 쓴다. 두 형식을 서로 비교하는 쿼리를 만들지 않는다.)
- 한국은 일광절약시간이 없어 KST = UTC+9 고정이다 [일반 지식]. 서버의 KST 변환(종일 일정 경계, 반복 전개, "당일 09:00" 알림)은 +9시간 고정 계산으로 한다. 다른 시간대를 지원하게 되면 `timezone` 컬럼과 `Intl.DateTimeFormat`으로 바꾼다.
- 종일 일정은 날짜가 진실이다(`start_date`/`end_date`). `start_at`/`end_at`은 기간 조회와 정렬을 위해 함께 채운다.

### 1.4 반복 일정

**결정: C1~C5에는 자체 일정의 반복을 넣지 않는다. 컬럼(`rrule`, `exdates`)만 미리 둔다. 반복은 선택 단계 C7에서 제한된 형태로 넣는다.**

근거:
- 반복은 화면(전개), 수정("이 일정만 / 전체"), 알림(회차별 중복 방지), 구글 쓰기(RRULE 변환) 네 군데에 모두 손이 간다. 첫 배포 범위에서 가장 큰 위험이다.
- 구글 쪽 반복 일정은 1단계부터 정상으로 보인다. 구글에 `singleEvents=true`로 물으면 구글이 회차를 펼쳐서 준다 [일반 지식].

C7에서 넣을 때의 형태(미리 정해 둠):
- 규칙은 `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` + `INTERVAL` + `UNTIL`(또는 `COUNT`)만. `BYDAY` 복수 요일은 WEEKLY에서만.
- 전개는 **서버가** 조회 기간 안에서 한다(최대 366회). 알림 크론도 같은 함수를 써야 해서 프런트 전개(FullCalendar rrule 플러그인)는 쓰지 않는다.
- 수정·삭제는 "전체 시리즈"와 "이 회차만 삭제(`exdates`에 추가)"만. "이 회차만 수정"은 지원하지 않는다.

### 1.5 결재 기한·할 일 기한·코칭 일정과의 연동

**결정: 다른 모듈의 날짜는 `calendar_events`에 복사하지 않는다. 조회할 때 원본 테이블에서 읽어 "읽기 전용 항목"으로 합쳐 보여준다.** 코칭 일정만 예외로, 일반 일정(`category = 'coaching'`)으로 직접 만든다.

| 대상 | 지금 가능한가 | 방식 |
| --- | --- | --- |
| 결재 기한 | **불가** — 기한 컬럼이 없다 [코드] | 결재 모듈이 `approval_documents.due_at`을 추가한 뒤, `/api/calendar/events` 응답에 `source: 'approval'` 읽기 전용 항목으로 합친다. 보이는 범위는 결재의 `canView` 규칙(기안자·결재선) 그대로. 클릭하면 `/#approval/<id>` |
| 할 일 기한 | **불가** — 기한 컬럼이 없다 [코드] | `tasks.due_at` 추가 뒤 같은 방식(`source: 'task'`, 소유자만) |
| 코칭 일정 | 예약 테이블 없음 [코드] | 캘린더에서 `category = 'coaching'` 일정을 직접 만든다. 별도 테이블을 만들지 않는다 |
| 강의(LMS) | 날짜 개념 없음 [코드] | 연동하지 않는다 |

복사(미러 행)가 아니라 조회 시 합치는 이유:
- 복사하면 원본이 바뀔 때마다 두 곳을 맞춰야 하고, 결재 상태 변경은 `machine.ts` 한 곳만 지나간다는 원칙 [코드 `0024` 주석]을 깨고 캘린더 쓰기를 끼워 넣어야 한다.
- 권한 판단이 원본 모듈에 남는다. 복사본은 권한이 바뀌어도(결재선 변경) 남아 정보가 샐 수 있다.

이 연동은 기한 컬럼이 생겨야 하므로 선택 단계 C7로 둔다. 기한 컬럼 추가는 결재·할 일 모듈 세션의 일이다(열린 질문 6).

### 1.6 API (`/api/calendar`, 새 파일 `src/calendar/routes.ts`)

전부 로그인 필수(익명 401). 상태 변경은 `originOk` 통과 필요. 남의 개인 일정은 존재를 숨기려고 404 (결재와 같은 원칙).

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /events?from=&to=` | 기간(최대 62일) 안의 내 개인 일정 + 팀 일정. 각 항목에 `source: 'local'`, `editable`(내가 고칠 수 있는가), `owner_name` |
| `POST /events` | 만들기. `{title, start_at, end_at, all_day, visibility, description?, location?, category?, remind_minutes?}` |
| `GET /events/:id` | 상세 |
| `PATCH /events/:id` | 수정. `version` 불일치면 409 |
| `DELETE /events/:id` | 소프트 삭제 |
| `GET /google/status` 외 | 2장·3장 |

검증: `end_at > start_at`, 한 일정 최대 31일, 시각 형식 엄격 검사, 본문 256KB 상한(결재와 같은 값), `visibility`·`category` 목록 검사.

---

## 2. 구글 OAuth 흐름

이 장의 구글 쪽 사실은 전부 [일반 지식]이다. 실제 콘솔 화면·메뉴 이름은 다를 수 있다(구글이 2025년에 OAuth 설정 화면을 "Google Auth Platform"으로 개편한 것으로 알고 있으나 확인하지 못했다).

### 2.1 사용자가 Google Cloud에서 해야 하는 일 (단계별)

**누가**: People OS 운영자(사용자) 한 명이 OAuth 앱을 한 번 만든다. 그 뒤 구글 캘린더를 붙이려는 사람은 각자 People OS 화면에서 자기 구글 계정으로 동의한다.

**먼저 정할 것 — 대상(Audience)**
- **Internal(내부)**: Google Workspace 조직 계정으로 프로젝트를 만들 때만 고를 수 있다. 같은 조직 계정만 연결할 수 있고, 아래의 테스트 사용자 등록·7일 만료·검증 심사가 없다. 회사가 Workspace를 쓰면 이쪽이 가장 간단하다.
- **External(외부)**: 개인 Gmail 포함 누구나. 처음에는 게시 상태가 **Testing**이다.
  - Testing에서는 **등록한 테스트 사용자(최대 100명)만** 연결할 수 있다.
  - Testing에서는 **리프레시 토큰이 7일 뒤 만료**된다. 사용자는 매주 "다시 연결"을 눌러야 한다.
  - 7일 만료를 없애려면 게시 상태를 **In production**으로 바꾼다. 캘린더 스코프는 민감(sensitive) 스코프라 구글 검증 심사 대상이다. 심사 전에도 쓸 수는 있으나 동의 화면에 "확인되지 않은 앱" 경고가 뜨고 사용자 수 상한(100명)이 있다.
  - 검증 심사에는 소유 확인된 도메인의 홈페이지·개인정보처리방침 주소 등이 필요하다. `workers.dev` 하위 주소로 심사가 되는지는 **확인 안 됨**.

**단계**

1. `https://console.cloud.google.com` 에 연동용으로 쓸 구글 계정으로 들어간다.
2. 새 프로젝트를 만든다 (예: `people-os-calendar`).
3. **API 및 서비스 → 라이브러리**에서 "Google Calendar API"를 찾아 **사용 설정**한다.
4. **OAuth 동의 화면**(또는 Google Auth Platform → Branding)에서 앱 이름(`People OS`), 사용자 지원 이메일, 개발자 연락처 이메일을 넣는다.
5. **대상(Audience)**에서 Internal / External을 고른다. External이면 **테스트 사용자**에 구글 캘린더를 연결할 사람들의 구글 계정 이메일을 추가한다.
6. **데이터 액세스(Scopes)**에서 스코프를 추가한다.
   - 1단계: `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.events.readonly`
   - 2단계에 들어갈 때 추가: `https://www.googleapis.com/auth/calendar.events`
7. **사용자 인증 정보(Credentials / Clients) → OAuth 클라이언트 ID 만들기**
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 리디렉션 URI** (글자 하나까지 정확히 일치해야 한다):
     - `https://people-os.workspace-easyware.workers.dev/api/calendar/google/callback`
     - 앱을 `peopleos.site`로도 연다면 `https://peopleos.site/api/calendar/google/callback`도 추가 (열린 질문 2)
     - 로컬 시험용(선택): `http://localhost:8787/api/calendar/google/callback`
   - "승인된 JavaScript 원본"은 비워 둔다 (서버가 코드를 교환하는 방식이라 필요 없다).
8. 만들어진 **클라이언트 ID**와 **클라이언트 보안 비밀**을 받는다. 보안 비밀은 채팅·문서·명령줄 인자에 붙여 넣지 않는다.
9. Worker에 시크릿 세 개를 넣는다 (값은 프롬프트 입력 또는 표준입력으로만):
   - `GOOGLE_CLIENT_ID` (비밀은 아니지만 한곳에서 관리하려고 시크릿으로 둔다)
   - `GOOGLE_CLIENT_SECRET`
   - `GCAL_TOKEN_KEY` — 토큰 암호화 키. 무작위 32바이트를 base64로 (`openssl rand -base64 32`의 출력)
   - 명령: `cf-wrangler.py secret put <이름>` (대화형 세션에서 사용자가 직접. `-p` 세션은 대화형 입력을 못 한다)
10. People OS에 로그인 → 캘린더 → **구글 캘린더 연결** → 구글 계정 선택 → 권한 동의. Testing 상태면 "Google에서 확인하지 않은 앱" 화면이 나오며 "계속"을 눌러야 한다.
11. 다른 구성원도 각자 10번을 한다 (External/Testing이면 5번의 테스트 사용자 목록에 있어야 한다).

### 2.2 스코프 (최소 권한)

| 단계 | 스코프 | 이유 |
| --- | --- | --- |
| 1단계 (읽기) | `https://www.googleapis.com/auth/calendar.events.readonly` | 일정 읽기만. 캘린더 목록·설정·공유 권한은 못 건드린다 |
| 1단계 (표시용) | `openid`, `email` | 어느 구글 계정이 연결됐는지 화면에 보여주기 위해. 민감 스코프가 아니다 |
| 2단계 (쓰기) | `https://www.googleapis.com/auth/calendar.events` | 일정 읽기·쓰기. 2단계에 들어갈 때 사용자에게 다시 동의를 받는다 |

- **쓰지 않는 것**: `https://www.googleapis.com/auth/calendar`(캘린더 전체 권한 — 캘린더 삭제·공유 설정까지 포함).
- 1단계는 **기본 캘린더(`primary`)만** 읽는다. 다른 캘린더를 고르게 하려면 캘린더 목록 스코프(`calendar.calendarlist.readonly`로 알고 있음)가 더 필요하므로 넣지 않는다.
- 더 좁은 쓰기 스코프(`calendar.events.owned`, `calendar.app.created`)가 있는 것으로 알고 있다. 이름과 동작은 **확인 안 됨**. C6 세션이 문서를 확인해, 쓸 수 있으면 `calendar.events` 대신 쓴다.
- 처음부터 쓰기 스코프를 받지 않는 이유: 1단계 코드는 구글에 아무것도 쓰지 않는다. 쓰지 않는 권한을 받아 두면 토큰이 새었을 때 피해가 커지고, 동의 화면 문구("일정 수정·삭제")가 사용자에게 불필요한 걱정을 준다.

### 2.3 연결 흐름

```
[브라우저]                      [Worker /api/calendar/google]                 [Google]
 "구글 캘린더 연결" 클릭
   POST /connect (세션 쿠키) ───▶ state·PKCE 생성, D1 calendar_oauth_states 저장(10분)
   ◀─── { url } ─────────────────
   location = url ──────────────────────────────────────────────────────────▶ 동의 화면
   ◀──────────── 302 /api/calendar/google/callback?code=…&state=… ───────────
   GET /callback (쿠키 없음!) ──▶ 세션 확인 없이 "연결 마무리" HTML만 돌려준다
   그 HTML의 스크립트가
   POST /complete {code,state} ─▶ 세션 확인 → state 조회·삭제 → state.user_id = 세션 사용자 확인
     (같은 출처라 쿠키 실림)       → code 교환 ───────────────────────────────▶ 토큰 엔드포인트
                                  ◀── access_token, refresh_token, id_token ──
                                  → 암호화해 D1 저장
   ◀─── { ok } → location.replace('/#calendar')
```

**`/callback`이 세션을 보지 않는 이유 (이 설계에서 가장 놓치기 쉬운 점)**: 세션 쿠키가 `SameSite=Strict`다 [코드]. 구글에서 돌아오는 이동은 다른 사이트가 시작한 이동이라 브라우저가 Strict 쿠키를 싣지 않는다 [일반 지식]. 콜백에서 바로 세션을 확인하면 항상 "로그인 필요"가 된다. 그래서 콜백은 최소한의 HTML만 돌려주고, 그 페이지가 같은 출처에서 `fetch`로 `/complete`를 부른다. 이 요청에는 쿠키가 실린다. 쿠키를 `Lax`로 낮추는 방법도 있지만 앱 전체의 보안 설정을 캘린더 때문에 바꾸지 않는다. (C3 검증 항목: 실제 브라우저에서 이 흐름이 쿠키와 함께 동작하는지.)

세부:
- **인가 요청 매개변수**: `response_type=code`, `client_id`, `redirect_uri`(요청이 들어온 출처 + 고정 경로, 허용 목록과 대조), `scope`, `state`, `access_type=offline`(리프레시 토큰을 받기 위해), `prompt=consent`(리프레시 토큰이 매번 오게), `include_granted_scopes=true`, `code_challenge` + `code_challenge_method=S256`.
- **state**: 무작위 32바이트. D1에는 `sha256(state)`만 저장한다(세션 토큰과 같은 방식 [코드 `auth.ts`]). 한 번 쓰면 지운다. 10분 넘으면 무효.
- **`calendar_oauth_states`**: `state_hash PK, user_id, code_verifier, redirect_uri, expires_at`. KV가 아니라 D1에 두는 이유는 2.4와 같다.
- **`/callback` 응답**: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. 스크립트는 `code`·`state`를 읽은 직후 `history.replaceState`로 주소창에서 지운다. 구글이 `error=access_denied`를 돌려주면 "연결을 취소했습니다"를 보여주고 캘린더로 돌아간다.
- **`/complete`**: 세션 필수 + `originOk`. state의 `user_id`가 세션 사용자와 다르면 거부한다(다른 사람의 인가 코드를 내 계정에 붙이는 공격 방지). 응답의 `scope`에 필요한 스코프가 빠져 있으면(사용자가 체크를 풀면) 저장하지 않고 안내한다. `refresh_token`이 없으면 저장하지 않고 "다시 연결"을 안내한다.
- **id_token**: 구글 토큰 엔드포인트에서 TLS로 직접 받은 것이라 페이로드의 `email`·`sub`만 읽는다. 로그인 수단으로 쓰지 않는다 — People OS 로그인은 기존 비밀번호 세션 그대로다.
- **미설정 시**: `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`·`GCAL_TOKEN_KEY` 중 하나라도 없으면 `/google/*`는 503 "구글 연동 미설정"을 돌려준다(fail-closed, `RESEND_API_KEY`와 같은 방식 [코드]). 자체 캘린더는 그대로 동작한다.

### 2.4 토큰 저장 위치와 암호화

**결정: D1 `calendar_google_accounts`에 AES-256-GCM으로 암호화해 저장한다. KV는 쓰지 않는다.**

| 컬럼 | 설명 |
| --- | --- |
| `user_id` TEXT PK | People OS 사용자당 구글 계정 1개 |
| `google_sub`, `google_email` | 연결된 구글 계정 (표시용) |
| `scopes` | 실제 부여된 스코프 문자열 |
| `refresh_token_enc` | 암호문 |
| `access_token_enc`, `access_expires_at` | 암호문 + 만료 시각 (매 요청마다 재발급하지 않으려고 둔다) |
| `key_version` INTEGER DEFAULT 1 | 키 교체용 |
| `status` | `CHECK IN ('CONNECTED','NEEDS_RECONNECT')` |
| `last_ok_at`, `last_error` | 상태 표시용 |
| `connected_at`, `updated_at` | |

D1을 고른 이유:
- KV는 쓰기가 다른 지역에 퍼지는 데 시간이 걸린다(최대 60초로 알고 있음 [일반 지식]). "연결 해제" 직후 다른 지역에서 옛 토큰이 읽히거나, 방금 저장한 state가 안 읽힐 수 있다. D1은 그런 지연이 없다.
- 연결 상태·연결 표(2단계)와 한 `batch`로 묶어 갱신할 수 있다.
- 사용자 삭제·비활성 때 `DELETE … WHERE user_id = ?` 한 줄로 지울 수 있다.

암호화:
- Web Crypto `AES-GCM`, 키는 시크릿 `GCAL_TOKEN_KEY`(32바이트). 암호화마다 무작위 12바이트 IV. 추가 인증 데이터(AAD)에 `user_id`와 용도(`refresh`/`access`)를 넣어, 한 사용자의 암호문을 다른 사용자 행에 붙여 넣어도 복호화가 실패하게 한다.
- 저장 형식: `v<key_version>.<base64 IV>.<base64 암호문>`.
- 새 파일 `src/calendar/crypto.ts`. 기존 코드에 재사용할 유틸이 없다 [코드].
- **이 암호화가 막는 것과 못 막는 것**: D1 내용만 본 사람(덤프·`d1 execute`·`X-Admin-Secret` 경로의 실수)은 토큰을 얻지 못한다. Worker 시크릿과 D1을 둘 다 가진 사람(배포 권한자)은 복호화할 수 있다. 이것은 Worker 한 개 구조에서 없앨 수 없다.
- 토큰과 인가 코드는 로그에 찍지 않는다. API 응답에 절대 넣지 않는다.

### 2.5 토큰 갱신

- 액세스 토큰 수명은 약 1시간으로 알고 있다 [일반 지식]. 고정값으로 가정하지 않고 응답의 `expires_in`으로 `access_expires_at`을 계산한다.
- 구글을 부르기 직전에 `access_expires_at`까지 5분 이하로 남았으면 토큰 엔드포인트에 `grant_type=refresh_token`으로 재발급을 받는다. 응답에 새 `refresh_token`이 들어 있으면 그것으로 바꿔 저장한다.
- 구글 API가 401을 주면 한 번만 재발급 후 다시 시도한다.
- 재발급이 `invalid_grant`로 실패하면(사용자가 구글에서 권한 회수, Testing 7일 만료, 6개월 미사용 등 [일반 지식]) `status = 'NEEDS_RECONNECT'`로 바꾸고 액세스 토큰을 지우고, `notifications`에 "구글 캘린더를 다시 연결해 주세요"를 **한 번만** 넣는다.
- 두 요청이 동시에 재발급해도 둘 다 유효한 토큰을 받는 것으로 알고 있다 [일반 지식]. 잠금은 두지 않고 나중에 쓴 값이 남게 한다.
- **연결 해제**(`DELETE /google`): 구글 폐기 엔드포인트에 리프레시 토큰을 보내고(실패해도 계속), 행을 지운다. 2단계의 연결 표도 지운다. People OS 일정은 남긴다.
- **사용자 비활성**: `users.status`가 `active`가 아닌 사용자의 `calendar_google_accounts` 행은 크론이 폐기·삭제한다 (`auth-routes.ts`를 건드리지 않으려고 크론 청소로 한다).

---

## 3. 동기화 설계

### 3.1 단계 구분

| | 1단계 (C3·C4) | 2단계 (C6) |
| --- | --- | --- |
| 방향 | 구글 → People OS **읽기만** | + People OS → 구글 **쓰기** |
| 구글 일정의 저장 | **저장 안 함** — 화면이 열릴 때 실시간으로 읽음 | 그대로 (저장 안 함) |
| People OS 일정의 구글 반영 | 없음 | 일정마다 "구글에도 저장"을 켠 **개인 일정만** |
| 스코프 | `calendar.events.readonly` | `calendar.events` |
| 충돌 가능성 | 없음 | 연결된 일정에 한해 있음 → etag로 처리 |

양방향을 한 번에 하지 않는 이유: 쓰기가 들어가는 순간 중복·충돌·삭제 전파·재시도가 한꺼번에 생긴다. 읽기만으로도 "내 구글 일정과 회사 일정을 한 화면에서 본다"는 가치의 대부분이 나온다.

### 3.2 1단계 — 복사 없는 실시간 읽기

`GET /api/calendar/google/events?from=&to=` (세션 필수):
1. 세션 사용자의 `calendar_google_accounts`를 읽는다. 없으면 `{connected:false}`.
2. 필요하면 토큰을 재발급한다(2.5).
3. 구글 `events.list`를 `calendarId=primary`, `timeMin`, `timeMax`, `singleEvents=true`, `showDeleted=false`, `maxResults=250`으로 부른다. 다음 페이지가 있으면 최대 4쪽까지만 따라간다(1,000건 상한 — 초과 시 `truncated:true`).
4. 필요한 필드만 골라 돌려준다: `id, summary, start, end, 종일 여부, location, htmlLink, status`. 설명·참석자·회의 링크는 내보내지 않는다(화면에 쓰지 않는 개인 정보를 옮기지 않는다).
5. 각 항목은 `source: 'google'`, `editable: false`. 클릭하면 `htmlLink`로 구글 캘린더를 새 탭에 연다.

프런트는 자체 일정(`/events`)과 구글 일정(`/google/events`)을 **두 개의 독립된 이벤트 소스**로 불러온다. 자체 일정이 먼저 그려지고, 구글이 느리거나 실패해도 자체 일정은 그대로 보인다.

이 방식을 고른 이유(미러 테이블 + 주기 동기화와 비교):

| | 실시간 읽기 (채택) | D1 미러 + Cron 동기화 |
| --- | --- | --- |
| 구글 일정이 D1에 평문으로 남는가 | 아니오 | 예 (개인 일정 제목·시간이 운영 DB에 쌓임) |
| 중복 방지·삭제 전파·동기화 토큰 관리 | 필요 없음 (항상 구글의 현재 상태) | 전부 필요 (syncToken, 410 시 전체 재동기화 등) |
| Cron·Free 한도 | 사용 안 함 | 사용자 수 × 주기만큼 외부 요청 |
| 화면 지연 | 구글 호출 1회(수백 ms 예상, 실측 안 함) | 없음 |
| 구글 장애 시 | 구글 일정만 안 보임 | 마지막 복사본은 보임 |
| 구글 일정으로 People OS가 알림·다이제스트 | 못 함 (구글 자체 알림에 맡김) | 가능 |

미러가 필요해지는 조건(지금은 해당 없음): 아침 다이제스트에 구글 일정을 넣거나, 에이전트가 구글 일정을 맥락으로 써야 할 때. 그때는 미러를 얹되 저장 필드를 최소로 한다.

참고 프로젝트와의 대응: Potion Calendar(구글 캘린더 클라이언트)가 이 방식이고, notion-caldav-sync·slotmirror는 미러 방식이다. 저장소를 이 세션에서 직접 읽지는 않았다 — 사용자 조사에 적힌 성격만 근거로 삼았다.

### 3.3 동기화 트리거

| 트리거 | 1단계 | 2단계 | 비고 |
| --- | --- | --- | --- |
| 화면 열기·기간 이동 | **사용** | 사용 | 달력이 보이는 기간이 바뀔 때마다 그 기간을 읽는다 |
| 수동 새로고침 버튼 | **사용** | 사용 | 사용자당 10초에 1회로 제한 (KV `CACHE` 카운터 — 기존 질문 제한과 같은 방식 [코드]) |
| Cron 주기 | 사용 안 함 | **사용** (연결된 일정 대조만, 15분) | 3.5 |
| 구글 웹훅(push notification) | **사용 안 함** | **사용 안 함** | People OS에 수신 엔드포인트가 없다. 채널이 만료돼 주기적으로 다시 등록해야 하고, 수신 주소 요건도 확인하지 못했다. 15분 대조로 부족해질 때의 후속 선택지로만 둔다 |

### 3.4 2단계 — 쓰기

범위:
- **보내는 것**: 본인이 만든 **개인 일정** 중 "구글 캘린더에도 저장"을 켠 것. 본인의 기본 캘린더로 간다.
- **보내지 않는 것**: 팀 공유 일정. 한 일정을 모든 사람의 구글 캘린더에 쓰려면 사람 수만큼 쓰기가 생기고, 한 명의 실패·수정이 전체와 어긋난다. 팀 일정을 구글에서도 보고 싶다는 요구는 읽기 전용 ICS 구독 주소(C7 후보)로 푸는 편이 단순하다.
- **구글 일정을 People OS에서 고치기**: 2단계에서도 **하지 않는 것을 권장**한다(구글 일정은 "구글에서 열기"). 이유: 참석자가 있는 일정·반복 일정의 회차 수정은 구글 쪽 규칙이 복잡하다. 요구가 분명해지면 3단계로.

연결 표 `calendar_event_links`:

| 컬럼 | 설명 |
| --- | --- |
| `event_id` TEXT PK | `calendar_events.id` |
| `user_id` | 누구의 구글 계정인가 (= 일정의 `owner_id`) |
| `google_event_id` | 구글 쪽 id |
| `etag` | 마지막으로 본 구글 etag |
| `push_status` | `CHECK IN ('PENDING','SYNCED','FAILED','DELETE_PENDING')` |
| `attempts`, `last_error`, `pushed_at` | 재시도 관리 |

`UNIQUE(user_id, google_event_id)`.

**중복 방지**
- 구글 일정 id를 People OS id에서 **미리 정해** 만들어 보낸다(구글은 클라이언트가 정한 id를 받는 것으로 알고 있다 — 허용 문자·길이는 확인 필요 [일반 지식]). 같은 일정을 다시 보내도 "이미 있음(409)"이 돌아오므로 재시도로 두 개가 생기지 않는다.
- 보낼 때 구글 일정의 비공개 확장 속성에 `peopleOsEventId`를 넣는다.
- 1단계의 실시간 읽기 결과에는 방금 보낸 일정이 구글 일정으로 다시 나타난다. 서버가 읽기 응답에서 **연결 표에 있는 `google_event_id`를 걸러** 같은 일정이 두 번 보이지 않게 한다.

**충돌 해결 — 연결된 일정은 구글 쪽 변경이 이긴다, 단 덮어쓰기 전에 etag로 확인한다**
- People OS에서 연결된 일정을 고치면: D1을 먼저 고치고(`push_status = 'PENDING'`), 응답을 보낸 뒤 `waitUntil`로 구글에 `If-Match: <etag>`와 함께 수정 요청을 보낸다.
  - 성공: 새 etag 저장, `SYNCED`.
  - 412(구글에서 그사이 바뀜): 구글의 현재 값을 가져와 **People OS 행을 구글 값으로 덮어쓰고**, 사용자에게 알림 "구글에서 먼저 바뀐 일정이라 구글 내용으로 맞췄습니다"를 넣는다. 조용히 버리지 않는다.
  - 그 밖의 실패: `FAILED` + `attempts` 증가, 크론이 재시도(최대 5회, 이후 화면에 "구글 반영 실패" 표시).
- 구글에서 연결된 일정이 바뀌면: 3.5의 대조가 etag 차이를 보고 People OS 행을 구글 값으로 고친다. 단, 그 행이 `PENDING`(People OS 변경이 아직 안 나감)이면 위의 412 경로와 같은 결과가 되도록 구글 값을 우선한다.
- 필드별 병합은 하지 않는다. "마지막에 구글에 도착한 것이 진실"이라는 한 규칙이 사용자에게 설명하기 쉽고, 구글이 다른 기기·앱과 공유되는 쪽이기 때문이다.

**삭제 전파**
- People OS에서 삭제: 소프트 삭제 + `push_status = 'DELETE_PENDING'` → 구글에 삭제 요청. 구글이 404/410을 주면 이미 지워진 것이므로 성공으로 본다. 끝나면 연결 행을 지운다.
- 구글에서 삭제: 대조에서 그 일정이 취소 상태로 나오면 People OS 행을 **소프트 삭제**한다(30일 안에 복구 가능). 알림을 한 건 넣는다. 외부에서 지워졌다고 People OS 데이터를 즉시 없애지는 않는다.
- "구글에도 저장"을 끄면: 구글 일정을 지우고 연결 행을 지운다. People OS 일정은 남는다.
- 연결 해제: 연결 행만 지운다. 구글에 이미 간 일정은 구글에 남는다(화면에서 미리 알린다).

### 3.5 2단계 — 연결된 일정 대조 (Cron)

- 15분 크론(4장의 알림 크론과 같은 틱)에서, 연결 행이 있는 사용자만 대상으로 한다.
- 사용자마다 `events.list`를 "마지막 대조 이후 바뀐 것"(`updatedMin`) + `showDeleted=true`로 부르고, 결과 중 **연결 표에 있는 id만** 처리한다. 나머지(연결 안 된 구글 일정)는 읽고 버린다 — 저장하지 않는다.
- `updatedMin`이 너무 오래됐다는 오류가 오면 연결된 일정을 하나씩 `events.get`으로 확인한다.
- 한 틱에 처리하는 사용자 수를 제한한다(마지막 대조가 오래된 순으로 최대 10명). Free 한도: 호출당 외부 요청 50개, D1 쿼리 50개(`batch`는 1개로 센다) [CF 문서].
- `syncToken` 방식 대신 `updatedMin`을 쓰는 이유: 저장할 것이 연결된 일정 몇 건뿐이라 전체 동기화 상태(토큰, 410 시 전체 재동기화)를 유지할 가치가 없다. `updatedMin`의 정확한 제약은 **확인 안 됨** — C6이 문서를 확인하고, 맞지 않으면 "연결된 일정을 `events.get`으로 하나씩"으로 단순화한다(연결 일정이 사용자당 수십 건 이하일 때만 유효).

---

## 4. 알림

### 4.1 방식 — 기존 알림 패턴 재사용

`Cron(15분) → D1 notifications 기록 → Resend 메일`. 결재 알림과 같은 표·같은 종 아이콘을 쓴다 [코드 `src/approval/notify.ts`].

- **Cron 추가**: `wrangler.toml`의 `crons`에 `*/15 * * * *`를 더한다.
  - **반드시 `scheduled()`에 분기를 추가해야 한다.** 지금 코드는 평가 cron이 아니면 전부 다이제스트를 생성한다 [코드 `index.ts:1887-1894`]. 분기 없이 cron만 더하면 다이제스트가 15분마다 돈다. `event.cron === "*/15 * * * *"`를 **맨 먼저** 검사한다.
  - Free 플랜의 Cron Trigger는 계정당 5개다 [CF 문서]. 이 Worker가 2개를 쓰고 있다 [코드]. 같은 계정의 다른 Worker가 몇 개를 쓰는지는 **확인 안 됨** — C5가 대시보드/`wrangler`로 확인한다.
  - Free의 Cron 호출 CPU 한도는 10ms다 [CF 문서]. 대기 시간(D1·fetch)은 CPU로 세지 않지만, 한 틱의 처리량을 작게 유지한다.
- **정밀도**: 15분 단위. "10분 전" 알림은 실제로 10~25분 전에 도착한다. 화면 문구는 "약 10분 전"이 아니라 선택지를 15분 단위(15분/30분/1시간/1일 전)로 제한해 어긋남을 없앤다.
- **대상 일정**: `remind_minutes IS NOT NULL`, 삭제·취소 아님, `start_at - remind_minutes분 <= 지금 < start_at`.
- **받는 사람**:
  - 개인 일정: 소유자. 종 알림 + 메일.
  - 팀 일정: 활성 사용자 전원에게 종 알림. 메일은 보내지 않는다(전원 메일은 Resend 한도와 소음 문제 — Resend 무료 한도 수치는 확인 안 됨).
  - 구글 일정: People OS가 알리지 않는다. 내용을 저장하지 않고, 구글이 이미 알린다(중복 알림 방지).
- **중복 방지**: `calendar_reminder_log(event_id, occurrence_start, user_id) PRIMARY KEY`에 `INSERT OR IGNORE`하고, 같은 `batch` 안에서 "방금 그 로그 행이 들어갔을 때만" `notifications`에 넣는다. 결재의 `notificationStmt`가 쓰는 `INSERT … SELECT … WHERE EXISTS` 형태를 따른다 [코드]. 크론이 겹쳐 돌거나 재시도돼도 한 번만 알린다.
- **알림 행**: `type = 'CALENDAR_REMINDER'`, `ref_type = 'calendar_event'`, `ref_id = <일정 id>`, `title = "[일정] <제목> · 11/20(금) 14:00"`, `link = "/#calendar/<일정 id>"`.
- **메일**: 제목·시각·링크만 담는다(기존 원칙: 본문 미포함). 발신 `"People OS 일정" <calendar@peopleos.site>`. `RESEND_API_KEY`가 없으면 메일은 건너뛰고 D1 기록만 남긴다(기존 동작과 같음).
  - `deliverEmails`는 결재용 발신자·문구가 박혀 있다 [코드]. 결재 모듈을 고치지 않고 `src/calendar/notify.ts`를 새로 만들어 `sendEmail`만 재사용한다. 공통화는 나중 일이다.
  - 크론에는 요청 출처가 없어 링크의 앞부분을 알 수 없다. `wrangler.toml [vars]`에 `APP_ORIGIN`을 추가한다(비밀 아님).
- **종일 일정**: 선택지를 "당일 오전 9시 / 전날 오전 9시"로 둔다. `remind_minutes`에 시작(00:00 KST) 기준 차이를 넣는다(당일 09:00 = −540, 전날 09:00 = 900).
- **청소**: 같은 크론이 하루 한 번(예: KST 04시대 틱) 만료된 `calendar_oauth_states`, 60일 지난 `calendar_reminder_log`, 30일 지난 소프트 삭제 일정을 지운다.

### 4.2 반복 일정 알림

C1~C5에는 반복이 없으므로 해당 없음. C7에서 반복을 넣을 때:
- 크론이 1.4의 서버 전개 함수로 "지금부터 가장 긴 알림 간격(1일)까지" 안의 회차를 구해 4.1과 같은 조건을 적용한다.
- 중복 방지 키의 `occurrence_start`가 회차별 시작 시각이므로 회차마다 한 번씩 알린다. 이 키 구조는 C1에서 미리 만들어 둔다(단일 일정은 `occurrence_start = start_at`).
- `exdates`로 뺀 회차는 전개 단계에서 빠진다.

---

## 5. UI 설계

### 5.1 달력 그리드 — FullCalendar를 쓴다

| 기준 | FullCalendar v6 표준 번들 | 직접 구현 |
| --- | --- | --- |
| 월 보기 | 있음 | 쉽다 |
| 주 보기(시간 격자, 겹치는 일정 배치, 여러 날 일정) | 있음 | 어렵다 — 겹침 배치·종일 줄·현재 시각선에서 버그가 나기 쉽다 |
| 라이선스 | 표준 플러그인(daygrid·timegrid·list·interaction)은 MIT로 알고 있다. 타임라인·리소스 보기는 유료(Premium)이며 쓰지 않는다 [일반 지식] | 해당 없음 |
| 번들 크기 | 전역 번들 한 파일 약 250~300KB(압축 전)로 알고 있다 — **확인 안 됨, C2에서 실측** | 20~30KB 예상 |
| 디자인 조화 | `--fc-*` CSS 변수와 자체 툴바로 맞춘다 | 완전히 자유 |

**결정: FullCalendar 표준 번들을 쓴다.** 주 보기를 직접 만드는 비용과 위험이 크기 부담보다 크다. 크기 부담은 다음으로 줄인다.
- 파일을 `public/vendor/fullcalendar/`에 직접 둔다(번들러가 없고 [코드], 데모가 외부 CDN에 의존하지 않게).
- **캘린더 탭을 처음 열 때만** 스크립트를 동적으로 불러온다. 다른 탭의 첫 로딩에는 영향이 없다. `index.html`에 `<script>` 태그를 추가하지 않는다 — `calendar.js`가 필요할 때 넣는다.
- 한국어 로케일 파일만 함께 둔다.

되돌림 기준: C2에서 실측한 번들이 400KB(압축 전)를 넘거나, People OS 모양에 맞추는 데 반나절 이상 걸리면 월 보기만 직접 구현하고 주 보기는 "주간 목록"으로 대체한다.

디자인 시스템과 맞추기 [코드 `public/styles.css` 토큰]:
- FullCalendar 기본 툴바는 끈다(`headerToolbar: false`). People OS 버튼 스타일로 자체 툴바를 만든다: `오늘` `‹` `›` `2026년 11월` … `월 | 주` `+ 일정 추가` `구글 상태 칩`.
- `--fc-border-color: var(--color-line)`, `--fc-today-bg-color: var(--color-accent-soft)`, `--fc-page-bg-color: var(--color-surface)`, 글자 크기는 `styles.css`의 타입 스케일(13/12px).
- 새 색을 만들지 않고 기존 토큰만 쓴다.

시간대: 화면은 항상 KST. FullCalendar의 `timeZone` 설정이 플러그인 없이 `Asia/Seoul`을 정확히 처리하는지는 **확인 안 됨**. C2 검증에 "브라우저 시간대를 다른 지역으로 바꿔도 KST로 보이는가"를 넣고, 안 되면 `calendar.js`의 변환 함수가 KST 벽시계 값으로 바꿔 넘기는 방식(+9시간 고정)으로 한다.

### 5.2 보기

- **월 보기**(기본): 날짜 칸에 일정 막대. 한 칸에 3개 넘으면 "+N개".
- **주 보기**: 시간 격자 07:00~21:00 기본 표시(스크롤로 전체), 종일 줄 위쪽.
- 좁은 화면(모바일 폭)에서는 주 보기 대신 주간 목록 보기.
- 빈 칸 클릭 = 그 날짜/시간으로 추가 폼. 일정 클릭 = 상세. 끌어서 옮기기는 C2 범위에서 뺀다(잘못 끌어 일정이 바뀌는 사고를 막고, 2단계의 구글 쓰기와 엮이지 않게).
- 해시: `#calendar`, `#calendar/<일정 id>`(알림 링크 — 그 일정의 달로 이동해 상세를 연다).

### 5.3 일정 추가·수정 폼 (기존 모달·카드 스타일)

| 필드 | 내용 |
| --- | --- |
| 제목 | 필수, 200자 |
| 종일 | 토글. 켜면 시간 입력이 날짜 입력으로 바뀐다 |
| 시작 / 종료 | 날짜 + 시간(15분 단위). 종료 기본값 = 시작 + 1시간. "한국 시간 기준" 안내 문구 |
| 공개 범위 | `나만 보기` / `팀 공유 (전원이 봅니다)` — 팀 공유를 고르면 그 문구를 한 번 더 보여준다 |
| 분류 | 일반 / 회의 / 코칭 / 교육 / 기한 |
| 장소, 메모 | 선택 |
| 알림 | 없음 / 15분 전 / 30분 전 / 1시간 전 / 1일 전 (종일: 당일 9시 / 전날 9시) |
| 구글 캘린더에도 저장 | **2단계에서만 표시.** 개인 일정 + 구글 연결됨일 때만 활성 |

- 버튼: `저장`, `취소`, (수정 시) `삭제` — 삭제는 확인 한 번. 팀 일정 삭제 확인에는 "전원의 달력에서 사라집니다"를 넣는다.
- 남의 팀 일정: 읽기 전용 상세(작성자 이름 표시), 수정·삭제 버튼 없음.
- 저장 충돌(409): "다른 곳에서 먼저 수정됐습니다. 새로 불러옵니다."

### 5.4 일정 구분 표시 (색 + 배지 — 색만으로 구분하지 않는다)

| 종류 | 표시 |
| --- | --- |
| 내 개인 일정 | 남색 면 (`--color-primary`), 흰 글자 |
| 팀 공유 일정 | 초록 면 (`--cat-emerald`) + `팀` 배지. 내가 만든 것은 수정 가능 표시 |
| 구글 일정 | 흰 면 + 하늘색 테두리 (`--cat-sky`) + `G` 배지. 클릭 시 "구글 캘린더에서 열기" |
| 코칭 분류 | 왼쪽 띠를 보라 (`--cat-violet`) |
| (C7) 결재·할 일 기한 | 호박색 점 (`--cat-amber`) + `기한` 배지, 읽기 전용 |

툴바 아래에 보기 필터 체크박스: `내 일정` `팀 일정` `구글`.

### 5.5 구글 연동 상태 표시 (툴바 오른쪽 칩 + 눌렀을 때 작은 패널)

| 상태 | 칩 | 패널 |
| --- | --- | --- |
| 서버 미설정 (시크릿 없음) | hr_admin에게만 `구글 연동 미설정` | "관리자가 Google OAuth 설정을 마쳐야 합니다" |
| 연결 안 됨 | `구글 캘린더 연결` (버튼) | 무엇을 읽는지 한 줄: "기본 캘린더의 일정을 읽기만 합니다. 내용은 People OS에 저장하지 않습니다." |
| 연결됨 | `● 구글 연결됨` | 계정 이메일, 마지막으로 읽은 시각, `새로고침`, `연결 해제` |
| 다시 연결 필요 | `▲ 다시 연결` (경고색 `--color-warn`) | "구글 권한이 만료됐거나 회수됐습니다" + `다시 연결` |
| 일시 오류 | `● 구글 응답 없음` | "구글 일정을 불러오지 못했습니다. 내 일정과 팀 일정은 정상입니다." + `다시 시도` |

연결 해제 확인 문구: "People OS의 일정은 그대로 남습니다. (2단계) 구글에 이미 저장된 일정은 구글에 남습니다."

### 5.6 파일

- `public/calendar.js` — `calendarOpen(sub)`, `calendarLeave()`를 전역으로 내놓는다(기존 `lmsOpen`/`lmsLeave`, `orgOpen` 계약과 같은 형태 [코드]). `index.html` 인라인 스크립트의 전역(`$`, `api`, `esc`, `escAttr`, `currentUser`)을 쓴다.
- `public/calendar.css`
- `public/vendor/fullcalendar/` — 번들 + 한국어 로케일 + 라이선스 파일
- 홈의 "오늘 일정" 카드는 C7 후보(홈 섹션이 `index.html` 안이라 배선 단계와 같은 제약을 받는다).

---

## 6. 보안·권한

### 6.1 권한표

| 대상 | 읽기 | 만들기 | 수정·삭제 |
| --- | --- | --- | --- |
| 개인 일정 (`private`) | 소유자만 | 본인 | 소유자만 |
| 팀 일정 (`team`) | 로그인한 전원 | 로그인한 전원 | **작성자 또는 hr_admin 세션** |
| 구글 일정 (실시간 읽기) | 연결한 본인만 | — | — (1단계) |
| 구글 토큰·연결 상태 | 본인만 (토큰 자체는 누구에게도 응답으로 나가지 않는다) | 본인 | 본인 (연결 해제) |

- **팀 일정을 누구나 만들 수 있게 한 이유**: hr_admin만 쓸 수 있으면 팀 달력이 공지 게시판이 되고 회의·교육·휴가 공유 같은 일상 용도가 막힌다. 대신 작성자가 기록되고, hr_admin이 부적절한 일정을 지울 수 있다. "hr_admin만 작성"을 원하면 서버 검사 한 줄 차이다(열린 질문 3).
- **hr_admin도 남의 개인 일정·구글 일정은 못 본다.** 결재가 "hr_admin이라도 결재선 밖이면 볼 수 없다"로 한 것과 같은 원칙이다 [코드 `approval/routes.ts:110`]. 남의 개인 일정을 물으면 403이 아니라 404.

### 6.2 `X-Admin-Secret` 차단

- **캘린더 하위 앱은 `isAdminRequest`를 쓰지 않는다.** 모든 경로가 `getSessionUser`만 쓴다. `getSessionUser`는 쿠키만 보므로 `X-Admin-Secret`만으로는 어떤 캘린더 경로도 통과하지 못한다(401) — LMS 진도 저장이 이미 이 방식이다 [코드 `lms/routes.ts:196`].
- 팀 일정의 hr_admin 수정 권한은 **세션 사용자의 `role === 'hr_admin'`**으로만 판단한다. 시크릿에는 사용자 신원이 없어 "본인"이라는 개념이 성립하지 않는다.
- 기존의 `X-Admin-Secret` 경로(`/api/debug-ai`, `/api/seed*`, `/api/admin/reindex*`, `/api/admin/build-trees`) [코드]는 캘린더 테이블을 읽지 않는다. C3 세션은 구현 후 `grep -rn "calendar_" src/`로 캘린더 테이블에 닿는 코드가 `src/calendar/`(와 `index.ts`의 크론 호출)뿐인지 확인한다.
- 다른 모듈(에이전트 활동 `src/agent/activity.ts`, 다이제스트, 개인 RAG)이 나중에 캘린더를 읽게 되면 반드시 소유자 조건을 붙인다. 구글 토큰 테이블은 `src/calendar/google-*.ts` 밖에서 읽지 않는다.

### 6.3 그 밖의 보호

- **OAuth**: state 1회용·10분·사용자 결합, PKCE, 리디렉션 URI 허용 목록 대조, `/complete`는 세션 + `originOk`. 연결 시작(`/connect`)도 POST + `originOk`(다른 사이트가 연결 흐름을 강제로 시작시키지 못하게).
- **토큰**: 암호화 저장(2.4), 로그·응답 미노출, 연결 해제 시 구글에 폐기 요청, 비활성 사용자 토큰 청소.
- **최소 수집**: 구글 일정은 저장하지 않고, 응답에도 화면에 쓰는 필드만 담는다.
- **밖으로 나가는 행동은 사람이 정한다**: 2단계의 구글 쓰기는 일정마다 사용자가 켠 것만. 자동으로 전부 보내는 설정은 만들지 않는다(People OS의 "시스템 밖으로 나가는 것은 사람이 결정" 원칙 [코드 `README.md`]).
- **입력 검증**: 길이 상한, 시각 형식, 기간 상한(조회 62일, 일정 31일). 화면 출력은 기존 `esc`/`escAttr`로 이스케이프. 구글에서 온 제목·장소도 같은 처리(외부 입력이다).
- **요청 제한**: 수동 새로고침 10초 1회, 연결 시작 1분 5회.
- **캐시**: 캘린더 API 응답은 `Cache-Control: no-store`(LMS와 같음 [코드]).

---

## 7. 구현 분할

### 7.1 단계

| 단계 | 내용 | 모델 | 만지는 파일 | 선행 |
| --- | --- | --- | --- | --- |
| **U1** (사용자) | 열린 질문 1~3 결정. Google Cloud 설정(2.1의 1~8) | — | — | — |
| **C1** | D1 + API 뼈대. `00NN_calendar.sql`, CRUD·기간 조회·권한, 스키마 누락 503, `index.ts`에 import + mount 2줄 | **Sonnet 5.5** | `migrations/00NN_calendar.sql`, `src/calendar/routes.ts`, `src/index.ts`(2줄), `files/calendar-c1-verify/**` | 없음 |
| **C2** | 화면. FullCalendar 반입·크기 실측, 월/주 보기, 추가·수정·삭제 폼, 색·배지, 해시 `#calendar/<id>`. **`index.html`은 건드리지 않는다** — 검증은 `files/calendar-c2-verify/`에 둔 `index.html` 사본으로 한다(조직관리 세션이 `notes/org-verify-index.html`로 한 방식 [코드]) | **Sonnet 5.5** | `public/calendar.js`, `public/calendar.css`, `public/vendor/fullcalendar/**`, `files/calendar-c2-verify/**` | C1 |
| **C2w** | **`index.html` 메뉴 배선.** 아래 7.2의 조건이 충족된 뒤에만 시작 | **Sonnet 5.5** (작은 세션) | `public/index.html`만 | C2 + **조직관리(Opus)·강의실 설정(Sonnet) 세션 종료** |
| **C3** | 구글 OAuth. `00NN+1_calendar_google.sql`, 암호화, 연결/콜백/완료/상태/해제, 토큰 갱신, 상태 칩 UI. 구현 전에 8장의 Google 문서를 먼저 읽는다 | **Opus 5.5** | `migrations/00NN+1_calendar_google.sql`, `src/calendar/crypto.ts`, `src/calendar/google-oauth.ts`, `src/calendar/routes.ts`(구글 경로 추가), `public/calendar.js`(칩), `files/calendar-c3-verify/**` | C1, **U1**, 시크릿 3개 |
| **C4** | 구글 일정 실시간 읽기(1단계 동기화). `/google/events`, 두 번째 이벤트 소스, 오류 상태 표시, 새로고침 제한 | **Sonnet 5.5** | `src/calendar/google-events.ts`, `src/calendar/routes.ts`, `public/calendar.js` | C2, C3 |
| **C5** | 알림. `*/15` 크론 + **`scheduled()` 분기**, `calendar_reminder_log`, `src/calendar/notify.ts`, `APP_ORIGIN`, 청소 작업 | **Sonnet 5.5** | `wrangler.toml`, `src/index.ts`(`scheduled()` 분기), `src/calendar/reminders.ts`, `src/calendar/notify.ts` | C1 (알림 링크가 열리려면 C2w) |
| **C6** | 2단계 쓰기. 스코프 올리기(재동의), `calendar_event_links`, 보내기·재시도, etag 충돌, 삭제 전파, 연결 일정 대조 크론 | **Opus 5.5** | `migrations/…_calendar_links.sql`, `src/calendar/google-push.ts`, `src/calendar/routes.ts`, `src/calendar/reminders.ts`(크론 틱에 대조 추가), `public/calendar.js` | C3·C4·C5 라이브 검증 완료 + 사용자 승인 |
| **C7** (선택) | 자체 일정 반복(1.4), 결재·할 일 기한 표시(1.5 — 기한 컬럼이 생긴 뒤), 홈 "오늘 일정" 카드, 팀 일정 ICS 구독 주소 | 반복은 Opus 5.5, 나머지 Sonnet 5.5 | 항목별 | 항목별 |

모델 추천 근거(AGENTS.md 기준: 지시가 정확한 단순 구현 = Sonnet, 어려운 구현 = Opus):
- C1·C2·C4·C5는 LMS·결재에서 이미 한 패턴의 반복이고 이 문서가 표·경로·조건을 정해 준다.
- C3는 보안 실수가 곧 토큰 유출이다(state, PKCE, 암호화, `SameSite=Strict`와 콜백의 상호작용, 실패 경로).
- C6는 재시도·충돌·삭제가 얽힌 상태 문제다.

### 7.2 `index.html` 배선(C2w)의 시작 조건과 범위

**조직관리 메뉴 세션(Opus)과 강의실 설정 세션(Sonnet)이 지금 `public/index.html`을 고치고 있다.** 같은 파일을 세 세션이 동시에 고치면 한쪽 변경이 덮인다. 그래서:

- C1·C2·C3·C4는 `index.html`을 **읽기만** 한다. C5도 마찬가지다.
- C2w는 다음을 **모두** 확인한 뒤 시작한다.
  1. 조직관리 세션과 강의실 설정 세션이 끝났다고 사용자(또는 지휘 세션)가 확인했다.
  2. `~/.claude/projects/<인코딩된 디렉터리>/*.jsonl` 최신 기록에 그 두 세션의 진행 중인 작업이 없다(AGENTS.md의 재시작 후 확인 방법).
  3. `public/index.html`의 수정 시각이 10분 이상 그대로다.
- C2w 직전에 `index.html`을 새로 읽고, 아래 지점만 고친다(줄 번호는 2026-11-17 08:33 기준이며 두 세션이 끝나면 달라진다 — 문자열로 찾을 것) [코드]:
  1. `<head>`에 `<link rel="stylesheet" href="/calendar.css" />`
  2. 사이드바 `.tabs`에 `<button data-tab="calendar">…캘린더</button>` — 위치는 `결재함` 다음, `할 일` 앞을 권장
  3. `<section id="tab-calendar"><div id="calendarMount"></div></section>`
  4. `<script src="/calendar.js"></script>` — `org.js` 다음
  5. `const TABS = […]`에 `'calendar'`
  6. `COACHEE_TABS`에 `'calendar'` (코칭 대상도 직원이므로 캘린더를 본다)
  7. 익명 사용자에게 탭을 숨기는 선택자 목록(`personal`·`email`·`approval`·`lms`)에 `calendar`
  8. `switchTab()`: 하위 경로를 허용하는 조건(`obs`·`approval`·`pitch`)에 `calendar` 추가, `if (name === 'calendar') calendarOpen(sub); else if (window.calendarLeave) calendarLeave();`
- C2w는 다른 줄을 정리하거나 재배치하지 않는다. 끝나면 기존 탭 전부가 그대로 열리는지 확인한다.

### 7.3 의존 관계

```
U1(사용자: 결정 + Google 설정) ───────────────┐
                                              ▼
C1 ──▶ C2 ──▶ C2w (조직관리·강의실 설정 세션 종료 후)
 │      │
 │      └──────────▶ C4 ◀── C3 ◀── (U1 + 시크릿)
 └──▶ C5
                    C3·C4·C5 라이브 검증 ──▶ C6 ──▶ C7(선택)
```

- C1 다음에 C2·C5는 병렬 가능. 단 **`src/index.ts`를 만지는 세션(C1, C5)은 동시에 돌리지 않는다.** C3·C4·C6는 `index.ts`를 만지지 않는다(구글 경로는 C1이 mount한 `calendarApp` 안에 추가).
- `public/calendar.js`는 C2 → C3 → C4 → C6 순서로만 고친다(동시 금지).
- 구글 쪽(C3·C4)이 U1 때문에 늦어져도 C1·C2·C2w·C5는 자체 캘린더로 완결돼 배포할 수 있다.

### 7.4 일정에 대한 참고

`lms-plan.md`는 기능 동결 11-25, 제출 11-27로 적었다 [코드]. 오늘은 11-17이다. 권장:
- 동결 전에 넣는다면 C1 → C2 → C2w까지(자체 캘린더). C5는 `index.ts`의 크론을 건드리므로 동결 4일 전(11-21) 이후에는 넣지 않는다 — `presentation-plan.md`가 A2에 적용한 기준과 같다.
- C3·C4는 U1(구글 설정)이 11-20 무렵까지 끝났을 때만 동결 전 후보다. Testing 상태의 7일 토큰 만료는 데모에는 문제가 없다.
- C6는 제출 이후.
- 캘린더를 제출 전에 넣을지 자체가 사용자 결정이다(열린 질문 1).

### 7.5 단계별 검증 (각 세션이 보고할 것)

공통: `npx tsc --noEmit` 통과, 로컬 `wrangler dev --local`에서 curl 검증(프록시 우회 — AGENTS.md), 검증 스크립트·결과는 `/tmp`가 아니라 `files/calendar-<단계>-verify/`에, 배포했다면 배포 버전 ID.

| 단계 | 반드시 확인할 것 |
| --- | --- |
| C1 | 익명 401 · `X-Admin-Secret`만으로 401 · A의 개인 일정을 B가 조회/수정/삭제 → 404 · 팀 일정은 B가 조회 가능, 수정은 403, hr_admin 세션은 수정 가능 · `version` 불일치 409 · 기간 경계(자정 KST에 걸친 일정, 종일 일정이 옆 날짜로 새지 않는가) · 마이그레이션 미적용 503 |
| C2 | 월/주 전환 · 추가→수정→삭제 왕복 · 브라우저 시간대를 바꿔도 KST 표시 · FullCalendar 번들 크기 실측값 · 다른 탭의 첫 로딩에 FullCalendar가 실리지 않음 · 긴 제목·특수문자 이스케이프 |
| C2w | 기존 탭 전부 정상 · 코칭 대상 계정에서 캘린더 보임 · 익명에게 숨김 · `#calendar/<id>` 직접 진입 |
| C3 | 시크릿 없을 때 503 · state 재사용 거부 · 만료 state 거부 · 다른 사용자의 state로 `/complete` 거부 · D1에 평문 토큰이 없음(`refresh_token_enc`가 `v1.`로 시작) · 응답·로그에 토큰 없음 · 연결 해제 후 행 삭제 · **실제 브라우저에서 구글 동의 → 연결 완료**(Strict 쿠키 흐름) · 리프레시 토큰을 망가뜨려 `NEEDS_RECONNECT` 전환 |
| C4 | 구글 일정이 KST로 맞게 보임(종일·여러 날·반복 회차) · 구글 실패 시 자체 일정은 정상 · A의 구글 일정을 B가 볼 방법이 없음 · D1에 구글 일정 내용이 저장되지 않음 |
| C5 | **다이제스트가 15분마다 돌지 않음**(분기 확인) · 같은 일정에 알림 1건만(크론 2회 연속 실행) · 팀 일정은 전원 종 알림·메일 없음 · `RESEND_API_KEY` 없을 때 D1 기록만 · 계정의 Cron Trigger 수 |
| C6 | 같은 일정 재전송에 구글 일정 1개만 · 구글에서 고친 뒤 People OS에서 고치면 구글 값으로 맞춰지고 알림 · 양쪽 삭제 전파 · 보낸 일정이 달력에 두 번 보이지 않음 |

---

## 8. 사실 기준표

### 8.1 확인된 것

| 사실 | 근거 |
| --- | --- |
| 세션 쿠키는 `SameSite=Strict` | [코드] `src/auth.ts:93` |
| `getSessionUser`는 쿠키만 본다 (`X-Admin-Secret` 무관) | [코드] `src/auth.ts:110-127` |
| `scheduled()`는 평가 cron 외에는 다이제스트를 실행한다 | [코드] `src/index.ts:1887-1894` |
| `tasks`·`approval_documents`에 기한 컬럼이 없고 코칭 일정 테이블이 없다 | [코드] `migrations/0002, 0018, 0021, 0024` |
| `notifications` 테이블과 Resend 발송 유틸이 있다 | [코드] `0024`, `src/email/send.ts` |
| 대칭 암호화 유틸은 없다 | [코드] |
| 프런트에 번들러·CSP가 없다 | [코드] `package.json`, `public/_headers` |
| Free: 호출당 외부 요청 50개, Cron Trigger 계정당 5개, Cron 호출 CPU 10ms | [CF 문서] `developers.cloudflare.com/workers/platform/limits/` (2026-11-17 조회, 요약 모델 경유) |
| D1 Free: 호출당 쿼리 50개, `db.batch()`는 쿼리 1개로 센다, 바인딩 매개변수 쿼리당 100개 | [CF 문서] `developers.cloudflare.com/d1/platform/limits/` (같은 조건) |
| Cloudflare에 공식 캘린더 제품·템플릿이 없다 / 참고 프로젝트 6개의 성격 | 사용자가 직접 조사한 내용 (이 세션에서 재확인하지 않음) |

### 8.2 확인 안 됨 — 구현 전에 원문을 볼 것

이 세션에서 Google 문서를 열지 못했다. 아래는 전부 기억에 의존한 내용이며, 실제 콘솔 화면·문서와 다를 수 있다.

| 항목 | 이 문서가 가정한 내용 | 확인할 곳 | 확인할 단계 |
| --- | --- | --- | --- |
| OAuth 엔드포인트 | 인가 `https://accounts.google.com/o/oauth2/v2/auth`, 토큰 `https://oauth2.googleapis.com/token`, 폐기 `https://oauth2.googleapis.com/revoke` | `developers.google.com/identity/protocols/oauth2/web-server` | C3 |
| 리프레시 토큰 발급 조건 | `access_type=offline` + 첫 동의(또는 `prompt=consent`)일 때만 온다 | 같은 문서 | C3 |
| 액세스 토큰 수명 | 약 1시간 (`expires_in`으로 온다) | 같은 문서 | C3 |
| 리프레시 토큰이 무효가 되는 경우 | External + Testing이면 7일 만료 / 6개월 미사용 / 사용자 회수 / 클라이언트당 계정별 발급 개수 상한(100개로 기억) | 같은 문서의 refresh token expiration 절 | C3, U1 |
| 웹 서버 흐름의 PKCE 지원 | `code_challenge`(S256)를 받는다 | 같은 문서 | C3 |
| 리디렉션 URI 규칙 | HTTPS 필수(localhost 예외), 정확히 일치 | 같은 문서 | U1, C3 |
| 스코프 이름 | `calendar.events.readonly`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.events.owned`, `calendar.app.created` | `developers.google.com/workspace/calendar/api/auth` | U1, C3, C6 |
| 캘린더 스코프의 민감도 분류와 검증 심사 요건 | 민감(sensitive) → In production 게시 시 검증 대상, 미검증이면 경고 화면 + 100명 상한 | 위 문서 + Google Cloud 콘솔 도움말(OAuth 앱 검증) | U1 |
| 테스트 사용자 상한 | 100명 | 콘솔 도움말 | U1 |
| 콘솔 메뉴 이름·순서 | 2.1의 단계 | 실제 콘솔 화면 | U1 |
| `workers.dev` 하위 주소로 검증 심사·승인된 도메인 등록이 되는가 | 모름 | 콘솔에서 직접 | U1 (In production으로 갈 때만) |
| `events.list` 매개변수 | `timeMin`/`timeMax`/`singleEvents`/`showDeleted`/`maxResults`(최대 2500으로 기억)/`updatedMin`, `events.readonly` 스코프로 호출 가능 | `developers.google.com/workspace/calendar/api/v3/reference/events/list` | C4, C6 |
| `syncToken`과 함께 못 쓰는 매개변수, 410 시 전체 재동기화 | 이 설계는 `syncToken`을 쓰지 않으므로 직접 영향 없음 | `…/calendar/api/guides/sync` | (미러로 바꿀 때만) |
| 클라이언트가 정하는 일정 id의 허용 문자·길이, `If-Match` etag 동작, 비공개 확장 속성 | 가능하다고 가정 | `…/v3/reference/events/insert`, `…/guides/version-resources` | C6 |
| 구글 push notification(웹훅)의 수신 주소 요건·채널 만료 | **이 설계는 쓰지 않는다** | `…/calendar/api/guides/push` | (도입 검토 시) |
| 구글 Calendar API 호출 한도 | 모름 (데모 규모에서는 문제 없을 것으로 추정) | 콘솔의 할당량 화면 | C4 |
| `SameSite=Strict` 쿠키가 구글 → 콜백 이동에는 안 실리고, 콜백 페이지의 같은 출처 `fetch`에는 실린다 | 그렇다고 가정 (브라우저 표준 동작) | 실제 브라우저 시험 | C3 |
| FullCalendar v6 표준 번들의 라이선스(MIT)·크기·전역 번들 파일 구성·`timeZone` 동작 | 5.1의 내용 | `fullcalendar.io/license`, `fullcalendar.io/docs` + 실측 | C2 |
| KV 쓰기 전파 지연(최대 60초) | D1을 고른 근거 중 하나 | `developers.cloudflare.com/kv/` | (결정에 영향 없음 — D1이 어차피 단순) |
| Resend 무료 발송 한도 | 모름 | Resend 대시보드 | C5 |
| 계정의 현재 Cron Trigger 사용 수 (다른 Worker 포함) | 이 Worker 2개만 확인 | Cloudflare 대시보드 | C5 |
| 앱이 `peopleos.site`로 열리는가 | 문서끼리 어긋남 (0장) | 사용자 확인 / 브라우저 | U1 |
| 참고 프로젝트(Mailflare·Punctual·Potion Calendar·timetracker·notion-caldav-sync·slotmirror)의 실제 구현 | 저장소를 읽지 않았다. 사용자 조사의 한 줄 설명만 썼다 | 각 저장소 | (필요 시) |

### 8.3 People OS에 없는 것 — 이 계획이 "쓴다"고 하지 않는 것

- 구글 캘린더 웹훅(push notification) 수신
- 구글 일정의 D1 미러, `syncToken` 증분 동기화
- 결재·할 일의 기한 (컬럼 자체가 없음)
- 코칭 예약 테이블
- 구글 계정으로 People OS에 로그인 (연동은 캘린더 접근 권한일 뿐, 로그인 수단이 아니다)
- 다른 사람의 구글 일정 보기, 빈 시간 찾기, 회의실·자원 예약, 참석자 초대
- CalDAV, Outlook/Microsoft 365 연동

---

## 9. 열린 질문 (사용자 결정 필요)

1. **제출(11-27) 전에 넣을 범위**: 자체 캘린더(C1·C2·C2w)까지? 구글 읽기(C3·C4)까지? 전부 제출 이후? — 권장: 자체 캘린더까지는 동결 전 가능, 구글은 U1이 11-20까지 끝날 때만.
2. **앱 대표 주소**: 사용자가 실제로 쓰는 주소가 `workers.dev`인가 `peopleos.site`인가(또는 둘 다)? 리디렉션 URI 등록과 알림 메일 링크(`APP_ORIGIN`)가 여기에 달려 있다.
3. **팀 일정 작성 권한**: 전원 작성 + 작성자·hr_admin 수정(권장)인가, hr_admin만 작성인가?
4. **Google 앱 대상**: Workspace 조직이 있어 Internal로 만들 수 있는가? External이면 Testing(7일마다 재연결, 테스트 사용자 등록)을 감수할 것인가, 검증 심사를 받을 것인가?
5. **2단계 쓰기 범위**: "People OS 개인 일정을 구글로 보내기"만(권장)인가, 구글 일정을 People OS에서 고치는 것까지 필요한가?
6. **기한 연동**: 결재·할 일에 기한 컬럼을 추가할 것인가? 추가한다면 그 모듈 세션의 일로 따로 잡는다.
7. **팀 일정 알림 메일**: 종 알림만(권장)인가, 메일도 보낼 것인가?
8. **구글 일정의 표시 범위**: 제목까지 보이는 것(권장, 본인만 보므로)인가, "바쁨"으로만 표시할 것인가?
