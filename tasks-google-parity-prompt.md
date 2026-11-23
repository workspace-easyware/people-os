# People OS 할 일 Google Tasks 패리티 구현 프롬프트 (2026-11-23)

## 목표

People OS의 할 일 기능을 Google Tasks와 동일하게 구성한다. 상위 개념은 **목록(List) > 할 일(task) > 하위 작업(subtask)** 이다. 사용자가 왼쪽에 띄운 Google Tasks 화면을 직접 조사·테스트해서 확인한 동작을 그대로 구현한다.

## 작업 디렉터리 (cwd)

`/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`

## 현재 상태 (반드시 먼저 읽을 것)

- `migrations/0002_workspace.sql`: tasks 테이블 (id, title, source, done, created_at, done_at). owner_id는 마이그레이션 0021에서 추가됨.
- `src/index.ts` 1618~1683행: tasks 라우트 (GET /api/tasks, POST /api/tasks, PATCH /api/tasks/:id 완료 토글만, DELETE /api/tasks/:id). 소유자 규칙: hr_admin은 전체 + `?owner=` 필터, 그 외는 본인 + 미지정(owner_id NULL)만. `canTouchTask`, `taskOwnerClause`, `resolveAsUser`를 재사용한다.
- `public/index.html`: 할 일 탭 (`#tab-tasks`, 약 346행), `loadTasks`/`taskRow`/`addTask`/`toggleTask`/`deleteTask` (약 1440~1510행), 관리자 바 (`taskAdminBar`, `taskOwnerFilter`, `newTaskOwner`).
- 홈의 "해야 할 일" 개수(`openTasks`)는 `GET /api/home`에서 tasks를 센다. 새 필드를 추가해도 기존 응답 모양을 깨지 말 것.
- 최신 마이그레이션은 0045이다. 이번 작업은 **마이그레이션 0046**을 새로 만든다.
- 보안: 모든 쓰기·읽기 라우트는 로그인(또는 X-Admin-Secret) 필수 (2026-11-22 보안점검 SEC-EX-015 — 익명 401). 새 라우트도 동일하게 적용한다.
- 디자인: Langfuse 스타일 (시스템 폰트, Lucide 16px 선 아이콘, 이모지 금지). 한국어 UI 문구는 기존 표현을 따른다 ("해야 할 일", "성찰" 등).

## Google Tasks에서 확인한 동작 (2026-11-23, 브라우저 직접 조사·테스트 — 지어낸 것 없음)

### 목록 (List)
- 사이드바: "All tasks" / "Starred" 필터, "Lists" 섹션, "Create new list".
- 목록 옵션(⋮) 메뉴: Sort by — My order(기본), Date, Deadline, Starred recently, Title / Rename list / Delete list (기본 목록은 삭제 불가·비활성화) / Print list / Delete all completed tasks / Clean up old tasks.
- 기본 목록 이름: "내 할 일 목록". 빈 상태 문구: "No tasks yet".

### 할 일 상세
- 필드: Title, Details(세부 메모), Today(오늘 날짜로 바로 지정), Tomorrow(내일 날짜로 바로 지정), Add date/time (달력 선택기 + 시간은 선택 사항, 30분 단위 12:00 AM~11:30 PM, 기본 하이라이트 9:00 AM), Repeat 버튼.
- 하단 행: Add subtask, Star this task, Move to list, Delete task.
- 저장 버튼 없음: 인라인 즉시 반영. 빈 초안은 포커스를 벗어나면 버려진다.

### 반복 (Repeat) — 사전 설정 메뉴 없이 사용자 지정 다이얼로그로 바로 이동
- "Repeats every" 숫자(기본 1, 1~100) + 단위 day / week / month / year.
- week: 요일 토글 S M T W T F S (시작 날짜의 요일이 미리 선택됨).
- month: 라디오 2개 — "Day N" (Day 1~31 + "Last day") / "Nth weekday" (First/Second/Third/Fourth/Last + 요일).
- year: 추가 옵션 없음. day: 추가 옵션 없음.
- "Starts": 시작일. "Ends": Never / On (날짜) / After N occurrences (1~1000, 기본 30).
- "Set time for recurrence": 반복에도 별도 시간 지정 가능 (30분 단위).
- Cancel / Done.

