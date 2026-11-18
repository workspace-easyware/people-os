# WF-1 프롬프트 — 워크플로우 데이터 모델 + CRUD/실행 API + 공용 타입

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: 같은 디렉터리의 `workflow-agent-builder-proposal.md`(제안서) + `workflow-agent-builder-FULL-PLAN.md`(전체 계획, §1·§2 WF-1행)를 먼저 읽을 것.
> 모델: Sonnet. 이 세션은 데이터 모델과 API만 만든다. 실행 엔진(WF-3), 노드 구현(WF-2), 승인 게이트(WF-4), UI(WF-5)는 **하지 않는다**.

## 목표

워크플로우 빌더의 뼈대를 만든다. D1 테이블 3개(마이그레이션 0027) + 워크플로우 CRUD/실행 API + 뒤따르는 세션(WF-2 노드, WF-3 엔진)이 함께 쓸 공용 타입·변수 치환·D1 헬퍼. 이 세션이 끝나면 사용자는 워크플로우를 만들고, 조회하고, 실행(run 행 생성)까지 할 수 있다. 실제 단계 실행은 WF-3에서 붙는다.

## 할 일

### 1. 마이그레이션 `migrations/0027_workflows.sql`

제안서 4.1.1의 SQL을 그대로 쓴다. 단, `CREATE TABLE`에는 `IF NOT EXISTS`를 붙인다 (로컬 재적용 안전). 테이블 3개:

- `workflows` (id, owner_id, name, description, status draft|active|paused, definition_json, created_at, updated_at) + `idx_workflows_owner`
- `workflow_runs` (id, workflow_id, owner_id, status queued|running|waiting_approval|succeeded|failed|cancelled, input_json, output_json, current_step, error, started_at, finished_at) + `idx_runs_owner`, `idx_runs_workflow`
- `workflow_run_steps` (id INTEGER PK AUTOINCREMENT, run_id, step_index, node_type, node_name, status pending|running|succeeded|failed|skipped, input_json, output_json, error, started_at, finished_at, UNIQUE(run_id, step_index)) + `idx_run_steps_run`

### 2. 공용 타입 `src/workflow/types.ts`

뒤 세션이 이 파일을 import해서 쓴다. 반드시 export할 것:

```ts
// 노드 종류 12개 (제안서 4.1.4) — WF-2가 이 목록대로 구현한다
export const NODE_TYPES = ['ask_rag','ask_personal','transcribe','summarize','reflect_coach','reflect_coachee','draft_pptx','email_draft','send_email','create_task','llm','create_calendar_event'] as const;
export type NodeType = typeof NODE_TYPES[number];
// 승인 없이 실행하면 안 되는 노드
export const APPROVAL_REQUIRED_NODES: NodeType[] = ['send_email'];

export interface WorkflowStepDef { id: string; type: NodeType; name: string; config: Record<string, unknown>; requiresApproval?: boolean; }
export interface WorkflowDefinition { version: 1; steps: WorkflowStepDef[]; }
export interface NodeContext { env: Env; user: { id: string; email: string; role: string; coaching_role?: string }; runId: string; workflowId: string; stepIndex: number; input: Record<string, unknown>; stepOutputs: Record<string, unknown>; }
export interface NodeResult { status: 'succeeded' | 'failed' | 'waiting_approval'; output?: unknown; error?: string; }
export interface ApprovalRequest { runId: string; workflowId: string; stepIndex: number; nodeType: NodeType; nodeName: string; summary: string; }
```

- `resolveVars(template: unknown, vars: Record<string, unknown>): unknown` — 문자열 안의 `{{input.docId}}`, `{{steps.s1.output.summary}}` 같은 참조를 치환한다. `{{input.*}}`는 run 입력, `{{steps.<stepId>.output.*}}`는 앞 단계 출력에서 찾는다. 없는 경로는 빈 문자열로 두고, 에러를 내지 않는다. 객체·배열은 재귀 치환. 중첩 경로(`a.b.c`)를 지원한다. 복잡한 표현식(`{{a + b}}` 등)은 지원하지 않는다 — 치환만 한다.
- `validateDefinition(def: unknown): { ok: true; def: WorkflowDefinition } | { ok: false; error: string }` — version===1, steps는 배열 1~50개, step마다 id(문자열, 중복 금지)·type(NODE_TYPES 안)·name(빈 문자열 금지)·config(객체). `send_email`은 `requiresApproval`이 true여야 한다 (없으면 검증에서 true로 강제해도 되고, 에러를 내도 된다 — 한 가지를 골라 주석에 적을 것).

### 3. D1 헬퍼 `src/workflow/store.ts`

