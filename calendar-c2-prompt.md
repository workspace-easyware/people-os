# 캘린더 C2 — 화면 — Sonnet 5.5

## 너의 역할
너는 구현 세션이다. People OS 캘린더 화면(C2)을 만든다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `calendar-plan.md` 5장(UI 설계 — 5.1 FullCalendar, 5.2 보기, 5.3 폼, 5.4 구분 표시, 5.6 파일) + 7.1(C2 행) — 이 문서의 지시를 그대로 따른다.
- C1 산출물: `src/calendar/routes.ts` (API 계약 — GET /events, POST /events, GET/PATCH/DELETE /events/:id), `migrations/0025_calendar.sql` (스키마).
- 기존 프런트: `public/lms.js` (탭 열기·닫기 `lmsOpen`/`lmsLeave` 계약, `api`·`esc`·`escAttr`·`currentUser` 전역 사용법), `public/org.js` (새 탭 패턴), `public/index.html` (탭 구조 — **읽기만, 건드리지 마라**), `public/styles.css` (디자인 토큰).

## 구현할 것
1. **FullCalendar 반입 + 안전 검사**: FullCalendar v6 표준 번들(MIT)을 `public/vendor/fullcalendar/`에 직접 둔다 (번들러 없음, 외부 CDN 의존 금지). 한국어 로케일 파일 포함. **번들 크기 실측** (압축 전 400KB를 넘으면 월 보기만 직접 구현하고 주 보기는 주간 목록으로 대체 — 계획서 5.1 되돌림 기준).
   - **안전 검사 (필수)**: `npm pack fullcalendar@6`으로 받은 뒤, 아래를 확인하고 결과를 보고한다.
     - `package/package.json`의 `name`이 `fullcalendar`이고 `version`이 6.x이며 `license`가 MIT인지.
     - 받은 파일이 `index.global.min.js`와 `locales/ko.global.min.js`인지 (파일명·크기).
     - 번들 안에 `eval(`·`Function(`·외부 URL로의 `fetch(`/`XMLHttpRequest` 같은 동적 코드 실행·외부 전송 패턴이 없는지 (grep으로 확인).
     - LICENSE 파일이 있는지.
     - npm 레지스트리에서 받은 tarball의 무결성 (npm이 검증한 것 — 별도 해시 비교는 하지 않는다).
     - 검사에서 이상이 있으면 멈추고 보고한다. 이상이 없을 때만 `public/vendor/fullcalendar/`에 둔다.
   - **한국어 로케일**: `fullcalendar@6` tarball에는 로케일 파일이 없다. 한국어 로케일은 `@fullcalendar/core` 패키지에 들어 있으니, `npm pack @fullcalendar/core@6.1.22`로 따로 받아 같은 안전 검사를 거친 뒤 `locales/ko.global.min.js`를 쓴다. 이미 받은 `fullcalendar-6.1.22.tgz`는 `files/calendar-c2-verify/dl/`에 있다 — 다시 받지 말고 그것을 쓴다.
   - **KST 표시 검증**: 이 VM에는 브라우저가 없다. 브라우저 시간대를 바꿔 확인하는 대신, DOM 스텁 하네스로 시간 변환 함수만 검증한다. 이 범위로 진행한다.
2. **`public/calendar.js`** (신규): 전역 `calendarOpen(sub)`, `calendarLeave()` (lms/org 계약과 같은 형태).
   - 월 보기(기본) + 주 보기(시간 격자 07:00~21:00, 종일 줄). 좁은 화면은 주간 목록.
   - 일정 추가·수정·삭제 폼 (계획서 5.3 — 제목·종일·시작/종료·공개 범위·분류·장소·메모·알림). 끌어서 옮기기는 C2 범위에서 뺀다.
   - 색·배지 (계획서 5.4 — 개인 남색, 팀 초록+`팀` 배지, 구글은 C4에서, 코칭 보라 띠). 구글 연동 UI(칩·패널)는 C3의 일이라 이번에 만들지 않는다.
   - 해시 `#calendar`, `#calendar/<id>`.
   - **캘린더 탭을 처음 열 때만** FullCalendar 스크립트를 동적으로 불러온다. `index.html`에 `<script>` 태그를 추가하지 않는다.
   - 시간대: 화면은 항상 KST. 브라우저 시간대를 바꿔도 KST로 보이는지 검증한다.
3. **`public/calendar.css`** (신규): FullCalendar `--fc-*` 변수로 People OS 토큰에 맞춘다. 자체 툴바 (오늘·이전·다음·년월·월|주·일정 추가).

## 검증 (로컬)
- `npx tsc --noEmit` 통과 (프런트 JS는 `node --check`).
- `npx wrangler dev --local` 로 검증: 월/주 전환 · 추가→수정→삭제 왕복 · 브라우저 시간대를 바꿔도 KST 표시 · FullCalendar 번들 크기 실측값 · 다른 탭의 첫 로딩에 FullCalendar가 실리지 않음 · 긴 제목·특수문자 이스케이프.
- **`index.html`은 건드리지 않는다.** 검증은 `files/calendar-c2-verify/`에 둔 `index.html` 사본으로 한다 (조직관리 세션이 `notes/org-verify-index.html`로 한 방식).
- 검증 산출물은 `files/calendar-c2-verify/`에 둔다. `/tmp` 금지.

## 제약
- C2 파일만 만든다/고친다: `public/calendar.js`, `public/calendar.css`, `public/vendor/fullcalendar/**`, `files/calendar-c2-verify/**`. `public/index.html`·`src/`·`public/lms.js`·`public/org.js`는 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든/고친 파일 목록, FullCalendar 번들 크기 실측값, 로컬 검증 결과를 적어라.
