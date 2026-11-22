# Think 전면 도입 T1 결과 (2026-11-20 새벽, Opus 5.5 단일 세션)

## 판정

| 통과 기준 | 판정 | 근거 |
|---|---|---|
| `npx tsc --noEmit` 오류 0 | ✅ | 운영(`tsconfig.json`)·하네스(`t1-harness/tsconfig.json`) 둘 다 출력 없음 |
| 로컬 하네스 7항목 | ✅ 7/7 (조건 2개) | 아래 표. 실제 모델 호출은 로컬 dev에서 막혀(샌드박스 프록시 TLS 오류) 원격 시험 Worker에서 했다. 7번은 로그인 없이 볼 수 있는 범위만 |
| `AGENT_RUNTIME=legacy` 배포 후 라이브 변화 없음 | ✅ | 스모크 9건 배포 전후 상태 코드·크기·sha256 전부 동일, D1 바인딩이 운영 DB임을 버전 정보로 확인, 크론 틱 꼬리 로그는 아래 "배포 후 크론" 절 |

- **라이브 버전**: `7931eb4a-af8d-412c-97b3-1e95e0df66d3` (people-os, 2026-11-19 16:16Z 무렵 = 11-20 01:16 KST). 직전 버전 `d48c8b4e-f3df-4ada-a236-54e5e54f8674`.
- **이 배포가 wrangler 4.165.0으로 만든 첫 운영 배포다.** (T0는 dry-run만)
- 커밋·태그는 하지 않았다 (`think-t1` 태그는 Merlin이).

## 구현한 것

| 파일 | 내용 |
|---|---|
| `src/workflow/think-agent.ts` (새 파일) | `ThinkAgent extends Think<Env>`. 도구 변환(`buildNodeTools`, `nodeInputSchema`), 훅(`beforeTurn`·`beforeStep`·`beforeToolCall`·`afterToolCall`·`onStepFinish`·`onChatRecovery`·`onSubmissionStatus`), 엔진 RPC(`startStep`·`resumeApproved`·`inspect`), 결과 전달(`deliver`) |
| `src/workflow/agent-think.ts` (새 파일) | 엔진 쪽 연결: `pickAgentRuntime`(단계별 런타임 결정), `advanceThinkAgentStep`(첫 메시지·깨움 메시지·승인 메시지) |
| `src/workflow/engine.ts` | **agent 분기 한 곳만**: 런타임을 고르고 think면 `advanceThinkAgentStep`, 아니면 기존 `advanceAgentTurn`. 보조 함수 `priorLlmCalls` 추가. 다른 줄은 import 1줄 외에 그대로 |
| `src/workflow/agent.ts` | `approvalSummary`에 `export`만 붙였다 (동작 변화 없음) |
| `src/workflow/types.ts` | `Env`에 `ThinkAgent?`·`AGENT_RUNTIME?`, `WorkflowStepMessage`에 `thinkSubmissionId?` |
| `src/index.ts` | `export { ThinkAgent }` 1줄 + `Env` 필드 2줄. **V1+V2가 고친 3곳(import·`finishTranscript`·`setMeetHooks`+`sweepMeetings`)은 건드리지 않았다.** 크론·큐 소비자 코드도 그대로 |
| `wrangler.toml` | `[[durable_objects.bindings]] ThinkAgent`, `[[migrations]] v4 new_sqlite_classes = ["ThinkAgent"]`, `[vars] AGENT_RUNTIME = "legacy"`. 그 밖은 그대로 (`compatibility_date` 2025-07-18 유지) |
| `migrations/0040_workflow_agent_think.sql` (새 파일) | `workflow_agent_steps` 표 (run_id, step_index PK; runtime, submission_id, status, result_json, consumed_submission, steps, llm_calls). **원격 적용 완료** (적용 전 `migrations list --remote`에서 0039는 적용 상태, 0040만 대기였다) |

`WorkflowAgent` 클래스·바인딩·v2 마이그레이션은 그대로 남아 있다. 건드리지 말 파일(`src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`)은 수정하지 않았다 (`git status`로 확인: 수정 파일은 위 5개뿐).

### 동작 설계 요약

