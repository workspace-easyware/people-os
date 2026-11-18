# WF-6 프롬프트 — 에이전트 루프 (ReAct)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.2.1 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-6행 + WF-1~WF-5 산출물(`src/workflow/{types,store,routes,engine,approvals,nodes}.ts`, `src/index.ts` 큐·`scheduled()` 배선) + 검증 문서(`files/workflow-verify/wf2/RESULT.md`의 "설계 메모", `wf3/RESULT.md`의 엔진 동작·명세 차이, `wf4/RESULT.md`의 승인 경로, `wf5/RESULT.md`의 API 표). **특히 WF-3의 엔진 흐름(`processWorkflowStep`의 claim·승인 게이트·LLM 캡·재시도 규칙)과 WF-2의 `nodes.ts` 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)를 먼저 읽을 것.**
> 모델: Opus. 이 세션은 **에이전트 루프만** 만든다. 조건 분기(WF-7), 스케줄(WF-8), 공유(WF-9), 캔버스(WF-10), 관측(WF-11)은 **하지 않는다**. D1 마이그레이션 파일을 만들지 않는다 (DO 마이그레이션은 `wrangler.toml` 태그로만 한다). **배포하지 않는다** — D-2에서 코디네이터가 0028 적용·배포·라이브 검증을 한다.
> **주의: `src/index.ts`를 만진다.** DO export 1줄 + 에이전트 단계의 엔진 분기만 최소한으로 고친다. 기존 메시지 타입(transcript-pipeline, build-tree, eval-item, workflow-step)의 동작은 절대 바꾸지 않는다. `scheduled()`는 건드리지 않는다.

## 목표

워크플로우 안에 `agent` 노드를 만든다. 사용자가 단계가 아니라 **목표**만 주면, Qwen3이 레지스트리의 도구를 골라서 목표에 다가가는 ReAct 루프를 돈다. 루프 상태는 Durable Object가 들고, 한 번에 한 턴씩만 진행한다. 외부 행동(`send_email`)은 승인 게이트를 그대로 탄다. 이 세션이 끝나면 목표만 준 워크플로우가 실제로 도구를 골라 실행하고, 멈춤 조건에 걸리면 멈추고, `send_email`을 고르면 승인 대기에서 멈춘다.

## 설계 (제안서 4.2.1 + 코디네이터 확정 — 이 설계를 따른다)

### 1. `agent` 노드 정의 (`src/workflow/types.ts`)

- `NodeType` 유니온 + `NODE_TYPES`에 `"agent"`를 추가한다 (정의 검증이 통과하게).
- `AgentConfig`를 정의한다: `{ goal: string (필수, 1~2000자), tools?: NodeType[] (쓸 수 있는 도구 목록, 생략 시 기본값 아래), maxSteps?: number (기본 10, 1~10) }`.
- 기본 도구 목록: 레지스트리의 12개 노드 중 `send_email`을 뺀 11개. `send_email`은 `config.tools`에 **명시적으로** 들어 있을 때만 쓸 수 있다 (그래도 승인 게이트는 그대로 탄다).
- `validateDefinition`에서 `agent` 단계의 config를 검증한다: goal 필수·문자열, tools는 NODE_TYPES 원소만 (agent 자기 자신·없는 타입 불가), maxSteps는 1~10 정수. `agent` 노드에 `requiresApproval`을 false로 끄는 것은 허용하지 않는다 (send_email 강제와 같은 원칙 — 에이전트 자체는 승인 게이트를 우회하지 않는다).

### 2. WorkflowAgent DO (`src/workflow/agent-do.ts`)

- 새 DO 클래스 `WorkflowAgent`(SQLite). 한 DO 인스턴스가 **run 1개 + agent 단계 1개**의 루프 상태를 든다. DO id는 `agent:<runId>:<stepIndex>` (문자열 id → `idFromName`).
- DO가 들고 있는 상태 (SQLite `state.storage`, 키-값):
  - `turns`: 지금까지의 턴 기록 배열. 각 턴 = `{ turn, thinking, action, tool?, args?, observation?, error? }`.
  - `lastTools`: 최근에 부른 도구 이름 배열 (같은 도구 3연속 감지용).
  - `pendingAction`: 승인 대기 중인 도구 선택. `{ tool, args, thinking }` 또는 null. 승인 뒤 재개할 때 새 선택을 하지 않고 이것을 실행한다 (아래 §4).
  - `startedAt`, `llmCalls`: 루프 시작 시각, 이 agent 단계에서의 LLM 호출 수.
