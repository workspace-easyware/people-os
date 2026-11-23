# People OS 캘린더에 "할 일" 체크박스 추가 프롬프트 (2026-11-23)

## 목표

Google Calendar 왼쪽의 "Tasks"처럼, People OS 캘린더에서 날짜가 있는 할 일을 달력에 표시한다. 필터 행의 "팀 일정" 다음에 "할 일" 체크박스를 넣고, 켜면 기한이 있는 할 일이 달력에 나타나고, 끄면 사라진다.

## 작업 디렉터리 (cwd)

`/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`

## 현재 상태 (반드시 먼저 읽을 것)

- 캘린더: `public/calendar.js` (742행), FullCalendar 기반. `calFilter = { mine: true, team: true, google: true }` (17행, 저장 안 함 — 탭을 열 때마다 기본값).
- 필터 행 (113~117행): `<label><input type="checkbox" id="calFMine" checked /> 내 일정</label>` / `calFTeam` 팀 일정 / `calFGoogle` 구글 + "구글 새로고침" 버튼 + 범례. **People OS 캘린더에는 왼쪽 사이드바가 없다. 필터 행이 구글의 왼쪽 "Tasks"에 대응하는 자리다.**
- 이벤트 소스 (`calInit`, 약 180행): 자체 일정(`calFetchRange`, `/api/calendar/events` + mine/team 필터) + 구글(`calFetchGoogle`) 2개. `calToFcEvent`(56행)가 자체 일정을 변환하고, `calEventClasses`(62행)가 스타일 클래스를, `calEventContent`(320행)가 내용을 그린다. `eventClick`은 구글 일정이면 `calShowGoogleDetail`, 자체 일정이면 `calShowDetail`.
- 할 일: `GET /api/tasks`가 `due_date`(YYYY-MM-DD, KST)·`due_time`(HH:MM, nullable)·`starred`·`parent_id`·`indent`(0/1)·`done`을 돌려준다 (마이그레이션 0046, `files/workflow-verify/tasks-google-parity/RESULT.md` 참조). 할 일 탭 UI는 `public/tasks.js` (IIFE, `S.open`이 펼쳐진 상세의 id, `S.tasks`가 현재 목록, 행 클릭이 `S.open`을 토글). 탭 전환은 전역 `switchTab('tasks')` (`public/index.html` 645행).
- 보안: 새 라우트가 필요 없다 (`/api/tasks` 재사용 — 이미 로그인 필수).
- 디자인: Langfuse 스타일 (시스템 폰트, Lucide 16px 선 아이콘, 이모지 금지). 한국어 UI.

## 구현 범위

1. **필터 체크박스**: `팀 일정` 다음, `구글` 앞에 `<label><input type="checkbox" id="calFTasks" checked /> 할 일</label>` 추가. `calFilter.tasks = true` (기본 켜짐). 변경 시 `calRefetch()`.
2. **할 일 이벤트 소스** (세 번째 소스): `calFetchRange`와 같은 방식으로 `GET /api/tasks`를 불러온다. 할 일 탭이 보는 것과 같은 범위(본인 + 미지정, hr_admin은 관리자 필터 기준)를 그대로 쓴다. 표시 대상은 **미완료(`done=false`)이고 `due_date`가 있는 할 일**. 하위 작업도 `due_date`가 있으면 표시한다.
   - `due_time`이 있으면 그 시각의 시간 이벤트 (시작 = 날짜 + 시간, 30분 길이). 없으면 종일(allDay) 이벤트.
   - 기한이 지난 할 일은 기한 날짜에 표시한다 (오늘로 옮기지 않는다).
   - FullCalendar가 범위를 바꿀 때마다 다시 불러오면 된다 (할 일 수는 적다).
3. **표시**: 일정과 구분되는 스타일. `cal-ev-task` 클래스 — 예: 체크 아이콘 + 제목, 할 일 전용 색/점선 테두리 등 일정·구글과 눈에 띄게 다르게. 범례에 할 일 점(`할 일` + 배지 설명)을 추가한다. 월 보기에서는 블록으로, 주 보기에서는 시간 격자/종일 행에 제대로 나온다.
4. **클릭**: 할 일 이벤트를 누르면 할 일 탭으로 이동해 해당 할 일을 펼쳐서 보여준다. `public/tasks.js`에 전역 함수(예: `window.openTaskDetail(id)`)를 노출한다 — 모드를 전체로 바꾸고, 목록을 다시 읽은 뒤 `S.open = id`로 펼치고 해당 행으로 스크롤한다. 하위 작업이면 부모와 함께 보이게 한다.
5. **끄기**: 체크를 끄면 할 일 소스가 빈 배열을 돌려주고 달력에서 사라진다 (구글 소스와 같은 방식).

## 하지 않는 것

- 새 API 라우트·마이그레이션 없음. 새 npm 의존성 없음.
- 완료된 할 일은 달력에 표시하지 않는다 (완료됨은 할 일 탭의 "완료됨" 섹션에서 본다).
- 할 일의 날짜·시간을 달력에서 직접 고치는 기능 없음 (클릭하면 할 일 탭으로 이동).
- 캘린더·메일·결재·워크플로우·에이전트 등 다른 기능은 건드리지 않는다.

## 검증

- `npx tsc --noEmit` 0건.
- 로컬 `wrangler dev --local` + 로컬 D1로 스모크: 날짜 있는 할 일(시간 있음/없음)·하위 작업·기한 지난 할 일을 만들고 달력을 열어 표시 확인, 체크박스 끄면 사라지는지, 클릭하면 할 일 탭에서 해당 할 일이 펼쳐지는지.
- 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행 (python3 경유·env 접두어 금지, cwd는 이 레포 루트). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 한다.
- 라이브 스모크: `https://people-os.workspace-easyware.workers.dev`로 curl (peopleos.site에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다. 원격 curl은 `--noproxy`를 쓰면 TLS 실패 — 프록시 경유 plain curl로). 로그인 필요한 호출은 `~/workspace/user`에 세션 토큰이 없으면 운영 D1에 임시 사용자 + 1시간 세션을 넣어 시험하고 지운다 (할 일·목록·세션·사용자 행 전부 삭제, 적용 직후 개수와 대조). 실제 사용자 3명의 데이터는 건드리지 않는다.
- 결과는 `files/workflow-verify/calendar-tasks/RESULT.md`에 기록한다 (배포 버전 ID, 검증 항목별 통과 여부, 남은 한계).
- **커밋하지 않는다** (Merlin이 직접 커밋한다). 작업 트리에 변경을 남기고 보고한다.
- 화면 확인은 이 세션에서 못 하므로 남긴다 (Merlin이 브라우저로 확인한다).
