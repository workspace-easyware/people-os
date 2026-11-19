# Project Think + Cloudflare OS 도입 계획 — People OS 에이전트 강화

작성일 2026-11-19 (목). 계획 문서만 썼고 코드·마이그레이션·배포는 건드리지 않았다.

> 날짜 확인: 2026-11-19는 수요일이 아니라 **목요일**이다. 동결 11-25(수)·공개 11-26(목)·제출 11-27(금)은 요일이 맞다. 동결까지 남은 날은 오늘 포함 7일(주말 포함)이다.

---

## 0. 결론 먼저

1. **동결(11-25) 전에는 (a) 점진적 도입으로 간다.** Think·Cloudflare OS의 패키지는 운영 Worker에 넣지 않고, Cloudflare OS에서 가장 값어치 있는 **개념 두 개를 People OS 코드로 직접 구현**한다.
   - **비동기 승인 + 시뮬레이션**: 승인이 필요한 동작을 대기열에 쌓고 run은 멈추지 않는다. 사용자는 나중에 한꺼번에 승인·거절한다.
   - **관찰 기록**: run이 읽은 자료를 기록하고, 개인 자료를 읽은 run은 외부로 나가는 동작을 비동기로 미루지 못하게 한다.
2. **(b) 전면 수정은 공모전 뒤로 미룬다.** 이유는 세 가지다.
   - Think는 공식 블로그가 "preview, API가 바뀔 수 있다"고 밝혔다.
   - 현재 엔진은 큐 재전달·중복 승인·시간 상한을 다루는 방어 코드가 촘촘하고 어제(11-18) 전체 점검을 막 끝냈다. 6일 안에 이것을 갈아엎고 템플릿 5개를 다시 검증하면 데모 직전에 회귀가 날 위험이 크다.
   - XAI·화상회의 세션이 같은 저장소에서 동시에 돌고 있다.
3. **Think는 별도 Worker에서 하루짜리 실험(스파이크)으로만 확인한다.** 운영에 넣을지는 실험 결과를 보고 사용자가 정한다(6장 결정 3).
4. **Cloudflare OS 자체는 설치·포크하지 않는다.** 라이브러리가 아니라 통째로 배포하는 워크스페이스이고, Gatekeeper는 단독 배포 방법이 아직 정해지지 않았다. 개념만 가져온다.
5. 비동기 승인 계층은 **노드 실행 층(`executeNode`)에 만든다.** 그러면 나중에 런타임을 Think나 Code Mode로 바꿔도 이 계층은 그대로 쓴다. 동결 전 작업이 공모전 뒤 전면 수정의 첫 단계가 된다.

---

## 1. 확인한 사실

### 1.1 People OS 현재 구조 (직접 읽은 코드)

읽은 파일: `src/workflow/agent-do.ts`, `agent.ts`, `approvals.ts`, `engine.ts`, `types.ts` 전체, `nodes.ts` 앞부분과 승인 관련 줄, `src/agent-session.ts`, `src/obs/routes-workflows.ts` 앞부분, `migrations/0027_workflows.sql`, `templates.ts` 앞부분, `wrangler.toml`, `package.json`.

| 항목 | 현재 구현 | 위치 |
|---|---|---|
| 실행 단위 | 큐 메시지 1개 = 단계 1개. agent 단계는 메시지 1개 = 1턴 | `engine.ts:216`, `agent.ts` |
| 중복 방지 | `(run_id, step_index)` 행을 조건부 UPDATE로 점유. agent는 DO가 턴 번호로 가드 | `engine.ts:274`, `agent-do.ts:205` |
| 충돌 복구 | 엔진 예외는 큐 재시도(3회 뒤 DLQ). 실행 중 워커가 죽으면 60분 뒤 청소가 failed로 정리 — **자동 재개는 없다** | `engine.ts:341`, `engine.ts:388` |
| 에이전트 루프 | `WorkflowAgent` DO(296줄). 직접 만든 ReAct. 모델이 JSON 하나를 내고 `parseDecision`이 파싱. 최근 10턴만 프롬프트에 넣고 관찰은 1,500자로 자름 | `agent-do.ts` |
| 모델 | `@cf/qwen/qwen3.8-27b`. action 자리에 도구 이름을 쓰는 실제 출력을 관용하는 코드가 있다 | `ask-pipeline.ts:38`, `agent-do.ts:103` |
| 승인 게이트 | `send_email`·`webhook`은 승인 필수. 엔진 1차 방어 + 노드 2차 방어(`ctx.approved !== true`면 실행 안 함). 승인 요청 시 run이 `waiting_approval`로 **멈추고 다음 메시지를 보내지 않는다** | `types.ts:40`, `engine.ts:159`, `nodes.ts:379`·`626` |
| 승인 범위 | agent는 "대기 중인 동작 1개"에만 유효. 승인 API는 run 단위 `approve`/`reject` | `agent.ts` 머리말, `routes.ts:284` |
| 정의 | D1 JSON, DAG(순환 금지), 단계 1~50개, 노드 15종 | `types.ts` |
| 한도 | 동시 3·하루 20·활성 30분·LLM 30회·agent 10스텝·agent LLM 20회 | `engine.ts:38-44`, `agent-do.ts:19` |
| 권한 | 모든 노드가 실행자(`ctx.user`) 권한으로 돈다. 문서는 `owner_id`로 격리, 공용 문서 쓰기는 hr_admin만 | `nodes.ts` `loadDoc` |
| 관측 | `workflow_runs`·`workflow_run_steps`에서 계산하는 읽기 전용 API(hr_admin 전용). agent 턴 기록은 단계 output에 들어간다 | `obs/routes-workflows.ts` |
| 채팅 기억 | `AgentSession` DO가 최근 20개 메시지를 배열로 보관. 분기·압축·검색 없음 | `agent-session.ts` |
| 빌드 환경 | wrangler **3.114.17**(설치본), `compatibility_date = "2025-07-18"`, 의존성은 hono·fflate·pptxgenjs뿐. `ai`·`agents`·`zod`는 직접 의존성이 아니다 | `package.json`, `node_modules` |

