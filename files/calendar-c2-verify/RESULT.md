# 캘린더 C2 로컬 검증 결과 (2026-11-17)

배포·원격 D1/R2 없음. 로컬 wrangler dev(포트 8802, 격리 D1 `state/`)만 사용. `public/index.html`은 읽기만 했고, 검증은 `scripts/build-site.cjs`가 만든 `site/`(index.html 사본에 C2w 배선 10곳 적용, 전부 매칭 확인)로 했다.

## FullCalendar 안전 검사
| 항목 | 결과 |
| --- | --- |
| `fullcalendar` package.json | name=`fullcalendar`, version=`6.1.22`, license=`MIT` |
| `@fullcalendar/core` package.json (ko 로케일 출처) | name=`@fullcalendar/core`, version=`6.1.22`, license=`MIT` |
| 받은 파일 | `index.global.min.js` **285,276 B**, `locales/ko.global.min.js` **387 B**, `LICENSE.md` 1,066 B |
| 동적 코드 실행 (`eval(`, `Function(`) | 번들·ko 둘 다 없음 |
| 외부 전송 | `fetch(`는 JSON 피드 이벤트 소스(`events: '<url>'`) 코드에만 있음 — 우리는 `events` 함수만 쓰므로 호출되지 않음. `XMLHttpRequest`·`sendBeacon`·`WebSocket`·`document.write` 없음. 번들 안 URL은 문서 링크 2개 + SVG 네임스페이스뿐 |
| LICENSE | 있음(MIT) |
| 무결성 | npm이 검증 (별도 해시 비교 안 함) — `@fullcalendar/core` shasum 446b9011d4f0… |
| 번들 크기 판정 | 285,276 B < 400KB → **되돌림 기준 미해당, FullCalendar 유지** |

배치: `public/vendor/fullcalendar/{index.global.min.js, ko.global.min.js, LICENSE.md}` (로케일은 평면 파일명).

## 자동 검사 (`scripts/harness.cjs`, 52개 PASS / 0 FAIL)
- 시간대: TZ=UTC·America/Los_Angeles·Pacific/Auckland·Asia/Kolkata·Asia/Seoul 하위 프로세스에서 모든 변환 결과가 동일하고 기대 KST 값과 일치 (14:00Z→23:00 KST, 자정 경계, 종일 날짜, 한글 날짜/범위, "지금"은 Intl(Asia/Seoul) 독립 계산과 일치). FullCalendar에는 `timeZone:'UTC'` + KST 벽시계 값 + `now()` 시프트를 넘긴다.
- 지연 로딩: calendar.js를 읽기만 하면 스크립트 0개 로드. 첫 `calendarOpen`에서 번들 → ko 순서로 동적 로드, 두 번째 열기에는 재로드 없음. `files/calendar-c2-verify/index.html`(배선 사본)에 `fullcalendar`/`vendor/` 문자열 0건 → 다른 탭 첫 로딩에 실리지 않음.
- 월/주 전환(주=시간 격자 높이 760·scrollTime 07:00, 좁은 화면=listWeek), 버튼 aria-pressed, 옵션(끌기 없음).
- 실제 로컬 API 왕복: 추가(UTC 저장·KST 표시·코칭 분류·알림) → 수정(제목·시각·팀 공개, version+1) → 낡은 version 수정 시 충돌 안내 → 종일 3일 추가(끝 미포함 11/27, 알림 -540) → 필터(팀 끄기) → 삭제(팀 확인 문구 "전원의 달력에서 사라집니다") → 개인 삭제. 입력 오류(빈 제목·종료<시작·31일 초과)는 요청 전에 막음.
- 이스케이프: 150자 제목 + `<img onerror>`·따옴표·`&`·`<script>` — 이벤트 제목은 `textContent`, 상세/폼 HTML은 `esc/escAttr` 통과 (원본 태그 없음).
- `npx tsc --noEmit` 통과, `node --check public/calendar.js` 통과. 익명 `GET /api/calendar/events` 401.

## 한계 (정직하게)
- 이 VM에는 브라우저가 없다. FullCalendar 본체의 실제 렌더링(월/주 격자 모양, 겹침 배치, `--fc-*` 변수 적용 결과, 모달 시각 디자인, 포커스 이동)은 **눈으로 확인하지 못했다.** DOM 스텁 하네스는 calendar.js가 넘기는 옵션·이벤트·시간 변환·API 호출만 검증한다. 가짜 Calendar 클래스를 썼으므로 FullCalendar가 `timeZone:'UTC'` + 벽시계 문자열을 기대대로 처리하는지는 FullCalendar 문서상의 동작에 의존한다 → **C2w 배선 후 실제 브라우저로 한 번 확인 필요** (월/주 보기, 11월 일정이 KST로 보이는지, 브라우저 시간대 변경).
- `dateClick`의 `dateStr` 형식(UTC 모드에서 `…Z` 또는 `+00:00`)은 앞 16자만 쓰므로 둘 다 안전하지만 실제 클릭은 미검증.
- 구글 칩·패널·필터는 C3/C4 범위라 만들지 않았다 (필터는 `내 일정`·`팀 일정`만).
