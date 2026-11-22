# Think 전면 도입 T3 결과 (2026-11-20 오후, Opus 5.5 단일 세션)

## 판정

| 통과 기준 | 판정 | 근거 |
|---|---|---|
| `npx tsc --noEmit` 오류 0 | ✅ | 운영(`tsconfig.json`)·하네스(`t3-harness/tsconfig.json`) 둘 다 출력 없음 (배포 직전 재확인) |
| 로컬 하네스 9항목 | ✅ 9/9 (5·9는 범위 제한) | 아래 표. 실제 모델 부분(6번)은 원격 시험 Worker에서. 5번은 브라우저가 없어 API·자산 수준, 9번은 로그인 없이 볼 수 있는 범위 |
| `AGENT_RUNTIME=think` 배포 후 think 경로 동작 + legacy 기존 동작 변화 없음 | ✅ | think: 기준선 워크플로를 라이브에서 think로 끝까지 실행(완료·멈춤 없음·승인 0·발송 0, 7번). 기존: 스모크 12건 중 기존 엔드포인트 10건 sha256 같음, 홈은 의도한 추가만 diff, tail 전부 `outcome ok`·예외 0 |

- **라이브 버전**: `a685a42f-0db5-4e92-8b77-e95c92aea0f0` (people-os, 2026-11-20 04:48:02Z = 13:48 KST 생성, 04:48:08Z 배포). 직전 버전 `307cf8b6`(reasoning low).
- `versions view a685a42f`: compatibility_date **2025-07-18 그대로**, 플래그 **`nodejs_compat, enable_ctx_exports`**, D1 `5dff997a-…`(운영), `AGENT_RUNTIME="think"`, `ASSISTANT_AGENT (AssistantAgent)`.
- 업로드 8,358 KiB / gzip 1,715 KiB (T2 8,330 / 1,709). DO 마이그레이션 태그 추가 없음 (하위 에이전트는 facet이라 v6 불필요).
- **D1 마이그레이션 0041 적용** (`migrations list --remote`로 미적용이 0041 하나뿐임을 확인한 뒤 `migrations apply --remote`, 04:47Z, 3 commands). 출력의 "preview database"는 wrangler 4 표시 문제 — id는 운영 `5dff997a`.
- 커밋·태그는 하지 않았다 (`think-t3`는 Merlin이).

## 구현한 것

