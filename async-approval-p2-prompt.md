# 비동기 승인 + 시뮬레이션 P2 프롬프트 (Opus 5.5 단일 세션)

## 배경

P1이 끝났다(끝나지 않았다면 이 프롬프트를 실행하지 말 것 — 먼저 P1-RESULT.md를 확인할 것). P1에서 만든 것: `workflow_pending_actions` 테이블(마이그레이션 0042), 노드 시뮬레이션(`NodeContext.deferActions`, `send_email`·`webhook`이 지연 모드에서 대기 동작 행을 넣고 시뮬레이션 출력을 돌려준다), 엔진 지연 경로(단계의 `approvalMode === "deferred"`이면 멈추지 않고 `deferActions: true`로 실행하고 다음 단계로 간다).

**P2 범위 = 설계 원본(`think-cloudflare-os-adoption-plan.md` §3.1) 항목 4·5: 에이전트 경로 지연 + 승인 결정 API + 큐 소비자.** 항목 6(UI)은 P3이므로 건드리지 않는다.

## 먼저 읽을 것

- `files/workflow-verify/async-approval/P1-RESULT.md`와 실제 코드. **P1의 테이블·컬럼·id 규칙(`wfpa_<runId>_<stepIndex>[_t<turn>]`)·상태 값이 이 프롬프트와 다르면 실제 코드를 따른다.** 다르면 P2-RESULT.md에 적는다.
- `src/workflow/agent.ts`(legacy 에이전트 루프), `src/workflow/think-agent.ts`(Think 에이전트), `src/workflow/agent-do.ts`(ThinkAgent DO, `pendingAction` 저장소), `src/workflow/engine.ts`의 `agentHooks`, `src/index.ts`의 큐 소비자(`queue()`).

## P2 범위 (이것만 한다)

### 1. 에이전트 경로 지연 (항목 4)

**대상은 `approvalMode === "deferred"`인 agent 단계뿐이다.** 동기식 agent 단계는 지금과 똑같이 동작해야 한다(멈추고 `waiting_approval`, 승인 뒤 재개).

**(a) Legacy 에이전트 루프 (`src/workflow/agent.ts`)**
- 현재: `gated(r.tool)`이면 DO에 `/pending`으로 저장하고 `hooks.pause(...)`를 불러 run을 `waiting_approval`로 멈춘다 (`agent.ts:136` 부근).
- 지연 모드에서는: 대기 동작 행을 `workflow_pending_actions`에 넣고(멱등 id `wfpa_<runId>_<stepIndex>_t<turn>`, `turn = r.turn`, `args_json` = 치환이 끝난 최종 인자 `r.args`, `simulated_output_json` = 시뮬레이션 출력), 관찰에 `"(승인 대기열에 넣음 — 승인되면 실행됩니다)"`를 적고, 멈추지 않고 다음 턴으로 간다(`hooks.requeue(r.nextTurn)` — `invalid`·`replay` 분기가 이미 쓰는 방식).
- 시뮬레이션 출력: P1의 노드 시뮬레이션과 같은 모양(`send_email` → `{ providerId: null, simulated: true, pendingActionId, to, subject }`, `webhook` → `{ status: null, ok: null, simulated: true, pendingActionId, method, url }`). 노드를 직접 부를 때는 `deferActions: true`로 `executeNode`를 부르는 방식을 우선 검토한다(검증·SSRF 검사가 노드 안에 있으므로). 단, agent 루프의 `runTool`이 `approved`만 받는 구조라면 노드 호출 전에 검증이 빠지지 않게 할 것 — 검증 실패는 대기 동작을 만들지 않고 도구 실패로 처리한다.
- DO의 `/pending`·`/take-pending` 저장소는 동기식 경로 전용으로 남긴다. 지연 모드에서는 쓰지 않는다.