- **인스턴스 = run 1개의 agent 단계 1개** (`think:<runId>:<stepIndex>`). legacy와 같은 단위. 바인딩 이름은 T0 게이트와 같게 클래스 이름 `ThinkAgent` 그대로 뒀다 (게이트에서 검증된 구성).
- **런타임 결정 (R11)**: agent 단계가 처음 시작될 때 한 번 정한다. `workflow_agent_steps`에 행이 있으면 그 런타임, 없고 `AGENT_RUNTIME !== "think"`면 legacy(행을 쓰지 않음 — legacy 경로의 D1 쓰기는 늘지 않고 SELECT 1회만 는다), think 모드에서도 이미 진행 중인 legacy 단계(agentTurn ≥ 1 또는 승인 재개)는 legacy. legacy 모드에서 표 조회가 실패하면 legacy로 본다. 계획의 "run 시작 때 기록"과 달리 **단계 단위**로 고정한다 — 진행 중인 단계가 런타임을 바꾸지 않는다는 목적은 같고, run 생성 경로(routes·schedules)를 고치지 않아도 된다.
- **엔진 연결 (C)**: 첫 메시지 → 점유를 풀고(running→pending) `startStep` = `runTurn({mode:"submit", submissionId = idempotencyKey = "runId:stepIndex"})` → 엔진 종료. DO가 턴을 끝내면 `onSubmissionStatus`(종료 상태 + 현재 제출일 때만) → D1 `workflow_agent_steps`에 결과 → `{type:"workflow-step", thinkSubmissionId}` 메시지. 엔진은 메시지의 제출 id가 D1 행과 같을 때만 결과를 읽고 `complete`/`fail`/`pause`(기존 훅 그대로) 후 `consumed_submission`을 남긴다. DO는 2분마다 최대 5번 `consumed_submission`을 보고 안 됐으면 다시 깨운다 (깨움 메시지가 점유 경합으로 버려지는 경우 대비). 연결 기준은 `submissionId` (복구 턴은 requestId가 바뀐다).
- **승인 차단 (G)**: `send_email`·`webhook`(그리고 `requiresApproval:true` agent면 모든 도구)은 `beforeToolCall`에서 `block` → 저장소 `pending` + 멈춤 사유 `approval_required` → 턴 종료 → 엔진이 기존 `requestWorkflowApproval`(알림 `wfapr_<run>_<step>_t<turn>`, 결재함, `approval.js`)로 멈춘다. 승인 메시지 → `resumeApproved`: `pending`을 첫 await 전에 지워(같은 승인 두 번 → 두 번째는 noop) 그 도구 1개만 `approved=true`로 실행 → 결과를 담아 이어지는 턴 제출(`runId:stepIndex:a<n>`). 2차 방어(노드의 `ctx.approved !== true` 검사)는 그대로이고, 루프 안의 도구 실행은 항상 `approved:false`.
- **멱등 키 (T0 주의 1)**: DO SQLite `pos_fx` 원장. 부작용 도구는 키 `runId:stepIndex:toolCallId`, "시작" 표시를 실행 전에 남겨 **최대 1회**(끊긴 뒤 재시도는 다시 실행하지 않고 "결과 불명"). 일반 도구는 키 `도구+입력`, 끝난 실행은 저장된 결과를 돌려준다.
- **한도 (저장소 누적값)**: `steps`·`modelCalls`·`llmCalls`·`activeSinceMs`·`lastTools`·`stop`·`pending`·`turns`가 전부 `pos_kv`에 있다. `beforeTurn`이 `turnBase`(턴 시작 시 누적 스텝)를 저장하고 `maxSteps = 남은 수`, `stopWhen = turnBase + steps.length`로 판정. `beforeStep`은 넘었으면 도구를 닫는 예비. `beforeToolCall`은 시간·승인·LLM 예산·반복을 센다. `onChatRecovery`는 이미 멈춘 상태면 `continue:false`.
  - 스텝 10 (agent 설정 `maxSteps`, 최대 10), agent LLM 20회(`AGENT_LLM_CAP`), **run 전체 LLM 30회 캡** = 엔진이 넘기는 `llmBudget = 30 − (앞 LLM 노드 단계 수 + 다른 agent 단계 turns 길이)`; DO가 모델 스텝 + LLM 도구(ask_rag·llm·email_draft 등) 호출을 합산, 시간 28분(엔진의 활성 시작 시각부터, 승인 재개 때 갱신), 같은 도구 3회 연속.
