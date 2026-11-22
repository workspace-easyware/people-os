# Think + Cloudflare OS 전면 도입 계획 (개정판)

작성일 2026-11-19 (목) 밤. 계획 문서만 썼고 코드·마이그레이션·배포는 건드리지 않았다.
기존 계획(`think-cloudflare-os-adoption-plan.md`, 점진적 도입)의 전제를 뒤집은 문서다. 겹치는 사실 확인은 다시 적지 않고 그 문서의 1장을 참조한다.

---

## 0. 결론 먼저

1. **"큐 엔진까지 갈아엎는 전면 도입"은 6일 안에 하지 않는다.** 할 수 없어서가 아니라 방향이 틀려서다. Cloudflare 문서가 파이버에 대해 "에이전트와 독립적으로 돌고 단계별 재시도가 필요한 일은 Workflows를 쓰라"고 적었고, 파이버 복구는 함수를 다시 돌려 주지 않는다. DAG 실행은 큐에 그대로 둔다.
2. **"Think가 People OS의 운영 에이전트 런타임이 되는 전면 도입"은 6일 안에 할 수 있다. 단, 11-20 하루짜리 관문을 통과해야 한다.** 실험 노드나 별도 Worker가 아니라, 운영 Worker 안에서 에이전트가 도는 모든 자리를 Think로 바꾼다.
3. **기존 템플릿 5개는 회귀 범위 밖이다.** 템플릿 5개는 `agent` 노드를 하나도 쓰지 않는다(`templates.ts` 확인: transcribe·summarize·create_task·email_draft·send_email·create_calendar_event·ask_personal·llm만 사용). 엔진을 건드리지 않으면 템플릿은 코드 경로가 바뀌지 않는다.
4. **Dynamic Workers는 쓰지 않는다. Paid 전환은 필요 없다.** Think 본체·파이버·하위 에이전트·세션은 Worker Loader 바인딩 없이 돈다. Loader가 필요한 것은 확장·코드 실행·스킬 스크립트뿐이고 이것들은 범위에서 뺀다.
5. **Cloudflare OS는 설치·포크하지 않는다.** 저장소를 다시 확인했다: Dynamic Workers와 Facets 위에서 돌고(= Paid 필요), Vite 프런트이며, LLM 계층은 Think가 아니라 Pi다. 가져오는 것은 화면 구성과 승인 개념이고 People OS 코드로 직접 만든다.
6. **최소 범위(동결에 반드시 넣는 것)**: 워크플로 `agent` 노드의 런타임을 Think로 교체 + Think 어시스턴트(영구 세션) 1개 + 하위 에이전트 사용처 1곳 + 에이전트 화면 1개. 그 밖은 4장의 "동결 뒤" 목록으로 간다.

> 요청문 배경 가운데 사실과 다른 점 두 가지. (i) Cloudflare OS는 "Think 부품으로 만든 앱"이 아니다. README에 Think가 없고 Pi(`pi-agent-core`)·Code Mode·Cap'n Web을 쓴다. (ii) 노드는 코드 기준 15종이다(요청문은 12개).

---

## 1. 이번에 새로 확인한 사실

