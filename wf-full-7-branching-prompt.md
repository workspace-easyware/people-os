# WF-7 프롬프트 — 조건 분기 + 정의 v2 (그래프)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.2.2 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-7행 + WF-1~WF-6 산출물(`src/workflow/{types,store,routes,engine,approvals,nodes,agent,agent-do}.ts`) + 검증 문서(`files/workflow-verify/wf2/RESULT.md`의 "설계 메모" — `resolveVars`·`ctx.stepOutputs` 형태, `wf3/RESULT.md`의 엔진 흐름·claim·LLM 캡, `wf6/RESULT.md`의 설계 메모 — agent 단계의 턴 메시지·D1 점유 방식을 먼저 읽을 것).
> 모델: Sonnet. 이 세션은 **조건 분기만** 만든다. 스케줄(WF-8), 공유(WF-9), 캔버스(WF-10), 관측(WF-11)은 **하지 않는다**. D1 마이그레이션 파일을 만들지 않는다 (정의 v2는 읽기 시 변환 — 스키마 변경 없음). **배포하지 않는다** — D-2에서 코디네이터가 배포·라이브 검증을 한다.
> **주의: `src/index.ts`를 만지지 않는다.** `src/workflow/` 안에서만 고친다. 기존 메시지 타입·`scheduled()`·승인 게이트·에이전트 루프의 동작은 절대 바꾸지 않는다.

## 목표

워크플로우 정의가 선형(일렬)에서 **그래프**가 된다. `condition` 노드가 앞 단계의 출력을 보고 갈림길을 고르고, 엔진이 간선(`next`)을 따라 다음 단계로 간다. 예: "요약에 '연차'라는 말이 있으면 HR 규정 검색으로, 없으면 코칭 질문으로." 이 세션이 끝나면 조건에 따라 다른 경로로 가는 워크플로우가 실제로 돌고, v1(선형) 워크플로우는 그대로 돈다.

## 설계 (제안서 4.2.2 + 코디네이터 확정 — 이 설계를 따른다)

### 1. 정의 v2 — `next` 간선 (`src/workflow/types.ts`)

- `WorkflowStepDef`에 `next?`를 추가한다:
  - 일반 단계: `next?: string` — 다음 단계의 id. 생략하면 배열의 다음 단계 (v1과 같은 동작).
  - `condition` 단계: `next?: { "true": string; "false": string }` — 조건 결과에 따른 다음 단계 id. 둘 다 필수 (한쪽만 있으면 검증 실패).
- `WorkflowDefinition`의 `version`은 **1로 유지한다** (버전 숫자를 올리지 않는다 — v1 정의는 `next`가 없는 v2로 읽는다). 읽기 시 변환: `next`가 없는 단계는 "배열의 다음 단계"로 간주한다. 저장된 JSON은 그대로 둔다 (D1 마이그레이션 불필요).
- **사이클 금지**: 정의는 DAG(방향성 비순환 그래프)여야 한다. `validateDefinition`에서 사이클을 검사한다 (DFS 또는 위상 정렬 — `next` 간선을 따라가며 방문한 단계를 다시 만나면 검증 실패 400, 에러 메시지 "순환 참조"). `next`가 가리키는 단계 id가 없으면 검증 실패 400 ("없는 단계"). `condition` 단계의 `next`가 `{true,false}` 형태가 아니면 검증 실패.
- **50단계 상한은 그대로**: `steps`는 1~50개 (기존 검증 유지). DAG라 각 단계는 run당 최대 1번 실행되므로, WF-3의 claim 메커니즘(`(runId, stepIndex)` 키)이 그대로 동작한다. **루프(사이클)는 만들지 않는다** — 반복이 필요하면 WF-8의 스케줄을 쓴다. 이 결정을 주석 + RESULT.md에 적는다.

### 2. `condition` 노드 (`src/workflow/nodes.ts`)

- 새 노드 타입 `"condition"`을 `NODE_TYPES` + `NODE_REGISTRY`에 추가한다 (에이전트와 달리 일반 노드 — `executeNode`로 실행된다).
- config: `{ source: string, operator: "contains" | "equals" | "not_contains" | "not_equals" | "exists" | "not_exists", value?: string }`.
  - `source`: `{{steps.s1.output.text}}` 같은 템플릿 문자열. 다른 노드 config와 같은 `resolveVars` 규칙으로 치환한다 (WF-6이 agent goal에 적용한 방식). 치환 결과가 없으면 빈 문자열로 본다.
  - `operator`: `contains`/`not_contains`는 부분 문자열, `equals`/`not_equals`는 문자열 동등, `exists`/`not_exists`는 값이 비어 있지 않은지/비어 있는지. `exists`/`not_exists`는 `value`가 없어도 된다. `contains`/`equals` 계열은 `value`가 필수 (없으면 NodeError).
  - 비교는 문자열 기준이다 (숫자·불린은 문자열로 바꿔서 비교 — 이 규칙을 주석에 적는다).