- **관측 호환**: 단계 output은 `{ final, turns, stoppedReason }` + `runtime:"think"`, `submissionId`, `steps`, `llmCalls`. `turns`는 **모델 스텝 1개 = 1항목**(`AgentTurn` 모양: turn·thinking·action(tool/finish/invalid)·tool·args·observation·at; 한 스텝에 도구가 여러 개면 `calls` 추가). `obs/routes-workflows.ts`가 `turns.length`를 LLM 호출 수로 세는 것과 맞다. 관측 API는 고치지 않았다.
- **도구 좁히기**: Think가 제공하는 도구는 21개(기본 7 + 노드 14)였고 `activeTools`로 agent 설정의 도구만 열었다 (예: `["llm","create_task"]`).

## 하네스 7항목

하네스 위치: `files/workflow-verify/think-full/t1-harness/` (`harness.ts`, `wrangler.toml`, 결과 `out-*.json`). 운영 코드를 그대로 import하고, 시험용 서브클래스 `HarnessThinkAgent`는 (i) 대본대로 도구를 부르는 모의 모델(`MockLanguageModelV4`), (ii) 줄인 한도, (iii) 노드 실행 계수·모의 실행만 덧씌운다. 훅·판정·승인·전달 코드는 운영 것이 돈다. 로컬 D1에 0001~0040 전부 적용(새 persist 디렉터리, 오류 없음).

**로컬 dev에서 실제 모델 호출 불가**: Workers AI 원격 바인딩이 `TLS handshake failed: received corrupt message of type InvalidContentType`로 실패한다 (샌드박스 프록시 — workerd가 프록시를 거치지 못함). 그래서 실제 모델(Qwen) 시험은 T0 게이트 방식의 **별도 시험 Worker** `people-os-t1-harness`(같은 harness.ts, AI + DO 2개만, D1·큐·KV·R2 없음, 시험 창 11-20 03:30 KST까지, 버전 `c27611b4-c2a7-4597-a2d5-3f30079ce028`)에서 했다.

| # | 항목 | 판정 | 증거 |
|---|---|---|---|
| 1 | `tsc` 오류 0 | ✅ | 운영·하네스 모두 출력 없음 |
| 2 | DO 생성 → submit → 턴 완료 | ✅ | 원격 `/turn-remote?run=r1` (실제 Qwen): `submissionId r-turn-r1:0 accepted`, 10.1초, `completed`, 2스텝(`llm` 도구 → 답 "번역 결과: \"Good morning.\""), `llmCalls 3`(모델 2 + llm 도구 1), `trigger: submission`, 활성 도구 `[llm, create_task]` / 제공 21. `t1-remote/out-turn-remote-r1.json`. 로컬(모의 모델)에서도 같은 생명주기로 완료 (6번). 로컬 실제 모델 시도는 위 TLS 오류로 `failed` → 이 실패도 결과 전달·엔진 깨움 경로를 그대로 탔다 (`out-turn-r1.json`) |
| 3 | 도구 변환 15종 | ✅ | `/tools`: `pass: true`. 노드 타입 15 = 레지스트리 14(전부 변환, 설명 포함·입력 키 순서까지 일치·execute 있음) + `agent`(도구가 아님, 설계상 제외). agent가 열 수 있는 것 13(condition 제외). `out-tools.json` |
| 4 | 부작용 도구 차단, 미승인 발송 0 | ✅ | `send_email`: 승인 전 `outcome approval`, `stop approval_required`, 노드 실행 0회, **발송 0** → `resumeApproved` 1회째 `submitted`(approved 실행 1회), 2회째 `noop` → **발송 1**. 대본의 두 번째 send_email은 다시 차단돼 승인 대기. `webhook`도 같은 결과(승인 전 0, 승인 후 1). `out-block-send_email.json`, `out-block-webhook.json`. 엔진 경유 승인도 6번에서 확인 |
| 5 | 한도 (저장소 누적) | ✅ | 스텝 10 → `max_steps` 10스텝 / run LLM 예산 4 → `llm_cap` 4 / agent LLM 상한(시험값 3) → `llm_cap` 3 / 시간(시험값 5초, 도구 2초) → `timeout` 3스텝 / 같은 도구 → `repeat_tool` 3스텝. **턴을 넘는 누적**: maxSteps 4, 2스텝째 승인 차단 → 승인 재개(새 턴, stepNumber 0부터) → 합계 **4**에서 `max_steps` (턴별로 셌다면 6). **강제 종료 복구**: 8초에 `ctx.abort()` → `chatRecovery {attempt 1, continue}` → `beforeTurn {trigger: recovery-continue, continuation: true, steps: 4}` → 합계 **10**에서 `max_steps` (T0 k3는 12). `out-lim-*.json` |
| 6 | 엔진 연결 | ✅ | 큐 엔진(`processWorkflowStep`) 그대로, 로컬 큐·D1. (a) think: agent(→create_task 실제 D1) → 다음 단계 create_task가 `{{steps.a1.output.final}}`로 이어받아 run `succeeded`; D1 행 `submission_id = consumed_submission = wr_…:0`. (b) think + 승인: run `waiting_approval`, 알림 `wfapr_…_0_t1`, 발송 0 → `resumeWorkflowRun` → `send_email(approved)` 1회 → 이어진 제출 `…:0:a1` → run `succeeded`. (c) 첫 메시지 3번 전달 → 제출 1개, 할 일 1개 + 후속 1개. (d) legacy: AGENT_RUNTIME=legacy인 run은 D1 행 없이 `WorkflowAgent`로 갔다(로컬은 모델 호출 실패로 `tool_selection_failed`). **legacy 끝까지**는 원격 시험 Worker에서 `advanceAgentTurn` + `WorkflowAgent`(운영 코드)를 실제 Qwen으로: 16.8초, 턴 0 `llm` → requeue 1 → 턴 1 finish "Good morning.", `complete`. turns 모양이 Think와 같다(`0:tool:llm`, `1:finish`). `out-engine-*.json`, `t1-remote/out-legacy-direct-r1.json` |
| 7 | legacy 라이브 스모크 | ✅ (범위 제한) | 아래 표. 로그인 뒤 화면 동작(HR 질문 답변·템플릿 실행·채팅·결재함·LMS 내용)은 시험 계정이 없어 확인하지 못했다 |