| 항목 | 확인한 내용 | 출처 |
|---|---|---|
| `@cloudflare/think` 버전 | **0.23.0** (저장소 `main`의 `package.json`). README 첫머리: "**Experimental** — the API surface is stable but may evolve before graduating out of experimental." | cloudflare/agents `packages/think` |
| Think 의존성 | peer: `agents >=0.34.0 <1.0.0`, `ai ^7`, `zod ^4`, `@cloudflare/computer ^0.10`. deps: `workers-ai-provider ^4`, `@cloudflare/codemode >=0.5`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `chat`. 문서의 설치 명령은 `@cloudflare/ai-chat`, `@ai-sdk/provider`도 포함 | 같은 `package.json`, Think 문서 |
| Loader 없이 되는 것 | 모델 호출, 에이전트 루프, 메시지 저장, 내구성 복구, 하위 에이전트, 세션·압축, 훅(`beforeTurn`·`beforeStep`·`beforeToolCall`·`afterToolCall`), 워크스페이스 파일 도구 | Think README |
| Loader가 필요한 것 | 확장(`extensionLoader`), 스킬 스크립트 실행, 코드 실행(README에서 이미 deprecated) | Think README |
| 서버에서 턴 실행 | `runTurn()`(wait·submit·stream). submit은 `idempotencyKey`를 받고 같은 키면 `accepted: false`. 추론은 복구 파이버 안에서 돈다. `runTurn()` 자체에 "Experimental" 표시 | Think 문서 |
| 하위 에이전트 | 자식 클래스는 바인딩·마이그레이션 불필요. `agentTool()`·`runAgentTool()`로 부모가 위임. 자식은 알람 슬롯이 없다. 플랜 요건은 문서에 없다 | 하위 에이전트 문서 |
| 파이버 | 복구는 재실행이 아니다("The original lambda is gone"). 마지막 `stash`만 받는다. 복구 재시도 기본 24시간 | 내구성 실행 문서 |
| 클라이언트 | 문서의 클라이언트는 React(`useAgentChat`)뿐. WebSocket 프로토콜(`cf_agent_chat_*`)의 비-React 사용법은 문서에 없다 | Think 문서·README |
| Dynamic Workers | "currently only available on the Workers Paid plan" | 가격 문서 |
| Free 플랜 한도 | HTTP 요청당 CPU 10ms, 요청당 하위 요청 50개, Cron 5개 | Workers 한도 문서 |
| Cloudflare OS | Apache-2.0, "Early access", "heavy development", 외부 기여 받지 않음. 워크스페이스마다 DO 1개, 가젯은 Dynamic Worker Facet에서 실행. pnpm + Vite. 루트 `wrangler.jsonc`는 `dev-router` 하나이고 나머지 설정은 스크립트가 생성 | 저장소 README·설정 파일 |
| People OS 현재 | wrangler **3.114.17**, `compatibility_date = "2025-07-18"`, DO 마이그레이션 v1~v3, D1 마이그레이션 0039까지, `zod`는 간접 의존성으로만 존재, `agents`·`ai` 없음 | 로컬 파일 |

**확인하지 못한 것**

- `files/workflow-verify/video-conference-v0/RESULT.md` 9절: 이 세션의 읽기 권한이 `files/people-os/` 안으로 제한돼 열지 못했다. 화상회의 범위는 커밋 `b30b244`, 마이그레이션 0038·0039, `src/meet/*`, `public/meet.*`, `src/chat/room.ts`·`routes.ts`, `src/calendar/routes.ts`로 추정했다. **T1 착수 전에 9절을 읽고 5장 겹침 표를 대조해야 한다.**
- npm 레지스트리 조회가 막혀 배포일·dist-tag는 못 봤다. 0.23.0은 저장소 기준이라 npm `latest`와 다를 수 있다.
- wrangler 3.114.17로 Think가 빌드·배포되는지. 하위 에이전트는 `ctx.exports`를 쓰므로 최신 `compatibility_date`와 wrangler 4가 필요할 가능성이 높다.
- `@cf/qwen/qwen3.8-27b`가 AI SDK 도구 호출로 안정적인지.
- Think에서 턴을 도구 호출 직후에 끝내는 정확한 방법, 승인 API의 세부(Actions 문서를 읽지 않았다).
- Free 플랜 CPU 10ms가 DO 안에서 도는 Think 루프(스트림 파싱·SQLite 쓰기)에 걸리는지.
- DO 마이그레이션을 넣은 뒤 `wrangler rollback`으로 그 이전 버전에 돌아갈 수 있는지. 문서상 DO 마이그레이션이 다른 버전으로의 롤백은 막힌다고 알고 있으나 이번에 다시 읽지 않았다.