**(b) Think 에이전트 (`src/workflow/think-agent.ts`, `src/workflow/agent-do.ts`)**
- 현재: `beforeToolCall`이 gated 도구(`APPROVAL_REQUIRED_NODES` 또는 `job.gatedAll`)를 차단하고 저장소에 `pending`을 남긴 뒤 `setStop("approval_required")`로 턴을 끝낸다. 엔진은 `agentHooks.pause`로 run을 `waiting_approval`로 멈춘다. 시스템 프롬프트 규칙 (e): "승인 대기라는 결과를 받으면 다시 부르지 말고 멈춘다."
- 지연 모드에서는(단계의 `approvalMode === "deferred"` — job이 단계 config를 들고 있는지 확인하고, 안 들고 있으면 `advanceThinkAgentStep`에서 job에 넘긴다):
  - `beforeToolCall`에서 gated 도구를 차단하지 않는다. `pending` kvPut도, `setStop("approval_required")`도 하지 않는다.
  - `runTool`에서 gated 도구를 `deferActions: true`로 `execNode`에 넘긴다(2차 방어 `approved:false`는 동기식일 때만). 노드의 시뮬레이션이 대기 동작 행을 넣고 시뮬레이션 출력을 돌려준다. 도구 결과를 모델에 돌려줄 때는 **"대기열에 넣었습니다. 아직 실행되지 않았습니다. 승인되면 실행됩니다."라는 뜻이 분명한 결과**를 준다. 모델이 같은 동작을 다시 부르지 않게 하고, 최종 답에 "보냈습니다/호출했습니다"라고 쓰지 않게 한다.
  - 시스템 프롬프트 규칙 (e)는 동기식에만 적용되게 고친다. 지연 모드에서는 "대기열에 넣었다는 결과를 받으면 같은 동작을 다시 부르지 말고 턴을 계속한다. 최종 답에서는 아직 실행되지 않았다고 말한다."는 뜻으로 바꾼다. 규칙 (e)의 동기식 문구는 그대로 둔다.
  - `stop === "approval_required"`일 때 `{ status: "approval", ... }`를 돌려주는 턴 종료 분기는 동기식 전용으로 남긴다. 지연 모드에서는 이 분기에 닿지 않아야 한다.
- `agent-do.ts`의 `pendingAction` 저장소·`/pending`·`/take-pending`은 동기식 경로 전용으로 남긴다. 지연 모드에서는 쓰지 않는다.
- **에이전트에게 "완료됐다"고 하지 않는다(안전 규칙).** 도구 결과·관찰·최종 답의 어느 곳에서도 아직 나가지 않은 메일을 보냈다고 말하지 않는다. 시뮬레이션 출력의 `simulated: true`가 모델·화면에 그대로 보이게 한다.

### 2. 승인 결정 API (항목 5, `src/workflow/routes.ts`)

- `GET /api/workflows/pending-actions` — 본인의 대기 동작 목록. 본인 것만 본다(남의 것은 404가 아니라 목록에서 안 보인다). `hr_admin`은 전부 볼 수 있다. `status`·`run_id` 필터와 최신순 정렬을 둔다. 응답에는 각 행의 `id, run_id, step_index, node_type, args 요약(to/subject 또는 method/url), simulated_output, status, created_at, decided_at, executed_at`을 담는다. (P3 UI가 이 API를 쓴다.)
  - **웹훅 헤더 값 가리기 (P1 인계)**: `args_json`에는 웹훅 헤더 값이 원본 그대로 들어 있다(P1이 실행을 위해 저장함). 승인함 응답에서는 헤더 **값**을 가리고 키만 보여준다(공유 경로 `redactShared`와 같은 원칙). 실행에는 원본 값을 쓴다. 메일 본문(`body`)도 응답에는 요약만 싣는다(전문을 그대로 내보내지 않는다).
- `POST /api/workflows/pending-actions/decide` — 본문 `{ ids: string[], action: "approve" | "reject" }`. id마다: 본인 것이 아니면 404(존재 여부를 흘리지 않는다 — 남의 id는 없는 id와 같이 취급한다). `status === "queued"`인 행만 결정할 수 있다(이미 결정된 행은 409로 개별 결과에 적는다).
  - 승인: `queued → approved` 조건부 UPDATE + `decided_at`, 그 뒤 큐에 `workflow-action` 메시지를 넣는다(`{ type: "workflow-action", pendingActionId }` — 아래 3번). 행마다 결과를 돌려준다(`{ id, status }`).
  - 거절: `queued → rejected` + `decided_at`. 실행하지 않는다. (거절은 뒤 단계를 되돌리지 않는다 — P1에서 이미 실행된 뒤 단계는 그대로이다.)
- 동기식 승인 API(`POST /runs/:runId/approve|reject`, `resumeWorkflowRun`, `cancelWorkflowRun`)는 건드리지 않는다.

