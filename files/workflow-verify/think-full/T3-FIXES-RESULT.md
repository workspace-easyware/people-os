# Think T3 남은 문제 6개 수정 결과 (2026-11-21 새벽 KST, Opus 5.5 단일 세션)

## 판정

| # | 항목 | 판정 | 한 줄 근거 |
|---|---|---|---|
| 1 | 엔진 run 30회 LLM 캡이 agent 뒤 LLM 노드에서 agent 사용량을 안 셈 | ✅ 고침 | llm 26 + agent 4 = 30 뒤 llm #27 → `LLM 호출 상한(30회)에 도달`로 막힘. 대조군(20 + 2) 뒤 llm 노드는 안 막힘. 동기식·지연(think·legacy) 회귀 통과 |
| 2 | 토큰 단위 스트리밍 없음 | ✅ 고침 (화면 렌더링은 브라우저 미확인) | 백엔드 `onChunk` → `delta` 이벤트, SSE 0.4초, 화면 EventSource + 말풍선 이어 붙이기 + 2초 폴링 폴백. 로컬 SSE를 5초에 끊어도 delta 7개·turnEnd 0. **실제 Qwen**: delta 47개 중 46개가 turnEnd 전(첫 조각 → 끝 12.3초) |
| 3 | 판단 근거(thinking)가 영어 | ❌ **미완 — 모델이 지시를 안 따름** | 실제 Qwen에 3가지 방식으로 지시(시스템 프롬프트 한국어 규칙 / 사용자 메시지 한국어 / 사용자 메시지 영어 "must be written entirely in Korean") → 워크플로 agent·어시스턴트 모두 thinking 영어. 프롬프트는 **원래대로 되돌렸다** (효과 없는 줄을 운영에 남기지 않음). 화면 "판단 근거:" 표시는 그대로 |
| 4 | 관측 llm_calls·duration 오차 | ✅ 고침 (표시만) | (a) agent `llm_calls` = Think output `llmCalls` (로컬: turns 2 / Think 3 → **3**, 라이브 T3 run `wfrun_mwoi511c_ez0l4k`: 2 → **3**). (b) think 단계 duration = `workflow_agent_steps.created_at` → 단계 `finished_at` (로컬 31 ms → **3,671 ms**, 라이브 T3 run 63 ms → **41,651 ms** = T3이 잰 "약 42초"). 끝 시각을 지시의 `updated_at` 대신 `finished_at`으로 바꾼 이유는 아래 4번 |
| 5 | 조사 자식 `max_steps` 표시 | ✅ 고침 (방식: 스스로 끝낸 턴은 `completed`) | 로컬: 4스텝째 정리 → 저장소 `max_steps`인데 결과 `stop: "completed"`. 대조군(끝까지 도구만) → `max_steps` 그대로. **실제 Qwen**: 자식 4스텝·정리로 끝남, 저장소 `max_steps`·`selfFinished true` → 부모 researchEnd `stop: "completed"` (T3 상황 그대로 재현 후 고쳐짐) |
| 6 | 조사 중 진행 로그 정체 | ✅ 고침 | 자식 `reportProgress` → 부모 `onProgress` → `researchProgress` 이벤트 + 15초 하트비트. 로컬 최대 공백 12.1초(느린 도구)/19.3초(40초 도구 1개). **실제 Qwen**: 조사 252초 동안 진행 이벤트 21개, 첫 이벤트 15초, 최대 공백 18.6초 |

통과 기준:

| 기준 | 판정 | 근거 |
|---|---|---|
| `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js` `node --check` 0 | ✅ | 운영 `tsconfig.json`·하네스 `t3-fixes-harness/tsconfig.json` 둘 다 출력 없음, `node --check public/agents.js` 통과 (최종 코드 = 배포 코드로 재확인) |
| 하네스 (항목별 실제 실행) | ✅ 1·2·4·5·6 / 3은 미완으로 기록 | 아래 "하네스" |
| 라이브 배포 + 스모크 | ✅ | 기존 엔드포인트 13건 바이트 동일(cmp), 홈 HTML 동일, 의도한 변화만(agents.js, 관측 think run 숫자). tail 예외 0 |
| 결과 파일 | 이 파일 | |