이 가운데 뒤 다섯 개가 11-20 관문의 점검 항목이다.

---

## 2. 전면 도입의 범위

### 2.1 넣는 것 (동결 범위)

| # | 요소 | People OS에 넣는 모습 | 등급 |
|---|---|---|---|
| A | Think 기본 클래스 | 새 DO `ThinkAgent`(가칭) = `Think` 서브클래스. 도구는 `NODE_REGISTRY`에서 AI SDK 도구로 변환(설명·입력 키가 이미 있다). 모델은 `getModel()`로 Workers AI | 필수 |
| B | 파이버 내구성 실행 | 따로 만들지 않는다. `runTurn()`이 복구 파이버 안에서 돌므로 A에 따라온다. 현재 약점("실행 중 죽으면 60분 뒤 실패, 자동 재개 없음")이 agent 단계에서 사라진다 | 필수(A에 포함) |
| C | 워크플로 `agent` 노드 런타임 교체 | 엔진은 agent 단계 메시지를 받으면 `ThinkAgent`에 `submit`(키 = `runId:stepIndex`)하고 끝낸다. DO가 루프를 스스로 돌고, 끝나면 결과를 D1에 쓰고 `workflow-step` 메시지를 넣어 엔진을 깨운다 | 필수 |
| D | 영구 세션 | 새 "어시스턴트" 에이전트(사용자당 DO 1개). 대화가 DO SQLite에 남고 압축·검색이 된다. 답 생성은 기존 `ask-pipeline`을 **도구로** 부른다 | 필수 |
| E | 하위 에이전트 | 1곳: 어시스턴트의 "조사" 위임. 부모가 `agentTool()`로 자식(자료 수집)을 부르고 결과를 합친다. 자식은 바인딩·마이그레이션이 필요 없다 | 권장 |
| F | Cloudflare OS식 에이전트 화면 | 새 메뉴 "에이전트": 내 에이전트 목록(어시스턴트 + 워크플로 agent 실행), 실행 중 표시, 도구 호출 기록, 승인 대기. 순수 HTML+JS로 만든다 | 필수(축소판) |
| G | Cloudflare OS식 승인(Gatekeeper 개념) | 부작용 도구(`send_email`·`webhook`)는 Think 훅 `beforeToolCall`에서 막고 기존 승인 게이트로 보낸다. 승인 화면은 지금의 `approval.js`를 쓴다 | 필수 |
| H | 추적 | `[observability.traces]`를 켜 대시보드 Agents 화면에 스팬이 보이게 한다. 기존 D1+R2 트레이스는 그대로 | 권장 |

### 2.2 넣지 않는 것

| 요소 | 이유 |
|---|---|
| DAG 엔진의 파이버 전환 | 0장 1번. 큐 재전달 멱등성·오래된 승인 차단·활성 시간 계산을 `onFiberRecovered`로 다시 쓰면 11-18에 끝낸 전체 점검이 무효가 된다 |
| Dynamic Workers·Code Mode·확장 | Paid 전용. 도구가 13종이라 Code Mode로 줄일 토큰도 거의 없다 |
| Cloudflare OS 설치·포크, 가젯·블루프린트, Cap'n Web | Paid 필요, 프런트 스택이 다름, early access, Think와 무관 |
| 기존 질문 탭(`ask-pipeline`, `AgentSession` DO)의 교체 | 골든셋 평가(5/6, 6/6 기록)가 이 경로에 묶여 있다. 답 경로를 바꾸면 평가를 처음부터 다시 해야 한다. 어시스턴트가 이 파이프라인을 도구로 부르는 것으로 충분하다 |
| React 클라이언트(`useAgentChat`) | 프런트가 빌드 없는 HTML+JS다. 2.4 참조 |
| 일괄 승인 + 시뮬레이션(기존 계획 P1~P3) | 엔진·노드·승인 API를 모두 고치는 작업이라 Think 교체와 같은 6일에 겹치면 승인 게이트가 두 군데서 동시에 바뀐다. 동결 뒤 |