### 별표 (Star)
- "Star this task" 버튼 + 왼쪽 "Starred" 필터 (별표 한 할 일만 모아 보기).

### 하위 작업 (Subtask) — 직접 테스트 결과 (Task1/Subtask1)
- 1단계까지만 가능. 하위 작업의 옵션 메뉴에는 "Add a subtask"가 없고 대신 "Unindent"(최상위 할 일로 되돌리기)가 있다. 하위 작업에는 Repeat 버튼도 없다.
- 표시: 부모 바로 아래 같은 목록에 별도 행으로 들여쓰기. 접기 화살표 없음 (항상 보임). 진행 표시(1/1 등) 없음. 하위 작업도 활성 할 일 수에 1개로 셈.
- 완료: 하위 작업만 완료하면 그것만 Completed로 가고 부모는 그대로. 부모를 완료하면 하위 작업까지 함께 완료 ("2 tasks completed"). 부모 완료 취소는 부모만 돌아오고 하위 작업은 완료 상태로 남음 (비대칭).
- Completed 섹션: 접힌 "Completed (N)", 취소선 제목, "Completed: Mon, Nov 23" 표시.

### 확인하지 못한 것 (지어내지 말고 표준 동작으로 구현)
- 기한 지난(overdue) 표시, 반복 할 일 완료 시 다음 회차 생성. 표준 Google 동작으로 구현한다: 반복 할 일을 완료하면 같은 내용의 다음 회차가 자동 생성되고 완료된 회차는 Completed에 남는다. 기한 지난 할 일은 날짜를 눈에 띄게(빨간색) 표시한다.

## 구현 범위

1. **마이그레이션 0046**
   - `task_lists` 테이블: id, owner_id, title, is_default (목록당 1개), created_at. 소유자별 기본 목록 "내 할 일 목록"은 첫 사용 시 자동 생성.
   - `tasks` 컬럼 추가: list_id, details TEXT, due_date TEXT (YYYY-MM-DD, KST 기준), due_time TEXT (HH:MM, nullable), starred INTEGER 0/1, repeat_rule TEXT (JSON), parent_id TEXT nullable (하위 작업), position INTEGER (수동 순서).
   - 기존 할 일은 소유자의 기본 목록으로, parent_id NULL, repeat_rule NULL로 이관한다.
2. **API**
   - 목록 CRUD: GET /api/task-lists, POST /api/task-lists, PATCH /api/task-lists/:id (이름 변경), DELETE /api/task-lists/:id (기본 목록 삭제 불가. 삭제 시 그 안의 할 일은 기본 목록으로 이동).
   - 할 일 확장: POST /api/tasks에 details/due_date/due_time/starred/repeat_rule/list_id/parent_id 허용. PATCH /api/tasks/:id에 done 토글 외에 위 필드 수정 + starred 토글 + list_id 이동 + parent_id 변경(Unindent는 parent_id null) 허용.
   - GET /api/tasks: `?list=<id>&filter=starred&sort=<myorder|date|deadline|starred|title>` 지원. 응답에 새 필드 전부 포함. 하위 작업은 부모 바로 아래 들여쓰기 순서로 (position 순, 부모 다음에 그 하위 작업들).
   - 완료 전파: 하위 작업만 완료 → 부모 그대로. 부모 완료 → 그 하위 작업 전부 함께 완료. 부모 완료 취소 → 부모만 복귀. 반복 할 일 완료 → 다음 회차 자동 생성 (repeat_rule로 다음 due_date 계산, Ends 규칙 준수: Never/On 날짜/After 횟수 — 같은 반복 그룹의 완료 회차 수로 횟수 제한. 그룹 식별용 repeat_group TEXT를 tasks에 둔다).
   - 할 일 삭제 시 그 하위 작업도 함께 삭제.
   - 입력 검증: title 1~200자, details 최대 2000자, due_date는 YYYY-MM-DD 형식, due_time은 HH:MM 형식, repeat_rule은 스키마 검증 (every 1~100, unit day/week/month/year, week는 weekdays 배열, month는 day 또는 nth+weekday, ends never/on/after, occurrences 1~1000). 반복은 due_date가 있을 때만 설정 가능 (Google과 동일 — Starts 날짜가 필요).
   - 소유권: 기존 규칙 유지 (본인·미지정만, hr_admin은 전체 + owner 필터). 목록도 owner_id 기준 동일 규칙.
