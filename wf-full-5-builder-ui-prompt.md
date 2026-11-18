# WF-5 프롬프트 — 폼 방식 빌더 UI

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.1.2 + `workflow-agent-builder-FULL-PLAN.md` §2 WF-5행 + WF-1~WF-4 산출물(API 목록 아래) + WF-4 검증 문서(`/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf4/RESULT.md` — "WF-5가 이어받을 지점"을 먼저 읽을 것).
> 모델: Sonnet. 이 세션은 프런트 UI만 만든다. 백엔드 API·마이그레이션·엔진을 바꾸지 않는다. `public/index.html`의 배선과 `public/workflow.{js,css}`만 만든다.

## 목표

사용자가 브라우저에서 워크플로우를 만들고, 단계를 쌓고, 실행하고, 실행 기록을 보고, 승인을 누를 수 있는 폼 방식 빌더 화면을 만든다. 비주얼 캔버스가 아니다 (WF-10에서).

## API (이미 있음 — 새로 만들지 않는다)

- `GET /api/workflows` — 내 목록. `POST /api/workflows` — 생성 `{name, description?, definition}`. `GET /api/workflows/:id`. `PATCH /api/workflows/:id`. `DELETE /api/workflows/:id`.
- `GET /api/workflows/:id/runs` — run 목록. `POST /api/workflows/:id/runs` — 실행 `{input?}` (429: 동시 3개·하루 20회 초과). `GET /api/workflows/runs/:runId` — run 상세 + steps.
- `POST /api/workflows/runs/:runId/approve` · `/reject` — 빈 본문 + 세션 쿠키. 401/404/409 처리.
- `GET /api/approval/notifications?unread=1` — 대기 목록은 여기서 `type==='WORKFLOW_APPROVAL'`만 필터. 응답에 `body`가 없고 워크플로우명·단계명이 `title`에 섞여 있다.
- 알림 link 형식: `/#workflow/<workflowId>?run=<runId>` — UI가 이 해시를 지원해야 한다 (해당 워크플로우를 열고 그 run의 상세를 보여준다).
- 노드 종류 12개: `ask_rag`, `ask_personal`, `transcribe`, `summarize`, `reflect_coach`, `reflect_coachee`, `draft_pptx`, `email_draft`, `send_email`, `create_task`, `llm`, `create_calendar_event`. `send_email`은 `requiresApproval:true`가 강제된다.

## 할 일

### 1. `public/workflow.js` + `public/workflow.css`

바닐라 JS만 쓴다 (빌드 없음). 기존 탭 패턴을 따른다 (`public/calendar.js`, `public/approval.js`를 먼저 읽고, 같은 구조·같은 CSS 변수·같은 탭 서브탭 패턴을 쓸 것).

**화면 구성 (탭 `#workflow`)**:
- 왼쪽(또는 위): 내 워크플로우 목록 (이름·상태 배지 draft/active/paused·마지막 실행 시각). "새 워크플로우" 버튼.
- 가운데: 선택한 워크플로우 편집.
  - 이름·설명·상태(드롭다운) 수정 폼. 저장 버튼 (PATCH).
  - 단계 목록: 각 단계가 카드 한 장. 단계 이름, 노드 종류(한국어 표시 — 아래 표), 설정 요약. 카드 옆 ↑↓로 순서 변경, ×로 삭제.
  - "단계 추가": 노드 종류를 드롭다운에서 고르면 그 노드의 설정 폼이 뜬다. 설정 폼은 노드별 필드 명세(아래 표)로 만든다. 저장은 "워크플로우 저장" 시 definition 전체를 PATCH로 보낸다 (단계마다 따로 저장하지 않는다).
  - 삭제 버튼 (confirm 후 DELETE).
- 아래(또는 오른쪽): 실행 영역.
  - 실행 입력: `docId` 텍스트 필드 1개 + "고급 입력(JSON)" 접기 textarea (비워 두면 `{}`; docId가 있으면 `{docId: ...}`로 합친다).
  - "실행" 버튼 → `POST /:id/runs` → run 목록에 추가 + run 상세로 이동.
  - run 목록: 상태 배지(queued/running/waiting_approval/succeeded/failed/cancelled)·시작 시각·현재 단계. 클릭하면 run 상세.
  - run 상세: 단계별 타임라인 (단계 이름·노드 종류·상태·소요·출력 요약·에러 메시지). `waiting_approval`이면 **승인 / 거절 버튼**을 크게 보여준다. 승인·거절 후 run 상세를 새로고침한다.
  - 대기 중인 승인: 상단에 "승인 대기" 섹션을 두고, `GET /api/approval/notifications?unread=1`에서 `WORKFLOW_APPROVAL`만 걸러 목록으로 보여준다 (제목 + "열기" 링크 → 해당 run 상세).
- 전역 함수: `workflowOpen(mountEl)` / `workflowLeave()` (다른 탭 모듈과 같은 패턴 — `public/calendar.js`의 `calendarOpen`/`calendarLeave`를 참고). 해시 `#workflow/<id>?run=<runId>`를 지원한다.

**노드별 한국어 표시 + 설정 필드 명세** (이 표를 `workflow.js` 안에 상수로 둔다):