### 2.3 기존 엔진과의 관계 — 얹는다, 단 agent 자리는 교체한다

```
[그대로] 큐 엔진(engine.ts) ── 단계마다 메시지 1개 ── 일반 노드 14종(nodes.ts)
                │
                └─ agent 단계 ──▶ [교체] ThinkAgent DO (runTurn submit, 복구 파이버)
                                     │  도구 = NODE_REGISTRY → AI SDK 도구 → executeNode()
                                     │  부작용 도구 → beforeToolCall에서 차단 → 기존 승인 게이트
                                     └─ 끝나면 D1 기록 + workflow-step 메시지로 엔진 재개

[새로] 어시스턴트 = ThinkAgent(사용자당 1개, 영구 세션) ──▶ 하위 에이전트(조사)
[그대로] 질문 탭 = ask-pipeline + AgentSession DO
```

- **갈아엎는 것**: `WorkflowAgent` DO의 직접 만든 ReAct 루프(`agent-do.ts` 296줄), `agent.ts`의 턴 진행(143줄). 합쳐 약 440줄.
- **그대로 두는 것**: `engine.ts`, `nodes.ts`의 노드 구현, `approvals.ts`, `routes.ts`의 승인 API, 스케줄·공유·웹훅, 한도(동시 3·하루 20·활성 30분·LLM 30회).
- **한도 이관**: 현재 agent 한도(10스텝, LLM 20회, 28분, 같은 도구 3회 반복 시 멈춤)를 Think 훅으로 다시 만든다. `beforeStep`에서 스텝 수·경과 시간을, `beforeToolCall`에서 반복을 센다. 관문에서 최소 스텝 상한과 시간 상한이 재현돼야 한다.
- **옛 런타임은 지우지 않는다.** `[vars] AGENT_RUNTIME = "think" | "legacy"`로 고르고 `WorkflowAgent` 클래스·바인딩·v2 마이그레이션은 남긴다. 5장의 롤백이 이것에 기댄다.
- **회귀 범위**: 템플릿 5개는 0. agent 노드를 쓰는 사용자 정의 워크플로와 관측 화면의 agent 턴 표시(`obs/routes-workflows.ts`가 단계 output의 `turns`를 읽는다)만 해당한다. Think 쪽 출력을 지금의 `turns` 모양으로 맞춰 써서 관측 API는 고치지 않는다.

### 2.4 프런트 연결 (React 없이)

Think의 WebSocket 프로토콜은 React 훅 밖의 사용법이 문서에 없다. 프로토콜을 직접 구현하지 않는다.

- Hono 라우트 `POST /api/agents/:id/messages`가 DO를 RPC로 부른다. DO는 `runTurn({ mode: "submit" })`으로 받고 바로 돌려준다.
- 화면은 `GET /api/agents/:id/events`로 진행을 받는다. 1안은 DO의 `chat()` 스트림 콜백을 SSE로 넘기는 것, 2안은 2초 폴링이다. 관문에서 1안이 반나절 안에 안 되면 2안으로 간다. 데모 영상에서는 차이가 거의 안 보인다.
- 인증은 기존 세션 쿠키 + 역할 검사를 그대로 탄다. `routeAgentRequest`로 DO를 바깥에 직접 열지 않는다(열면 기존 이중 게이트를 우회한다).

---

## 3. Dynamic Workers와 플랜

- **이 설계는 Dynamic Workers가 필요 없다. Paid 전환을 권고하지 않는다.**
- 조건부 예외 하나: 관문에서 Think 루프가 Free의 CPU 10ms 한도로 죽으면, 선택지는 (i) Workers Paid 월 $5 전환, (ii) 전면 도입 축소(6장 대안) 둘이다. 이때는 (i)을 권한다. $5로 일정 전체가 살고, 공모전 요건은 플랜을 따지지 않는다. Paid로 가더라도 Dynamic Workers는 동결 범위에 넣지 않는다.
- Cron은 늘리지 않는다(5개 중 3개 유지). Think 예약 작업은 DO 알람을 쓰므로 Cron 한도와 무관하다.

