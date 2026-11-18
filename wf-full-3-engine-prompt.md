# WF-3 프롬프트 — 워크플로우 실행 엔진

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.1.3 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-3행 + WF-1/WF-2 산출물(`src/workflow/types.ts`, `store.ts`, `routes.ts`, `nodes.ts` — `executeNode`, `NODE_REGISTRY`, `APPROVAL_REQUIRED_NODES`, `NodeContext.approved?`) + WF-2 검증 문서(`/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf2/RESULT.md`의 "설계 메모" — 특히 `ctx.stepOutputs` 형태, `send_email` 검증 순서, `reflect_*`의 reflections 행 저장을 먼저 읽을 것).
> 모델: Opus. 이 세션은 실행 엔진만 만든다. 승인/거절 HTTP API(WF-4), UI(WF-5)는 **하지 않는다**. 새 마이그레이션을 만들지 않는다 (0027 스키마 그대로).
> **주의: `src/index.ts`를 만진다.** 큐 디스패치(`queue()`, `processPipelineMessage` 부근, ~1815-1944행)와 `scheduled()`(~1889행)만 최소한으로 고친다. 기존 메시지 타입(transcript-pipeline, build-tree, eval-item)의 동작은 절대 바꾸지 않는다.

## 목표

워크플로우 run을 단계마다 큐 메시지 1개씩 직렬로 실행하는 엔진을 만든다. 멱등성·재시도·캡·승인 멈춤·정체 run 청소를 포함한다. 이 세션이 끝나면 `POST /api/workflows/:id/runs`로 만든 run이 실제로 단계들을 순서대로 돌고, `send_email` 단계에서 멈추고, 승인하면 이어간다.

## 할 일

### 1. 큐 메시지 타입 + 디스패치 (`src/index.ts`)

- 새 메시지 타입을 추가한다:
  ```ts
  type WorkflowStepMessage = { type: "workflow-step"; runId: string; stepIndex: number; approved?: boolean; enqueuedAt: string; };
  ```
  `QueueMessage` 유니온에 `| WorkflowStepMessage`를 추가한다.
- `queue()` 핸들러에서 `msg.body.type === "workflow-step"`이면 엔진의 `processWorkflowStep(env, msg.body)`를 부른다. 기존 타입의 분기는 그대로 둔다.
- WF-1이 `routes.ts`의 `POST /:id/runs`에 남긴 TODO를 찾아서, run 생성 직후 첫 단계 메시지를 큐에 넣게 배선한다: `await c.env.PIPELINE.send({ type: "workflow-step", runId, stepIndex: 0, enqueuedAt: new Date().toISOString() })`. PIPELINE.send가 실패하면 run은 `queued`로 남고, 정체 청소(WF-3의 sweep)가 60분 뒤 `failed`로 정리한다 — 이 동작을 주석에 적는다.

### 2. 엔진 `src/workflow/engine.ts`

export할 함수:

