# 홈 화면 표시 문제 5건 수정 — 결과 (2026-11-22, Fable 5.2)

**배포 버전 ID: `83c2da21-1e04-4244-aa51-86d552fcb78e`** (직전 `859de054-ad9b-4d5f-8030-e71d96d52ca9`). 배포 1회.

바꾼 파일은 `public/` 4개뿐이다: `workflow.js`, `lms.js`, `index.html`, `styles.css`.
`src/`, `wrangler.toml`, 마이그레이션은 건드리지 않았다. 커밋·태그·문서 갱신은 하지 않았다.

**브라우저로 화면을 본 것은 없다.** 아래 검증은 코드 확인, 로컬 dev의 API 상태 재현, 배포된 자산의 문자열 확인까지다.
1~5번 모두 녹화 전에 브라우저에서 한 번 눈으로 확인해야 한다.

## 건별

### 1. 홈 '내 워크플로우' 카드의 'null' 글자
- 원인: `wfHomeCard()`가 승인 대기가 없을 때 `box.append(..., null)`을 불렀다. `Element.append(null)`은 글자 "null"을 넣는다.
- 수정: `public/workflow.js` 836~838행. 개수 줄을 먼저 붙이고, 배지는 `if (waiting.size)`일 때만 붙인다.
- 로컬 재현 (`wrangler dev --local`, 임시 사용자 `u_hg_user`):
  - 대기 0건: 워크플로우 2개, 실행 1건 `succeeded`, `/api/approval/notifications?unread=1` 0건 → `waiting.size`가 0이라 예전 코드에서 "null"이 나오던 바로 그 상태. 새 코드는 이 경우 append를 부르지 않는다.
  - 대기 1건: 승인이 필요한 메일 워크플로우를 실행 → 실행 `waiting_approval` + `WORKFLOW_APPROVAL` 알림 1건(링크 끝 `?run=<id>`) → `waiting.size`가 1이라 배지 "승인 대기 1"이 붙는 분기.
  - 로컬이 내려준 `workflow.js`에 새 코드가 있고 `: null);`이 없음을 확인.
- 못 한 것: 카드가 실제로 그려진 모습 확인 (브라우저 없음).

### 2. 홈 '이어서 듣기'의 제목 반복
- 원인: `lmsHomeCard()`가 `과정 제목 · 강의 제목`을 항상 둘 다 썼다. 강의 1개짜리 과정은 둘이 같다.
- 수정: `public/lms.js` 174~180행. 앞뒤 공백을 뗀 두 제목이 같거나 한쪽이 비면 하나만, 다르면 예전처럼 `과정 · 강의`.
- 검증: `node --check` 통과, 로컬·라이브 자산에 `nextLabel` 확인. 로컬에 강의 데이터를 만들어 돌려 보지는 않았다.

### 3. 홈 '열린 할 일'의 내부 식별자
- 원인: 워크플로우 `create_task` 노드가 할 일 출처를 `workflow:<워크플로우 id>`로 저장하고(`src/workflow/nodes.ts:450`), `taskRow()`가 그것을 그대로 보여줬다. 어시스턴트가 만든 할 일은 `workflow:assistant`다.
- 수정: `public/index.html`의 `taskRow()` 아래에 `taskSrcHtml()`·`taskSrcResolve()` 추가 (1345~1367행 부근), `loadHome()`·`loadTasks()`가 목록을 그린 뒤 `taskSrcResolve`를 부른다.
  - `workflow:<id>` → 처음에는 숨긴 칸으로 그리고, `GET /api/workflows`로 내 워크플로우 이름을 찾으면 이름을 넣어 보인다. 못 찾으면 숨긴 채 둔다.
  - `workflow:assistant` → "AI 어시스턴트".
  - 그 밖의 `종류:영숫자id` 꼴 → 출처를 안 보인다.
  - 사람이 쓴 출처(문서 제목 등, 공백·한글 포함)는 예전과 같다.
