# WF-11 프롬프트 — 관측 + 홈 카드 + 다듬기

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-11행 + WF-1~WF-10 산출물 + 검증 문서(`files/workflow-verify/wf5/RESULT.md`의 홈 카드 보류, `wf8/RESULT.md`의 스케줄 UI 메모, `wf9/RESULT.md`의 템플릿 토글 없음, `wf6/RESULT.md`의 DO 타임아웃 메모, D-2 라이브 기록의 create_task dueDate 오해).
> 모델: Sonnet. 이 세션은 **관측 + 홈 카드 + 다듬기만** 만든다. 새 노드·새 실행 동작·새 스키마는 만들지 않는다. **배포하지 않는다** — D-3b에서 코디네이터가 WF-10·WF-11을 묶어 배포·라이브 검증한다.
> **원칙**: 관측은 읽기 전용이다 (실행·승인·스케줄 동작을 바꾸지 않는다). 홈 카드는 기존 카드 패턴을 따른다. 다듬기는 문구·표시만 고치고 동작을 바꾸지 않는다 (타임아웃 28분만 예외 — 아래 4번).

## 목표

워크플로우 실행이 어떻게 돌아갔는지 관측 화면에서 보고, 홈에서 내 워크플로우를 바로 열 수 있게 하고, 그동안 쌓인 작은 다듬기(스케줄 UI·템플릿 토글·에이전트 도구 설명·DO 타임아웃)를 끝낸다. 이 세션이 끝나면 hr_admin이 관측 화면에서 워크플로우 run 목록과 단계별 타임라인을 보고, 홈 카드에서 내 워크플로우·최근 실행을 확인하고, 스케줄을 화면에서 만들고, 템플릿 지정을 화면에서 할 수 있다.

## 할 일

### 1. 관측 화면에 워크플로우 run 타임라인 (`public/obs/` + 읽기 전용 API 1개)

- **API (신규, hr_admin 전용)**: `GET /api/obs/workflow-runs?limit=50&status=&owner=` — 관측 라우트(`src/obs/`) 패턴을 따른다 (hr_admin 세션 또는 X-Admin-Secret 게이트, 기존 obs 라우트와 같은 방식). 워크플로우 run 목록을 최신순으로 돌려준다: run id·워크플로우 이름·소유자(이메일·이름)·상태·시작·종료·소요 시간·단계 수·LLM 호출 수·에러(있으면). 단계별 타임라인은 `GET /api/obs/workflow-runs/:runId`로 돌려준다: run 정보 + 단계 목록(단계 이름·노드 타입·상태·시작·종료·소요 시간·에러).
  - **LLM 호출 수**: run의 단계 중 LLM을 쓰는 노드(`LLM_NODE_TYPES` — `src/workflow/engine.ts`에 있음) 개수 + agent 단계의 turn 수(`output.turns` 길이)를 합친다. 새 카운터를 저장하지 않는다 — 있는 데이터에서 계산한다.
  - **소요 시간**: `started_at`/`finished_at`이 있는 단계는 그 차이, 없는 단계(아직 안 돈 단계)는 "—"로 표시한다. run 전체 소요도 같다.
  - **격리**: 이 API는 hr_admin만 본다 (일반 사용자는 자기 run을 워크플로우 탭에서 본다 — WF-5에서 이미 된다). 목록에 소유자 이메일이 나오므로 마스킹하지 않는다 (관측 화면은 원래 admin 전용이고, 트레이스 상세도 admin만 본다).
- **화면 (`public/obs/traces.js` 또는 새 파일 `public/obs/workflows.js` — 기존 obs 구조에 맞는 쪽으로)**: 관측 메뉴에 "워크플로우" 탭을 추가한다. 목록 테이블(상태 배지·소요 시간·LLM 호출 수) + 행 클릭 시 단계 타임라인 상세(단계별 막대 또는 목록 — 소요 시간이 긴 단계가 눈에 띄게). 필터는 상태(`succeeded`/`failed`/`waiting_approval` 등)만 넣는다 (복잡한 필터는 안 만든다).
  - 관측 화면이 없는 사용자(hr_admin이 아닌 경우)에게는 탭이 안 보인다 (기존 obs 탭 가시성 규칙과 같다).