- DO의 단일 스레드 특성으로 같은 run의 턴이 동시에 도는 것을 막는다 (한 번에 한 요청만 처리).
- DO 메서드 (stub fetch로 부른다 — 경로는 세션이 정한다, 예: `POST /advance`, `POST /observe`, `GET /state`):
  - `advance({ goal, tools, maxSteps, runInput, stepOutputs })`: 한 턴을 진행한다. (a) 멈춤 조건을 먼저 본다 (아래 §3). (b) Qwen3에게 ReAct 선택을 시킨다 (아래 §3의 프롬프트). (c) 결과를 state에 기록하고, 선택된 행동을 돌려준다: `{ status: "tool", tool, args, thinking }` / `{ status: "finish", final, thinking }` / `{ status: "stopped", reason, final? }`.
  - `observe({ tool, observation })`: 도구 실행 결과를 턴 기록에 붙인다 (엔진이 도구를 실행한 뒤 부른다).
  - `setPendingAction({ tool, args, thinking })` / `takePendingAction()`: 승인 대기용. `takePendingAction`은 pending을 꺼내서 돌려주고 null로 지운다 (한 번만 실행되게).
- **DO가 Qwen3를 부른다.** DO 클래스는 생성자에서 `env`를 받아 `env.AI.run`을 쓴다 (기존 `AgentSession` DO가 env를 받는 패턴을 따른다). 모델은 기존과 같은 `@cf/qwen/qwen3-30b-a3b-fp8`, AI Gateway 태그는 `"workflow-agent"`로 한다.

### 3. ReAct 선택 (Qwen3 프롬프트 + 멈춤 조건)

- Qwen3에게 주는 것: 시스템 프롬프트(아래) + 목표 + 지금까지의 턴 기록(생각·행동·관찰, 최근 10턴까지) + 쓸 수 있는 도구 목록(이름·설명·입력 키 — `NODE_REGISTRY`의 description·inputKeys에서 가져온다) + run input·앞 단계 출력 요약.
- 시스템 프롬프트는 한국어로, 다음을 명시한다: (a) 한 번에 도구 하나만 고른다. (b) 목표에 도달했으면 `finish`를 고르고 최종 답을 쓴다. (c) 같은 도구를 반복해서 부르지 않는다. (d) 모르면 추측하지 말고 `finish`로 "할 수 없다"고 밝힌다. (e) 출력은 반드시 JSON 하나만 (아래 형식).
- 응답 형식 (JSON): `{ "thinking": "…", "action": "tool" | "finish", "tool": "<노드 타입>", "args": { … }, "final": "…" }`. `nodes.ts`의 `extractJson` 패턴으로 파싱한다 (펜스·앞뒤 잡문자 허용). 파싱 실패 시 그 턴은 실패로 기록하고, **연속 3회 파싱 실패면 루프를 멈춘다** (reason `"tool_selection_failed"`).
- **멈춤 조건 (반드시 전부 구현한다)**:
  1. `turns.length >= maxSteps` (기본 10) → 멈춤, reason `"max_steps"`.
  2. 같은 도구를 3번 연속으로 부름 → 멈춤, reason `"repeat_tool"`. (`lastTools`의 마지막 3개가 모두 같은 도구면.)
  3. run 시작 후 30분 경과 (WF-3의 run 캡과 같은 기준 — 엔진이 run 시작 시각을 DO에 넘긴다) → 멈춤, reason `"timeout"`.
  4. 이 agent 단계의 LLM 호출이 20회를 넘으면 멈춤, reason `"llm_cap"`. (run 전체 캡 30회는 WF-3 엔진이 이미 세고 있다 — agent 턴의 선택 호출은 `workflow_run_steps` 행이 아니라 DO의 `llmCalls`로 세므로, 이 agent 단계 안에서 따로 20회 상한을 둔다.)