### 7번 라이브 스모크 (workers.dev, 배포 전 `d48c8b4e` → 배포 후 `7931eb4a`)

| 대상 | 배포 전 | 배포 후 | 본문 sha256 |
|---|---|---|---|
| `GET /` (홈·로그인 화면) | 200, 138,237 B | 200, 138,237 B | 같음 (로컬 `public/index.html`과도 같음) |
| `GET /api/auth/me` (비로그인) | 401 | 401 | 같음 |
| `POST /api/ask` "연차 휴가는 1년에 며칠인가요?" (비로그인, Turnstile 토큰 없음) | 403 "봇 확인이 아직 끝나지 않았습니다…" | 403 같음 | 같음 |
| `GET /api/workflows/templates` (비로그인) | 401 | 401 | 같음 |
| `GET /api/chat/rooms` (비로그인) | 401 | 401 | 같음 |
| `GET /api/approval/box` (비로그인) | 401 | 401 | 같음 |
| `GET /api/lms/courses` (비로그인) | 401 | 401 | 같음 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200 `{"ok":true,"runs":[]}` | 200 같음 | 같음 |
| `GET /meet.js` (V1+V2 자산) | 200, 13,830 B | 200, 13,830 B | 같음 (로컬 파일과도 같음 → 직전 라이브에 V1+V2가 이미 들어가 있었다) |

파일: `live-smoke/before-*`, `live-smoke/after-*`.

**확인하지 못한 것 (Merlin이 브라우저로 봐 주셔야 함)**: 로그인 → HR 규정 질문 1개 답변 → 템플릿 5개 중 1개 실행 → 채팅 진입 → 결재함 진입 → LMS 진입. 세션 전용 경로라 관리자 시크릿으로 열리지 않고, 운영 DB에 시험 계정을 만드는 것은 승인 없이 하지 않았다. 질문은 Turnstile 때문에 curl로 답변 경로까지 갈 수 없다.

### 배포 확인

- `versions view 7931eb4a`: D1 바인딩 `database_id 5dff997a-…`(운영). **wrangler 4의 deploy·dry-run 출력은 `env.DB (36113f26-…)`(preview id)로 표시하지만 실제 바인딩은 운영 DB다** — 표시만의 문제. `migrations apply --remote`도 "preview database"라고 표시하지만 id는 `5dff997a`, `served_by: v3-prod`.
- `ThinkAgent` 네임스페이스 생성됨 (v4 적용). 시크릿(`RESEND_API_KEY` 등) 유지.
- 업로드 8,304 KiB / gzip 1,701 KiB (T0 dry-run 375 KiB → Think 의존성 포함으로 증가, Free 3 MB 이내). 시작 시간 103 ms.
- 자산 변경 없음 ("No updated asset files to upload").