| 노드 | 표시 이름 | 설정 필드 |
|---|---|---|
| `ask_rag` | HR 규정 질문 | question (textarea, 필수) |
| `ask_personal` | 내 문서 질문 | question (textarea, 필수) |
| `transcribe` | 전사 확인 | docId (text, 필수) — 이미 전사 완료된 문서만 |
| `summarize` | 문서 요약 | docId (text, 필수) |
| `reflect_coach` | 코치 리플렉션 | docId (text, 필수) |
| `reflect_coachee` | 코칭 대상 리플렉션 | docId (text, 필수) |
| `draft_pptx` | PPTX 초안 | title (text, 필수), bullets (textarea, 선택 — 비우면 앞 단계 요약 사용) |
| `email_draft` | 메일 초안 | to (text, 필수), context (textarea, 필수) |
| `send_email` | 메일 발송 (승인 필요) | to (text, 필수), subject (text, 필수), body (textarea, 필수). 카드에 "승인 필요" 배지를 항상 표시 |
| `create_task` | 할 일 만들기 | title (text, 필수), dueDate (date, 선택) |
| `llm` | 자유 프롬프트 | prompt (textarea, 필수). 안내 문구: `{{input.docId}}`, `{{steps.<단계id>.output.<키>}}`로 앞 단계 출력을 쓸 수 있다 |
| `create_calendar_event` | 일정 만들기 | title (text, 필수), start (datetime-local, 필수), end (datetime-local, 필수), allDay (checkbox) |

- 설정 값은 `{{...}}` 변수 참조를 그대로 둘 수 있다 (예: question에 `{{input.question}}` 입력 가능). 엔진이 치환한다.
- 단계 id는 `s1`, `s2`, ... 순서대로 자동 부여한다 (삭제 후에는 다시 부여하지 않고, 새 단계는 기존 최대값+1).

### 2. `public/index.html` 배선 (C2w 패턴, 8곳)

`public/calendar.js` 배선(C2w)을 참고해 같은 8곳을 고친다:
1. `workflow.css` 링크 추가.
2. 사이드바 버튼을 **강의실 다음, 개인 업무 검색 앞**에 추가: `<button data-tab="workflow">` + Lucide 스타일 인라인 SVG 아이콘(워크플로우 — 노드·간선 모양, 예: `git-branch` 계열) + `<span class="nav-label">워크플로우</span>`.
3. `<section id="tab-workflow">` 추가 (다른 탭과 같은 구조).
4. `workflow.js` script를 `org.js` 다음에 추가.
5. `TABS`와 `COACHEE_TABS`에 `'workflow'` 추가 (전원 사용 — 코치·코칭 대상·HR admin 모두).
6. 익명 숨김 선택자에 `data-tab="workflow"` 추가 (로그인 안 하면 안 보임).
7. `switchTab` 하위 경로에 workflow 추가 + `workflowOpen`/`workflowLeave` 호출.
8. 홈 카드? **이번에 안 만든다** (WF-11에서). 메뉴·탭만.

### 3. 보안·UX 규칙

- **제목·본문·출력은 `textContent`로만 넣는다.** `innerHTML`에 사용자 입력·서버 데이터를 넣지 않는다 (C2 교훈 — XSS).
- 모든 fetch는 세션 쿠키 포함 (same-origin, 기본값). 401이면 로그인 화면으로 안내한다 (다른 탭과 같은 처리).
- 에러 메시지는 한국어로, 서버가 준 이유를 그대로 보여준다 (예: 429면 "동시 실행 3개를 넘었습니다").
- `send_email` 단계가 있는 워크플로우를 저장할 때 "메일 발송 단계는 실행 중 승인이 필요합니다"라는 안내를 저장 버튼 옆에 보여준다.

## 제약

- 백엔드 파일을 바꾸지 않는다 (`src/` 일절 금지).
- 새 CSS 변수·새 폰트를 도입하지 않는다. 기존 `styles.css`의 변수·패턴을 따른다.
- `public/index.html`의 기존 탭·메뉴 순서를 바꾸지 않는다 (워크플로우 버튼만 강의실 다음에 삽입).

## 검증 (반드시 수행하고 결과를 기록할 것)

1. `node --check public/workflow.js` 통과. `npx tsc --noEmit` 통과 (백엔드 변경이 없어야 하지만 확인한다).
2. 로컬 하네스: `npx wrangler dev --local`을 띄우고,
   - `GET /` 200, `workflow.js`·`workflow.css` 200 확인.
   - 테스트 사용자로 로그인한 뒤 curl로 API 왕복이 UI 없이도 되는지 확인 (WF-1~WF-4에서 이미 검증했으므로, 여기서는 **UI가 부르는 것과 같은 순서**로 1건만: 워크플로우 생성 → run 생성 → run 상세 조회).
   - 브라우저 시각 확인은 이 세션에서 못 하므로, 대신 `workflow.js`의 주요 흐름(목록 렌더·단계 추가·실행·승인 버튼)을 코드 리뷰 체크리스트로 `RESULT.md`에 적고, 각 함수가 어떤 API를 부르는지 표로 남긴다.
   - 익명 401, `index.html`에 workflow 버튼·section·script가 있는지 grep으로 확인.
   - dev 서버가 포트를 잡고 있으면 `ss`로 pid를 확인해 kill한다. `pkill -f`는 쓰지 않는다.
3. 산출물은 goal 루트 `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf5/` 아래에 둔다 (`RESULT.md` + 체크리스트).

## 산출물

- `public/workflow.js`, `public/workflow.css`
- `public/index.html` 배선 (8곳)
- `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf5/RESULT.md` (검증 결과 + UI 흐름 체크리스트 + 미검증 항목 — 특히 **브라우저 시각 확인은 안 됐음**을 명시)

마지막에 무엇을 만들었고, 무엇을 검증했고, 미검증 항목(브라우저 시각 확인)과 D-1 배포 시 확인할 것(실제 브라우저에서 워크플로우 만들기→실행→승인)을 요약해서 보고할 것.