| 파일 | 내용 |
|---|---|
| `src/assistant/research.ts` (새 파일) | **`ResearchAgent extends Think<Env>`** — 조사 하위 에이전트. 도구 3개(`ask_rag`·`ask_personal`·`summarize`, 읽기 전용)만 만들고 `beforeTurn` activeTools로 좁힘, `beforeToolCall`이 목록 밖·승인 필요 도구를 막음. 한도 4스텝·LLM 8회·6분(저장소 누적). 소유자는 부모가 input으로 넘기고 `formatAgentToolInput`이 저장소에만 둔다(모델 메시지에는 주제만). `getAgentToolOutput`이 `{summary, sources, grounded, steps, llmCalls, toolCalls, tools, stop}`을 부모에 돌려준다. 자식 이름(runId) = `research:<userId>:t<턴>:<입력 해시>` |
| `src/assistant/agent.ts` | (1) **`research` 도구** → `runAgentTool(ResearchAgent, { runId, eventDelivery: "terminal" })`. 같은 턴·같은 입력이면 같은 runId(복구 턴에서 다시 불려도 runAgentTool이 중복 실행하지 않음) + 멱등 원장. 자식 llmCalls를 턴 llmCalls(20회 상한)에 더함. 남은 예산 2 미만이면 위임을 막음. 이벤트 `researchStart`/`researchEnd`. (2) **하루 턴 상한 30회** (`day:<KST 날짜>` 카운터, clientId 재전송은 세지 않음, 제출 실패 시 되돌림, 대화 지우기로 초기화 안 됨). (3) **`clear()`** — Think `clearMessages()` + `clearAgentToolRuns()` + 이벤트·원장 삭제, 턴 상태는 남기고 `clearedThrough` 뒤 턴만 화면에 보임. 열린 턴이 있으면 거부. (4) 턴 끝에 **D1 `assistant_turns` 요약 1행** (내용 없음, 실패해도 턴 영향 없음). (5) `history()`에 `usage` 추가. 시스템 프롬프트에 규칙 (g) 추가 (비교·여러 항목 조사 → research) |
| `src/assistant/routes.ts` | `GET /api/agents` (화면 목록: 내 어시스턴트 + 내 워크플로 agent 단계 20개, 승인 대기 = run `waiting_approval` && `current_step` = 그 단계), `GET /api/agents/wf/:runId/:stepIndex` (도구 호출 기록 — 끝난 단계는 D1 output.turns, 진행 중 Think 단계는 `ThinkAgent.inspect()` 읽기 전용; 내 run 아니면 404), `DELETE /api/agents/:id/messages` (본인만, 남의 id 404, Origin 검사, 열린 턴 409), 429 `daily_limit` 안내 |
| `src/obs/routes-workflows.ts` | `GET /api/obs/assistant-turns` (hr_admin/X-Admin-Secret, 익명 401·비관리자 403, 0041 없으면 `schemaMissing`) — **index.ts 수정 없이** 기존 `/api/obs` 마운트에 붙임 |
| `migrations/0041_assistant_turns.sql` (새 파일) | `assistant_turns(user_id, turn_no PK, status, stopped_reason, steps, llm_calls, tool_calls, tools, research_runs, recoveries, duration_ms, started_at, ended_at)` + `ended_at` 인덱스. 추가만 |
| `public/agents.js`·`public/agents.css` (새 파일) | 에이전트 화면 (순수 HTML+JS, 빌드 없음). 왼쪽 목록(어시스턴트 + 워크플로 agent 실행, 실행 중 점·상태 배지·Think/legacy·오늘 사용량), 어시스턴트 대화·보내기(clientId)·대화 지우기, **진행 기록**(2초 폴링: 도구 시작/끝·근거 유무·차단·스텝·판단 근거·하위 에이전트 위임/결과·한도·턴 끝), 워크플로 agent 단계 상세(도구 호출 기록·판단 근거·관찰·최종 답·**승인 대기 안내 → 결재함/워크플로 실행 화면 링크**, 실행 중이면 5초마다 갱신). 승인 처리 UI는 새로 만들지 않음 |
| `public/obs/assistant.js` (새 파일) | 관측 탭 하위 탭 "어시스턴트": 턴 요약 표(사용자·턴·상태·멈춤 사유·스텝·LLM 호출·도구·조사 위임·복구·소요) |
| `public/index.html` | 메뉴 "에이전트"를 **"워크플로우" 바로 다음**에 추가(기존 순서 그대로), `#tab-agents` 섹션, `agents.css`/`agents.js`/`obs/assistant.js` 로드, `TABS`·`COACHEE_TABS`·로그인 전용 목록에 `agents`, `switchTab`에 `agentsOpen`/`agentsLeave`, 관측 하위 탭 `assistant` (OBS_SUBS·obsSubOf) |
| `src/index.ts` | **+1줄**: `export { ResearchAgent }` (facet은 `ctx.exports[클래스 이름]`으로 찾으므로 export만 필요). V1+V2 3곳·크론·큐 소비자는 건드리지 않음 |
| `wrangler.toml` | `compatibility_flags = ["nodejs_compat", "enable_ctx_exports"]`, `[observability.traces] enabled = true, head_sampling_rate = 1`, `[vars] AGENT_RUNTIME = "think"`. compatibility_date·DO 블록·마이그레이션 태그·크론·큐는 그대로 |

건드리지 말 파일(`src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`)은 수정하지 않았다 (`git status`: 수정 6개 — index.html, agent.ts, routes.ts, index.ts, routes-workflows.ts, wrangler.toml). 질문 탭(`ask-pipeline.ts`·`agent-session.ts`)·엔진(`engine.ts`)·`think-agent.ts`도 그대로다.

### 0041을 만든 이유 (프롬프트 0-3 판단)

DO `inspectState`를 읽는 관리자 API는 "어느 사용자의 DO를 열지"를 D1 없이 알 수 없다 — 모든 사용자 DO를 순회하면 쓰지 않은 사용자의 DO까지 깨운다(생성자가 표를 만든다). 턴 끝에 D1 요약 1행을 쓰는 쪽이 쓰기 1회 + 조회 1회로 가볍고, 관측 탭에서 여러 사용자 턴을 한 표로 볼 수 있다. 내용은 싣지 않는다. 기존 `ask_events`는 건드리지 않았다.