**읽지 못한 부분**: `routes.ts`·`store.ts`·`sharing.ts`·`schedules.ts` 본문, `nodes.ts`의 노드별 구현 대부분, `index.ts`(2,211줄), 프런트(`public/workflow.js` 923줄, `workflow-canvas.js` 539줄, `approval.js` 375줄), `src/obs/trace.ts`. 이 파일들에 닿는 작업 범위는 아래에서 "확인 필요"로 표시했다.

### 1.2 Project Think (공식 블로그·개발자 문서에서 확인)

| 항목 | 확인한 내용 |
|---|---|
| 상태 | 블로그(2026-04-15 게시): preview, "API가 바뀔 수 있다". Think 문서는 `runTurn()`에 "Think가 experimental을 졸업하기 전에 바뀔 수 있다"고 적었다. Session API는 `agents/experimental/memory/session` 경로다 |
| 패키지 | `@cloudflare/think`, `agents`, `ai`(AI SDK v6·v7), `zod`, `workers-ai-provider`, `@cloudflare/shell`, `@cloudflare/codemode`, `@cloudflare/worker-bundler` |
| 설정 | `nodejs_compat`, `[ai]` 바인딩, 에이전트 클래스의 DO 바인딩 + `new_sqlite_classes` 마이그레이션. 예시의 `compatibility_date`는 오늘 날짜 |
| 진입점 | Think는 `agents`의 `Agent`를 상속한다. 예시는 `routeAgentRequest(request, env)`로 라우팅한다 |
| 서버에서 턴 실행 | `runTurn()` — `wait`·`submit`·`stream` 세 방식. 채팅 UI 없이 워크플로 단계에서 부를 수 있다 |
| 파이버 | `runFiber(name, fn)`, `ctx.stash()`, `onFiberRecovered(ctx)`, `keepAliveWhile()`. **복구는 함수를 처음부터 다시 돌리는 방식이 아니다.** 마지막 `stash` 스냅샷만 넘겨받고 복구 로직은 직접 쓴다. 복구 기록은 기본 24시간 뒤 버려진다. 문서는 "에이전트와 독립적으로 돌고 단계별 재시도가 필요한 일은 Workflows를 쓰라"고 한다 |
| 하위 에이전트 | `this.subAgent(Class, "name")`. 자식 클래스는 바인딩·마이그레이션이 필요 없고 `ctx.exports`로 찾는다. 각자 SQLite가 따로 있다 |
| Code Mode | `createCodeTool({ tools, executor })` + `DynamicWorkerExecutor`(Worker Loader 바인딩 필요). **`needsApproval` 도구는 `createCodeTool`에서 빠진다("This API does not pause").** 멈추는 승인은 커넥터의 `requiresApproval`로 하고 `approve()`·`reject()`·`pending()`을 쓴다. 문서 경고: 이미 실행된 동작은 되돌리지 않는다 |
| Dynamic Workers | `[[worker_loaders]] binding = "LOADER"`. **Workers Paid 플랜 전용.** 월 1,000개·요청 1,000만·CPU 3,000만 ms 포함, 초과분은 Worker당 하루 $0.002 |
| 추적 | `[observability.traces] enabled = true`를 켜면 `invoke_agent`·`chat`·`execute_tool`·`tool_approval` 스팬이 대시보드 Agents 화면에 나온다 |

**미확인**:
- 각 패키지의 현재 버전·최근 배포일 (이 세션에서 `npm view`와 npmjs.com 조회가 권한에 막혔다).
- wrangler 3.114.17이 `worker_loaders`와 `ctx.exports`를 지원하는지. 최소 wrangler 버전은 문서에 없다.
- `wrangler dev --local`에서 Dynamic Workers·Facets가 도는지.
- `qwen3.8-27b`가 `workers-ai-provider`의 도구 호출로 안정적으로 동작하는지. 문서 예시는 `@cf/moonshotai/kimi-k2.6`만 쓴다.
- Think에서 승인이 필요한 도구를 선언·해소하는 정확한 API(문서의 Actions 페이지는 읽지 않았다).
- People OS 계정이 Workers Paid인지.

### 1.3 Cloudflare OS (저장소 README·docs에서 확인)