- `processWorkflowStep(env, msg: WorkflowStepMessage): Promise<void>` — 큐 소비자가 부른다. 흐름:
  1. run 조회 (`workflow_runs` by runId). 없으면 조용히 return (이미 삭제된 run의 늦은 메시지).
  2. run이 `cancelled`/`succeeded`/`failed`면 return (늦은 메시지 무시).
  3. run이 `waiting_approval`인데 `msg.approved`가 아니면 return (승인 없이 재개 금지).
  4. 경과 시간 체크: `started_at`으로부터 30분 초과 시 run을 `failed`로 바꾸고 return.
  5. 워크플로우 정의 조회 (owner는 run.owner_id). 단계 정의는 `definition.steps[msg.stepIndex]`. 없으면 run을 `failed`로 바꾸고 return.
  6. **멱등성/점유(claim)**: `workflow_run_steps`에 (runId, stepIndex) 행이 `succeeded`면 저장된 출력을 쓰고 바로 다음 단계로 간다 (재전달). 행이 없으면 `pending`으로 삽입한다. 그 다음 `UPDATE workflow_run_steps SET status='running', started_at=... WHERE run_id=? AND step_index=? AND status IN ('pending','failed')`를 실행한다. 바뀐 행이 0개면 다른 전달이 이미 처리 중이므로 return (중복 실행 방지). 큐는 at-least-once라 메시지가 두 번 올 수 있다.
  7. **승인 게이트**: 단계의 `requiresApproval`이 true이거나 타입이 `APPROVAL_REQUIRED_NODES`에 있으면, `msg.approved`가 true가 아닐 때 `requestWorkflowApproval(env, {runId, workflowId, stepIndex, nodeType, nodeName, summary})`를 부르고 (아래 §3) run을 `waiting_approval`로 바꾸고 return 한다. **다음 단계 메시지를 보내지 않는다.** (`send_email` 노드 자체도 `ctx.approved`를 확인하지만, 엔진이 1차 방어선이다.)
  8. **LLM 호출 캡**: 이 run의 `workflow_run_steps`에서 LLM 노드 타입(`ask_rag`, `ask_personal`, `summarize`, `reflect_coach`, `reflect_coachee`, `llm`, `email_draft`) 행 수를 센다. 30개 이상이면 run을 `failed`(error: "LLM 호출 상한(30회)에 도달")로 바꾸고 return.
  9. `NodeContext`를 만든다: `env`, `user`(run.owner_id로 users 조회 — id, email, name, role, coaching_role), `runId`, `workflowId`, `stepIndex`, `input`(run.input_json 파싱), `stepOutputs`(앞 단계들의 `output_json`을 단계 id 키로 모은 것), `approved: msg.approved === true`. `executeNode(step.type, ctx, step.config)`를 부른다.
  10. 결과를 `workflow_run_steps`에 기록한다 (status, output_json, error, finished_at). `run.current_step`을 갱신한다.
  11. 성공이면: 다음 단계가 있으면 `PIPELINE.send({type:"workflow-step", runId, stepIndex: stepIndex+1, ...})`. 마지막 단계면 run을 `succeeded`로 바꾸고 `output_json`에 마지막 출력을 넣고 `finished_at`을 찍는다.
  12. 실패(`status:'failed'`)면: run을 `failed`로 바꾸고 error를 넣고 `finished_at`을 찍는다. **throw하지 않는다** — 큐 재시도는 같은 메시지를 다시 줘서 claim이 `failed`→`running`으로 다시 실행하게 한다 (일시적 오류는 재시도로, 영구적 오류는 3회 후 DLQ로 간다. 기존 파이프라인과 같은 방식).
  13. `waiting_approval` 결과(`send_email` 노드가 돌려준 경우)면: run을 `waiting_approval`로 바꾸고 return (다음 단계 메시지 없음). (엔진 §7이 먼저 걸러주므로 이 경로는 2차 방어선이다.)
- `resumeWorkflowRun(env, runId): Promise<{ok:boolean; error?:string}>` — WF-4의 승인 API가 부른다. run이 `waiting_approval`이면 `running`으로 바꾸고 현재 단계 메시지를 `approved:true`로 큐에 넣는다. 다른 상태면 `{ok:false}`.
- `cancelWorkflowRun(env, runId): Promise<{ok:boolean}>` — WF-4의 거절 API가 부른다. run이 `waiting_approval`이면 `cancelled` + `finished_at`로 바꾼다.
- `sweepStaleWorkflowRuns(env): Promise<{failed:number; cancelled:number}>` — `queued`/`running`인데 `started_at`이 60분 넘은 run은 `failed`(error "실행 시간 초과(60분)")로, `waiting_approval`인데 7일 넘은 run은 `cancelled`로 바꾼다. 오래된 run이 많으면 한 번에 100개까지만 처리한다.

### 3. 승인 요청 `src/workflow/approvals.ts`

- `requestWorkflowApproval(env, req: ApprovalRequest): Promise<void>` — `notifications` 테이블에 행을 만든다 (`migrations/0024_approval.sql`의 스키마 확인: id, user_id, type, ref_type, ref_id, title, body, link, read_at, emailed_at, created_at). 값: `user_id` = run 소유자, `type` = `'WORKFLOW_APPROVAL'`, `ref_type` = `'workflow_run'`, `ref_id` = runId, `title` = `"워크플로우 승인 요청: <워크플로우 이름> — <단계 이름>"`, `body` = 노드 종류 + 요약, `link` = `/#workflow/<workflowId>?run=<runId>` (**이 링크 형식을 RESULT.md에 적는다. WF-5 UI가 이 해시를 지원해야 한다**).
- 같은 (runId, stepIndex)에 대한 승인 요청이 이미 있으면 중복 삽입하지 않는다 (멱등).

### 4. 속도 제한 (KV 가드, `src/workflow/engine.ts`에 두고 routes에서 호출)

