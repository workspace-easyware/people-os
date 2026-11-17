# 캘린더 C2w — index.html 메뉴 배선 — Sonnet 5.5 (작은 세션)

## 너의 역할
너는 구현 세션이다. People OS 사이드바에 **캘린더** 메뉴를 배선한다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 전제 (시작 조건 충족됨)
- 조직관리 세션(Opus)과 강의실 설정 세션(Sonnet)은 끝났다. C2(캘린더 화면)도 끝났다 (`public/calendar.js`·`calendar.css`·`public/vendor/fullcalendar/` 존재).
- `public/index.html`만 고친다. 다른 파일은 건드리지 마라.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `calendar-plan.md` 7.2 (C2w 배선 지점 8곳) — 문자열로 찾을 것. 줄 번호는 달라졌을 수 있다.
- `public/index.html` (편집 직전에 다시 읽어라 — 조직관리·강의실 설정 세션이 고친 뒤의 최신 상태).
- `public/calendar.js` (전역 `calendarOpen(sub)`·`calendarLeave()` 계약 확인).

## 배선할 것 (8곳, 계획서 7.2)
1. `<head>`에 `<link rel="stylesheet" href="/calendar.css" />`
2. 사이드바 `.tabs`에 `<button data-tab="calendar">…캘린더</button>` — 위치는 `결재함` 다음, `할 일` 앞을 권장
3. `<section id="tab-calendar"><div id="calendarMount"></div></section>`
4. `<script src="/calendar.js"></script>` — `org.js` 다음
5. `const TABS = […]`에 `'calendar'`
6. `COACHEE_TABS`에 `'calendar'` (코칭 대상도 직원이므로 캘린더를 본다)
7. 익명 사용자에게 탭을 숨기는 선택자 목록(`personal`·`email`·`approval`·`lms`)에 `calendar`
8. `switchTab()`: 하위 경로를 허용하는 조건(`obs`·`approval`·`pitch`)에 `calendar` 추가, `if (name === 'calendar') calendarOpen(sub); else if (window.calendarLeave) calendarLeave();`

## 제약
- 다른 줄을 정리하거나 재배치하지 않는다. 이 8곳만 고친다.
- `public/index.html`만 고친다. `public/calendar.js`·`calendar.css`·`src/`는 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.

## 검증 (로컬)
- `npx tsc --noEmit` 통과 (index.html 인라인 스크립트는 `node --check`로 추출 검증 — 조직관리·강의실 설정 세션이 한 방식).
- `npx wrangler dev --local` 로: 기존 탭 전부가 그대로 열리는지, 캘린더 메뉴가 뜨고 월/주 보기가 보이는지, 코칭 대상 계정에서 캘린더가 보이는지, 익명에게 숨겨지는지, `#calendar/<id>` 직접 진입이 되는지 확인. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 `files/calendar-c2w-verify/`에 둔다. `/tmp` 금지.
- 끝나면 최종 보고에 고친 곳 8개, 로컬 검증 결과를 적어라.