- **최종 라이브 버전**: `7fbe378c-4b9d-46af-b462-982316d4b6d0` (people-os, 2026-11-20 23:10:16Z = 11-21 08:10 KST, 100%). 중간 버전 `308ec528-6eb2-46b0-8165-0f32cbea4210` (23:04:26Z). 직전 `f6954a89`.
- 두 번 배포한 이유: 첫 배포 뒤 라이브 스모크에서 4(b)의 끝 시각(updated_at)이 옛 재알림 알람 때문에 밀린 행을 찾았다 → 끝 시각을 단계 `finished_at`으로 바꿔 로컬 재확인 후 재배포 (아래 4번). 커밋할 코드 = `7fbe378c`.
- `versions view` (둘 다): compatibility_date 2025-07-18 그대로, 플래그 `nodejs_compat, enable_ctx_exports` 그대로, D1 `5dff997a-…`(운영 — deploy 출력의 `36113f26`은 wrangler 4 표시 문제), `AGENT_RUNTIME="think"`.
- **D1 마이그레이션 없음.** DO 마이그레이션 태그 추가 없음. 커밋·태그는 하지 않았다.

## 바꾼 파일

| 파일 | 내용 |
|---|---|
| `src/workflow/engine.ts` | `agentOutputLlmCalls(output)` (export): Think output `llmCalls`가 있으면 그것, 없으면(legacy) turns 길이. `priorLlmCalls`가 이걸 쓴다. **8번 LLM 상한 검사**가 `LLM 노드 단계 수`만 세던 것을 `priorLlmCalls(steps, stepIndex)`(LLM 노드 + 앞 agent 단계 사용량)로 바꿨다. 상한 숫자 30·검사 위치·실패 처리(단계 failed + run failed, 같은 문구)는 그대로. 머리 주석 갱신 |
| `src/obs/routes-workflows.ts` | 목록: agent LLM 수 = `COALESCE($.llmCalls, json_array_length($.turns))`. 상세: `workflow_agent_steps` LEFT JOIN, agent `llm_calls` = `agentOutputLlmCalls`, **끝난 think agent 단계의 duration = agent_steps created_at → 단계 finished_at** (finished_at이 없으면 updated_at, 표가 없으면 예전 조회로 떨어진다). 한도 판정과 무관 |
| `src/workflow/think-agent.ts` | `deliver()`: 엔진이 이미 처리한 제출(consumed)이면 D1 행을 다시 쓰지 않고 끝 (2분 재알림 알람이 `updated_at`을 단계 끝 시각 뒤로 미는 것을 막는다 — 4(b)의 정확도 보조). 프롬프트는 바뀌지 않았다 (3번 시도 후 되돌림, 주석 2줄만) |
| `src/assistant/research.ts` | (5) `onStepFinish`가 도구 없는 정리 스텝이면 `selfFinished` 표시(한도로 도구를 닫은 스텝은 `forced`라 제외) → `getAgentToolOutput.stop = "completed"`. 한도로 끝난 경우(도구 스텝에서 상한·캡·시간)는 그대로. 상한 4·프롬프트("최대 3번 안에")는 바꾸지 않았다. (6) `reportProgress({message, phase, fraction, data:{steps,maxSteps,tool,llmCalls}}, {persist:true})`를 도구 호출 직전·스텝 끝마다 (실패 무시) |
| `src/assistant/agent.ts` | (2) `onChunk`: `text-delta`를 모아 250ms·120자마다 `delta` 이벤트 1줄 (토큰마다 SQL 쓰기 안 함), 스텝 끝·턴 끝에 남은 조각 flush. (6) `onProgress` → `researchProgress` 이벤트(source child), `runResearch` 중 5초마다 점검해 15초 동안 신호가 없으면 `researchProgress`(source heartbeat, 경과·스텝). 한도·턴 상한·도구 목록은 그대로 |
| `src/assistant/routes.ts` | SSE가 DO를 읽는 간격 1초 → 0.4초 (열린 턴이 있는 동안만, 최대 55초 그대로). JSON 폴링 응답 모양·`pollMs 2000` 그대로 |
| `public/agents.js` | 열린 턴이 있으면 **EventSource**(`GET /events`, 브라우저가 `Accept: text/event-stream`을 보낸다)로 받고, `delta`는 답 말풍선에 이어 붙인다(`<think>` 구간은 감춤, 도구 스텝이면 비움, 턴 끝나면 저장된 대화로 교체). 서버가 55초에 `end`를 보내면 폴링 1회로 맞춘 뒤 다시 연다. **첫 메시지 전 오류 → 이 화면에서 SSE를 끄고 2초 폴링(예전 동작)**, 도중 오류 → 폴링 1회 후 재연결. 이벤트 id로 중복 제거(두 경로가 겹쳐도 한 번). `researchProgress` 줄 표시("조사 진행: 스텝 2/4 · HR 규정 검색 실행, 경과 35초" / "조사 중… (2스텝 진행, 경과 45초)"). 안내 문구 갱신 |

