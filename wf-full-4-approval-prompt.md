# WF-4 프롬프트 — 승인 게이트 API

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.1.3(승인 게이트) + `workflow-agent-builder-FULL-PLAN.md` §2 WF-4행 + WF-3 산출물(`src/workflow/engine.ts`의 `resumeWorkflowRun`/`cancelWorkflowRun`, `src/workflow/approvals.ts`의 `requestWorkflowApproval`, `src/workflow/store.ts`의 `getRun`) + WF-3 검증 문서(`/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf3/RESULT.md` — "WF-4가 이어받을 것" 부분을 먼저 읽을 것).
> 모델: Sonnet. 이 세션은 승인/거절 API만 만든다. UI(WF-5)는 **하지 않는다**. 새 마이그레이션 없음. 엔진(`engine.ts`)·노드의 동작을 바꾸지 않는다.

## 목표

`waiting_approval` 상태의 run을 사람이 승인하거나 거절하는 HTTP API를 만든다. 승인하면 엔진이 멈춘 단계부터 이어가고, 거절하면 run이 취소된다.

## 할 일

### 1. 승인/거절 API (`src/workflow/routes.ts`에 추가)

`src/auth.ts`의 `getSessionUser`로 세션을 확인한다. 익명은 401, `X-Admin-Secret`만으로는 불가 (WF-1과 같은 원칙).

- `POST /api/workflows/runs/:runId/approve`
  1. `getRun(db, user.id, runId)`로 조회한다. 없으면 **404** (타인 소유도 404 — 존재 은닉). **소유권 검사는 반드시 엔진 함수 호출 전에 한다** (`resumeWorkflowRun`/`cancelWorkflowRun`은 소유권을 검사하지 않는다).
  2. run의 status가 `waiting_approval`이 아니면 **409** (이미 진행 중/완료/취소된 run).
  3. `resumeWorkflowRun(env, runId)`를 부른다. `{ok:false}`면 409.
  4. 해당 승인 알림을 읽음 처리한다: `UPDATE notifications SET read_at = datetime('now') WHERE ref_type='workflow_run' AND ref_id=? AND user_id=? AND read_at IS NULL`.
  5. 200 + `{ok:true, runId, status:'running'}` (재개 후 상태).
- `POST /api/workflows/runs/:runId/reject`
  1. 위와 같은 소유권 확인 (404) + 상태 확인 (409).
  2. `cancelWorkflowRun(env, runId)`를 부른다. `{ok:false}`면 409.
  3. 승인 알림을 읽음 처리한다 (위와 동일).
  4. 200 + `{ok:true, runId, status:'cancelled'}`.
- 두 엔드포인트 모두 본문이 없어도 된다 (POST 빈 본문 허용). 거절 사유는 받지 않는다 (1단계 범위).

### 2. 대기 중인 승인 목록 (기존 알림 API 재사용 확인)

- 먼저 기존 `GET /notifications` (결재 모듈, `src/approval/` 부근)가 `WORKFLOW_APPROVAL` 타입 알림을 그대로 보여주는지 확인한다. 보여주면 새로 만들지 않는다.
- 보여주지 않거나 타입 필터가 없으면, `GET /api/workflows/approvals/pending`을 추가한다: 내 `waiting_approval` run 목록 (워크플로우 이름·단계 이름·요청 시각 포함, 최신순 최대 50). WF-5 UI가 이 엔드포인트를 쓴다.
- 어느 쪽이든 RESULT.md에 어떤 방식을 택했는지 적는다.

## 제약

- `engine.ts`·`approvals.ts`·`nodes.ts`를 바꾸지 않는다. `routes.ts`에만 엔드포인트를 추가한다.
- `src/index.ts`를 건드리지 않는다 (마운트는 WF-1에서 이미 됨).
- 비밀번호·토큰·시크릿을 파일에 쓰지 않는다.

## 검증 (반드시 수행하고 결과를 기록할 것)

1. `npx tsc --noEmit` 통과.
2. 로컬 하네스 (WF-2·WF-3과 같은 방식: 임시 Worker + 로컬 D1/R2/KV, AI는 mock). 산출물은 goal 루트 `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf4/` 아래에 둔다 (`RESULT.md` + 스크립트).
   - 승인 경로: `llm` → `send_email`(승인 필요) → `create_task` 워크플로우를 run → `waiting_approval`에서 멈춤 + 알림 1건 → 승인 API → run이 이어져서 `succeeded`, task 1개 생성됨, 알림이 읽음 처리됨.
   - 거절 경로: 같은 워크플로우를 다시 run → `waiting_approval` → 거절 API → run `cancelled`, task 생성 안 됨, 알림 읽음 처리됨.
   - 소유권: 타인(B)이 승인/거절을 부르면 404, run 상태는 그대로.
   - 상태 오류: `running`/`succeeded`/`cancelled` run에 승인/거절을 부르면 409.
   - 이중 승인: 승인 후 다시 승인하면 409 (두 번째는 상태가 이미 바뀜).
   - 익명 승인 → 401.
   - (엔드포인트를 새로 만든 경우) 대기 목록에 위 run이 뜨고, 승인 후 목록에서 사라지는지 확인.
   - dev 서버가 포트를 잡고 있으면 `ss`로 pid를 확인해 kill한다. `pkill -f`는 쓰지 않는다.
3. 하네스 마지막에 테스트 데이터를 정리한다.

## 산출물

- `src/workflow/routes.ts`에 승인/거절 엔드포인트 추가 (+ 필요 시 대기 목록 엔드포인트)
- `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/workflow-verify/wf4/RESULT.md` (검증 결과 + 대기 목록 방식 + 미검증 항목)

마지막에 무엇을 만들었고, 무엇을 검증했고(통과 수), WF-5가 이어받을 지점(승인 API 경로, 대기 목록 조회 방식, 알림 link 형식 `/#workflow/<workflowId>?run=<runId>`)을 요약해서 보고할 것.
