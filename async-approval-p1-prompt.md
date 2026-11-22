# 비동기 승인 + 시뮬레이션 P1 프롬프트 (Opus 5.5 단일 세션)

## 배경

People OS 워크플로우: 지금은 승인이 필요한 단계(`send_email`·`webhook`)에서 run이 `waiting_approval`로 멈춘다. 사용자가 승인해야 다음 단계로 간다. P1~P3의 목표는 승인 필요한 동작을 대기열에 쌓고 run은 멈추지 않고 끝까지 가게 하는 것이다. 사용자는 나중에 승인함에서 쌓인 동작을 한꺼번에 또는 하나씩 승인·거절하고, 승인된 동작만 그때 실제로 실행된다.

설계 원본: `think-cloudflare-os-adoption-plan.md` §3.1 "비동기 승인 + 시뮬레이션". **P1 범위 = 그 절의 항목 1·2·3 + 저장 시점 지연 거부 + 만료.** 항목 4(에이전트)·5(승인 API·큐 소비자)는 P2, 항목 6(UI)는 P3이므로 이번 세션에서 건드리지 않는다.

## P1 범위 (이것만 한다)

1. **대기 동작 테이블** — 마이그레이션 `0042_workflow_pending_actions.sql` (추가만). 열은 설계 원본 §3.1 항목 1 그대로: `id`, `run_id`, `step_index`, `turn`(agent만, P1에서는 NULL), `owner_id`, `node_type`, `args_json`(변수 치환이 끝난 최종 인자), `simulated_output_json`, `status`(`queued`·`approved`·`executing`·`executed`·`rejected`·`failed`·`expired`), `result_json`, `error`, `created_at`, `decided_at`, `executed_at`. `UNIQUE(run_id, step_index, turn)`도 원본대로 둔다. 인덱스: `run_id`, `(owner_id, status)`.
   - **멱등성 주의**: SQLite UNIQUE는 NULL을 서로 다르게 취급하므로, P1의 비에이전트 행(`turn` NULL)은 UNIQUE만으로 중복 삽입을 막지 못한다. 그래서 행 id를 결정적으로 만들고(`wfpa_<runId>_<stepIndex>`, agent면 `_t<turn>` 접미 — P1에서는 안 쓰임) **PRIMARY KEY(id)로 INSERT OR IGNORE**한다. 이것이 중복 방지의 실제 수단이다.
2. **노드 층 시뮬레이션** (`src/workflow/nodes.ts`, `src/workflow/types.ts`의 `NodeContext`).
   - `NodeContext`에 `deferActions?: boolean`을 더한다.
   - `send_email`·`webhook`은 `approved !== true`이고 `deferActions === true`이면: (a) 지금처럼 검증을 먼저 한다(주소 형식·20명 상한·제목·본문 / 웹훅 설정 검증·SSRF 검사 — 검증 실패는 지금처럼 실패이지 시뮬레이션이 아니다). (b) 검증 통과한 최종 인자로 대기 동작 행 1개를 넣는다(`args_json` = `executeNode`가 치환해 넘긴 최종 config — 노드가 받는 `cfg`가 이미 치환된 값이다. `executeNode`가 `resolveVars(rawConfig, {input, steps})`를 먼저 한다). (c) `{ status: "succeeded", output: { simulated: true, pendingActionId, ... } }`를 돌려준다.
     - `send_email` 시뮬레이션 출력: `{ providerId: null, simulated: true, pendingActionId, to, subject }`.
     - `webhook` 시뮬레이션 출력: `{ status: null, ok: null, simulated: true, pendingActionId, method, url }`. 응답 본문은 지어내지 않는다.
   - `deferActions`가 아닐 때의 동작은 지금과 완전히 같아야 한다: `approved !== true`면 `{ status: "waiting_approval", ... }` (2차 방어선), `approved === true`면 실제 실행. `approved === true`이면 `deferActions`보다 승인이 우선한다(실제 실행).