건드리지 말 파일(`public/approval.js`·`public/chat.js`·`public/meet.*`·`src/meet/*`·`src/chat/*`·`src/ask-pipeline.ts`·평가 runner·프롬프트 v5·`pending-actions.ts`·큐 `workflow-action` 분기·`public/workflow.js`)은 수정하지 않았다 (`git status`: 수정 7개 = 위 표). 동기식 승인 경로·승인 게이트·한도 숫자(30회·10스텝·20회·28분·일일 30턴)도 그대로다.

## 하네스 (`files/workflow-verify/think-full/t3-fixes-harness/`)

T3 하네스 패턴: 운영 `AssistantAgent`·`ResearchAgent`·`agentsApp`·`workflowRunsApp`·엔진을 그대로 쓰고, 시험용 서브클래스(`FixAssistantAgent`·`FixResearchAgent`·`FixThinkAgent`(T1 `HarnessThinkAgent` 재사용))는 모의 모델(글을 조각으로 천천히 흘릴 수 있음)·모의/느린 노드·하트비트 간격만 덧씌운다. 로컬 D1 0001~0042 전부 적용(오류 없음). 실제 모델 시험은 **원격 시험 Worker `people-os-t3-fixes-harness`**(T1 방식, 버전 `4dca02b9` → `5e49adc9`, 큐 없음, 결과 전달 건너뜀 — 시험 뒤 **삭제함**).

### 1. LLM 캡 (로컬, 운영 엔진 + 로컬 큐)

| 시험 | 결과 | 파일 |
|---|---|---|
| llm 26(완료) → think agent(예산 4, create_task·calendar 교대) → llm | agent `llm_cap`(steps 4, llmCalls 4), **llm #27 `failed` "LLM 호출 상한(30회)에 도달"**, run `failed` 같은 문구. (T3 하네스 8번에서는 같은 구성에서 #27이 실행됐다) | `out-1-llm-cap-26.json` |
| 대조군: llm 20 → agent(2회 사용) → llm | 합계 22 → 뒤 llm 노드가 **캡에 막히지 않고 실행됨** (로컬 dev엔 AI 바인딩이 없어 노드 자체가 `Cannot read properties of undefined (reading 'run')`로 실패 — 캡 문구 아님) | `out-1-llm-control-20.json` |
| 동기식 회귀 (think agent → send_email) | run `waiting_approval`, `stop approval_required`, 발송 0 → `resumeWorkflowRun` → run `succeeded`, **발송 1** | `out-1-sync-before.json`, `out-1-sync-after.json` |
| 지연 회귀 — **P2 하네스를 고치지 않고 새 상태 폴더(`state-p2/`)로** 다시 돌림 (운영 `workflowApp`·결정 API·`processWorkflowAction`) | Think 지연(`wf-tdef`): run `succeeded`, 대기 동작 `wfpa_…_0_t0` `queued`, emails 0 → `POST /pending-actions/decide approve` → `executed`, `provider_id re_fake_1`, 제목 "[P2] Think 안내". Legacy 지연(`wf-ldef`, mode legacy): run `succeeded`, 대기 동작 1 `queued`, agentRow 없음(legacy) | `out-1-deferred-think-queued.json`, `out-1-deferred-think-executed.json`, `out-1-deferred-legacy.json` |