- 멈추면 agent 단계는 **성공으로 끝낸다** (output에 `{ final, turns, stoppedReason }`를 담는다). 단, 파싱 실패 3연속으로 멈춘 경우만 `failed`로 끝낸다 (error에 이유를 적는다). "목표에 도달하지 못했어도, 멈춤 자체는 정상 종료"라는 원칙을 주석에 적는다.

### 4. 엔진 연동 (`src/workflow/engine.ts` + `src/workflow/agent.ts`)

- **엔진은 `agent` 단계를 특별 취급한다.** `processWorkflowStep`에서 `step.type === "agent"`이면 `executeNode`를 부르지 않고 `advanceAgentTurn(env, run, step, ctx)`(새 파일 `src/workflow/agent.ts`)를 부른다. `executeNode`에 `"agent"`가 들어오면 명확한 에러를 던진다 (절대 직접 실행하지 않는다 — 루프는 엔진이 몰아야 한다).
- `advanceAgentTurn`의 흐름 (한 큐 메시지가 한 턴):
  1. DO stub을 만든다 (`env.WORKFLOW_AGENT.idFromName(`agent:${runId}:${stepIndex}`)`).
  2. `pendingAction`이 있으면 (`takePendingAction`): 그 도구를 실행한다 (아래 4번으로). 새 선택을 하지 않는다.
  3. 없으면 DO `advance`를 부른다. 결과가 `finish`면 agent 단계를 **성공**으로 끝낸다 (output `{ final, turns, stoppedReason: null }`, 다음 단계 메시지를 보낸다). `stopped`면 성공으로 끝낸다 (output에 `stoppedReason` 포함). `tool`이면 아래로 간다.
  4. **승인 게이트 (WF-3 §7과 같은 원칙)**: 고른 도구가 `APPROVAL_REQUIRED_NODES`에 있으면, `msg.approved`가 true가 아닐 때 DO에 `setPendingAction`으로 선택을 저장하고, `requestWorkflowApproval`로 알림을 만들고, run을 `waiting_approval`로 바꾸고 return 한다. **다음 단계 메시지를 보내지 않는다.** (승인 뒤 `resumeWorkflowRun`이 `approved:true`로 같은 단계 메시지를 다시 보내면, 2번에서 pending을 꺼내 실행한다.)
  5. 도구를 실행한다: `executeNode(tool, toolCtx, args)` — `toolCtx`는 현재 단계의 `NodeContext`를 재사용하되, `approved`는 `msg.approved === true`로 둔다. 도구 실행은 **별도의 `workflow_run_steps` 행을 만들지 않는다** (agent 단계 1개 행만 있다 — 턴 기록은 DO state + 최종 output에 남긴다).
  6. 결과를 DO `observe`로 기록한다. 도구 실행이 실패하면 그 턴은 observation에 에러를 적고, **다음 턴으로 간다** (도구 실패가 run 전체를 실패시키지 않는다 — 단, 같은 도구가 3연속 실패하면 §3의 repeat 규칙으로 멈춘다).
  7. 같은 단계 메시지를 다시 큐에 넣는다 (`PIPELINE.send({type:"workflow-step", runId, stepIndex, approved: msg.approved, enqueuedAt: ...})`) — 다음 턴을 위해. **이때 run 상태는 `running`으로 유지한다** (단계를 `succeeded`로 바꾸지 않는다 — 아직 안 끝났다).
- **멱등성**: 큐 재전달로 같은 턴이 두 번 오면, DO의 `turns` 길이가 이미 진행된 턴 수와 같으면 두 번째 호출은 state를 바꾸지 않고 같은 결과를 돌려준다 (DO가 턴 번호로 가드한다 — `advance` 호출마다 턴 번호를 받아, 이미 처리한 턴이면 저장된 결과를 반환). 이 가드를 RESULT.md에 적는다.
- **run 전체 캡**: WF-3의 30분 run 캡과 LLM 30회 캡은 그대로 적용된다 (엔진이 `processWorkflowStep` 시작 부분에서 이미 검사한다 — agent 단계도 그 검사를 통과해야 한다).

### 5. 배선 (`wrangler.toml` + `src/index.ts`)