- `createWorkflow(db, ownerId, {name, description, definition})`, `getWorkflow(db, ownerId, id)` (없거나 타인 소유면 null), `listWorkflows(db, ownerId, {limit})`, `updateWorkflow(db, ownerId, id, patch)`, `deleteWorkflow(db, ownerId, id)` (runs·steps도 함께 삭제).
- `createRun(db, ownerId, workflowId, input)`, `getRun(db, ownerId, runId)` (+ steps 포함 반환), `listRuns(db, ownerId, workflowId, {limit})`, `updateRun(db, runId, patch)`, `upsertRunStep(db, runId, stepIndex, patch)`.
- id 생성은 `src/lib.ts`의 기존 uid 패턴을 재사용할 것 (없으면 `wf_`, `wfrun_` 접두 + Date.now base36 + random).

### 4. 라우트 `src/workflow/routes.ts` (Hono)

`src/auth.ts`의 `getSessionUser`로 세션을 확인한다. **익명은 전부 401. `X-Admin-Secret`만으로는 접근 불가** (캘린더 C1과 같은 원칙). 모든 조회는 `owner_id = 세션 사용자 id`로 거른다. 남의 워크플로우·run id를 직접 쳐서 들어오면 404 (존재 은닉).

- `GET /api/workflows` — 내 워크플로우 목록 (최신순, 최대 100).
- `POST /api/workflows` — {name, description?, definition} 생성. definition은 `validateDefinition`으로 검증, 실패 시 400 + 이유.
- `GET /api/workflows/:id` — 상세 (+ steps 정의 포함).
- `PATCH /api/workflows/:id` — name/description/status/definition 수정. definition 수정 시 재검증.
- `DELETE /api/workflows/:id` — 삭제 (runs·steps 포함).
- `GET /api/workflows/:id/runs` — 해당 워크플로우의 run 목록.
- `POST /api/workflows/:id/runs` — {input?}으로 run 생성 (status `queued`, current_step 0). **실제 단계 실행은 WF-3에서 붙인다 — 이 세션에서는 run 행만 만들고, `PIPELINE.send`를 호출하지 않는다.** 코드에 `// WF-3: 여기서 PIPELINE.send({type:"workflow-step",...})로 첫 단계를 큐에 넣는다`는 TODO 주석을 남길 것.
- `GET /api/workflows/runs/:runId` — run 상세 + steps 배열.
- 본문 상한: definition_json 256KB, input_json 64KB를 넘으면 413.

### 5. 마운트 `src/index.ts`

기존 마운트 패턴(`app.route("/api/calendar", calendarApp)` 부근)에 `app.route("/api/workflows", workflowApp)`를 추가한다. 다른 라우트는 건드리지 않는다. `scheduled()`와 `queue()`는 **건드리지 않는다**.

## 제약

- Workers-only. 새 바인딩·새 큐·새 DO를 만들지 않는다.
- `src/index.ts`의 기존 동작을 바꾸지 않는다. 마운트 1줄만 추가한다.
- 비밀번호·토큰·시크릿을 파일에 쓰지 않는다.
- 기존 마이그레이션 파일은 수정하지 않는다. 0027만 새로 만든다.

## 검증 (반드시 수행하고 결과를 기록할 것)

1. `npx tsc --noEmit` 통과.
2. `npx wrangler d1 migrations apply people-os-db --local` — 0027이 적용되고, 다시 돌려도 에러가 없을 것.
3. 로컬 하네스: `npx wrangler dev --local`을 띄우고, 테스트 사용자로 로그인한 뒤 curl로 왕복 확인할 것 — 워크플로우 생성(정상 + 잘못된 definition 400) → 조회 → 수정 → run 생성 → run 상세 조회 → 삭제. 익명 401, 타인 소유 404도 확인할 것. 하네스 스크립트와 결과는 `files/workflow-verify/wf1/RESULT.md`에 남길 것 (스크립트는 `files/workflow-verify/wf1/` 아래에 둔다. /tmp는 쓰지 않는다 — 런타임 재시작 시 지워진다).
4. 로컬 DB에 남은 테스트 데이터는 하네스 마지막에 정리한다.

## 산출물

- `migrations/0027_workflows.sql`
- `src/workflow/types.ts`, `src/workflow/store.ts`, `src/workflow/routes.ts`
- `src/index.ts` 마운트 1줄
- `files/workflow-verify/wf1/RESULT.md` (검증 결과 + curl 로그 요약)

마지막에 무엇을 만들었고, 무엇을 검증했고(통과 수), WF-3이 이어받을 지점(TODO 위치)을 요약해서 보고할 것.