### 2. 토큰 스트리밍

| 시험 | 결과 | 파일 |
|---|---|---|
| 로컬, 모의 모델이 105자 답을 8자 조각·0.3초 간격으로 | delta 이벤트 14개, 0.3초 간격으로 쌓임, 이어 붙인 글 = 원문, **14개 전부 turnEnd 전**(첫 조각 → turnEnd 4.5초) | `out-2-stream-timeline-local.json` |
| 로컬 **SSE** (`Accept: text/event-stream`, 운영 라우트·세션 쿠키), 0.6초 간격 턴을 **5초에 끊음** | 받은 이벤트: turnQueued·turnStart·toolStart·toolEnd·step + **delta 7개, turnEnd 0** = 턴이 끝나기 전에 SSE로 조각이 도착 | `out-2-sse-cut-5s.txt` |
| 폴링 폴백 (JSON, Accept 없음) | 200, `pollMs 2000` 그대로, 같은 턴 이벤트 전부(delta 14 + 기존 이벤트) — 화면은 delta를 말풍선에, 나머지를 진행 기록에 | `out-2-poll-fallback.json` |
| **원격 실제 Qwen** (조사 위임 턴, 270초) | delta 47개 중 **46개가 turnEnd 전** (첫 조각 257.4초, 끝 269.7초 → 12.3초 동안 흘러나옴), 이어 붙인 글 = 최종 답(표 포함) | `out-real-research-1.json` (`streaming`) |

**범위**: 화면(`agents.js`)은 `node --check`와 코드 경로까지만 확인했다. VM에 브라우저가 없어 실제 EventSource 연결·말풍선 렌더링은 보지 못했다 (T3과 같은 사정) — 11-24 회귀에서 확인 필요. SSE가 막히는 환경이면 화면은 첫 오류에서 2초 폴링으로 돌아간다 (예전 동작 그대로).

### 3. 한국어 판단 근거 — 미완

| 시도 (원격 실제 Qwen `@cf/qwen/qwen3.8-27b`) | thinking | 파일 |
|---|---|---|
| 시스템 프롬프트에 규칙 "(언어) 생각하는 과정도 처음부터 끝까지 한국어로 쓴다. 영어로 생각하지 않는다." — 워크플로 agent(ask_rag 목표) | "The user is asking in Korean: …", "Got the answer. …" (영어). 최종 답은 한국어 | `out-real-wf-1.json` |
| + 목표(사용자 메시지)에 "(중요: 생각하는 과정도 반드시 한국어로 써라.)" | "The user wants to find out …" (영어) | `out-real-wf-2-usermsg.json` |
| + 목표에 영어로 "IMPORTANT: Your internal reasoning (thinking) must be written entirely in Korean (한국어), never in English." | "The user is asking me to find …" (영어) | `out-real-wf-3-english-meta.json` |
| 어시스턴트 실제 턴 (시스템 프롬프트 규칙 포함) | 2스텝 모두 영어 ("… according to rule (g), I should use the research tool.") | `out-real-research-1.json` (`thinking`) |