---

## 4. 일정 (11-20 ~ 11-25)

목표 일정이다. 작업량을 실측한 값이 아니다.

| 날짜 | 단계 | 통과 기준 | 세션 |
|---|---|---|---|
| 11-20 (금) | **T0 관문**. 기준점 커밋·태그, wrangler 4 + 의존성 설치, 별도 Worker `people-os-think-gate`에 `ThinkAgent` 배포 | 아래 관문 6항목 | Fable(문제 해결) |
| 11-21 (토) | **T1** 운영 Worker에 `ThinkAgent` DO(v4) + 도구 변환 + 승인 차단 + 한도 훅 + 엔진 연결. `AGENT_RUNTIME=legacy`로 배포해 무해함 확인 | `tsc` 통과, 로컬 하네스 7항목, legacy 상태에서 라이브 변화 없음 | Opus |
| 11-22 (일) | **T2** 어시스턴트(영구 세션) + Hono 라우트 + 진행 이벤트 + `ask-pipeline` 도구 | 대화가 DO 재시작 뒤에도 남는다, 다른 사용자의 에이전트는 404, 질문 탭 평가 재실행 결과가 전과 같다 | Opus |
| 11-23 (월) | **T3** 에이전트 화면 + 하위 에이전트(조사) + 추적 켜기. `AGENT_RUNTIME=think`로 전환 | 화면에서 실행·도구 기록·승인 대기가 보인다, 하위 에이전트 결과가 부모 답에 들어온다 | Sonnet(화면) / Opus(하위 에이전트) |
| 11-24 (화) | **회귀 검증** + 문서·대본 갱신 | 아래 회귀 목록 전부 | Opus |
| 11-25 (수) | 예비일. 새 기능 금지, 수정만. 동결 | 라이브 버전 ID 확정, GitHub 백업 | — |

### T0 관문 (11-20 밤에 판정)

1. wrangler 4로 올린 뒤 **기존 People OS가 그대로 빌드·배포 가능**하다(`cf-wrangler.py deploy --dry-run`, `tsc`). `compatibility_date`를 올려야 하면 그 영향도 여기서 본다.
2. Think 0.23.0(정확히 고정)이 Free 플랜 Worker에 배포되고 한 턴이 끝난다.
3. `qwen3.8-27b`가 도구 3개(`ask_rag`·`create_task`·`email_draft` 흉내)를 10회 중 8회 이상 올바로 고른다. 안 되면 문서 예시 모델(`@cf/moonshotai/kimi-k2.6`)로 같은 시험을 한다.
4. 스텝 상한·시간 상한이 훅으로 걸리고, `beforeToolCall`에서 부작용 도구를 막은 뒤 턴이 정상 종료된다.
5. 10스텝짜리 턴이 Free CPU 한도 오류 없이 끝난다(3회 반복).
6. 실행 중 DO를 죽여도(재배포) 턴이 복구되거나, 최소한 "중단됨"으로 정리돼 엔진에 실패가 전달된다.

**판정**: 1~5 통과면 T1로 간다. 6만 실패하면 진행하되 복구는 "실패로 정리"까지만 약속한다. **1이 실패하면 그날로 중단하고 6장 대안으로 간다** — 운영 빌드 도구를 못 올리면 운영에 넣을 방법이 없다. 3이 두 모델 모두 실패하거나 5가 실패하고 Paid 전환도 안 하면 역시 대안으로 간다.

### 11-24 회귀 검증

하네스·기록은 `files/workflow-verify/think-full/` 아래에 둔다(`/tmp` 금지).