| 항목 | 확인한 내용 |
|---|---|
| 상태 | "WARNING: Early access", "heavy development", v2는 전면 재작성, "2026년 8월 릴리스 기준 아직 거친 부분이 많다". 외부 기여는 받지 않는다(십여 줄 이하 수정만) |
| 형태 | **라이브러리가 아니다.** `workshop-backend`(커널) + `workshop-frontend`(셸) + 서비스별 `gatekeeper-*` Worker를 통째로 배포한다. 배포는 `os.cloudflare.app/deploy` 또는 `cloudflare-os-starter` |
| Gatekeeper | 부작용이 있는 동작마다 사용자에게 승인·거절 기회를 준다. 승인 전에는 결과를 로컬에서 시뮬레이션해 에이전트가 계속 일하게 하고, 에이전트가 결과를 다시 읽으면 시뮬레이션 결과를 준다. 사용자는 한꺼번에 또는 하나씩 승인·거절한다. 모든 동작을 기록한다. **단독 배포는 "세부 사항이 아직 정해지지 않았다"** |
| 자원 소개 | 에이전트·가젯은 사용자가 자원을 하나씩 소개해야 접근한다. 에이전트가 소개를 요청할 수도 있다 |
| 가젯·블루프린트 | 가젯은 Dynamic Worker에서 돌고 인터넷이 막혀 있다. 블루프린트는 코드 사본이고 사용자마다 자기 사본을 돌린다 |
| 관찰자 검증 | `docs/observers.md`·`sharing.md`: 공유받은 사람이 열 때마다 Gatekeeper가 그 사람의 접근 권한을 다시 검증한다. 현재 협업자가 볼 수 없는 데이터가 든 관찰은 차단한다. 제한 데이터가 있으면 웹 요청을 제한하고 수동 승인을 요구한다(`containsRestrictedData`). 정적 스냅샷은 검증을 건너뛰며 이 부분은 "유지보수자 승인 대기"다 |
| 에이전트 | Code Mode 에이전트. LLM 계층은 Pi(`pi-agent-core`)다. **README에 Think는 나오지 않는다** — Cloudflare OS는 Think 위에 만든 것이 아니다 |

**미확인**: 사용자 요약의 "Typed Binding"·"읽기/행동 경로 분리"·"Observation Log"라는 용어는 README에서 그 이름으로는 찾지 못했다(내용은 위 표와 대체로 맞는다). `docs/observers.md`는 뒤쪽 약 2만 5천 자를 읽지 않았다. Gatekeeper 소스 코드는 읽지 않았다.

---

## 2. 도입 방식 비교

| | (a) 점진적 | (c) 하이브리드 | (b) 전면 수정 |
|---|---|---|---|
| 바꾸는 것 | 엔진·노드에 비동기 승인과 관찰 기록을 추가. 런타임은 그대로 | `WorkflowAgent` DO를 Think 서브클래스로 교체. 정의·UI·엔진은 유지 | 엔진을 Fiber + 하위 에이전트로 재구성. 큐 실행 제거 |
| 새 의존성 | 없음 | `agents`, `@cloudflare/think`, `ai`, `zod`, `workers-ai-provider`, 새 DO 마이그레이션, 아마 wrangler 업그레이드 | (c) + Dynamic Workers(Paid), Code Mode |
| 기존 데이터 | 테이블 추가만 | agent 단계 output의 `turns` 형식이 바뀐다 → 관측 화면 수정 | run·step 테이블의 의미가 바뀐다. 진행 중 run 이관 필요 |
| 깨질 수 있는 것 | 승인 흐름(범위가 좁다) | agent 단계 전체, 턴 단위 승인, 28분 정상 멈춤, 반복 도구 멈춤 | 템플릿 5개, 스케줄, 공유·웹훅, 관측, 한도 전부 |
| 동결 전 가능성 | 가능 | 스파이크가 하루 안에 통과하면 실험 노드로만 가능 | 권하지 않는다 |
| 얻는 것 | 데모에서 바로 보이는 변화(멈추지 않는 에이전트, 일괄 승인) | 스트리밍, 세션 메모리, 자동 추적, SDK가 관리하는 루프 | 장기 실행·하위 에이전트·코드 실행 전체 |

**(b)를 동결 전에 하지 않는 근거**
- 엔진이 지금 보장하는 것(재전달 멱등성, 오래된 승인 메시지 차단, 활성 시간 계산, 승인 1회 실행)을 파이버로 옮기면 복구 로직을 `onFiberRecovered`에 직접 다시 써야 한다. 파이버는 자동 재실행이 아니다.
- 워크플로 실행은 Cloudflare 문서 스스로 "독립 실행·단계별 재시도는 Workflows"라고 안내하는 종류의 일이다. DAG 실행을 파이버로 옮기는 것은 일정과 무관하게 맞는 방향인지부터 따져야 한다(4장 열린 질문 1).
- Think가 preview라 동결 뒤 제출 전까지 패키지가 바뀌어도 고칠 수 없다.

**(c)를 동결 전 기본안으로 삼지 않는 근거**
- 현재 agent 루프는 Qwen3의 형식 오류를 관용하는 파서에 기대고 있다. 같은 모델이 AI SDK 도구 호출로 잘 도는지는 미확인이다. 모델을 바꾸면 판단 품질을 다시 검증해야 한다.
- 턴마다 큐 메시지 하나인 현재 구조와, 한 번의 `runTurn()` 안에서 여러 스텝을 도는 Think 구조가 다르다. 28분 정상 멈춤·LLM 20회 상한·도구별 승인을 Think 훅으로 다시 만들어야 한다.
- 하루 실험으로 이 불확실성이 풀리면 실험 노드로 넣을 수 있다. 그래서 스파이크를 계획에 넣었다.

---

## 3. 요소별 적용 계획

| # | 요소 | 판단 | 시점 |
|---|---|---|---|
| 1 | 비동기 승인 + 시뮬레이션 | 직접 구현 | 동결 전 (최우선) |
| 2 | 관찰 기록 | 축소판 직접 구현 | 동결 전 |
| 3 | Think 베이스 클래스 | 별도 Worker 스파이크 → 결과에 따라 실험 노드 | 동결 전 스파이크, 본 도입은 뒤 |
| 4 | Code Mode | 스파이크에서 토큰 측정만 | 뒤 |
| 5 | 영구 세션 | Think 도입과 함께 채팅 쪽에 | 뒤 |
| 6 | 하위 에이전트 | Think 도입 뒤 | 뒤 |
| 7 | Fiber | agent 단계 안에서만. DAG 실행은 큐 유지 | 뒤 |
| 8 | 게이트키퍼(능력 기반) | "자원 소개"만 실행 입력 단위로 | 뒤 (일부는 2번에 포함) |
| 9 | 실행 래더 | 0~1단계까지만 | 뒤 |
| 10 | 가젯·블루프린트 | 도입하지 않음. 템플릿 공유 규칙만 참고 | 보류 |