### 하위 에이전트 사전 확인 — `enable_ctx_exports` (계획과 다른 점)

계획은 "자식은 바인딩·마이그레이션 불필요"였고 그대로 됐지만, **`compatibility_date 2025-07-18` + `nodejs_compat`만으로는 `ctx.exports`가 없어 `subAgent()`가 실패한다**. 별도 Worker `people-os-t3-probe`로 확인했다 (`t3-probe/out-probe.json`):
- 플래그 `nodejs_compat`만: `facets: object, exports: undefined` → `subAgent() is not supported in this runtime`
- `+ enable_ctx_exports`: `exports: object`, 자식 facet 왕복 성공 (Free 플랜)

그래서 compatibility_date는 올리지 않고 플래그 1개만 더했다. 영향 범위: `ctx.exports`가 생기는 것뿐 (다른 동작 변화 없음 — 아래 라이브 비교). 롤백 시 이 플래그를 빼면 research 도구만 실패로 끝난다(턴은 `조사 에이전트를 부르지 못했습니다` 관찰로 계속).

## 하네스 9항목

하네스: `files/workflow-verify/think-full/t3-harness/` (`harness.ts`, `wrangler.toml`(로컬), `wrangler.remote.toml`(원격), `tsconfig.json`, 결과 `out-*.json`·`out-local-routes.txt`). 운영 `AssistantAgent`·`ResearchAgent`·`agentsApp`·`workflowRunsApp`·엔진을 그대로 쓰고, 시험용 서브클래스(`HarnessAssistantAgent`·`HarnessResearchAgent`, T1의 `HarnessThinkAgent` 재사용)는 모의 모델·한도·노드 모의 실행만 덧씌운다. 로컬 D1에 0001~0041 전부 적용(오류 없음). 로컬 시험 사용자는 운영 `createSession`으로 만든 세션 쿠키로 불렀다.