1. **템플릿 5개**를 라이브에서 한 번씩 실행. 휴가 승인·지출 결재는 승인 대기 → 승인 → 완료, 거절 경로도 한 번.
2. **agent 노드**: 같은 목표 3개를 `legacy`와 `think`로 돌려 완료 여부·멈춤 사유·승인 요청 횟수를 비교. 승인 전에 메일·웹훅이 나가지 않았음을 확인. 같은 큐 메시지 두 번 → 한 번만 실행.
3. **한도**: 동시 3·하루 20·활성 30분·LLM 30회가 Think 경로에서도 걸린다. Think의 LLM 호출이 run 전체 30회 캡에 합산된다.
4. **DO 5종**: 채팅방(ChatRoom) 송수신·읽음, 알림 토스트(NotificationHub), 질문 레이트 리미터(RateLimiter) 제한 동작, AgentSession 대화 이어짐.
5. **질문·평가**: 골든셋 평가 재실행, 03:00 KST 평가 cron 다음 실행 확인, 관측 탭에서 agent 턴 표시.
6. **화상회의 V0~V2**: 방 생성 → 2인 입장 → 타일 표시 → 채팅 → 종료 뒤 전사 파이프라인. wrangler·`compatibility_date`를 올렸으므로 큐 소비자(`transcript-pipeline`)와 RealtimeKit 호출을 반드시 본다.
7. **기타 live**: 로그인(이중 게이트), 결재, LMS, 메일, 캘린더, Plaud 가져오기 — 각 화면 진입과 대표 동작 1개.

실패 항목이 11-24 밤까지 안 풀리면 `AGENT_RUNTIME=legacy`로 돌려 배포하고, 어시스턴트·에이전트 화면은 메뉴에서 숨긴다.

### 동결에 못 맞추면 — 잘라내는 순서

뒤에서부터 뺀다: H 추적 → E 하위 에이전트 → F 에이전트 화면의 도구 기록·드릴인(목록만 남김) → D 어시스턴트. **C(agent 노드의 Think 런타임)는 마지막까지 남긴다.** C만 남아도 "운영 에이전트가 Think 위에서 돈다"는 말은 사실이다.

**동결 뒤로 가는 것**: 일괄 승인 + 시뮬레이션, 관찰 기록·오염 규칙, 질문 탭의 세션 교체, 능력 기반 자원 범위, Dynamic Workers·Code Mode(Paid 전환 시), DAG 실행의 Cloudflare Workflows 이전 검토.

---

## 5. 위험과 롤백