### 3.1 비동기 승인 + 시뮬레이션 (동결 전, 최우선)

**지금**: 승인이 필요한 단계에서 run이 `waiting_approval`로 멈춘다. agent가 메일 세 통을 보내려 하면 사용자가 세 번 승인해야 하고 그 사이 에이전트는 아무것도 못 한다.

**바꿀 모습**: 승인 필요한 동작을 **대기 동작**으로 저장하고, 노드는 시뮬레이션 결과를 돌려주고, run은 끝까지 간다. 사용자는 승인함에서 쌓인 동작을 한꺼번에 또는 하나씩 승인·거절한다. 승인된 동작은 그때 실제로 실행된다.

**설계**

1. **새 테이블 `workflow_pending_actions`** (마이그레이션 1개, 추가만).
   열: `id`, `run_id`, `step_index`, `turn`(agent만), `owner_id`, `node_type`, `args_json`(변수 치환이 끝난 최종 인자), `simulated_output_json`, `status`(`queued`·`approved`·`executing`·`executed`·`rejected`·`failed`·`expired`), `result_json`, `error`, `created_at`, `decided_at`, `executed_at`.
   `UNIQUE(run_id, step_index, turn)`로 큐 재전달에도 한 행만 생긴다.
2. **노드 층에 시뮬레이션 추가** (`nodes.ts`). `NodeContext`에 `deferActions?: boolean`을 더한다. `send_email`·`webhook`은 `approved !== true`이고 `deferActions`이면 검증을 통과한 인자로 대기 동작을 넣고 `{ status: "succeeded", output: { simulated: true, pendingActionId, ... } }`를 돌려준다. 검증(주소 형식, SSRF 검사)은 지금처럼 승인 요청 전에 먼저 한다.
   - `send_email` 시뮬레이션: `{ providerId: null, simulated: true, to, subject }`.
   - `webhook` 시뮬레이션: `{ status: null, ok: null, simulated: true, method, url }`. 응답 본문은 지어내지 않는다.
3. **엔진** (`engine.ts`). 승인 게이트(7번)에서 단계가 지연 방식이면 `pauseForApproval` 대신 노드를 `deferActions: true`로 실행하고 다음 단계로 간다. run 상태 값은 늘리지 않는다. "승인 대기 동작 N개"는 테이블에서 세어 표시한다.
4. **에이전트** (`agent.ts`). `gated(tool)`이면 DO에 pending을 저장하고 멈추는 대신 대기 동작을 넣고 관찰에 `"(승인 대기열에 넣음 — 승인되면 실행됩니다)"`를 적어 다음 턴으로 간다.
5. **승인 API** (`routes.ts`, 확인 필요). `GET /api/workflows/pending-actions`, `POST /api/workflows/pending-actions/decide`(id 배열 + 승인·거절). 승인하면 상태를 `approved`로 바꾸고 큐에 `workflow-action` 메시지를 넣는다. 소비자는 `approved → executing` 조건부 UPDATE로 점유한 뒤 `executeNode(type, { ...ctx, approved: true }, args)`를 부른다. 실행자는 지금처럼 run 소유자이고 활성 계정인지 다시 확인한다.
6. **UI** (`public/workflow.js`·`approval.js`, 확인 필요). 승인함에 "대기 동작" 묶음, 전체 선택, 일괄 승인·거절. run 상세에는 시뮬레이션된 단계에 "승인 대기" 표시.
7. **만료**: 7일 지난 `queued`는 기존 정체 청소에서 `expired`로 바꾼다.

**Cloudflare OS와 다르게 가는 점 — 세 가지 안전 규칙**

- **에이전트에게 "완료됐다"고 하지 않고 "대기열에 넣었다"고 알린다.** Cloudflare OS는 완료됐다고 알리지만, People OS 에이전트는 최종 답에 "메일을 보냈습니다"라고 쓰게 되고 그것이 사용자에게 그대로 보인다. 아직 안 나간 메일을 보냈다고 말하는 화면은 만들지 않는다.
- **지연 방식은 선택 사항이고 기본값은 지금의 동기식이다.** 단계에 `approvalMode: "deferred"`를 둔다(생략하면 동기식). 뒤 단계가 그 동작의 실제 결과에 기대는 경우는 저장 시점에 지연을 거부한다: (i) 뒤 단계가 `{{steps.<id>.output...}}`으로 그 단계 출력을 참조할 때, (ii) `webhook`이 GET일 때(읽기라서 시뮬레이션할 결과가 없다).
- **거절은 뒤 단계를 되돌리지 않는다.** 지연 방식에서는 승인 전에 뒤 단계가 이미 실행된다. 예를 들어 "휴가 신청 승인" 템플릿은 결재 메일 승인 뒤에 캘린더 일정을 만드는데, 지연으로 바꾸면 메일이 거절돼도 일정이 남는다. 그래서 이 템플릿은 동기식으로 둔다. 거절 화면에는 "이 동작 뒤에 이미 실행된 단계"를 보여준다. (Code Mode 문서도 같은 한계를 밝힌다: "It does not roll back earlier actions.")

**템플릿별 적용**: 회의 자동화·주간 보고의 메일 발송과 agent 단계는 지연 방식으로 시연한다. 휴가 승인·지출 결재는 동기식 유지. 신입 온보딩은 정의를 읽고 정한다(확인 필요).