### 배포 후 크론

`cf-wrangler.py tail people-os --format json`을 배포 직후부터 첫 15분 크론 틱까지 걸어 두었다 (`live-smoke/tail-after-deploy.jsonl`). 16:30:28Z(01:30 KST) `*/15 * * * *` 이벤트: `outcome: "ok"`, `exceptions: []` (워크플로우 스케줄 틱 + 정체 run 청소 + `sweepMeetings()`가 같은 분기에서 오류 없이 끝남). 그 사이 오류 로그 없음. 큐 소비자·RealtimeKit·03:00 평가 크론·07:00 다이제스트는 이 창에서 실행되지 않아 확인하지 못했다 → 11-24 회귀 6·5번에서 본다.

## T2에 넘길 주의사항

1. **run 전체 LLM 30회 캡의 나머지 절반**: Think 단계는 앞 단계 사용량을 빼고 시작하지만, **엔진의 기존 LLM 캡(일반 LLM 노드 단계, `engine.ts` 8번)은 agent 단계를 세지 않는다** (R4 때문에 일반 경로는 고치지 않았다). agent 뒤에 오는 LLM 노드까지 합산하려면 `engine.ts` 8번에서 `workflow_agent_steps.llm_calls`(또는 agent output의 `llmCalls`)를 더해야 한다. 관측 API도 `turns.length`만 세서 agent 안의 LLM 도구 호출(ask_rag·llm 등)은 빠진다 — Think output의 `llmCalls`를 쓰면 정확하다.
2. **승인 재개 중 DO가 죽으면**: `pending`은 실행 전에 지워지므로(중복 발송 방지) 그 사이에 죽으면 단계가 pending으로 남고 메시지가 없다 → 60분 정체 청소가 실패로 정리한다. 발송은 많아야 1회.
3. **일반 도구는 최소 1회(at-least-once)**: 끝난 실행은 원장이 막지만, 실행 도중(D1 쓰기 뒤 원장 기록 전) 끊기면 복구 턴이 다시 실행할 수 있다 (예: create_task 2건). 부작용 도구만 최대 1회다.
4. **런타임은 단계 단위로 고정**: think로 전환하면 이미 legacy로 시작한 agent 단계는 legacy로 끝나고, 새 agent 단계부터 think. run 하나에 두 런타임이 섞일 수 있다.
5. **Qwen의 `thinking`이 비어 있다**: 실제 Qwen 턴에서 도구 스텝의 `reasoningText`가 비어 turns의 `thinking`이 ""였다. 에이전트 화면(T3)에서 판단 근거를 보여 주려면 `sendReasoning`/모델 옵션을 봐야 한다.
6. **로컬 dev는 Workers AI를 못 부른다** (프록시 TLS). 실제 모델 시험은 원격 시험 Worker가 필요하다. `people-os-t1-harness`는 시험 창(03:30 KST)이 지나면 403이 된다. 지울지는 Merlin이 판단 (`cf-wrangler.py delete --name people-os-t1-harness`).
7. **AGENT_RUNTIME=think로 바꾸기 전에** (T3): 라이브에서 agent 노드 워크플로 1개를 legacy로 한 번 돌려 두면 비교 기준이 생긴다 (이번에는 로그인 계정이 없어 못 했다).
8. **Think 기본 도구**: Think가 턴마다 기본 도구 7개(워크스페이스 등)를 섞어 준다. `activeTools`로 막았지만, T2 어시스턴트에서 `getTools()`를 바꿀 때도 반드시 좁힐 것.
9. **결과 전달 재시도**: `deliver`가 2분 간격 최대 5회 다시 깨운다 (`consumed_submission` 확인). 엔진이 처리한 뒤에는 멈춘다.

## 정리할 것 (커밋에서 뺄 것)

- `files/workflow-verify/think-full/dryrun-t1/` — dry-run 빌드 산출물.
- `files/workflow-verify/think-full/t1-harness/state/` — 로컬 D1·DO 상태. `dev.log`도.
- 커밋할 것: `src/workflow/think-agent.ts`, `src/workflow/agent-think.ts`, `src/workflow/{engine,agent,types}.ts`, `src/index.ts`, `wrangler.toml`, `migrations/0040_workflow_agent_think.sql`, `t1-harness/{harness.ts,wrangler.toml,tsconfig.json,out-*.json}`, `t1-remote/`, `live-smoke/`, 이 파일.
