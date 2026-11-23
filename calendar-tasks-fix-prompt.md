# 캘린더 "할 일" 수정 프롬프트 (2026-11-23, 배포 f8f2c025 후속)

## 배경

캘린더 필터 행 "할 일" 체크박스(배포 `f8f2c025`, 마이그레이션 없음, 변경 파일 `public/calendar.js`·`public/calendar.css`·`public/tasks.js`)를 브라우저로 검증했더니 결함 3건이 나왔다. 원인을 재현으로 확인했고, 아래 증거와 진단을 그대로 따른다. **커밋하지 않는다** (Merlin이 직접 커밋한다).

## 결함 1 — 달력에서 할 일을 누르면 이전에 열려 있던 상세가 잠깐 보인다 (재현으로 확인됨, 코드상 뒤바뀜 아님)

### 증거 (브라우저 재현 2회, 전부 테스트 할 일은 삭제해 정리됨)
- 1차: 달력에서 11/23 할 일을 누르자 11/22 할 일 상세가, 11/24를 누르자 11/23 상세가, 11/25를 누르자 11/24 상세가 펼쳐졌다 (정확히 하루 전).
- 2차: 11/23 "[재현] 오늘 할 일"을 누르자 11/24 "[재현] 내일 할 일" 상세가, 11/24를 누르자 11/23 상세가 펼쳐졌다 (서로 바뀜).
- 대조 실험: 할 일 탭 안에서만 줄을 눌러 펼치면 상세가 항상 맞는 할 일로 열리고, 별표·삭제도 맞는 줄에 적용됐다 (결함 없음).

### 진단 (확정)
코드에 뒤바뀜은 없다. `eventClick`은 `raw.id`를 `window.openTaskDetail(id)`에 넘기고, `openTaskDetail`은 `S.open = id` 뒤 `switchTab('tasks')` → `loadTasks()` → `render()`로 맞는 상세를 그린다. 문제는 **탭 전환 직후 할 일 탭에 이전 렌더(이전에 열려 있던 상세)가 그대로 보이다가, 비동기 `loadTasks()`가 끝난 뒤에야 맞는 상세가 그려진다**는 점이다. 브라우저가 전환 직후 읽으면 이전 상세를 보고, 그게 "하루 전/서로 바뀜"으로 보였다. 1차의 "하루 전" 패턴은 직전에 만진 할 일이 11/22였기 때문이고, 2차의 "바뀜"은 직전에 만진 할 일이 11/24였기 때문이다.

### 수정
- `openTaskDetail(id)`: `S.tasks`에 해당 할 일이 이미 있으면 `switchTab` 전에 `render()`를 한 번 동기적으로 돌려 맞는 상세를 즉시 보여주고, 그 뒤 `loadTasks()`로 새로고침한다. 없으면 목록 영역에 "불러오는 중…"을 먼저 보여주고 `loadTasks()`를 기다린다. 어느 경우든 전환 직후에 이전 상세가 보이지 않게 한다.
- `focusRow`는 그대로 둔다 (스크롤·포커스).

## 결함 2 — 주 보기 30분 칸에서 할 일 이름이 "[" 한 글자만 보인다

### 증거
주 보기 시간 격자에서 시간 지정 할 일이 14:00~14:30 칸에 "14:00 - 14:30 […"까지만 보이고 이름은 여는 대괄호 한 글자만 남았다. `calEventContent`가 시간 범위 텍스트(`arg.timeText`, "14:00 - 14:30")를 제목 앞에 붙여 칸을 다 차지한다.

### 수정
- 시간 격자(timeGrid) 보기에서는 할 일 이벤트의 시간 범위 텍스트를 빼고 체크 아이콘 + 제목만 보여준다 (시간은 격자 눈금이 이미 보여준다). 월 보기·목록 보기에서는 지금처럼 시간 접두사를 둔다.
- 30분 칸에서 제목이 한 글자만 남지 않는지 로컬에서 `calEventContent` 출력 길이를 확인한다.

## 결함 3 — 할 일 알약이 노랑이 아니라 파란색, 기한 지남이 빨간색이 아니다