| # | 항목 | 판정 | 증거 |
|---|---|---|---|
| 1 | `tsc` 오류 0 | ✅ | 운영·하네스 모두 출력 없음 |
| 2 | 하루 턴 상한 | ✅ | 로컬 운영 라우트, 시험값 상한 2: 턴 1·2 → 202 / 3번째 → **429** `"오늘 어시스턴트 사용 한도(2회)를 다 썼습니다. 내일(한국 시간 0시 이후) 다시 이용해 주세요."`, `code: daily_limit` / 같은 clientId 재전송 → 202 `duplicate: true` (세지 않음) / "다음 날"(dayKey +1일) → 202, 턴 3 완료, `usage {day 2026-11-21, used 1, cap 2}`. `t3-harness/out-local-routes.txt`, `out-daily-a-history.json` |
| 3 | 대화 지우기 | ✅ | B 쿠키로 A 지우기 → **404**, 쿠키 없음 → 401, 다른 Origin → 403, A 본인 → 200 `clearedThrough 3`. 뒤 `GET A messages` → `messages: [], turns: []` (사용량 used 1 그대로 — 지워도 상한 초기화 안 됨), 이벤트는 `cleared` 1줄만. **B 대화는 2개 그대로**. 지운 뒤 A 새 턴 → 정상, 메시지 2개 |
| 4 | 관측 탭 어시스턴트 턴 | ✅ | 0041 `assistant_turns` + `GET /api/obs/assistant-turns`: 로컬 hr_admin → 200, 6행(턴 상태·steps·**llm_calls**·tools·research_runs·소요), 일반 사용자 403, 익명 401. **라이브**: X-Admin-Secret → 200, 원격 하네스의 실제 턴 1행 (`llm_calls 9, tools [research], research_runs 1, duration 183,821 ms`), 익명 401. 화면: 관측 · 평가 → "어시스턴트" 하위 탭 (`public/obs/assistant.js`) |
| 5 | 에이전트 화면 | ✅ (API·자산 수준 — 아래 범위) | 화면이 부르는 API를 같은 순서로 확인: `GET /api/agents`(어시스턴트 + 워크플로 agent 목록, `out-list-eng.json`) → `GET messages`·`POST messages` 202 → `GET events?after=`(turnQueued·turnStart·toolStart·toolEnd·step(thinking)·turnEnd) → 답. 워크플로 agent 상세 `GET /api/agents/wf/…`(도구 호출 기록 turns 4개, 남의 run 404, `out-wf-detail.json`). **승인 대기 표시**: think agent가 send_email 선택 → run `waiting_approval`, 목록 `waitingApproval: true`, 상세 `live.pendingTool: send_email`, **발송 0**. 실제 모델 부분은 원격(6번)에서 같은 이벤트 모양 확인. 자산: 로컬·라이브 `agents.js` 200 22,934 B, `agents.css` 200, `obs/assistant.js` 200, 홈 HTML에 메뉴·섹션·스크립트 추가(diff는 의도한 줄만). `node --check` 오류 0. **범위**: VM에 브라우저가 없어 실제 클릭·렌더링은 확인하지 못했다 — Merlin이 로그인 후 메뉴 "에이전트"에서 1회 확인 필요 |
| 6 | 하위 에이전트 | ✅ | **로컬(모의 모델)** `out-research-local.json`: 부모 `research` → 자식 facet `research:u_res1:t1:91563f7c`(`trigger: agent-tool`, 활성 도구 3개뿐) → ask_rag → 요약 → **부모의 다음 모델 입력에 자식 요약 표식이 들어감(`markerHits 1`)** → 최종 답. 자식이 send_email을 부르게 해도 도구가 없어 실행 0. 부모 llmCalls 6 = 부모 2 + 자식 4. **원격(실제 Qwen 부모·자식 + 실제 ask-pipeline)** `out-real-research.json`: "연차 휴가와 경조사 휴가 규정을 조사 담당에게 맡겨 비교 정리해 줘" → 부모 스텝 1 `research`(thinking: "according to rule (g), I should use the research tool") → 자식 4스텝(ask_rag 3회, `grounded true`, 출처 연차휴가·근태·지각·출산 전후 재택 공지) → 부모 최종 답이 자식 결과(연차 제12조 내용, "3회 검색으로 확인", 경조사 규정 없음 안내)를 담음. 184초, `completed`, **llmCalls 9 = 부모 2 + 자식 7** |
| 7 | think 전환: legacy 기준선 비교 | ✅ | 아래 표. 라이브 `a685a42f`에서 같은 워크플로 `wf_mwo6tt5c_lfyb1p`를 think로 실행 |
| 8 | 한도 (Think 경로) | ✅ (+ 남은 문제 재현) | 로컬 운영 엔진: **동시 3** → 4번째 `동시 실행 상한(3개)` / **하루 20** → 20회 통과, 21번째 `하루 실행 상한(20회)` / **활성 30분** → 31분 전 시작 run은 첫 메시지에서 `실행 시간 상한(30분)을 넘었습니다`로 실패(DO 제출 없음) / **LLM 30** → llm 노드 26개 뒤 agent 예산 4, Think DO `llm_cap`(steps 4, llmCalls 4) = 합계 30에서 멈춤. agent 뒤 llm 노드는 막히지 않음 = 남은 문제 1. agent 자체 한도(10스텝·20회·28분·반복 3)는 T1 하네스 5번 그대로 (코드 변경 없음) |
| 9 | think 라이브 스모크 | ✅ (범위 제한) | 아래 표. 로그인 뒤 화면(질문 답변·템플릿 실행·채팅·결재함·LMS 내용·에이전트 화면 클릭)은 시험 계정이 없어 확인하지 못했다 |

### 7번 상세 — legacy 기준선 vs think (같은 워크플로·같은 목표 "T1 테스트용으로 이번 주 할 일을 한 문장으로 정리해 주세요.")