**건드리는 파일**: `types.ts`, `nodes.ts`, `engine.ts`, `agent.ts`, `routes.ts`, `index.ts`(큐 메시지 유니온·소비자 분기), 마이그레이션 1개, `public/workflow.js`, `public/approval.js` 또는 새 파일. `agent-do.ts`는 고치지 않아도 된다(동기식 경로를 위해 `pendingAction`은 남긴다).

### 3.2 관찰 기록 (동결 전, 축소판)

**지금**: 노드가 무엇을 읽었는지는 단계 output에 섞여 있을 뿐 따로 남지 않는다. 접근 제어는 읽는 순간의 `owner_id` 검사뿐이다.

**바꿀 모습**

1. **새 테이블 `workflow_run_observations`**: `run_id`, `step_index`, `resource_type`(`document`·`personal_pool`·`public_pool`·`recording`·`email`), `resource_id`, `resource_owner_id`, `at`. `loadDoc`, `ask_rag`·`ask_personal`의 출처 목록, 전사 읽기에서 한 줄씩 넣는다.
2. **run 상세에 "이 실행이 읽은 자료" 목록**을 보여준다. 설명 가능성(XAI) 화면과 나란히 놓기 좋다. XAI 세션과 화면이 겹치지 않는지 확인이 필요하다.
3. **오염 규칙**: 개인 자료(`resource_owner_id`가 있는 자료)를 읽은 run에서는 외부로 나가는 동작(`webhook`, 회사 도메인 밖으로 가는 `send_email`)을 지연 방식으로 넣지 않고 **동기식 승인으로 강제**한다. 승인 요청에 "이 실행은 개인 자료 N건을 읽었습니다"를 붙인다. Cloudflare OS의 `containsRestrictedData`(제한 데이터가 있으면 수동 승인 요구)와 같은 생각이다.

**동결 뒤로 미루는 부분**: 산출물을 다른 사람이 열 때 그 사람이 관찰된 자료 각각에 접근 권한이 있는지 검증하는 것. 여기에는 `sharing.ts`(워크플로 공유)와 관측 API가 걸린다. 지금 관측 API는 hr_admin에게 run 단계를 보여주는데, 개인 RAG를 읽은 단계의 출력이 거기에 포함되는지는 이 세션에서 확인하지 못했다. **포함된다면 개인 RAG 격리와 어긋나므로 별도로 확인할 가치가 있다**(6장 결정 6).

### 3.3 Think 베이스 클래스 (동결 전 스파이크, 본 도입은 뒤)

**스파이크 (하루, 운영 Worker 밖)**: 새 Worker `people-os-think-spike`를 따로 만든다. 운영 `people-os`의 `wrangler.toml`·`package.json`·DO 마이그레이션은 건드리지 않는다. 확인할 것:

1. 설치·배포가 되는가. wrangler 3.114.17로 되는지, 4로 올려야 하는지.
2. `qwen3.8-27b`가 AI SDK 도구 호출로 도구 3개(`ask_rag`, `create_task`, `email_draft` 흉내)를 안정적으로 고르는가. 안 되면 `kimi-k2.6` 등 문서 예시 모델로 비교한다.
3. `runTurn()`을 서버에서 불러 한 목표를 끝까지 돌릴 수 있는가. `maxSteps`·시간 상한·같은 도구 반복 멈춤을 훅으로 걸 수 있는가.
4. 같은 목표를 현재 ReAct와 Think로 돌렸을 때 **입력·출력 토큰과 왕복 횟수**(AI Gateway 로그로 잰다).
5. `[observability.traces]`로 대시보드에 스팬이 나오는가.

**통과 기준**: 1~3이 하루 안에 되고, 현재 루프의 멈춤 규칙 네 가지 중 최소 `max_steps`·`timeout`을 재현할 수 있다.

**통과하면 (선택)**: 운영에 새 노드 타입 `agent_think`를 **실험 표시**로 추가한다. 기존 `agent` 노드와 `WorkflowAgent` DO는 그대로 둔다. 이 경우 운영 Worker에 DO 마이그레이션 `v4`가 들어가고 되돌리려면 삭제 마이그레이션이 또 필요하므로 사용자 결정이 필요하다(결정 3).

**본 도입 (공모전 뒤)**: `WorkflowAgent`를 Think 서브클래스로 교체한다. 도구는 `NODE_REGISTRY`에서 AI SDK 도구로 자동 변환한다(`description`·`inputKeys`가 이미 있어 zod 스키마만 더하면 된다). 승인은 3.1의 대기 동작 계층을 도구 구현 안에서 그대로 부른다.

### 3.4 Code Mode (뒤)

- 사용자 자료의 "117만 → 1,000 토큰"은 엔드포인트가 수천 개인 Cloudflare API MCP 서버 사례다. People OS agent의 도구는 13종이고 프롬프트에 한 줄씩만 들어가므로 **도구 정의에서 줄일 토큰은 거의 없다.** 줄어들 수 있는 것은 왕복 횟수다(지금은 턴마다 최근 10턴 기록을 다시 보낸다). 얼마나 줄지는 재 보지 않았으므로 숫자를 적지 않는다. 스파이크 4번에서 잰다.
- Dynamic Workers가 Workers Paid 전용이라 플랜 확인이 먼저다.
- `createCodeTool`은 승인 필요 도구를 빼 버린다. People OS는 3.1의 계층이 도구 안에서 시뮬레이션 결과를 돌려주므로 이 제약과 잘 맞는다 — 코드가 `tools.send_email()`을 불러도 멈추지 않고 대기 동작만 쌓인다.
- 생성된 코드는 `globalOutbound: null`(기본값)로 네트워크를 막고 도구 바인딩만 준다.