- 출력: `{ matched: boolean, branch: "true" | "false", source: "<치환된 source 값(최대 500자)>" }`. `matched`가 true면 branch는 `"true"`, 아니면 `"false"`.
- `condition` 노드는 LLM을 부르지 않는다 (LLM 캡에 안 잡힌다). 실패하는 경우: `value` 누락, 알 수 없는 operator → NodeError로 단계 실패 (run failed — WF-3 규칙).

### 3. 엔진 — 간선을 따라간다 (`src/workflow/engine.ts`)

- `processWorkflowStep`의 "다음 단계" 로직을 바꾼다 (WF-3의 §11):
  - 현재: 성공하면 `stepIndex + 1`로 다음 메시지를 보낸다.
  - 변경: 성공하면 `resolveNextStep(definition, step, stepOutput)`을 부른다. 이 함수는:
    - 단계에 `next`가 문자열이면: 그 id의 단계 인덱스를 찾는다. 없으면 run을 `failed`(error "없는 단계")로 바꾼다.
    - 단계가 `condition`이고 `next`가 `{true,false}`면: 단계 출력의 `branch`(`"true"`/`"false"`)로 `next[branch]`를 골라 그 id의 인덱스를 찾는다. branch가 없거나 id가 없으면 run을 `failed`로 바꾼다.
    - `next`가 없으면: `stepIndex + 1` (기존 동작).
    - 다음 인덱스가 없으면 (마지막 단계): run을 `succeeded`로 바꾼다 (기존 동작).
  - **agent 단계도 간선을 탄다**: agent 단계가 끝나면(`succeeded`), 그 단계의 `next`를 따라간다. agent 단계의 `next`가 문자열이면 그 id로 간다. (agent + condition 조합은 WF-7에서 동작해야 한다.)
- **claim·멱등성은 그대로**: `(runId, stepIndex)` 키로 단계를 점유한다 (DAG라 각 단계는 최대 1번). 재전달 시 이미 `succeeded`인 단계는 저장된 출력을 쓰고 간선을 따라간다 (재실행하지 않는다).
- **`run.current_step`은 마지막으로 실행한 단계 인덱스**로 둔다 (기존과 같은 의미 — "다음 단계"가 아니라 "방금 끝낸 단계"). 이 의미를 주석에 적는다.

### 4. UI에는 최소한만 손댄다

- WF-5의 폼 빌더는 `condition` 노드를 드롭다운에 **자동으로** 보여준다 (`WF_NODES`가 하드코딩이면 `condition` 항목 1개 추가 — 필드는 source·operator·value 3개). **간선(`next`) 편집 UI는 만들지 않는다** (WF-10 캔버스에서 만든다). 폼 빌더에서 만든 워크플로우는 선형으로 저장된다 (next 없음 = 배열 순서). 이 제한을 RESULT.md에 적는다.

## 검증 (반드시 `files/workflow-verify/wf7/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf7/`)

- `npx tsc --noEmit` 통과, `node --check public/workflow.js` 통과 (건드렸으면).
- 로컬 하네스 (WF-6의 `wf6/` 패턴 — `wrangler.toml` + `worker.ts` + Miniflare, AI·VECTOR·fetch는 mock):
  1. **분기 true 경로**: `llm`(요약에 "연차" 포함) → `condition`(contains "연차") → `ask_rag` 경로로 가고, 다른 경로는 실행되지 않는다 (단계 행으로 확인).
  2. **분기 false 경로**: 같은 워크플로우에 "연차"가 없는 요약을 주면 `false` 경로로 간다.
  3. **연산자**: `equals`·`not_contains`·`exists`·`not_exists`가 각각 맞게 동작한다.
  4. **v1 호환**: `next`가 없는 기존 워크플로우(`llm → create_task`)가 배열 순서대로 그대로 돈다.
  5. **검증 실패**: 사이클(A→B→A) 정의는 400, 없는 단계 id를 가리키는 `next`는 400, `condition`의 `next`가 한쪽만 있으면 400.
  6. **agent + condition**: agent 단계 뒤에 condition을 두고, agent의 최종 출력에 따라 분기한다.
  7. **회귀**: 일반 워크플로우 + 승인 게이트 + agent 루프(WF-6의 핵심 2~3건: 루프 종료·승인 게이트)가 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Workers AI 응답 품질, 배포·원격 D1, 브라우저 화면, 간선 편집 UI — WF-10에서 만듦).

## 금지

- 루프(사이클)를 허용하지 않는다. `while`·반복 노드를 만들지 않는다.
- `src/index.ts`를 만지지 않는다. 새 D1 마이그레이션 파일을 만들지 않는다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 코드 실행 노드를 만들지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