- 원격 시험 Worker는 이 규칙 줄이 들어간 코드로 돌았다. 2·5·6번 원격 증거(`out-real-research-1.json`)도 같은 실행이다 — 이후 운영 코드에서 뺀 것은 프롬프트 문자열 1줄뿐이고 스트리밍·stop·진행 이벤트 코드는 같다.
- 결론: Qwen3.8의 reasoning 채널은 프롬프트 언어 지시를 따르지 않는다. 지시대로 번역기를 붙이지 않았고, 효과가 없는 프롬프트 줄은 **운영 코드에서 되돌렸다** (세 에이전트 프롬프트는 T3과 같다). 화면 "판단 근거:" 표시는 그대로.
- 필요 작업 (선택지·규모·위험):
  - (A) 화면에서 판단 근거를 접어 두고 "모델 원문(영어)"이라고 표시 — 작음(`agents.js` 몇 줄), 위험 낮음. **권장 (데모 전 가능)**.
  - (B) 턴 끝에 thinking만 짧게 한국어 요약(LLM 1회 추가/턴) — 중간, 턴당 비용·지연 증가, LLM 상한 계산에 넣어야 함. 지시상 이번에는 하지 않음.
  - (C) reasoning 언어를 따르는 다른 모델로 교체 — 큼, 도구 선택 정확도(T0 관문 10/10) 재검증 필요. 동결(11-25) 전에는 권하지 않음.

### 4. 관측 숫자 (로컬)