3. **UI (할 일 탭)**
   - 목록 전환 UI + "새 목록" 만들기 + 목록 이름 변경/삭제 (기본 목록 삭제 불가 표시).
   - 전체/별표 필터 + 정렬 메뉴 (내 순서/날짜/기한/별표/제목).
   - 할 일 행: 체크박스, 제목, 기한 표시 (오늘·내일·날짜, 기한 지남 빨간색), 별표 토글, 하위 작업 들여쓰기 표시.
   - 할 일 클릭 시 상세 펼치기: 세부 메모, 날짜(오늘·내일 바로 지정 + 달력 + 시간 선택), 반복 설정 다이얼로그, 별표, 목록 이동, 삭제, 하위 작업 추가 (하위 작업 행에서는 반복·하위 작업 추가 버튼 없음 — Google과 동일).
   - 완료된 할 일은 접힌 "완료됨 (N)" 섹션으로.
   - 기존 관리자 바(사용자 필터·담당자 드롭다운)는 유지하고, 목록 전환과 함께 동작하게 한다.
4. **검증**
   - `npx tsc --noEmit` 0건.
   - 로컬 `wrangler dev --local` + 로컬 D1로 스모크: 마이그레이션 적용, 기본 목록 자동 생성, 목록 CRUD, 할 일 생성·날짜·별표·반복 설정, 반복 완료 시 다음 회차 생성, 완료 전파(부모→자식, 취소 비대칭), 하위 작업 Unindent, 정렬·별표 필터.
   - 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행 (python3 경유·env 접두어 금지, cwd는 이 레포 루트). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 한다.
   - 라이브 스모크: `https://people-os.workspace-easyware.workers.dev`로 curl (peopleos.site에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다. 원격 curl은 `--noproxy`를 쓰면 TLS 실패 — 프록시 경유 plain curl로). 로그인 필요한 호출은 `~/workspace/user`에 있는 세션 토큰 방식을 쓴다 (기존 세션들이 쓰던 `S=$(cat <토큰 파일>); curl -H "cookie: people_os_session=$S" <URL>` 한 개씩). 실제 사용자 3명의 데이터는 건드리지 않는다 — 테스트용 목록·할 일을 만들고 검증 뒤 삭제한다.
   - 결과는 `files/workflow-verify/tasks-google-parity/RESULT.md`에 기록한다 (배포 버전 ID, 검증 항목별 통과 여부, 남은 한계).
   - **커밋하지 않는다** (Merlin이 직접 커밋한다). 작업 트리에 변경을 남기고 보고한다.

## 금지 사항

- 다른 기능(캘린더·메일·결재·워크플로우·에이전트 등)은 건드리지 않는다.
- 기존 /api/tasks 응답의 기존 필드를 빼거나 이름을 바꾸지 않는다 (필드 추가만).
- 새 npm 의존성을 추가하지 않는다 (필요하면 먼저 보고한다).
- `files/workflow-verify/` 바깥에 임시 파일을 남기지 않는다. 하네스·state 파일은 커밋 대상이 아니므로 RESULT.md에만 결과를 적는다.