### 3.5 영구 세션 (뒤)

- 대상은 워크플로가 아니라 **채팅**이다. `AgentSession` DO(최근 20개 배열)를 Think 세션(트리 메시지·비파괴 압축·FTS5 검색·컨텍스트 블록)으로 바꾸면 "지난번에 물어본 것" 검색과 사용자별 장기 기억이 생긴다.
- 질문 응답 본체(`ask-pipeline.ts`, 판단 모델 4층, 평가)는 Think로 옮기지 않는다. Think는 대화 상태 관리만 맡고 답 생성은 지금 파이프라인을 도구로 부른다. 골든셋 평가 결과를 유지하려면 답 경로가 그대로여야 한다.
- 기존 트레이스(D1 + R2)는 유지한다. Think의 자동 추적은 보완용으로 켠다.
- Session API가 experimental 경로에 있으므로 Think 본 도입 뒤 따로 판단한다.

### 3.6 하위 에이전트 (뒤)

- 쓸 곳: (i) 코칭 리플렉션에서 "코치 관점"과 "코치이 관점"을 각자 격리된 기억으로 돌리고 부모가 합친다. (ii) 긴 조사 목표에서 "자료 수집"과 "검토"를 나눈다.
- 자식 클래스는 바인딩·마이그레이션이 필요 없어 추가 비용이 작다. 다만 부모가 Think/Agent여야 하므로 3.3 뒤에만 가능하다.
- 하위 에이전트마다 LLM 호출이 늘어난다. 지금의 run당 LLM 상한을 하위 에이전트까지 합산하도록 다시 정해야 한다.

### 3.7 Fiber (뒤, 범위 한정)

| | 현재 큐 방식 | Fiber |
|---|---|---|
| 재시도 | 큐가 메시지를 다시 전달, 3회 뒤 DLQ | 없음. `onFiberRecovered`에서 직접 결정 |
| 워커가 실행 중 죽으면 | 단계가 running에 남고 60분 뒤 청소가 failed 처리. **이어서 실행하지 않는다** | 마지막 `stash` 스냅샷으로 복구 훅이 불린다 |
| 중복 방지 | D1 조건부 UPDATE + DO 턴 가드 | 한 DO 안에서 도므로 구조적으로 덜 필요 |
| 승인 대기 | 메시지를 안 보내면 된다 (비용 0) | 최대 며칠 대기에는 맞지 않는다. 복구 기록 기본 수명 24시간 |

- 판단: **DAG 단계 실행은 큐에 둔다.** Fiber는 agent 단계 하나의 루프 안에서만 쓴다(Think 본 도입 시 `runTurn`이 복구 파이버 안에서 돌므로 자동으로 따라온다).
- 현재 약점인 "실행 중 죽으면 60분 뒤 실패"는 Fiber 없이도 줄일 수 있다(청소 시 `running`에 남은 agent 단계를 실패 대신 다음 턴 메시지로 다시 넣기). 동결 전에 할지는 선택 사항이다.

### 3.8 게이트키퍼식 권한 (뒤, 일부만)

- 현재 모델은 "실행자의 권한 전부"다. agent 단계는 실행자가 볼 수 있는 모든 문서를 읽을 수 있다. 능력 기반은 "이 run에 소개한 자원만"이다.
- 들여올 만한 최소 단위: agent 노드 config에 `resources`(문서 id 목록, 풀 종류)를 두고, 지정했으면 노드의 읽기가 그 범위로 좁혀진다. 지정하지 않으면 지금과 같다. 역할 기반 + `owner_id` 검사는 그 아래에서 그대로 돈다(두 겹).
- 읽기/행동 분리는 3.1(행동은 승인 대기열)과 3.2(읽기는 기록)로 이미 대응된다.
- 자격 증명 격리(구글 캘린더·Plaud 토큰을 에이전트 코드가 직접 못 보게)는 Code Mode를 들일 때 필요해진다. 지금은 LLM이 코드를 실행하지 않으므로 급하지 않다.
- Cap'n Web: 프런트는 Hono REST를 쓰고 있고 바꿀 이유가 지금은 없다. 도입하지 않는다.

### 3.9 실행 래더 (뒤)

| 단계 | 내용 | 판단 |
|---|---|---|
| 0 | Workspace (`@cloudflare/shell`) | agent가 초안·중간 산출물을 파일로 쌓는 용도로 유용. Think 도입 시 함께 |
| 1 | Dynamic Worker (Code Mode) | 3.4. Paid 확인 뒤 |
| 2 | 런타임 npm | 쓸 곳이 뚜렷하지 않다. 보류 |
| 3 | 브라우저 | HR 업무에서 외부 사이트 조작 수요가 있는지 먼저 확인. 보류 |
| 4 | 샌드박스 | 필요 없다 |

### 3.10 가젯·블루프린트 (도입하지 않음)

- 가젯은 사용자가 만든 코드가 그 자체로 앱이 되는 구조다. People OS의 대상은 HR 담당자와 코치·코치이이고 지금의 노드 캔버스가 그 사용자에게 맞다. 가젯을 넣으면 제품 성격이 바뀐다.
- 가져올 것은 블루프린트의 공유 규칙 하나다: **템플릿·공유 워크플로는 정의만 가져가고 데이터·자격 증명은 가져가지 않는다.** 현재 공유(`sharing.ts`)가 이 규칙을 지키는지는 본문을 읽지 않아 확인하지 못했다(확인 필요).