- `checkWorkflowRateLimit(env, userId): Promise<{ok:true} | {ok:false; reason:string}>` — KV 사용:
  - 동시 실행: `queued`/`running`/`waiting_approval` 상태인 run이 사용자당 3개 이하면 통과, 초과면 `{ok:false, reason:'동시 실행 상한(3개)'}`.
  - 일일 실행: KV 키 `wf:rl:<userId>:<YYYY-MM-DD>` 카운터, 20회 이하면 통과 후 +1 (TTL 24시간), 초과면 `{ok:false, reason:'하루 실행 상한(20회)'}`.
- `routes.ts`의 `POST /:id/runs`에 이 가드를 연결한다 (초과 시 429 + reason). 가드가 KV 오류로 실패하면 **통과시킨다** (fail-open, 기존 ask 레이트 리밋과 같은 원칙).

### 5. 정체 청소 배선 (`src/index.ts` `scheduled()`)

- `EVAL_CRON` 분기 안에 `ctx.waitUntil(sweepStaleWorkflowRuns(env))`를 추가한다 (평가 크론이 돌 때 함께 청소 — 평가의 "정체 실행 청소"와 같은 자리). 다른 크론 분기는 건드리지 않는다.

## 제약

- 새 마이그레이션 없음. 0027 스키마 그대로.
- `send_email` 노드·`nodes.ts`·`types.ts`의 동작을 바꾸지 않는다 (필요하면 `types.ts`에 `WorkflowStepMessage` 타입만 추가해도 된다 — `src/index.ts`에 두는 것이 나으면 그리 한다).
- 기존 큐 메시지 타입의 디스패치를 바꾸지 않는다. `processPipelineMessage`의 기존 분기는 그대로 둔다.
- 비밀번호·토큰·시크릿을 파일에 쓰지 않는다.

## 검증 (반드시 수행하고 결과를 기록할 것)

1. `npx tsc --noEmit` 통과.
2. 로컬 하네스 (WF-2와 같은 방식: 임시 Worker + 로컬 D1/R2/KV, AI는 mock). 산출물은 goal 루트 `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf3/` 아래에 둔다 (`RESULT.md` + 스크립트). **WF-1처럼 `files/people-os/files/...` 아래에 두지 않는다.**
   - 성공 체인: `llm` → `create_task` → `llm` 3단계 워크플로우를 run하면 3단계 전부 succeeded, run succeeded, 출력이 다음 단계에 전달됨 (`{{steps.s1.output.text}}` 치환 확인).
   - 실패: 두 번째 단계가 실패하는 워크플로우 → run failed, 세 번째 단계는 실행 안 됨.
   - 멱등성: 같은 step 메시지를 두 번 보내면 단계가 한 번만 실행됨 (예: `create_task`가 1개만 생김).
   - 승인 멈춤·재개: `send_email` 단계에서 run이 `waiting_approval`이 되고 알림 행 1개가 생김. `resumeWorkflowRun`을 부르면 이어져서 다음 단계까지 감. `cancelWorkflowRun`을 부르면 cancelled.
   - 캡: started_at을 31분 전으로 만든 run은 failed. LLM 노드 30개 초과 run은 failed.
   - 속도 제한: 동시 3개 초과 429, 하루 20회 초과 429 (KV 카운터로 확인).
   - sweep: 오래된 queued run → failed, 오래된 waiting_approval → cancelled.
   - 회귀: 기존 메시지 타입(transcript-pipeline, build-tree)이 여전히 정상 디스패치됨 (코드 경로 확인 + 가능하다면 기존 파이프라인 하네스 1건).
   - dev 서버가 포트를 잡고 있으면 `ss`로 pid를 확인해 kill한다. `pkill -f`는 쓰지 않는다.
3. 하네스 마지막에 테스트 데이터를 정리한다.

## 산출물

- `src/workflow/engine.ts`, `src/workflow/approvals.ts`
- `src/index.ts` 최소 변경 (QueueMessage 유니온 + queue() 분기 + scheduled() sweep 1줄)
- `src/workflow/routes.ts` 최소 변경 (첫 단계 enqueue + 속도 제한 가드)
- `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf3/RESULT.md` (검증 결과 + 알림 link 형식 명시 + 미검증 항목)

마지막에 무엇을 만들었고, 무엇을 검증했고(통과 수), 미검증 항목과 WF-4가 이어받을 지점(`resumeWorkflowRun`/`cancelWorkflowRun` 위치, 알림 link 형식)을 요약해서 보고할 것.
