# 홈 화면 링크 수정 — Sonnet 세션 프롬프트

## 배경

사용자가 직접 보고한 문제: People OS 홈에서 "해야 할 일", "최근 문서", "최근 성찰" 항목을 눌러도 해당 항목으로 이동하지 않고, 상단 4개 카드("안 읽은 메일", "해야 할 일", "문서", "성찰")도 눌러도 메뉴로 이동하지 않는다.

## 현재 코드 (Merlin이 직접 확인함 — 다시 읽어 대조할 것)

- `public/index.html` `renderHomeStats()` (~1415행): 4개 `<div class="stat">`에 클릭 핸들러 없음.
- `public/index.html` `loadHome()` (~1441행): 최근 문서(`homeDocs`)·최근 성찰(`homeRefl`) 행이 클릭 없는 plain `<div class="taskrow">`. 해야 할 일(`homeTasks`)은 `taskRow()` (~1385행)인데 체크박스 토글·× 삭제만 있고 제목 클릭 이동 없음.
- 이미 되는 곳이 모델: 홈 메일 행 (~1437행)은 `<div class="taskrow" style="cursor:pointer" onclick="switchTab('email');emailView('...')">`로 돼 있음. 같은 패턴으로 할 것.
- 탭 전환: `switchTab('email'|'tasks'|'upload'|'library'|...)`, 코칭 성찰 탭 이름은 `'coaching'` (`data-tab="coaching"`, index.html:117).
- 라이브러리 상세: `openLibDetail(kind, i)` (~1706행, 인덱스 기반, 전체 화면 상세 + "<- 목록" 뒤로가기).
- 할 일 펼치기: `public/tasks.js` `openTaskDetail(id)` (~224행, `window.openTaskDetail`로 노출됨) — 캘린더 알약 클릭(`public/calendar.js:219`)이 이미 이걸 재사용해 할 일 탭으로 가서 펼친다. 홈 할 일 행도 이걸 재사용할 것.

## 고칠 것

1. **최근 문서 행 클릭** → 해당 문서의 라이브러리 상세(전체 화면)로 이동. `openLibDetail`은 인덱스 기반이라 홈 행에서 바로 못 쓸 수 있음 — id로 여는 방법(예: id→인덱스 매핑, 또는 id 기반 상세 열기)을 세션이 정할 것. 문서 종류(규정/전사본/덱 등)별로 맞는 상세로 열릴 것. `/api/home`의 `recentDocuments`가 주는 필드(id·kind 등)를 먼저 확인할 것.
2. **해야 할 일 행 클릭** → `window.openTaskDetail(id)`로 할 일 탭으로 가서 해당 할 일이 펼쳐진 상태로 보이게. 단, 체크박스(완료 토글)와 ×(삭제)는 그대로 동작해야 함 — 행 클릭 핸들러에서 이 두 컨트롤의 클릭 전파를 막을 것 (`event.stopPropagation()` 또는 컨트롤에 직접). 제목만 클릭 가능하게 하는 게 아니라 행 전체를 클릭 가능하게 하되 컨트롤은 제외.
3. **최근 성찰 행 클릭** → 해당 성찰의 라이브러리 상세(전체 화면)로 이동. `/api/home`의 `recentReflections` 필드를 확인할 것.
4. **상단 4개 카드 클릭** → 해당 메뉴로 이동: 안 읽은 메일→`switchTab('email')`, 해야 할 일→`switchTab('tasks')`, 문서→`switchTab('library')`, 성찰→`switchTab('coaching')`. 카드 전체가 클릭 가능하게 하고 `cursor:pointer`를 줄 것.

## 제약

- 모바일 2줄 행 구조(어제 고친 `.t-meta` 모바일 행)는 건드리지 말 것. 클릭만 추가한다.
- 모든 새 클릭 영역에 `cursor:pointer`를 줄 것.
- 키보드 접근성: 카드·행에 `tabindex="0" role="button"` + Enter 키 핸들러를 붙이는 것이 좋음 (라이브러리 카드 `libcard-click`이 이미 그렇게 돼 있음 — 같은 패턴).
- 건드리지 말 것: `src/meet/*`, `src/chat/*`, `public/meet.*`, `public/chat.js`를 제외하고, 이번 작업과 무관한 파일은 고치지 않는다. `public/approval.js`는 건드리지 않는다.
- GitHub 푸시는 하지 않는다 (Merlin이 나중에 스냅샷 푸시로 따로 한다). 로컬 커밋도 하지 않는다.

## 검증 (반드시 수행)

1. `npx tsc --noEmit` (0건) + 수정한 JS 파일 `node --check`.
2. 로컬 `npx wrangler dev --local`로 띄워서(또는 동등한 방법) 홈 HTML이 새 핸들러를 포함하는지 확인할 것.
3. 라이브 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행할 것 (python3 경유·env 접두어 금지, cd 없이 `--config` 절대 경로 사용). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 배포 3분 뒤에 할 것.
4. 라이브 스모크: `curl`로 health 확인 + 서빙되는 `index.html`에 새 핸들러(예: `openTaskDetail`, 카드 onclick)가 들어 있는지 확인할 것. 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 할 것 (peopleos.site에 Cookie 헤더를 붙인 curl은 샌드박스 프록시에서 멈춤). 필요하면 `~/workspace/user`에 있는 시크릿 파일을 읽어 `x-admin-secret` 헤더를 쓸 것 (비밀 값은 보고서에 적지 말 것).
5. 결과 보고: 라이브 배포 버전 ID, 수정한 파일·함수, 검증 결과(무엇을 어떻게 확인했는지)를 `files/workflow-verify/home-links/RESULT.md`에 적고, 최종 응답에도 요약할 것.