---

## 4. 일정·순서

### 4.1 동결 전 (11-19 ~ 11-25)

아래는 목표 일정이다. 작업량을 실측한 값이 아니다.

| 날짜 | 작업 | 세션 |
|---|---|---|
| 11-19 (목) | 이 계획 검토, 6장 결정 | 사용자 |
| 11-20 (금) | **P1** 대기 동작 테이블 + 노드 시뮬레이션 + 엔진 지연 경로 + 로컬 검증 하네스 | Opus (엔진 수정이라 난도 높음) |
| 11-21 (토) | **P2** agent 경로 + 승인 API(목록·일괄 결정) + 큐 소비자 + 만료 청소 | Opus |
| 11-22 (일) | **P3** 승인함 UI(일괄 승인·거절) + run 상세 표시 + 템플릿 2개를 지연 방식으로 | Sonnet (명세가 분명) |
| 11-23 (월) | **P4** 관찰 기록 테이블 + 읽은 자료 목록 + 오염 규칙 / 병행: **Think 스파이크**(별도 Worker) | Sonnet / Fable |
| 11-24 (화) | 템플릿 5개 회귀 검증, 원격 마이그레이션·배포, 데모 대본 갱신. 스파이크 통과 + 사용자 승인 시에만 `agent_think` 실험 노드 | Opus |
| 11-25 (수) | 예비일. 동결 | — |

**순서 원칙**
- P1~P2가 끝나고 로컬 검증을 통과하기 전에는 P3을 시작하지 않는다. 승인은 안전장치라 반쯤 된 상태로 배포하지 않는다.
- P4는 P1~P3과 독립이라 일정이 밀리면 P4를 먼저 뺀다. 그다음 뺄 것은 Think 스파이크다.
- 11-24에 회귀가 잡히면 지연 방식을 꺼 둔 채(모든 단계 동기식) 배포한다. `approvalMode`가 선택 사항이라 끄는 것은 템플릿 정의만 되돌리면 된다.

**검증 (각 단계 공통)**
- `npx tsc --noEmit`.
- 로컬 하네스(`files/workflow-verify/` 아래, `/tmp` 금지): (i) 지연 단계가 run을 멈추지 않는다, (ii) 승인 전에는 메일·웹훅이 실제로 나가지 않는다, (iii) 같은 큐 메시지를 두 번 넣어도 대기 동작이 한 행이다, (iv) 승인 메시지를 두 번 넣어도 한 번만 실행된다, (v) 거절하면 실행되지 않는다, (vi) 다른 사용자의 대기 동작은 목록에 안 보이고 결정도 404다, (vii) 기존 동기식 템플릿이 전과 같이 돈다.
- 원격: `migrations list --remote` 확인 뒤 단일 파일 적용. 배포 버전 ID와 라이브 확인 결과를 보고.

### 4.2 공모전 뒤

1. Think 본 도입: `WorkflowAgent` → Think 서브클래스 (3.3). 모델·멈춤 규칙·승인 재검증.
2. 채팅 세션을 Think 세션으로 (3.5).
3. Code Mode + Workspace (3.4, 3.9) — Paid 플랜 확인 뒤.
4. 하위 에이전트 (3.6).
5. 능력 기반 자원 범위 (3.8)와 공유 시 관찰 기록 검증 (3.2 뒷부분).
6. DAG 실행을 큐에 둘지 Cloudflare Workflows로 옮길지 판단 (열린 질문 1).

---

## 5. 위험·열린 질문

### 5.1 위험

| # | 위험 | 대응 |
|---|---|---|
| R1 | 같은 저장소에서 XAI(Opus)·화상회의(Fable) 세션이 동시에 진행 중이다. `engine.ts`·`nodes.ts`·`index.ts`·`wrangler.toml`·마이그레이션 번호(다음은 0037)가 겹칠 수 있다 | P1 시작 전에 두 세션이 건드리는 파일과 쓰는 마이그레이션 번호를 확인한다. 작업 트리에 커밋되지 않은 변경이 많다(수정 30여 개 + 미추적 다수) — 먼저 커밋해 기준점을 만든다 |
| R2 | 지연 방식에서 거절해도 뒤 단계가 이미 실행됐다 | 기본값 동기식, 저장 시점 정적 검사, 거절 화면에 실행된 뒤 단계 표시 (3.1) |
| R3 | 시뮬레이션 결과를 실제 결과로 오해 | 출력에 `simulated: true`, 에이전트 관찰과 UI에 "승인 대기" 명시, 최종 답에 "보냈다"고 쓰지 않도록 시스템 프롬프트에 규칙 한 줄 추가 |
| R4 | 승인된 동작이 나중에 실행될 때 상황이 바뀌어 있다(계정 비활성, Resend 미설정, 웹훅 주소가 사설로 바뀜) | 실행 시점에 소유자 활성 확인·SSRF 검사를 다시 한다. 실패는 `failed`로 남기고 알림 |
| R5 | Think가 preview다. 제출 직전 패키지 변경 | 운영에는 넣지 않거나, 넣더라도 버전을 정확히 고정하고 기존 `agent` 노드를 그대로 둔다 |
| R6 | DO 마이그레이션은 되돌리기 번거롭다 | 스파이크는 별도 Worker에서만. 운영 `v4`는 사용자 결정 뒤 |
| R7 | Cloudflare OS는 early access이고 Gatekeeper 단독 배포 방식이 없다 | 코드 의존 없음. 개념만 차용하므로 이 위험은 계획에 영향이 없다 |
| R8 | 관찰 기록을 넣을 읽기 지점을 빠뜨리면 오염 규칙이 샌다 | 읽기 헬퍼(`loadDoc` 등)에 넣고, 노드별 구현을 전부 읽어 빠진 경로를 목록으로 만든 뒤 구현 |
| R9 | 데모·문서에서 "Project Think·Cloudflare OS를 썼다"고 하면 사실과 다르다 | "Cloudflare OS의 Gatekeeper 설계에서 착안해 직접 구현했다"로 정확히 적는다 |