3. **엔진 지연 경로** (`src/workflow/engine.ts`).
   - 승인 게이트(7번, `processWorkflowStep` 안 `if (step.type !== "agent" && needsApproval(step) && !approved)`): 단계의 `approvalMode === "deferred"`이면 `pauseForApproval`을 부르지 않고, 노드를 `deferActions: true`로 실행하고 다음 단계로 간다. 즉 게이트를 통과시켜 `executeNode`까지 가게 한다. `ctx`에 `deferActions: true`를 담는다.
   - `WorkflowStepDef`(`src/workflow/types.ts:63`)에 `approvalMode?: "deferred"`를 추가한다(생략 = 동기식, 지금 동작).
   - run 상태 값은 늘리지 않는다(`waiting_approval`은 동기식 전용으로 남는다). 지연된 단계는 `succeeded`로 기록되고 그 출력(시뮬레이션 출력)이 `workflow_run_steps.output_json`에 남는다. `advance()`는 기존 경로 그대로.
   - "승인 대기 동작 N개"는 `GET /api/workflows/runs/:runId` 응답에 `pendingActions` 개수(대기 중인 `queued` 행 수)를 더해 제공한다. 다른 run 조회 API는 건드리지 않는다.
4. **저장 시점 지연 거부** (`validateDefinition`, `src/workflow/types.ts` — `routes.ts`가 생성·수정 때 이미 부른다).
   - `approvalMode: "deferred"`는 `send_email`·`webhook` 단계에만 허용한다. 다른 타입(agent 포함 — agent 지연은 P2)이나 다른 값이면 400.
   - 뒤 단계가 그 동작의 실제 결과에 기대는 경우 지연을 거부한다(400): (i) 뒤 단계의 config 안에 `{{steps.<지연단계id>.output...}}` 참조가 있을 때(config 전체를 문자열로 만들어 패턴으로 찾으면 된다 — 보수적으로 잡는다). (ii) `webhook` 단계의 method가 `GET`일 때(읽기라서 시뮬레이션할 결과가 없다. method 생략은 POST 기본값이라 허용).
   - `requiresApproval` 강제 규칙(설계 원본이 아니라 `validateDefinition` 기존 동작: `APPROVAL_REQUIRED_NODES`는 `requiresApproval` 없으면 true로 강제, 명시적 false는 에러)은 그대로 둔다.
5. **만료** (`sweepStaleWorkflowRuns`, `src/workflow/engine.ts` — 15분 크론이 부른다).
   - 7일(`STALE_APPROVAL_MS`) 지난 `queued` 대기 동작을 `expired`로 바꾼다. `sweepStaleWorkflowRuns`의 반환 형태는 바꾸지 않는다.

## 안전 규칙 3개 (설계 원본 — P1에서 지켜야 할 것)

- **지연 방식은 선택 사항이고 기본값은 지금의 동기식이다.** `approvalMode`를 생략한 모든 단계와 모든 템플릿은 지금과 똑같이 동작한다. P1에서 템플릿 정의를 바꾸지 않는다.
- **거절은 뒤 단계를 되돌리지 않는다.** 지연 방식에서는 승인 전에 뒤 단계가 이미 실행된다. 이것은 설계상 한계이고 P1에서 되돌림을 구현하지 않는다. (거절 화면에 "이 동작 뒤에 이미 실행된 단계"를 보여주는 것은 P3 UI 일이다.)
- **검증은 승인 요청 전에 먼저 한다.** 잘못된 메일·막힌 웹훅 주소가 대기 동작으로 쌓이지 않는다. 노드의 검증 실패는 지금처럼 단계 실패이다.

## 건드리지 말 것 (P2·P3, 동기식 경로)

- **에이전트 경로 일절**: `src/workflow/agent.ts`, `src/workflow/agent-do.ts`, `src/workflow/agent-think.ts`, `src/assistant/*`. agent 단계의 지연은 P2이다. `agent-do.ts`의 `pendingAction` 저장소 필드도 건드리지 않는다.
- **승인 결정 API·큐 소비자 일절**: `GET /api/workflows/pending-actions`, `POST /api/workflows/pending-actions/decide`, `workflow-action` 큐 메시지, `index.ts`의 큐 소비자 분기는 P2이다. P1에서는 대기 동작을 만들고 쌓기만 하고, 승인·거절·실행 경로는 만들지 않는다.
- **UI 일절**: `public/workflow.js`, `public/approval.js`, `public/index.html` — P3이다. P1에서 화면을 바꾸지 않는다.
- **동기식 승인 경로**: `pauseForApproval`, `requestWorkflowApproval`(알림), `resumeWorkflowRun`, `cancelWorkflowRun`, `POST /runs/:runId/approve|reject`는 지금과 똑같이 동작해야 한다. `waiting_approval` 상태·7일 정체 청소(기존 run 대상)는 그대로.
- **질문 경로·평가·관측·채팅·화상회의·캘린더·이메일·결재·LMS**: 건드리지 않는다. `src/ask-pipeline.ts`, `src/obs/*`, `src/meet/*`, `src/chat/*`는 수정 금지.
- **질문 탭의 agent 노드와 ThinkAgent DO**: P1은 일반 노드(`send_email`·`webhook`)의 엔진 경로만 바꾼다.