### 3. 큐 소비자 (항목 5, `src/index.ts`)

- 큐 메시지 유니온에 `workflow-action`을 추가하고 `queue()` 소비자 분기를 만든다. 큐는 기존 `PIPELINE`(people-os-pipeline)을 쓴다.
- 소비자 동작:
  1. 행을 읽는다. 없으면 끝낸다. `status !== "approved"`이면 실행하지 않고 끝낸다(방어).
  2. `approved → executing` 조건부 UPDATE로 점유한다. 0행이면 이미 다른 전달이 점유했거나 실행했으므로 끝낸다(큐 at-least-once 재전달에도 1회만 실행된다).
  3. 실행자는 run 소유자이다. `users`에서 소유자를 다시 읽고 `status = 'active'`인지 확인한다(엔진 9번과 같은 조건). 비활성이면 행을 `failed` + `error`로 남기고 끝낸다.
  4. `executeNode(type, { ...ctx, approved: true }, args)`를 부른다. `ctx`는 `runId, workflowId, stepIndex, user, input: {}, stepOutputs: {}`를 갖춘다. `args`는 행의 `args_json`이다. **이미 치환된 args 그대로 실행한다** (P1 인계): `resolveVars`를 다시 돌려도 `{{`가 없어 무해하지만, `stepOutputs` 없이 돌리므로 치환을 기대하면 안 된다. 노드가 검증·SSRF 검사를 다시 하므로(같은 노드 함수) 추가 작업은 없다.
  5. 노드 결과가 `succeeded`면 `executed` + `result_json` + `executed_at`. 노드가 `failed`를 돌려주면 `failed` + `error`(재큐하지 않는다 — 사용자는 승인함에서 에러를 보고 다시 결정한다). D1 자체가 죽는 등의 엔진 예외는 throw해서 큐 재시도에 맡긴다.
- `workflow-action` 메시지는 `workflow-step` 메시지와 별개이다. `processWorkflowStep`을 부르지 않는다.

## 건드리지 말 것

- **UI 일절**: `public/workflow.js`, `public/approval.js`, `public/index.html` — P3이다.
- **동기식 승인 경로**: `pauseForApproval`, `requestWorkflowApproval`, `resumeWorkflowRun`, `cancelWorkflowRun`, `POST /runs/:runId/approve|reject`, legacy·Think 에이전트의 동기식 차단·정지 분기는 지금과 똑같이 동작해야 한다.
- **P1 결과물**: `workflow_pending_actions` 스키마·노드 시뮬레이션·엔진 지연 경로·`validateDefinition`의 지연 거부 규칙은 바꾸지 않는다(버그가 있으면 P2-RESULT.md에 적고 최소한만 고친다). 단, 한 가지는 P2 범위이다: **`validateDefinition`의 approvalMode 허용 타입에 `agent`를 추가한다** (P1은 agent를 거부했다. P1의 `pendingActionId(runId, stepIndex, turn)` 헬퍼에 `_t<turn>` 자리가 이미 있다). agent 단계에도 지연 거부 규칙 (i)(뒤 단계가 그 단계 출력을 참조하면 거부)를 그대로 적용한다. 규칙 (ii)(GET 웹훅)는 agent와 무관하다.
- **질문 경로·평가·관측·채팅·화상회의·캘린더·이메일·결재·LMS**: 건드리지 않는다.
- **템플릿**: P2에서 템플릿 정의를 바꾸지 않는다.

## 통과 기준