### 5.2 열린 질문

1. 워크플로 DAG 실행의 장기 방향: 큐 유지 / Cloudflare Workflows / Fiber. Cloudflare 문서는 독립 실행·단계별 재시도에 Workflows를 권한다. Dynamic Workers 문서에 "Dynamic Workflows" 항목도 있다(읽지 않았다).
2. Think에서 승인 필요한 도구의 선언·해소 API와, 승인 대기 중 턴이 어떻게 유지되는지 (Actions 문서 미확인).
3. `qwen3.8-27b`의 AI SDK 도구 호출 안정성 (스파이크로 확인).
4. wrangler 3 → 4 업그레이드가 필요한지, 필요하다면 기존 `cf-wrangler.py` 배포 경로와 맞는지.
5. Workers 플랜 (Dynamic Workers는 Paid 전용).
6. 관측 API가 hr_admin에게 개인 RAG를 읽은 단계의 출력을 보여주는지.
7. 현재 워크플로 공유가 정의만 넘기는지, 실행 기록·입력 값도 넘기는지.

---

## 6. 정리

### 먼저 할 것 (동결 전)

1. 작업 트리 커밋으로 기준점 만들기, XAI·화상회의 세션과 파일·마이그레이션 번호 조율.
2. **P1~P3 비동기 승인 + 시뮬레이션** — 대기 동작 테이블, 노드 시뮬레이션, 엔진·에이전트 지연 경로, 일괄 승인 API·UI.
3. **P4 관찰 기록** — 읽은 자료 기록·표시, 개인 자료를 읽은 run의 외부 동작은 동기식 승인 강제.
4. **Think 스파이크** — 별도 Worker에서 하루. 토큰·왕복 횟수 측정 포함.
5. 템플릿 5개 회귀 검증 뒤 배포, 데모 대본에 "멈추지 않는 에이전트 + 일괄 승인" 장면 추가.

### 나중에 할 것 (공모전 뒤)

1. `WorkflowAgent`를 Think 서브클래스로 교체.
2. 채팅 세션을 Think 세션(트리·압축·검색)으로.
3. Code Mode + Workspace.
4. 하위 에이전트(코칭 리플렉션 역할 분담).
5. 능력 기반 자원 범위, 공유 시 관찰 기록 검증.
6. DAG 실행 방식 재검토.
7. 도입하지 않음: Cloudflare OS 설치·포크, 가젯, Cap'n Web, 래더 2~4단계.

### 사용자 결정이 필요한 것

1. **도입 방식**: 동결 전 (a) 점진적 + 공모전 뒤 (c)→(b) 순서로 가는 이 안에 동의하는가. 전면 수정을 동결 전에 원하면 위험(R5·R6, 템플릿 회귀)을 감수하는 결정이 된다. *권고: 이 안대로.*
2. **지연 방식의 기본값**: 새 워크플로의 승인을 기본 동기식(이 안)으로 둘지, 기본 지연으로 둘지. *권고: 기본 동기식, 템플릿 2개와 agent 단계만 지연.*
3. **Think를 운영에 넣을지**: 스파이크가 통과하면 `agent_think` 실험 노드를 동결 전에 운영에 넣을지(DO 마이그레이션 `v4` 포함), 스파이크 결과만 데모에서 "다음 단계"로 소개할지. *권고: 통과해도 운영에는 넣지 않고 결과만 소개. Cloudflare 심사에서 최신 SDK 사용이 가점이 된다고 판단하면 넣는 쪽도 성립한다.*
4. **에이전트에게 알리는 문구**: Cloudflare OS처럼 "완료됐다"고 알릴지, "대기열에 넣었다"(이 안)고 알릴지. *권고: 대기열에 넣었다.*
5. **Workers 플랜 확인**: 계정이 Paid인지 대시보드에서 확인 필요. Free라면 Code Mode·Dynamic Workers는 플랜을 올려야 쓸 수 있다.
6. **관측 API의 개인 자료 노출 여부 점검**을 P4에 포함할지(5.2의 6번). *권고: 포함. 읽기만 하는 점검이라 부담이 작다.*
7. **P1 착수 시점**: XAI 세션이 `engine.ts`·`nodes.ts`·`index.ts`를 건드린다면 그 세션이 끝난 뒤 시작할지, 워크트리를 나눠 병행할지.
8. **11-25 예비일**: 동결 하루 전(11-24)에 배포를 끝내고 11-25를 비워 두는 이 일정에 동의하는가.

---

## 출처

- Project Think 블로그: https://blog.cloudflare.com/project-think/ (한국어판: https://blog.cloudflare.com/ko-kr/project-think)
- Think 문서: https://developers.cloudflare.com/agents/api-reference/think/
- 내구성 실행(파이버): https://developers.cloudflare.com/agents/api-reference/durable-execution/
- 하위 에이전트: https://developers.cloudflare.com/agents/api-reference/sub-agents/
- Code Mode: https://developers.cloudflare.com/agents/api-reference/codemode/
- Dynamic Workers: https://developers.cloudflare.com/dynamic-workers/ (getting-started, pricing)
- Cloudflare OS: https://github.com/cloudflare/cloudflare-os (README, `docs/observers.md`, `docs/sharing.md`)