- `wrangler.toml`에 추가한다:
  ```toml
  [[durable_objects.bindings]]
  name = "WORKFLOW_AGENT"
  class_name = "WorkflowAgent"
  [[migrations]]
  tag = "v2"
  new_sqlite_classes = ["WorkflowAgent"]
  ```
  **주의**: 이 태그는 D-2 배포 때 원격 적용된다. 이 세션은 배포하지 않으므로 원격에 v2가 없어도 된다. 로컬 검증은 Miniflare가 처리한다.
- `src/index.ts`에 `export { WorkflowAgent } from "./workflow/agent-do";`를 추가한다 (기존 `AgentSession` export 패턴과 같은 위치·형식).
- `Env` 타입에 `WORKFLOW_AGENT: DurableObjectNamespace`를 추가한다 (어디에 Env가 정의돼 있는지 찾아서 — `src/workflow/types.ts`의 `Env`를 쓴다면 거기에).

### 6. UI에는 손대지 않는다

- WF-5의 폼 빌더는 `agent` 노드를 드롭다운에 **자동으로** 보여준다 (`WF_NODES` 상수가 `NODE_REGISTRY`에서 오는지 확인하고, 아니라면 `agent`를 노드 목록에 추가하는 최소 변경만 한다 — 폼 필드는 goal·tools·maxSteps 3개). 이 세션은 폼 필드의 상세 디자인을 다듬지 않는다 (WF-11에서 다듬는다).

## 검증 (반드시 `files/workflow-verify/wf6/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf6/`)

- `npx tsc --noEmit` 통과.
- 로컬 하네스 (WF-5의 `wf5/` 패턴을 따른다 — `wrangler.toml` + `worker.ts` + Miniflare, AI·VECTOR·fetch는 mock):
  1. **루프 종료**: mock AI가 도구를 2번 고른 뒤 `finish`를 고르면 run이 `succeeded`로 끝나고, 턴 기록이 output에 남는다.
  2. **최대 단계**: mock AI가 계속 도구를 고르면 10턴에서 멈추고 `stoppedReason: "max_steps"`로 성공 종료한다.
  3. **같은 도구 3연속**: mock AI가 같은 도구를 3번 고르면 `stoppedReason: "repeat_tool"`로 멈춘다.
  4. **승인 게이트**: mock AI가 `send_email`을 고르면 run이 `waiting_approval`로 멈추고 메일이 발송되지 않으며, 승인 뒤 같은 도구가 실행되고 run이 `succeeded`로 끝난다 (WF-4의 승인 API 재사용).
  5. **DO 직렬화**: 같은 run의 `advance`를 동시에 2번 부르면, 턴이 1번만 진행된다 (두 번째는 저장된 결과를 받는다).
  6. **격리**: 다른 사용자의 runId로는 DO state를 읽을 수 없다 (DO id에 runId가 들어가지만, 엔진이 owner를 확인하고, 직접 stub 접근은 세션으로 막힌다 — 어떻게 막히는지 RESULT.md에 적는다).
  7. **기존 회귀**: 일반 워크플로우(`llm → create_task`)가 여전히 돌고, 기존 메시지 타입(transcript-pipeline)이 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Workers AI 응답 품질·JSON 파싱률, 실제 DO 원격 동작, 배포·원격 D1, 브라우저 화면).
- **알려진 편차·부채를 RESULT.md에 적는다**: WF-2의 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)를 건드렸는지, 안 건드렸으면 그대로 둘 것. DO가 로컬 검증에서 막히면 D1 폴백(`workflow_runs.agent_state_json`)을 검토하되, **스키마 변경이 필요하면 마이그레이션 파일을 만들지 말고 RESULT.md + PROGRESS.md에 기록한다** (코디네이터가 판단한다).

## 금지

- Agents SDK를 통째로 들이지 않는다 (패턴·예시만 참고 — `cloudflare/agents`의 `examples/workflows/`는 승인 게이트 참고용으로만 본다).
- 코드 실행 노드를 만들지 않는다. 에이전트가 고를 수 있는 도구는 레지스트리의 12개(+agent 제외)뿐이다.
- `src/index.ts`의 `scheduled()`·기존 큐 분기를 바꾸지 않는다. 새 크론을 추가하지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