### 2. 홈 "내 워크플로우" 카드 (`public/index.html` + `public/workflow.js`)

- WF-5에서 보류한 홈 카드다. 기존 홈 카드 패턴(메일함·결재·할 일 카드와 같은 구조)을 따른다:
  - 제목 "내 워크플로우", 내용: 내 워크플로우 수 + 최근 실행 3건(워크플로우 이름·상태·시각) + 승인 대기 중인 run이 있으면 그 수(빨간 배지).
  - 버튼 "워크플로우 열기 →" (`switchTab('workflow')` — 메뉴 이름은 기존 배선과 맞춘다).
  - 데이터는 기존 API로 가져온다 (`GET /api/workflows/` 목록 + 각 워크플로우의 최근 run — run 목록 API가 워크플로우별로 있으므로, 최근 실행은 워크플로우 3개까지만 조회한다. 홈 로딩이 느려지면 안 된다 — 실패하면 카드를 비워두고 에러 문구를 안 띄운다 (다른 홈 카드와 같은 fail-soft).
  - 카드 위치는 "빠른 검색" 카드 앞, 메뉴 순서(홈 배치)와 맞춘다.

### 3. 스케줄 UI (`public/workflow.js` — WF-8에서 API만 만들고 화면이 없었다)

- 워크플로우 상세 화면에 "스케줄" 섹션을 넣는다: 스케줄 목록(트리거 종류·cron·이벤트·활성화 여부·마지막 실행) + 생성 폼(스케줄 cron 입력 또는 이벤트 `transcript_completed` 선택) + 활성화 토글 + 삭제 버튼. 기존 스케줄 API(`POST/GET/PATCH/DELETE /api/workflows/:id/schedules`)를 쓴다.
- **분 입력 검증 (WF-8 메모)**: cron의 분 필드가 0/15/30/45가 아니면 저장 전에 경고 문구를 보여준다 ("크론은 15분마다 돌기 때문에 분이 0·15·30·45가 아니면 실행되지 않을 수 있습니다"). 저장을 막지는 않는다 — 경고만 한다 (경고 후에도 사용자가 저장하면 그대로 보낸다).
- 스케줄이 있는 워크플로우를 일시정지(`paused`)하면 스케줄이 안 돈다는 안내 문구 1줄을 넣는다 (D-2에서 확인한 `status='active'` 규칙).

### 4. 다듬기 (작은 수정 3건 — 동작 변경은 이 3건뿐이다)

- **DO 타임아웃 28분 (WF-6 메모)**: `src/workflow/agent-do.ts`의 `AGENT_TIMEOUT_MS`를 30분에서 **28분**으로 바꾼다. 엔진의 30분 run 상한보다 먼저 걸려서, 30분에 걸린 agent run이 "정상 멈춤"으로 끝나게 한다. 주석에 이유를 적는다. 다른 타임아웃 값은 건드리지 않는다.
- **create_task 도구 설명 — dueDate는 선택 사항 (D-2 라이브 메모)**: 에이전트가 `create_task`에 dueDate가 필수인 줄 알고 목표 달성을 거절한 적이 있다. `src/workflow/nodes.ts`의 `create_task` 레지스트리 설명을 "할 일을 만든다. 기한(dueDate)은 선택 사항이다 — 없으면 기한 없이 만든다."로 바꾼다. 에이전트 프롬프트가 도구 설명을 그대로 읽으므로, 이 한 줄이 곧 프롬프트 수정이다. `create_task` 노드 자체의 동작(기한 없으면 제목에 기한 안 붙임)은 바꾸지 않는다.
- **hr_admin 템플릿 토글 (WF-9에서 API만 만들었다)**: 워크플로우 상세의 공유 섹션에 "조직 템플릿으로 지정" 토글을 넣는다. `currentUser.role === 'hr_admin'`일 때만 보인다 (전역 `currentUser`는 index.html 인라인 스크립트에 있다). 토글 시 `PATCH /api/workflows/:id {is_template: true|false}`를 보낸다. 일반 사용자에게는 토글이 안 보인다.

### 5. 에러 문구 한국어 다듬기 (동작 변경 없음)

- 워크플로우 관련 사용자 노출 문구를 한 번 훑는다 (`public/workflow.js`·`workflow-canvas.js`의 `wfMsg`·`wfFail` 문구, `src/workflow/`의 `WfError` 메시지, `validateDefinition` 에러):
  - 영어가 섞인 문구가 있으면 한국어로 바꾼다 (예: "Workflow not found" 류가 남아 있으면 "워크플로우를 찾을 수 없습니다"로).
  - 같은 뜻의 문구가 여러 가지로 쓰이면 하나로 통일한다 (예: 저장 실패 문구).
  - 기술 용어(ID·HTTP 상태)는 그대로 둔다 (디버깅에 필요하다).
  - 바꾸는 문구는 RESULT.md에 목록으로 적는다 (전·후).

## 검증 (반드시 `files/workflow-verify/wf11/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf11/`)

- `npx tsc --noEmit` 통과. `node --check public/workflow.js public/obs/workflows.js`(새 파일이 있으면) 통과.
- 로컬 하네스 (WF-9·WF-10의 `wf9/`·`wf10/` 패턴 — Miniflare, AI·fetch는 mock):
  1. **관측 API**: hr_admin은 목록·상세 200, 일반 사용자는 401/403, 익명은 401. 목록에 run 정보(상태·소요·LLM 호출 수)가 있고, 상세가 단계별 타임라인(소요 시간 포함)을 돌려준다. agent run의 LLM 호출 수가 turn 수와 맞는다.
  2. **홈 카드**: 로컬 dev 화면에서 카드가 뜨고(데이터는 mock API 또는 실제 로컬 API), "워크플로우 열기" 버튼이 워크플로우 탭으로 간다. API 실패 시 카드가 조용히 비워진다.
  3. **스케줄 UI**: 화면에서 스케줄 생성·토글·삭제가 API와 왕복한다. 분이 7인 cron을 입력하면 경고 문구가 보인다 (저장은 된다).
  4. **다듬기**: `AGENT_TIMEOUT_MS`가 28분인지 코드로 확인 + agent run이 28분에 정상 멈춤으로 끝나는지 하네스로 확인 (실제 28분을 기다리지 않는다 — 타임아웃 판정 로직에 짧은 값을 주입하거나 `activeSinceMs`를 과거로 두고 확인한다). `create_task` 설명에 "선택 사항"이 들어갔는지 확인. hr_admin만 템플릿 토글이 보이는지(일반 사용자는 안 보임) 확인.
  5. **회귀**: 선형 실행 + 승인 게이트 + agent 루프 + condition 분기 + `next: null` 종료 + 스케줄 API + 공유/복사 + 웹훅 SSRF 차단 + 캔버스 정의 왕복이 그대로 동작한다 (WF-10 하네스 일부를 재사용한다).
- **미검증 목록을 RESULT.md에 적는다** (브라우저 화면 시각 확인, 배포·원격 D1, 실제 28분 타임아웃 — 로컬에서는 주입값으로만 확인).

## 금지

- 관측 API·홈 카드·스케줄 UI 외의 새 API를 만들지 않는다. D1 마이그레이션을 만들지 않는다 (스키마 변경 없음). 배포하지 않는다.
- 실행·승인·에이전트·스케줄·공유 동작을 바꾸지 않는다 (`AGENT_TIMEOUT_MS` 28분만 예외).
- 외부 라이브러리·CDN을 들이지 않는다. Agents SDK를 들이지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