1. `npx tsc --noEmit` 오류 0.
2. 로컬 하네스 (새 폴더 `files/workflow-verify/async-approval/p2-harness/`, `wrangler dev --local` + 로컬 D1에 0001~0042 전부 적용): 아래 항목 전부.
   - **Legacy agent 지연**: `approvalMode: "deferred"`인 agent 단계가 `send_email`을 고르면 → run이 멈추지 않고 끝까지 간다(`succeeded`), 대기 동작 행 1개(`status queued`, `turn` 있음, `args_json` = 최종 인자), 실제 발송 0건, 관찰에 "(승인 대기열에 넣음 — 승인되면 실행됩니다)"가 있다.
   - **Think agent 지연**: 같은 시나리오를 Think 런타임으로 → run 완료, 대기 동작 행 1개, 실제 발송 0건, 턴이 `approval` 상태로 끝나지 않는다. 모델의 최종 답에 "보냈습니다"가 없다(관찰·턴 기록으로 확인).
   - **동기식 agent 불변**: `approvalMode` 없는 agent 단계가 `send_email`을 고르면 → 지금처럼 run이 `waiting_approval`로 멈추고, 승인하면 그 도구가 실행되고 run이 이어진다.
   - **결정 API 승인 → 실제 실행**: 지연으로 쌓인 동작 1건을 `decide`로 승인 → 큐 소비자가 실제 실행한다(웹훅은 로컬 캡처 엔드포인트로 fetch가 닿는 것으로 확인, 메일은 `emails` 행으로 확인). 행이 `executed` + `result_json` 있음.
   - **결정 API 거절**: 승인하지 않은 동작은 실행되지 않고 `rejected`가 된다.
   - **일괄 결정**: 2건을 한 번에 승인하면 둘 다 실행된다. 1건 승인·1건 거절도 각각 처리된다.
   - **권한**: 남의 동작 id로 `decide`를 부르면 404(목록에도 안 보인다). `hr_admin`은 볼 수 있다.
   - **중복 승인**: 같은 동작을 두 번 승인하면 실행은 1회만 일어난다(두 번째 decide는 409, 소비자의 조건부 UPDATE도 1회만 점유).
   - **비활성 소유자**: 소유자를 비활성으로 바꾼 뒤 승인하면 소비자가 실행하지 않고 행이 `failed`가 된다.
   - **검증 우선**: agent가 주소를 틀리게 불러도 대기 동작은 안 생기고 도구 실패로 처리된다.
3. D1 마이그레이션: **없다** (P2는 테이블을 추가하지 않는다). `migrations list --remote`로 0042까지 적용됨을 확인만 한다.
4. 라이브 배포 + 스모크: 배포 전후 기존 엔드포인트 응답이 의도한 변화 외에는 같아야 한다. 새 API 2개(`GET /api/workflows/pending-actions`, `POST /api/workflows/pending-actions/decide`)는 비로그인 시 401이다. 배포 직후 약 2분은 옛 버전이 응답하니 스모크는 3분 뒤에 한다.
5. 결과 파일 `files/workflow-verify/async-approval/P2-RESULT.md` 작성: 판정 표, 구현한 파일 목록, 하네스 항목별 증거, 라이브 버전·스모크 결과, 남은 문제, P3에 넘길 것(결정 API 응답 모양·행 필드).

## 작업 방식·주의사항 (검증된 교훈 — 반드시 지킬 것)

- **커밋·태그는 하지 않는다.** Merlin이 직접 한다. `git add`도 세션에서 막히니 시도하지 않는다.
- **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 **절대 경로로 직접 실행**한다 (python3 경유·env 접두어 금지). "This command requires approval"로 막히면 우회하지 말고 Merlin에게 보고하고 멈춘다. 배포는 직렬로만 한다.
- **로컬 검증**: `npx wrangler dev --local`은 `--local`이 `dev` 바로 뒤에 와야 한다. 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/..."`로 한 URL씩. 셸 반복문(`for`/`until`)/포그라운드 `sleep`은 승인 대기로 막히니, 긴 대기는 `sleep N`을 백그라운드로 돌리고 깨어난 뒤 curl 1회로 확인한다. 셸 변수·`tee`·`sort`·`diff` 파이프는 막히니 값을 명령에 직접 쓴다. 예외: `S=$(cat <비밀 파일>); curl -H "x-admin-secret: $S" <URL>` 한 개는 된다.
- **비밀**: `X-Admin-Secret` 값은 `~/workspace/user` 안의 비밀 파일에서 읽는다 (`--add-dir /home/hatch/workspace/user`를 함께 줬다). 값을 채팅·파일·커밋에 적지 않는다.
- **건드리지 말 파일**: `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`. `src/index.ts`의 V1+V2 3곳·15분 크론은 건드리지 않는다 (큐 소비자 분기 추가만 한다).
- **tail JSON은 들여쓰기가 있다**: `"outcome": "ok"`처럼 콜론 뒤에 공백이 있다.
- 결과 파일에 커밋에서 뺄 파일 목록(하네스 state·dev.log·dry-run 산출물)을 적어 둔다.