| # | 망가질 수 있는 것 | 왜 | 대응 |
|---|---|---|---|
| R1 | **모든 기능** | wrangler 3→4, `compatibility_date` 2025-07-18→최신, `zod` 4·`ai` 7 추가는 Think와 무관한 코드에도 닿는다. 이번 계획에서 가장 큰 위험이다 | T0 1번에서 Think를 넣기 전에 도구만 올려 단독으로 검증. `compatibility_date`는 Think가 요구하는 최소로만 올린다 |
| R2 | 롤백 | DO 마이그레이션 v4를 배포한 뒤에는 `wrangler rollback`으로 `d48c8b4e`에 못 돌아갈 수 있다 | 롤백을 "앞으로 가는 배포"로 설계: `AGENT_RUNTIME=legacy`로 바꿔 재배포. `ThinkAgent` 클래스는 export를 유지한다. v4는 11-21에 `legacy` 상태로 먼저 넣어 하루 묵힌다 |
| R3 | 승인 게이트 | 부작용 도구가 Think 루프 안에서 승인 없이 실행 | 방어 두 겹 유지: `beforeToolCall` 차단 + 노드의 `ctx.approved !== true` 검사(지금 있는 2차 방어, 고치지 않는다). 하네스에서 "승인 전 발송 0건"을 매 단계 확인 |
| R4 | 템플릿 5개 | 엔진을 건드리면 | 엔진 수정은 agent 분기 한 곳으로 제한. 다른 줄을 고쳐야 하면 멈추고 보고 |
| R5 | DO 레이트 리미터·채팅·알림 | 같은 `wrangler.toml`의 DO 블록·마이그레이션을 고친다 | v4는 `new_sqlite_classes = ["ThinkAgent"]` 추가만. 기존 v1~v3과 바인딩은 건드리지 않는다 |
| R6 | 관측·평가 | agent 단계 output 모양이 바뀌면 관측 화면이 깨진다. 질문 경로를 건드리면 평가가 깨진다 | output을 기존 `turns` 모양으로 맞춘다. 질문 탭은 범위 밖 |
| R7 | 화상회의 V1+V2 | 방금 배포돼 검증 이력이 짧고, R1의 도구 업그레이드에 노출된다. `src/chat/room.ts`를 화상회의가 고쳤다 | Think 작업은 `src/meet/*`·`src/chat/*`·`public/meet.*`를 건드리지 않는다. 회귀 6번 |
| R8 | Free 한도 | CPU 10ms, 하위 요청 50개(도구 많은 턴), Workers AI 일일 무료분을 Think 루프가 더 빨리 쓴다 | T0 5번. 턴당 스텝 상한 10 유지. 초과 시 3장의 조건부 Paid |
| R9 | 모델 | Qwen이 AI SDK 도구 호출에 약하면 모델을 바꿔야 하고, 판단 품질을 다시 봐야 한다 | T0 3번. agent 경로만 모델을 바꾸고 질문 경로 모델은 그대로 |
| R10 | 제출 직전 패키지 변경 | Think는 experimental | 버전을 범위 없이 정확히 고정하고 `package-lock.json`을 커밋. 동결 뒤 `npm install` 금지 |
| R11 | 기존 `WorkflowAgent`로 진행 중인 run | 전환 순간에 걸친 run | `AGENT_RUNTIME`은 run 시작 때 읽어 run에 기록하고 끝까지 그 런타임으로 돈다 |

**롤백 지점**

| 지점 | 상태 | 돌아가는 법 |
|---|---|---|
| P0 | 지금. 라이브 `d48c8b4e`, GitHub `96fa4c82` | T0 착수 전에 로컬 커밋 + 태그 `pre-think`. v4 배포 전까지는 `wrangler rollback` 가능 |
| P1 | 11-21 밤. v4 배포됨, `legacy` | 여기서부터는 재배포로만 되돌린다. 태그 `think-t1` |
| P2 | 11-23 밤. `think` 전환 | `AGENT_RUNTIME=legacy` 재배포 + 메뉴 숨김. 태그 `think-t3` |
| P3 | 11-24 밤. 회귀 통과 | 동결 후보. 태그 `freeze-candidate` |

D1 마이그레이션은 추가만 한다(다음 번호 0040). 적용 전 `migrations list --remote`로 추적 상태를 확인하고 단일 파일로 적용한다.

---

## 6. 관문이 실패했을 때의 현실적인 범위

T0가 실패하면 "운영 전면 도입"은 접고 다음으로 간다.

- Think는 **별도 Worker**(`people-os-think-gate`)에 어시스턴트만 띄우고 People OS가 서비스 바인딩이 아닌 HTTP로 부른다. 운영 Worker의 빌드 도구·DO는 손대지 않는다.
- 남는 날은 기존 계획의 P1~P3(일괄 승인 + 시뮬레이션)에 쓴다.
- 문서 표기는 "Think 기반 어시스턴트를 별도 Worker로 연동"으로 정확히 적는다.

---

## 7. 데모·제출 반영