| | legacy `wfrun_mwo6tzvm_tofn09` (11-20 08:35 KST) | think `wfrun_mwoi511c_ez0l4k` (11-20 13:51 KST, `a685a42f`) |
|---|---|---|
| 완료 여부 | run `succeeded`, agent `succeeded` | run `succeeded`, agent `succeeded` (D1 `workflow_agent_steps.runtime = think`, `submission_id = consumed_submission = …:0`) |
| 도구 순서 | ask_personal → 최종 답 (turns 2) | ask_personal → 최종 답 (turns 2, 같은 모양 — 관측 API가 그대로 읽음) |
| 멈춤 사유 | 없음 | 없음 (`stoppedReason null`) |
| 승인 요청 | 0 | 0 (notifications 0) |
| 메일·웹훅 | 0 | 0 (도구 호출 기록에 send_email·webhook 없음) |
| 후속 단계 | create_task → `task_mwo6vb28_oodh5u` | create_task → `task_mwoi66p3_r18e04` |
| 소요 | 61초 | 54초 |
| LLM 호출 | 관측 2 (turns 길이) | DO 누적 3 (모델 2 + ask_personal 1), 관측 화면은 2로 표시 (남은 문제 4) |
| 답 | "이번 주 할 일 목록 없음" (세미나 전사본만 찾음) | "금요일 연차 3일 → 수요일까지 팀장에게 신청" (11월 팀 회의 전사본) — 같은 도구, 다른 검색 결과. 런타임 차이로 보지 않는다 (ask_personal 검색 결과 차이) |

실행 방법: 원격 시험 Worker `people-os-t3-harness`가 화면의 "실행" 버튼과 같은 처리(`checkWorkflowRateLimit` → 운영 `createRun` → `stepMessage(run, 0)`을 운영 큐에 넣기)만 했다. 이 Worker는 큐 **생산자로만** 붙어 있어 처리는 운영 Worker 소비자가 했다(tail: `entrypoint ThinkAgent`, `queue people-os-pipeline`, 전부 `outcome ok`). 기준선 소유자 계정에 할 일 1건(`task_mwoi66p3_r18e04` "T1 테스트 할 일")이 생겼다 — 기준선과 같은 부작용. `t3-live-smoke/live-run-state.json`, `live-obs-run.json`.

### 9번 라이브 스모크 (workers.dev, 배포 전 `307cf8b6` → 배포 후 `a685a42f`, 배포 3분 뒤 04:51Z)

| 대상 | 배포 전 | 배포 후 | 본문 |
|---|---|---|---|
| `GET /` (홈·로그인 화면) | 200, 138,237 B | 200, 139,478 B | **diff = 의도한 추가만** (agents.css 링크, 메뉴 버튼 "에이전트"(워크플로우 다음), `#tab-agents`, 관측 하위 탭 "어시스턴트", 스크립트 2줄, TABS·COACHEE_TABS·로그인 전용 목록·switchTab·OBS_SUBS 각 1곳) |
| `GET /api/auth/me` | 401 | 401 | sha256 같음 |
| `POST /api/ask` (HR 규정 질문, Turnstile 없음) | 403 | 403 | 같음 |
| `GET /api/workflows/templates` | 401 | 401 | 같음 |
| `GET /api/chat/rooms` | 401 | 401 | 같음 |
| `GET /api/approval/box` | 401 | 401 | 같음 |
| `GET /api/lms/courses` | 401 | 401 | 같음 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 797 B | 200, 797 B | 같음 (T2 최종과도 같음) |
| `GET /meet.js` | 200, 13,830 B | 200, 13,830 B | 같음 |
| `GET /api/agents/me` | 401 | 401 | 같음 |
| `GET /api/agents` (새) | 404 | **401** | 의도한 변화 |
| `GET /api/agents/wf/…`, `DELETE /api/agents/…/messages` (새, 비로그인) | — | 401 | |
| `GET /agents.js`·`/agents.css`·`/obs/assistant.js` | 404 | 200 (22,934 / 5,574 / 4,622 B) | |
| `GET /api/obs/assistant-turns` | — | 익명 401 / X-Admin-Secret 200 | |

파일: `t3-live-smoke/before-*`, `after-*`.

- 템플릿 5개 실행 자체는 로그인 계정이 필요해 하지 않았다. 대신 7번의 실제 워크플로 run이 라이브 큐 엔진 → think agent → 후속 create_task까지 끝났다 (엔진 경로 동작 확인).
- 배포 직후 2분 주의: 이번에는 04:49:49Z(배포 1분 41초 뒤)에 이미 새 라우트가 401을 냈다. 그래도 스모크와 think run은 04:51Z 이후에 했다.

### 배포 후 tail (`t3-live-smoke/tail-after-deploy.jsonl`)