`/h/eng/obs`: think agent(ask_rag 1회, 도구 3초) → create_task. 운영 `workflowRunsApp`(hr_admin 세션):
- 1차(끝 = updated_at): agent `llm_calls` **3** (= Think `llmCalls 3`, turns 2), `duration_ms` **4,103** (단계 started_at→finished_at은 35 ms). `out-4-obs-detail.json`, `out-4-obs-run.json`
- 목록: 같은 run `llm_calls 3`. (llm 26 run은 31 = 26 + agent 4 + 막힌 #27 행 1 — 실패한 LLM 노드 행도 세는 예전 셈법 그대로) `out-4-obs-list.json`
- **끝 시각을 finished_at으로 바꾼 이유 (첫 배포 `308ec528` 뒤 라이브에서 발견)**: 라이브 T3 run의 think 단계가 created_at→updated_at으로 **155,416 ms**였다. D1 행: created 04:51:47.616, updated **04:54:23.032** — T3 tail에 기록된 04:54:23Z ThinkAgent 알람(결과 재알림, 고치기 전 `deliver`가 이미 처리된 행을 다시 씀)이 updated_at을 밀어 놓은 것. 단계 `finished_at`(엔진이 결과를 처리한 시각, 04:52:29.267)은 알람이 건드리지 않는다 → created_at→finished_at = **41,651 ms**. 그래서 끝 시각을 finished_at으로 바꿨고(updated_at은 없을 때만), `deliver`도 처리된 제출이면 행을 다시 쓰지 않게 고쳤다(새 행은 둘 다 정확).
- 2차(끝 = finished_at, 최종 코드): 새 run `wr_fxobs_1795216173279` agent `duration_ms` **3,671** (created 23:09:34.056 → finished 23:09:37.727), `llm_calls 3`. `out-4-obs-detail-v2.json`
- `deliver` 고침 확인: 1차 run의 agent_steps `updated_at`이 4.8분 뒤(2분 재알림 알람 시각 지남)에도 22:52:39.411 그대로.
- 승인 대기가 있었던 think 단계는 created_at→finished_at에 **승인 대기 시간이 포함된다** (아래 남은 문제 2).

### 5. 조사 자식 stop — 선택: "스스로 끝낸 턴은 completed"

상한을 5로 올리는 안은 쓰지 않았다: 자식이 5스텝까지 쓸 수 있게 되면 LLM 사용량·조사 시간이 늘고(실제 실행에서 이미 252초), 프롬프트("최대 3번 안에")와의 어긋남은 그대로다. 대신 "마지막 스텝이 도구 없는 정리이고, 한도로 도구를 닫은 스텝이 아니면 `completed`"로 판단한다 — 상한·프롬프트·한도 판정은 안 바뀌고 표시만 바뀐다.

| 시험 | 저장소 stop | selfFinished | 결과 stop | 파일 |
|---|---|---|---|---|
| 로컬: ask_rag 3회 → 4스텝째 정리 | `max_steps` | true | **`completed`**, summary = 정리 | `out-5-child-complete.json` |
| 로컬 대조군: 끝까지 ask_rag | `max_steps` | false | `max_steps`, summary "조사를 끝내지 못했습니다 (max_steps)." | `out-5-child-maxsteps.json` |
| 원격 실제 Qwen: ask_rag 3회 → 4스텝째 정리 | `max_steps` | true (forced 없음) | **`completed`** (researchEnd), 부모 답에 반영 | `out-real-research-1.json` (`children`) |

### 6. 조사 진행 이벤트

| 시험 | 결과 | 파일 |
|---|---|---|
| 로컬: 자식 도구 12초 × 2 | 위임 25.1초 동안 `researchProgress` 3개(source child: "ask_rag 검색 중" 0.66초, "스텝 1 끝" 12.7초, "스텝 2 끝" 24.8초), 최대 공백 12.1초 | `out-6-progress-slow.json` |
| 로컬: 자식 도구 1개가 40초 (자식 신호 공백) | child 0.7초 → **heartbeat 20.0초, 35.0초** → child 40.7초, 최대 공백 19.3초 | `out-6-progress-heartbeat.json` |
| 원격 실제 Qwen (조사 252초) | `researchProgress` 21개 (heartbeat 15·30·45초 → child "ask_rag 검색 중" 46초 → … → "스텝 4 끝 (정리 작성)" 252초), **첫 이벤트 15초, 최대 공백 18.6초** | `out-real-research-1.json` (`research`, `events`) |

- 자식 신호(onProgress)는 `eventDelivery: "terminal"`에서도 부모로 왔다(로컬·원격 모두). 같은 시각의 신호는 SDK가 합칠 수 있어(coalesced) 도구 시작 줄이 빠지기도 하지만, 하트비트가 15초 이상 공백을 막는다.
- 실제 실행이 T3(184초)보다 길었다(270초): 첫 모델 스텝 46초, ask_rag 1회 60초 넘게 — Workers AI 응답이 느린 시간대였다. 28분 상한 안.

## 라이브

workers.dev. 배포 전(`f6954a89`, 22:58Z) → 1차 `308ec528` 뒤(23:07:30Z, 배포 3분 뒤) → 최종 `7fbe378c` 뒤(23:13:07Z). 파일: `t3-fixes-live-smoke/before-*`, `after-*`(1차), `after2-*`(최종).

| 대상 | 배포 전 | 최종 | 본문 |
|---|---|---|---|
| `GET /` (홈·로그인 화면) | 200, 139,478 B | 200, 139,478 B | **바이트 동일** (index.html 무변경) |
| `GET /api/auth/me` | 401 | 401 | 동일 |
| `POST /api/ask` (비로그인, Turnstile 없음) | 403 | 403 | 동일 |
| `GET /api/workflows/templates` · `/api/chat/rooms` · `/api/approval/box` · `/api/lms/courses` | 401 | 401 | 전부 동일 |
| `GET /meet.js` | 200, 13,830 B | 200, 13,830 B | 동일 |
| `GET /api/agents/me` · `/api/agents` · `/api/agents/asst_someone/events` (비로그인) | 401 | 401 | 동일 |
| `GET /agents.css` · `/obs/assistant.js` | 200 | 200 | 동일 |
| `GET /agents.js` | 200, 22,934 B | 200, **29,126 B** | **의도한 변화** — 로컬 `public/agents.js`와 바이트 동일 |
| `GET /api/obs/assistant-turns` (X-Admin-Secret) | 200, 633 B | 200, 633 B | 동일 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 1,182 B | 200, 1,182 B | **의도한 변화 1곳**: think run `wfrun_mwoi511c_ez0l4k` `llm_calls 2 → 3`. legacy run 2개(`…tzvm_tofn09` 2, `…msze_d79bii` 3)는 그대로 |
| `GET /api/obs/workflow-runs/wfrun_mwoi511c_ez0l4k` | agent `duration_ms 63`, `llm_calls 2`, run llm 2 | agent **`41,651`**, **`3`**, run llm **3** | 의도한 변화 (1차 `308ec528`에서는 155,416 — 위 4번) |

- 로그인 뒤 화면(어시스턴트 실제 턴의 스트리밍·조사 진행 줄·SSE 폴백)은 시험 계정이 없어 라이브에서 확인하지 못했다 — 같은 운영 코드를 로컬 하네스(운영 라우트·세션 쿠키)와 원격 시험 Worker(실제 Qwen)로 확인했다.
- 배포 직후 2분 주의: 스모크는 1차 3분 뒤, 최종은 2분 48초 뒤에 쟀다. 최종에서 관측 상세가 41,651(최종 코드에서만 나오는 값)이라 새 버전이 응답한 것이 확인된다.

### 배포 후 tail (`t3-fixes-live-smoke/tail-after-deploy.jsonl`)

1차 배포 직후(23:04Z)부터 23:15:30Z까지 74건: `outcome ok` 73 + `canceled` 1, **예외 있는 이벤트 0**. 버전은 `308ec528` → `7fbe378c`로 넘어감. `canceled` 1건은 `NotificationHub` DO(옛 버전 `308ec528`, cpuTime 0) — 2차 배포 때 코드 교체로 끊긴 연결이다(오류 아님).
tail 전체(23:04Z~약 23:29Z, 시간 상한으로 종료): 138건 = ok 134 + canceled 4, **예외 0**. canceled 4건은 전부 `NotificationHub` DO, wallTime·cpuTime 0 (1건 `308ec528`, 3건 `7fbe378c`) — 알림 허브 연결 종료 이벤트로 보이며 이번에 바꾸지 않은 코드다. 11-24에 알림(벨) 동작을 볼 때 같이 확인할 것.
**15분 크론**: 23:15:28Z `*/15 * * * *` — `scriptVersion 7fbe378c`, `outcome ok`, `exceptions []`, wallTime 534 ms (워크플로 스케줄 틱 + 정체 run 청소(대기 동작 만료 포함) + `sweepMeetings()`). 큐 소비자(`workflow-step`·`workflow-action`)·03:00 평가 크론·07:00 다이제스트는 이 창에서 돌지 않았다 — 이번 변경은 그 경로 코드를 바꾸지 않았다(엔진 8번 셈법 제외 — 하네스로 확인).

## 남은 문제

1. **3번(한국어 판단 근거) 미완** — 위 3번의 선택지 (A)를 권한다.
2. **think 단계 duration에 승인 대기 시간이 들어간다**: created_at→finished_at이라 동기식 승인으로 멈췄던 think 단계는 승인까지 기다린 시간이 포함된다. 승인 없는 단계는 실제 시간. 정확히 하려면 단계 turns의 `at`(스텝 시각)으로 활성 시간만 더해야 한다 — 작은 일(관측 API 몇 줄), 위험 낮음.
3. **관측 목록의 LLM 수는 실패한 LLM 노드 행도 센다** (예전 셈법 그대로 — 캡에 막힌 #27도 1로 셈). 엔진 캡 검사도 같은 셈법(`priorLlmCalls`는 상태와 무관하게 LLM 노드 행을 센다)이라 일관적이다.
4. **화면 렌더링 미확인** (브라우저 없음): SSE 연결·말풍선 이어 붙이기·조사 진행 줄·폴백 전환. 코드 경로와 서버 응답은 확인함.
5. **SSE 비용**: 열린 턴이 있는 동안 서버가 0.4초마다 DO를 읽는다 (1분 턴 ≈ 150회 DO 요청). 하루 턴 상한 30회 × 사용자 수 규모에서는 무료 한도 안이지만, 사용자가 늘면 간격을 다시 볼 것. 턴이 없으면 연결은 바로 닫힌다.
6. `delta` 이벤트가 `pos_ev`에 쌓인다 (긴 답 1개 ≈ 30~50줄). 보존 3,000줄 정리 규칙은 그대로라 오래된 이벤트가 더 빨리 밀린다 — 화면·관측에는 영향 없음.
7. 시험 흔적 (운영 D1·R2): 원격 하네스의 실제 턴들이 ask_rag 질문 트레이스를 남겼다 (세션 id 접두어 `wf_asst_u_t3fx_r1`, `wf_research_u_t3fx_r1`, `wf_wr_t3fx_…` — 조사 3회 + 워크플로 agent 3회). 원격 하네스에는 `assistant_turns` 1행(`u_t3fx_r1`)도 남았다. 운영 `workflow_agent_steps`는 건드리지 않았다(결과 전달 건너뜀). 지울지는 Merlin 판단.

## 11-24 회귀 검증에 넘길 것

- **에이전트 화면 실제 확인**(로그인): 어시스턴트 메시지 → 답이 **조각으로 이어 붙는지**(SSE), 진행 기록이 실시간으로 쌓이는지, 개발자 도구 Network에서 `events` 요청이 `text/event-stream`인지. 조사 위임 요청("연차와 경조사 휴가 규정을 비교해 정리해 줘") → 3~4분 동안 **15초 안팎마다 "조사 진행/조사 중" 줄**이 오는지, researchEnd에 `stop`이 "완료"로 끝나는지(진행 기록 줄에 표시).
- SSE가 막히는 네트워크(회사 프록시 등)에서 2초 폴링으로 자연스럽게 돌아가는지.
- 관측 · 평가 → 워크플로 run 상세: think agent 단계 LLM 호출 수·소요 시간이 실제와 맞는지 (라이브 T3 run `wfrun_mwoi511c_ez0l4k`가 기준 — 위 라이브 표).
- 엔진 LLM 캡: 실제 워크플로에서 LLM 노드가 많은 템플릿 + agent를 돌릴 일은 드물다 — 로컬 하네스로 확인함. 동기식·지연 승인 1회씩(라이브 로그인 계정)으로 회귀 확인.
- 3번 선택지 (A) 적용 여부 결정.

## AGENTS.md에 넣을 것 (Merlin이 옮겨 주세요)

- **원격 시험 Worker에 5분 가까이 붙잡는 HTTP 요청은 본문 없이 끊긴다** (270초 턴을 기다리는 `/h/real`이 빈 응답). 긴 실제 턴은 "제출 라우트 + 나중에 읽는 보고 라우트"로 나눈다 (`/h/real-start`, `/h/report`).
- **Qwen3.8(`@cf/qwen/qwen3.8-27b`)의 thinking은 언어 지시를 따르지 않는다** (시스템 프롬프트·사용자 메시지, 한국어·영어 지시 모두 영어 thinking).
- **Think 하위 에이전트 진행**: 자식 `reportProgress(p, {persist:true})` → 부모 `onProgress(run, snapshot)`이 `eventDelivery: "terminal"`에서도 온다 (로컬·원격). 같은 순간 신호는 합쳐질 수 있어 하트비트를 같이 둔다.
- **Think 토큰 스트리밍**: submit 모드 턴에서도 `onChunk`가 `text-delta`마다 불린다 → DO 저장소에 묶어 남기고 SSE로 읽으면 된다 (runTurn stream 모드·요청 재설계 불필요).
- `cf-wrangler.py delete --name <worker> --force`는 비대화형으로 된다.
- `-p` 세션에서 `B=<URL> && curl $B/...`는 "A variable in this command can't be checked"로 막힌다 — URL을 매번 직접 쓴다 (`&&`로 이은 curl 여러 개는 된다).

## 정리할 것 (커밋에서 뺄 것)

- `files/workflow-verify/think-full/t3-fixes-harness/state/`, `state-p2/` — 로컬 D1·DO·큐 상태.
- `files/workflow-verify/think-full/t3-fixes-harness/dev.log`, `dev-p2.log`.
- 원격 시험 Worker `people-os-t3-fixes-harness`는 **이 세션에서 삭제함**.
- 커밋할 것: `src/workflow/{engine,think-agent}.ts`, `src/obs/routes-workflows.ts`, `src/assistant/{agent,research,routes}.ts`, `public/agents.js`, `t3-fixes-harness/{harness.ts,wrangler.toml,wrangler.remote.toml,tsconfig.json,out-*}`, `t3-fixes-live-smoke/`, 이 파일.