- 홈과 할 일 탭 둘 다 같은 `taskRow()`를 써서 두 곳에 함께 적용된다.
- 로컬 확인: `/api/home`의 `openTasks[0].source`가 `workflow:wf_mwr24pu3_umpmmb`로 오고, 같은 사용자의 `/api/workflows`에 그 id의 이름("HG 승인 없는 흐름")이 있음 → 이름으로 바뀌는 경로의 데이터가 맞다.
- 알아둘 점:
  - 할 일 목록에 워크플로우 출처가 있을 때만 `GET /api/workflows` 읽기 요청이 1건 더 나간다 (없으면 요청 없음).
  - 이름은 "내 워크플로우"에서만 찾는다. 관리자가 다른 사람의 할 일을 볼 때, 또는 워크플로우가 지워진 뒤에는 출처가 비어 보인다.
  - 문구 "AI 어시스턴트"는 내가 고른 것이다. 다른 말이 좋으면 `taskSrcHtml` 한 줄만 바꾸면 된다.

### 4. 히어로 상태 배지
- 원인: `/api/health` 응답의 바인딩 이름을 그대로 이어 붙였다.
- 수정: `public/index.html` 1747~1749행. 글자는 `정상`만, 서비스 목록은 배지의 `title`(마우스를 올리면 보임)에만 둔다. 실패 문구는 그대로다.
- 확인: 로컬 `POST /api/health` 200 `ok:true`, 로컬·라이브 `index.html`에 `'정상 · '`가 0건.

### 5. 소개 탭 '하루' 흐름의 세로 선
- 수정: `public/styles.css` 154행 `#tab-about .pt-flow`의 `border-left` 색을 `--color-line`(#e4e4e7, zinc-200) → `--color-text-3`(#a1a1aa, zinc-400)로. 이미 있는 토큰이고 새 색은 없다. 발표자료 쪽 `.pt-flow`(pitch.css)는 그대로다.
- 진하기가 알맞은지는 눈으로 봐야 한다. 과하면 `--color-line-strong`(#d4d4d8, zinc-300)이 중간 값이다.

## 정적 검증
- `node --check public/workflow.js`, `public/lms.js` 통과. `npx tsc --noEmit` 0건.
- `index.html` 안의 인라인 스크립트는 `node --check` 대상이 아니라 문법 검사를 따로 못 했다 (로컬·라이브에서 200으로 내려오는 것만 확인).

## 라이브 스모크 (배포 3분 뒤, 익명 호출만)

| 대상 | 배포 전 | 배포 후 |
|---|---|---|
| `/api/health` | 200 | 200 (본문 같음) |
| `/api/auth/me` | 401 | 401 |
| `/api/workflows` | 401 | 401 |
| `/api/home` | 200 | 200 |
| `/api/lms/summary` | 401 | 401 |
| `/` | 200 | 200 |
| `/workflow.js`, `/lms.js`, `/styles.css` | — | 200, 각각 새 코드 포함 |

## 임시 데이터
- 운영 D1에는 아무것도 쓰지 않았다. 로그인이 필요한 라이브 호출도 하지 않았다.
- 로컬(`files/workflow-verify/home-glitch-fix/state`)에 만든 사용자 1·세션 1·워크플로우 2·실행 2·할 일 1·알림 1을 `harness/cleanup.sql`로 지웠다. 지운 뒤 개수: users 0, auth_sessions 0, workflows 0, workflow_runs 0, workflow_run_steps 0, tasks 0, notifications 0.
- 남은 파일: `harness/`(seed·요청 본문·cleanup·dev.log), `state/`(빈 로컬 D1). 커밋 대상이 아니면 지워도 된다.

## 남은 것
- 브라우저 확인 5건 전부 (특히 1번 카드, 3번 출처 이름, 5번 선 진하기).
- 2번은 실제 강의 데이터로 돌려 보지 않았다.
- 이번 세션에서 겪은 것: 예전 시드에서 가져온 `auth_sessions.expires_at` 값(1795265789630)은 이미 지난 시각이라 로컬 로그인이 401이었다. 시드를 다시 쓸 때는 만료 시각을 새로 넣어야 한다.