## 현재 코드 사실 (검증됨 — 읽고 확인할 것)

- `src/workflow/engine.ts:104` `needsApproval(step)`: `step.requiresApproval === true || APPROVAL_REQUIRED_NODES.includes(step.type)`. `APPROVAL_REQUIRED_NODES = ['send_email', 'webhook']` (`types.ts:46`).
- 엔진 게이트(7번): `if (step.type !== "agent" && needsApproval(step) && !approved) { await pauseForApproval(...); return; }`. 2차 방어선: `res.status === "waiting_approval"`이면 `pauseForApproval`을 다시 부른다.
- `send_email`(`nodes.ts`): 주소·제목·본문 검증 → `ctx.approved !== true`면 `{ status: "waiting_approval", output: { to, subject } }` → 승인 시 Resend 발송 + `emails` 행 기록 → `ok({ providerId })`.
- `webhook`(`nodes.ts`): 설정 검증·SSRF 검사·GET/DELETE body 금지 → `ctx.approved !== true`면 `{ status: "waiting_approval", output: { method, url } }` → 승인 시 fetch(10초·256KB, redirect manual) → `ok({ status, ok, contentType, body, json? })`. 4xx/5xx도 성공 출력이다.
- `executeNode`(`nodes.ts:697`): `resolveVars(rawConfig, {input, steps})`로 치환한 config를 executor에 넘긴다. `agent` 타입은 여기서 실행하지 않는다(예외).
- `WorkflowStepDef`(`types.ts:63`): `{ id, type, name, config, requiresApproval?, next? }`.
- `validateDefinition`(`types.ts`): version 1, steps 1~50, id 중복 금지 등. `APPROVAL_REQUIRED_NODES`는 `requiresApproval` 없으면 true로 강제하고 명시적 false는 에러로 거부한다.
- `sweepStaleWorkflowRuns`(`engine.ts:413`): queued/running 60분 → failed, `waiting_approval` 7일(`STALE_APPROVAL_MS`) → cancelled. 15분 크론(`index.ts:2204` 부근)이 부른다.
- 마이그레이션: 최신은 `0041_assistant_turns.sql` (원격 적용됨). P1은 **0042**.
- 라이브 버전: `a685a42f` (`AGENT_RUNTIME=think`). Think 전환이 끝났지만 P1은 엔진의 일반 노드 경로만 건드린다.
- `wrangler.toml`: `compatibility_date 2025-07-18`, 플래그 `nodejs_compat, enable_ctx_exports`. 바꾸지 않는다.

## 통과 기준