| 산출물 | 바꾸는 내용 |
|---|---|
| 데모 대본 (`DEMO-SCRIPT.md`) | "1:35–2:15 워크플로우 + 승인" 장면은 그대로 둔다(템플릿은 안 바뀐다). 지금 "미리 돌려 둔 결과를 1~2초 비춘다"로 돼 있는 에이전트 노드 대목을 **에이전트 화면 10~15초**로 바꾼다: 목표 입력 → 도구를 고르는 기록 → 메일 도구에서 승인 대기. 2:50 길이를 지키려면 채팅(15초)이나 코칭 리플렉션(15초)에서 5초씩 줄인다. LLM 대기는 컷 |
| pitch | 한 줄 추가: "에이전트 런타임은 Cloudflare Agents SDK의 Think 위에서 돈다 — 실행 중 끊겨도 이어지고, 하위 에이전트에 일을 나눈다. 밖으로 나가는 동작은 사람이 승인한다." |
| README | Cloudflare 기능 표에 Agents SDK(Think) 행 추가. "정직한 상태"에 Think가 experimental이고 버전을 고정했다는 것, DAG 실행은 큐라는 것, Dynamic Workers는 쓰지 않는다는 것을 적는다 |
| ARCHITECTURE | 3.5절(DO)에 `ThinkAgent` 추가, 5장에 2.3의 그림, 10장 로드맵에 4장의 "동결 뒤" 목록 |
| 다이어그램 | 큐 엔진 옆에 Think DO 상자 1개와 하위 에이전트 1개. 질문 경로는 그대로 |

**표현 규칙**

- 쓸 수 있는 말: "에이전트가 Think(`@cloudflare/think`, experimental) 위에서 돈다", "Cloudflare OS의 승인·에이전트 화면 설계에서 착안해 직접 구현했다".
- 쓰면 안 되는 말: "Cloudflare OS를 도입했다", "워크플로 엔진이 Think로 돈다", "샌드박스에서 코드를 실행한다".
- 잘라내기로 E·D가 빠지면 pitch의 "하위 에이전트"·"영구 세션" 문구도 같이 뺀다.

**공모전 요건**: Workers + D1에 더해 R2·KV·Vectorize·DO·Queues·Workers AI·RealtimeKit를 이미 쓰므로 "다른 제품 1개 이상"은 지금도 충족한다. Think는 요건을 바꾸지 않고 Agents SDK 사용이 하나 더해질 뿐이다. Free 플랜 유지도 요건과 무관하다.

---

## 8. 사용자 결정이 필요한 것

1. **범위 정의에 동의하는가**: "전면 도입 = 운영의 에이전트 자리 전부를 Think로, DAG 엔진은 큐 유지". 엔진까지 바꾸길 원하면 템플릿 5개와 11-18 점검이 전부 회귀 대상이 되고, 11-25 동결은 지킬 수 없다고 본다. *권고: 이 정의대로.*
2. **wrangler 4 업그레이드 승인**: 운영 전체에 닿는 변경이다(R1). *권고: T0에서 단독 검증 후 진행.*
3. **CPU 한도 실패 시 Paid($5/월) 전환 여부**를 미리 정해 둔다. *권고: 전환.*
4. **모델 교체 허용 여부**: Qwen이 관문 3번에 실패하면 agent 경로만 다른 Workers AI 모델로 바꾼다. *권고: 허용.*
5. **`RESULT.md` 9절 대조**: 이 세션이 못 읽었다. T1 세션에 읽기 권한을 주거나 요점을 전달해야 한다.
6. **기존 계획의 일괄 승인(P1~P3)을 동결 뒤로 미루는 데 동의하는가.** *권고: 동의. 둘을 같이 하면 승인 게이트가 두 갈래로 동시에 바뀐다.*

---

## 출처

- Think 패키지: https://github.com/cloudflare/agents/tree/main/packages/think (`package.json`, `README.md`)
- Think 문서: https://developers.cloudflare.com/agents/api-reference/think/
- 하위 에이전트: https://developers.cloudflare.com/agents/api-reference/sub-agents/
- 내구성 실행: https://developers.cloudflare.com/agents/api-reference/durable-execution/
- Dynamic Workers 가격: https://developers.cloudflare.com/dynamic-workers/pricing/
- Workers 한도: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare OS: https://github.com/cloudflare/cloudflare-os (README, `wrangler.jsonc`, `cloudflare.config.ts`)
- 기존 계획: `files/people-os/think-cloudflare-os-adoption-plan.md`