04:48:30Z~04:54:34Z에 33건 — **전부 `scriptVersion a685a42f`, `exceptions: []`**, outcome `ok` 32건 + `canceled` 1건. `canceled`는 ThinkAgent DO의 알람(04:52:22Z 예약, cpuTime 0) — 7번 run의 결과 전달 재알림(`deliver` 2분 뒤 재시도)이며, 엔진이 이미 결과를 처리한(consumed) 뒤라 할 일이 없는 알람이다. 04:54:23Z 알람은 `ok`. 요청·ChatRoom DO·큐(`people-os-pipeline`)·ThinkAgent 호출 모두 `ok`.

**15분 크론(`*/15`, 05:00Z)은 확인하지 못했다.** tail 스트림이 04:54:34Z 이후 아무 이벤트도 내지 않았고(두 번째 tail도 비어 있음), 05:00Z scheduled 이벤트가 기록되지 않았다. 크론 분기 코드(워크플로우 스케줄 틱·`sweepMeetings()`)는 이번에 바꾸지 않았지만, `enable_ctx_exports` 플래그가 더해졌으므로 **Merlin이 대시보드 Logs/Cron 이벤트에서 05:00Z 이후 `*/15` 실행이 `ok`인지 확인해 주세요** (11-24 회귀 6번과 같이).

## 남은 문제

1. **엔진 run 30회 LLM 캡이 agent 뒤 LLM 노드에서 agent 사용량을 세지 않는다 (T1 주의 1, 이번에 고치지 않음)**. 8번에서 재현: llm 26 + agent 4 = 30 뒤에도 llm 노드 #27이 실행됐다. 엔진 `LLM 호출 상한` 검사가 `LLM_NODE_TYPES` 단계 수만 센다. 고치려면 engine.ts 8번 검사에 `priorLlmCalls()`(agent turns 포함)를 쓰면 되지만 엔진 수정이라 회귀 범위 판단이 필요하다.
2. **토큰 단위 스트리밍 없음** — 스텝 단위 진행만(T2-RESULT 3번 그대로). 긴 답은 턴이 끝날 때 한 번에 보인다.
3. **판단 근거(thinking)가 영어** — 어시스턴트·워크플로 agent 둘 다 이번 실제 실행에서 영어였다("According to rule (g)…", "Goal: …"). 화면에는 "판단 근거:"로 그대로 보인다. 한국어화는 T3 범위 밖.
4. **관측 숫자 두 가지**: (a) 워크플로 run 관측의 agent `llm_calls`는 turns 길이(모델 스텝)라 LLM 도구 호출을 빼고 센다 — think run 실제 3, 관측 2. (b) think agent 단계의 `duration_ms`가 63 ms로 나온다 — 엔진이 점유를 풀 때(`release`) 단계 `started_at`이 깨움 메시지 처리 시각으로 다시 찍히기 때문. 실제 단계 시간은 `workflow_agent_steps.created_at`→`updated_at`(약 42초). 둘 다 표시 문제이고 한도 판정과 무관.
5. **조사 자식의 마지막 스텝이 `max_steps`로 표시된다** — 실제 실행에서 자식은 4스텝째에 정리를 쓰고 끝났지만 `stop: max_steps`가 함께 남았다(4스텝째가 상한과 같아서). 결과(summary)는 정상으로 부모에 갔다. 3스텝 안에 끝내라는 프롬프트와 상한 4의 관계를 조정할지 11-24에 판단.
6. **조사 위임 소요 시간**: 실제 턴 184초(자식 4스텝 + ask_rag 3회). 활성 28분 상한 안이지만 화면에서는 3분 동안 "조사 하위 에이전트에 위임" 다음 줄이 안 바뀐다 (자식 진행은 부모 이벤트에 안 보임 — `eventDelivery: "terminal"`).
7. **에이전트 화면 실제 렌더링 미확인** (브라우저 없음, 위 5번).
8. `create_task` at-least-once (T2 주의 8)는 그대로. 조사 자식은 읽기 전용이라 해당 없음.
9. **시험 흔적 (운영 D1·R2)**: 원격 하네스의 실제 턴이 `assistant_turns`에 1행(`u_t3r`), ask_rag 질문 트레이스 3건(세션 id 접두어 `wf_research_u_t3r`)을 남겼다. 7번 think run과 할 일 `task_mwoi66p3_r18e04`는 기준선 계정에 남았다. 지울지는 Merlin 판단.