1. `npx tsc --noEmit` 오류 0.
2. 로컬 하네스 (새 폴더 `files/workflow-verify/async-approval/p1-harness/`, `wrangler dev --local` + 로컬 D1에 0001~0042 전부 적용): 아래 항목 전부.
   - **지연 메일**: `send_email` 단계에 `approvalMode: "deferred"`인 워크플로 실행 → run `succeeded`까지 멈추지 않고 끝남, 대기 동작 행 1개(`status queued`, `args_json` = 치환된 최종 인자, `simulated_output_json` = 시뮬레이션 출력), 실제 발송 0건(Resend 호출 없음, `emails` 행 없음), 단계 출력에 `simulated: true, pendingActionId` 있음, run 상세에 `pendingActions: 1`.
   - **지연 웹훅(POST)**: 같은 방식으로 run 완료 + 대기 동작 행 + 실제 fetch 0건.
   - **지연 + 뒤 단계**: 지연 메일 뒤에 `create_task` 단계가 있으면 둘 다 실행되고 run이 끝난다(뒤 단계가 시뮬레이션 출력을 참조하지 않을 때).
   - **저장 거부 (i)**: 뒤 단계 config에 `{{steps.<지연단계id>.output.providerId}}` 참조가 있으면 워크플로 저장 400.
   - **저장 거부 (ii)**: method GET인 `webhook` 단계에 `approvalMode: "deferred"`를 두면 저장 400.
   - **저장 거부 (iii)**: `send_email`·`webhook`이 아닌 단계나 `deferred`가 아닌 값에 `approvalMode`를 두면 저장 400.
   - **동기식 불변**: `approvalMode` 없는 `send_email` 워크플로 실행 → 지금처럼 `waiting_approval`로 멈추고 알림 1건, 승인하면 발송되고 run이 끝난다. 거절하면 run 취소. (기존 WF-4 동작 그대로.)
   - **큐 재전달 멱등**: 같은 지연 단계를 두 번 실행(재전달 시뮬레이션)해도 대기 동작 행은 1개만 생긴다.
   - **만료**: `created_at`이 8일 전인 `queued` 행이 있으면 sweep 뒤 `expired`가 된다. (sweep 함수를 직접 부르는 하네스로 확인해도 된다.)
   - **검증 우선**: 주소가 틀린 지연 메일은 대기 동작을 만들지 않고 단계 실패로 run이 실패한다. SSRF 차단 주소의 지연 웹훅도 마찬가지.
3. D1 마이그레이션 0042 원격 적용 (`migrations list --remote`로 미적용이 0042 하나뿐임을 먼저 확인하고 `migrations apply --remote`).
4. 라이브 배포 + 스모크: 배포 전후 기존 엔드포인트 응답이 의도한 변화 외에는 같아야 한다. 새 테이블·새 라우트 없음( P1은 라우트를 추가하지 않는다 — run 상세 응답에 `pendingActions` 개수만 더한다). 배포 직후 약 2분은 옛 버전이 응답하니 스모크는 3분 뒤에 한다.
5. 결과 파일 `files/workflow-verify/async-approval/P1-RESULT.md` 작성: 판정 표, 구현한 파일 목록, 하네스 항목별 증거, 라이브 버전·스모크 결과, 남은 문제, P2에 넘길 것.

## 작업 방식·주의사항 (검증된 교훈 — 반드시 지킬 것)

- **커밋·태그는 하지 않는다.** Merlin이 직접 한다. `git add`도 세션에서 막히니 시도하지 않는다.
- **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 **절대 경로로 직접 실행**한다 (python3 경유·env 접두어 금지). "This command requires approval"로 막히면 우회하지 말고 Merlin에게 보고하고 멈춘다. 배포는 직렬로만 한다.
- **로컬 검증**: `npx wrangler dev --local`은 `--local`이 `dev` 바로 뒤에 와야 한다. 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/..."`로 한 URL씩. 셸 반복문(`for`/`until`)/포그라운드 `sleep`은 승인 대기로 막히니, 긴 대기는 `sleep N`을 백그라운드로 돌리고 깨어난 뒤 curl 1회로 확인한다. 셸 변수·`tee`·`sort`·`diff` 파이프는 막히니 값을 명령에 직접 쓴다. 예외: `S=$(cat <비밀 파일>); curl -H "x-admin-secret: $S" <URL>` 한 개는 된다.
- **비밀**: `X-Admin-Secret` 값은 `~/workspace/user` 안의 비밀 파일에서 읽는다 (`--add-dir /home/hatch/workspace/user`를 함께 줬다). 값을 채팅·파일·커밋에 적지 않는다.
- **마이그레이션**: 원격 적용 전 `migrations list --remote`로 미적용 목록을 확인한다. wrangler 4 출력이 D1 id를 preview id로 잘못 표시하지만 실제 바인딩은 운영 DB이다 — 표시만의 문제이다.
- **건드리지 말 파일**: `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`. `src/index.ts`의 V1+V2 3곳·15분 크론·큐 소비자는 건드리지 않는다 (P1에서 `index.ts` 변경은 필요 없다).
- **tail JSON은 들여쓰기가 있다**: `"outcome": "ok"`처럼 콜론 뒤에 공백이 있다.
- 결과 파일에 커밋에서 뺄 파일 목록(하네스 state·dev.log·dry-run 산출물)을 적어 둔다.