### 증거
- 월 보기에서 할 일 알약은 파란 배경 + 흰 글자로 보이고, 주황 점선 테두리는 (두 번째 재현에서는) 보이는 것 같았다. 기한 지난 할 일도 파란색 그대로였고, 설명(title)만 "할 일 (기한 지남)"이었다.
- 라이브 `/calendar.css`에는 `.cal-grid .fc .cal-ev-task{background:var(--color-warn-bg);border:1px dashed var(--cat-amber);color:var(--color-text)}`와 `.cal-ev-task-over` 규칙이 있고, 변수(`--color-warn-bg`·`--cat-amber`·`--color-err-bg`)도 `public/styles.css`에 정의돼 있다. 정적 파일은 `Cache-Control: no-cache` + ETag라 캐시 문제도 아니다.
- 단서: FullCalendar v6는 이벤트 안쪽 `.fc-event-main`에 인라인 `color`(기본 흰색)를 넣는다 (`public/vendor/fullcalendar/index.global.min.js`의 `elStyle: color:t.textColor`). 바깥 배경은 `.fc-h-event`/`.fc-v-event`가 `background-color:var(--fc-event-bg-color)`(기본 #3788d8)로 정한다. 우리 CSS보다 명시도가 낮지만, 실제 화면에서는 파란색이 이겼다.

### 수정
- CSS 명시도 싸움을 하지 말고 FullCalendar 방식으로 색을 준다: `calTaskToFc`에서 이벤트에 `backgroundColor`·`borderColor`·`textColor`를 직접 넣는다 (FullCalendar가 인라인 스타일로 적용해 테마를 이긴다). 일반 할 일: 연한 노랑 배경(#fff4d6)·주황 테두리(#d97706)·어두운 글자. 기한 지남: 연한 빨강 배경(#fdecea)·빨강 테두리(#b3261e)·빨강 글자. 기존 CSS 클래스(`cal-ev-task`·`cal-ev-task-over`)도 유지한다 (범례 점·목록 보기용).
- `calEventContent`의 체크 아이콘 색도 인라인 색과 어긋나지 않게 맞춘다.

## 범위 밖 (이번에 고치지 않는다 — RESULT.md에 한계로 적는다)
- 할 일 추가·삭제 직후 목록이 한 박자 늦게 다시 그려져, 재빨리 누르면 클릭이 다시 그려진 다른 줄에 닿을 수 있다 (브라우저에서 2회 관찰). 근본 수정은 별도 작업으로 남긴다.
- 달력에서 날짜·시간을 고치거나 완료 처리하는 기능, 반복 할 일의 미래 회차 미리 보기, 완료된 할 일 표시 — 모두 범위 밖.

## 검증
- `npx tsc --noEmit` 0건, `node --check public/calendar.js`, `node --check public/tasks.js` 통과.
- 로컬 `wrangler dev --local` + 로컬 D1로 스모크: 날짜 있는 할 일(시간 있음/없음)·기한 지남·하위 작업을 만들고, (a) `openTaskDetail` 호출 직후(로드 전) 맞는 상세가 보이는지, (b) 주 보기 30분 칸의 제목이 읽히는지, (c) `calTaskToFc`가 낸 이벤트의 색 속성(backgroundColor·borderColor·textColor)이 일반/기한 지남 각각 맞는지.
- 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행 (python3 경유·env 접두어 금지, cwd는 이 레포 루트). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 한다.
- 라이브 스모크: `https://people-os.workspace-easyware.workers.dev`로 curl (peopleos.site에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다. 원격 curl은 `--noproxy`를 쓰면 TLS 실패 — 프록시 경유 plain curl로). 로그인 필요한 호출은 `~/workspace/user`에 세션 토큰이 없으면 운영 D1에 임시 사용자 + 1시간 세션을 넣어 시험하고 지운다 (할 일·목록·세션·사용자 행 전부 삭제, 적용 직후 개수와 대조). 실제 사용자 3명의 데이터는 건드리지 않는다.
- 결과는 `files/workflow-verify/calendar-tasks/RESULT.md`에 §5(수정) 절로 추가한다 (배포 버전 ID, 검증 항목별 통과 여부, 남은 한계).
- **커밋하지 않는다** (Merlin이 직접 커밋한다). 작업 트리에 변경을 남기고 보고한다.
- 화면 확인은 이 세션에서 못 하므로 남긴다 (Merlin이 브라우저로 확인한다).
- 작업 트리의 `public/email.css`·`public/email.js`·`public/index.html` 미커밋 변경은 다른 작업(메일 서식 편집기)이다. 건드리지 말고, 커밋 대상에도 넣지 않는다.