## 11-24 회귀 검증에 넘길 것

- 로그인해서 **에이전트 화면 클릭 확인**: 메뉴 순서(워크플로우 → 에이전트), 어시스턴트 메시지 → 진행 기록 2초 갱신 → 답, "대화 지우기", 워크플로 agent 실행 목록·상세·승인 대기 배지 → 결재함 링크. 코칭 대상 계정에서도 메뉴가 보이는지.
- 관측 · 평가 → "어시스턴트" 하위 탭 표.
- 회귀 목록 2번(agent 노드 legacy/think 3목표 비교·같은 큐 메시지 2번): 이번 7번은 1목표만. 승인 경로(send_email 고르는 목표)를 라이브 think로 1회 — 로컬에서는 승인 전 발송 0 확인함.
- 03:00 KST 자동 평가(질문 경로) 결과 확인 — 이번 배포는 질문 경로를 바꾸지 않았다 (`ask-pipeline.ts`·`agent-session.ts`·평가 runner 무변경).
- 화상회의 V0~V2·전사 큐: 이번 배포에서 `enable_ctx_exports` 플래그가 더해졌으므로 RealtimeKit·`transcript-pipeline` 소비자를 실제로 1회 확인.
- 대시보드 **Observability → Traces / Agents 화면에 스팬이 보이는지** (Merlin 직접 확인 — 아래).
- 롤백 방법(P2): `AGENT_RUNTIME = "legacy"` 재배포 + index.html에서 `data-tab="agents"` 버튼 숨김. `enable_ctx_exports`·traces는 그대로 둬도 된다 (research만 영향).

## 추적 (H)

`[observability.traces] enabled = true, head_sampling_rate = 1`로 배포했다 (dry-run·배포 모두 설정 오류·경고 없음). **대시보드에서 스팬이 보이는지는 이 세션에서 확인하지 못했다** (대시보드 접근 없음) — Merlin 확인 필요: Workers & Pages → people-os → Observability(Traces), Agents 화면. 기존 D1+R2 트레이스(관측 탭)와 Workers Logs는 그대로다.

## 정리할 것 (커밋에서 뺄 것)

- `files/workflow-verify/think-full/t3-harness/state/`, `dev.log` — 로컬 D1·DO 상태.
- `files/workflow-verify/think-full/dryrun-t3/` — dry-run 빌드 산출물.
- 원격 Worker: `people-os-t3-probe`·`people-os-t3-harness` **둘 다 이 세션에서 삭제함**. T1·T2 하네스 Worker(`people-os-t1-harness`, `people-os-t2-harness`)는 손대지 않았다.
- 커밋할 것: `src/assistant/{agent,routes,research}.ts`, `src/index.ts`, `src/obs/routes-workflows.ts`, `migrations/0041_assistant_turns.sql`, `public/{index.html,agents.js,agents.css,obs/assistant.js}`, `wrangler.toml`, `t3-harness/{harness.ts,wrangler.toml,wrangler.remote.toml,tsconfig.json,out-*}`, `t3-probe/`, `t3-live-smoke/`, 이 파일.

## AGENTS.md에 넣을 것 (이 세션은 `~/AGENTS.md`를 쓸 권한이 없다 — Merlin이 옮겨 주세요)

- **Think 하위 에이전트(facet)는 `compatibility_date 2025-07-18`에서 `enable_ctx_exports` 플래그가 있어야 된다** (`ctx.facets`는 있지만 `ctx.exports`가 없다). Free 플랜에서 동작. 자식 클래스는 worker 진입점에서 export만 하면 되고 바인딩·마이그레이션은 필요 없다.
- `-p` 세션에서 셸 변수(`A=...; curl $A`)·`tee`·`sort`·`diff`를 파이프로 이으면 승인 대기가 된다. 값을 명령에 직접 쓰고 한 명령에 한 도구로. 예외: `S=$(cat <비밀 파일>); curl -H "x-admin-secret: $S" <URL>` 한 개는 된다.
- `npx wrangler dev`는 `--local`이 **`dev` 바로 뒤**에 있어야 허용 규칙에 걸린다 (`npx wrangler dev --local --config …`).
