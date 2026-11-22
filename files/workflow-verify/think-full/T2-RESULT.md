# Think 전면 도입 T2 결과 (2026-11-20 오전, Opus 5.5 단일 세션)

## 판정

| 통과 기준 | 판정 | 근거 |
|---|---|---|
| `npx tsc --noEmit` 오류 0 | ✅ | 운영(`tsconfig.json`)·하네스(`t2-harness/tsconfig.json`) 둘 다 출력 없음 (배포 직전 재확인) |
| 로컬 하네스 8항목 | ⚠️ 7/8 통과 + 7번 판정 보류 | 아래 표. 실제 모델·ask-pipeline 시험(2·3번 일부)은 원격 시험 Worker에서 했다. 8번은 로그인 없이 볼 수 있는 범위만. **7번(골든셋)은 Workers AI `3040 Capacity temporarily exceeded`로 2문항이 두 번 다 채점되지 못해 "6/6, 0.8667과 같다"를 확인하지 못했다** (채점된 문항은 2차에서 4/4 통과) |
| `AGENT_RUNTIME=legacy` 배포 후 라이브 변화 없음 | ✅ (평가 조건부) | 기존 스모크 9건이 배포 전과 최종 버전 사이에 상태 코드·크기·sha256 전부 같음, 15분 크론 틱 `outcome ok`·예외 0, tail 전체에 오류 결과 0. 골든셋은 위 7번 참조 — 실패 원인은 질문 경로 코드가 아니라 모델 용량 오류 |

- **최종 라이브 버전**: `ad64158d-b33f-4d62-a087-23ffa04abe3c` (people-os, 2026-11-20 01:21:58Z = 10:21 KST, 100%). 중간 버전 `28548d29-5fd9-4d40-bec2-c573a7ca4cf2` (01:01:34Z = 10:01 KST, T2 첫 배포). T2 직전 버전 `7931eb4a-af8d-412c-97b3-1e95e0df66d3`.
- 두 번 배포한 이유: 첫 배포 뒤 자체 검토에서 `send()`의 버그를 찾았다 — `runTurn` 제출 자체가 예외를 내면 턴이 `queued`로 영영 남고, 그런 턴이 2개 쌓이면 그 사용자는 계속 429를 받는다. 예외 시 턴을 `error`로 닫고 `turnEnd`를 남기도록 고쳤다(로컬 회귀: 운영 라우트로 턴 3 `completed`). 이 고침을 포함한 것이 `ad64158d`이고, 커밋할 코드와 라이브가 같다.
- `versions view`: D1 `5dff997a-…`(운영) — deploy 출력의 `36113f26`은 wrangler 4 표시 문제(AGENTS.md), `AGENT_RUNTIME="legacy"`, 새 바인딩 `ASSISTANT_AGENT (AssistantAgent)`, v5 적용.
- 업로드 8,330 KiB / gzip 1,709 KiB (T1 8,304 / 1,701), 시작 시간 172 ms. 자산 변경 없음.
- **D1 마이그레이션 없음** (0041을 만들지 않았다 — 어시스턴트 상태는 전부 DO SQLite에 있다). 그래서 `migrations list`/apply도 하지 않았다.
- 커밋·태그는 하지 않았다 (`think-t2` 태그는 Merlin이).

## 구현한 것

| 파일 | 내용 |
|---|---|
| `src/assistant/agent.ts` (새 파일) | `AssistantAgent extends Think<Env>` — 사용자당 DO (이름 `assistant:<userId>`). 도구 6개, 훅(`beforeTurn`·`beforeStep`·`beforeToolCall`·`afterToolCall`·`onStepFinish`·`onChatRecovery`·`onSubmissionStatus`), RPC(`send`·`events`·`history`·`inspectState`) |
| `src/assistant/routes.ts` (새 파일) | Hono `agentsApp`: `GET /me`, `POST /:id/messages`, `GET /:id/messages`, `GET /:id/events` |
| `src/index.ts` | **+4줄만**: import 1줄, `export { AssistantAgent }` 1줄, `Env.ASSISTANT_AGENT` 1줄, `app.route("/api/agents", agentsApp)` 1줄(캐치올 앞, `/api/workflows` 다음). V1+V2 3곳(import·`finishTranscript`·`setMeetHooks`+`sweepMeetings`)·크론·큐 소비자는 건드리지 않았다 |
| `src/workflow/types.ts` | `Env.ASSISTANT_AGENT?` 1필드 |
| `src/workflow/think-agent.ts` | 도우미 4개(`clip`·`asText`·`stripThink`·`stableKey`)에 `export`만 붙였다 (동작 변화 없음) |
| `wrangler.toml` | `[[durable_objects.bindings]] ASSISTANT_AGENT → AssistantAgent`, `[[migrations]] v5 new_sqlite_classes = ["AssistantAgent"]`. v1~v4·기존 바인딩·`compatibility_date`·`[vars]`(`AGENT_RUNTIME="legacy"`) 그대로 |

건드리지 말 파일(`src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`)은 수정하지 않았다 (`git status`: 수정 4개 + 새 디렉터리 `src/assistant/`). 질문 탭(`ask-pipeline.ts`·`agent-session.ts`)도 그대로다.

### 설계 요약

- **격리 (D)**: 워크플로 agent 단계(ThinkAgent, `think:<runId>:<stepIndex>`)와 **클래스·바인딩·DO 저장소가 아예 다르다** (`AssistantAgent`, `assistant:<userId>`). 라우트는 `:id === "asst_" + 세션 사용자 id`일 때만 그 사용자의 DO를 연다 — 다르면 **404** (다른 사용자 어시스턴트가 있는지도 흘리지 않는다). DO 안에서도 소유자(`owner`)를 저장해 두고 RPC마다 한 번 더 확인한다(다르면 라우트가 404로 바꾼다).
- **인증 (2.4)**: 세션 쿠키 전용, `getSessionUser`의 역할 검사(hr_admin·user만) 그대로. X-Admin-Secret으로는 열리지 않는다(라이브 401 확인). 쓰기(POST)는 워크플로 라우트와 같은 Origin 검사. **`routeAgentRequest`는 쓰지 않았다** — DO는 Worker 라우트를 거친 RPC로만 불린다.
- **메시지 (2.4)**: `POST /api/agents/:id/messages {text, clientId?}` → DO `send()` → `runTurn({ mode: "submit", submissionId = idempotencyKey = "turn-<n>", metadata: { turnNo } })` → **202로 바로 반환** (턴은 DO 안에서 돈다). `clientId`가 같으면 같은 턴을 돌려준다(`duplicate: true`). 동시에 열린 턴은 2개까지(초과 429). 본문 4,000자 상한.
- **진행 이벤트 (2.4)**: **2안(2초 폴링)을 택했다.** 메시지가 submit 모드라 턴이 RPC 요청 밖(DO의 제출 큐)에서 돌고, `chat()` 스트림 콜백은 그 턴에 붙일 수 없다. 대신 훅마다 DO SQLite `pos_ev`에 한 줄씩 남기고(`turnQueued`·`turnStart`/`turnResume`·`toolStart`·`toolEnd`·`toolBlocked`·`toolReplay`·`step`·`limit`·`recovery`·`turnEnd`), `GET /:id/events?after=<cursor>`가 JSON으로 돌려준다(`pollMs: 2000`). 덤으로 `Accept: text/event-stream`이면 같은 로그를 SSE로 흘린다(서버가 1초마다 DO를 읽음, 최대 55초, 턴이 없으면 닫고 `Last-Event-ID`로 이어 받기). 이벤트는 3,000줄 보존.
- **대화 영구 저장**: Think가 메시지를 DO SQLite에 저장 → `GET /:id/messages`(`getMessages()` 요약 + 최근 턴 10개 상태). 한도로 멈춘 턴은 `addMessages`로 멈춤 안내를 대화에 남긴다(턴을 새로 돌리지 않음).
- **도구 (필수 좁히기)**: `getTools()`가 `ASSISTANT_TOOLS` 6개(`ask_rag`·`ask_personal`·`summarize`·`llm`·`email_draft`·`create_task`)만 만들고, `beforeTurn`이 `activeTools`를 같은 6개로 준다. Think가 제공한 도구는 **13개(기본 7 + 6)였고 활성은 6개** (로컬·원격 모두 `turnStart.offered 13 / active 6`). `send_email`·`webhook`은 목록에 없고, 그래도 들어오면 `beforeToolCall`이 막는다(`toolBlocked:not_allowed`, 실행 0).
- **ask-pipeline 도구**: `ask_rag`/`ask_personal`은 T1과 같은 `NODE_REGISTRY` 경로(`runAskNode` → `runAsk`)다. 노드 컨텍스트: `runId = asst_<uid>_t<turn>`, `workflowId = "assistant"` → ask 세션 id `wf_asst_<uid>_t<n>_<n>`, `create_task`의 출처 표시 `workflow:assistant`.
- **한도 (T1과 같은 값·같은 방식)**: 턴 상태 `pos_kv turn:<n>`에 `steps`·`llmCalls`·`toolCalls`·`lastTools`·`stop`·`startedAt`·`turnBase`. 턴 번호는 `runTurn` metadata → Think가 사용자 메시지에 저장 → 복구 턴에서도 `activeTurnMetadata.turnNo`로 같은 턴을 이어 센다. 10스텝, **LLM 20회 = 모델 스텝 + LLM 도구(ask_rag·llm·email_draft 등) 합계**(T1의 run 30회 캡은 걸지 않음), 28분(첫 `beforeTurn`부터 — 대기열 시간 제외), 같은 도구 3회 연속. 턴의 `llmCalls`는 `turnEnd` 이벤트·턴 상태·`GET messages`의 `turns`에 남는다.
- **멱등 원장 (T1 주의 1)**: `pos_fx` 키 = `턴 번호 + 도구 + 입력`. 같은 턴의 복구 턴은 끝난 실행을 다시 하지 않는다(`toolReplay`). 다른 턴에서 같은 질문은 새로 실행한다. 부작용 도구가 없어 at-most-once가 필요한 도구는 없다.

## 하네스 8항목

하네스: `files/workflow-verify/think-full/t2-harness/` (`harness.ts`, `wrangler.toml`(로컬), `wrangler.remote.toml`(원격), `tsconfig.json`, 결과 `out-*.json`). 운영 `AssistantAgent`를 그대로 쓰고, 시험용 서브클래스 `HarnessAssistantAgent`는 모의 모델(`MockLanguageModelV4`)·줄인 한도·노드 모의 실행/계수만 덧씌운다. `/api/agents/*`는 **운영 라우트 `agentsApp`를 그대로 마운트**했고, 로컬 시험 사용자는 운영 `createSession`으로 만든 세션 쿠키로 불렀다. 로컬 D1에 0001~0040 전부 적용(오류 없음).

| # | 항목 | 판정 | 증거 |
|---|---|---|---|
| 1 | `tsc` 오류 0 | ✅ | 운영·하네스 모두 출력 없음 |
| 2 | 어시스턴트 생성 → 메시지 → 턴 완료, ask_rag가 실제 `runAsk`로 근거 있는 답 | ✅ | **원격(실제 Qwen + 실제 ask-pipeline)** `out-real-turn1.json`: "연차 휴가는 1년에 며칠인가요?" → `toolStart ask_rag` → `toolEnd ok, grounded: true`(sources `doc_mweyu70u…`, 『연차휴가 › 제12조』) → 최종 답 "1년 이상 근속 15일, 2년마다 +1일, 최대 25일 (출처: 『연차휴가』 제12조)". 41.6초, 2스텝, llmCalls 3(모델 2 + ask_rag 1), `completed`. 로컬(모의 모델)에서도 운영 라우트로 같은 흐름 202 → `turnEnd completed` (`out-events-a-turn1.json`) |
| 3 | 영구 세션 (DO 재시작·재배포 뒤 대화 유지) | ✅ | **로컬**: 턴 1 → `ctx.abort()`로 DO 강제 종료 → `GET messages` 그대로 → 턴 2 → **wrangler dev 프로세스 전체 재시작** → 4개 메시지 + 턴 2개 그대로 (`out-history-a-after-restart.json`). **원격**: 턴 1 → DO 강제 종료 → 후속 질문 "그럼 입사 5년 차면 며칠이야?"가 앞 턴 맥락으로 도구 없이 "17일 (출처: 『연차휴가』 제12조)" (`out-real-turn2.json`) → **시험 Worker 재배포**(`1f923d38` → `16616005`) → `/h/history`에 4개 메시지·턴 2개 그대로 (`out-real-history-after-redeploy.json`) |
| 4 | 격리: 남의 id 404, 자기 것 200 | ✅ | 로컬 운영 라우트: B 쿠키로 A의 `GET /messages`·`POST /messages`·`GET /events` → 전부 **404** "어시스턴트를 찾을 수 없습니다", B 자기 것 `GET /asst_u_t2b/messages` → **200** (빈 대화 — A의 대화가 안 보임), A 자기 것 → 200(대화 2개), 쿠키 없음 → **401**. 라이브: 비로그인 `/api/agents/me`·`/api/agents/asst_someone/events` → 401, X-Admin-Secret만 → 401 |
| 5 | 진행 이벤트 (2안 폴링 + SSE 래퍼) | ✅ | `GET /events?after=0` (JSON, `pollMs 2000`): `turnQueued → turnStart(active 6) → toolStart ask_rag → toolEnd(grounded) → step 1 → step 2(text) → turnEnd(completed, steps 2, llmCalls 3)`. SSE(`Accept: text/event-stream`, `after=7`): 200 `text/event-stream`, `id:`/`event:` 줄로 턴 2 이벤트 7개 + `event: end` (`out-sse-a.txt`). 원격 실제 턴 이벤트도 같은 모양 (`out-real-turn1.json` events) |
| 6 | 한도 (DO 저장소 누적값) | ✅ | 로컬 모의 모델, 운영 훅 그대로 (`out-lim-*.json`). 스텝: `max_steps` **10스텝**. LLM: 운영값 20은 10스텝 안에 닿을 수 없어(최대 15) 시험값 7 → `llm_cap` **llmCalls 7**(모델 5 + ask_rag 2). 시간: 시험값 5초·도구 2초 → `timeout` 3스텝. 반복: create_task 연속 → `repeat_tool` 3스텝. **강제 종료 복구**: 8초에 `ctx.abort()` → `recoveries 1` → 누적 **10**에서 `max_steps` (턴별로 셌다면 넘었을 것). 부작용 차단: 모델이 `send_email`·`webhook`을 부르게 해도 `toolBlocked:not_allowed` 2회, **실행 0·발송 0**, 턴은 `completed` |
| 7 | 질문 탭 회귀 (골든셋 평가) | ⚠️ 판정 보류 | 기준 `run_33db237d37c24e15`(v5, 00:06Z): 6/6 통과, avgJudge 0.8667. 배포 후 2회 (둘 다 `28548d29`, 프롬프트 v5 `pv_086c7a84faaa4d19`, 같은 데이터셋 `ds_core_v1`) — 아래 표 |

#### 7번 상세

| 문항 | 기준 (00:06Z) | 1차 `run_7a7bca7ba310408d` (01:04Z) | 2차 `run_fd460952327e498c` (01:14Z) |
|---|---|---|---|
| gi_s03_leave_3days | pass | pass 0.8 | pass 0.8 |
| gi_s04_leave_accrual | pass | **error** `ask_llm_unavailable` | **error** `ask_llm_unavailable` |
| gi_s05_tacit_maternity_remote | pass | pass 0.8 | pass 0.9 |
| gi_s07_hwpx_scope | pass | **fail 0.5** (조치 0점 — 판정 흔들림) | pass 0.8 |
| gi_s10_training_support | pass | **error** `ask_llm_unavailable` | **error** `ask_llm_unavailable` |
| gi_s11_travel_expense | pass | pass 0.9 | pass 0.9 |
| 합계 | 6/6, 0.8667 | `partial`, 3 pass / 1 fail / 2 error, avgJudge 0.75 | `partial`, **4/4 pass**, 2 error, avgJudge 0.85 |

- error 2건의 원인은 트레이스의 `llm` 스팬: **`3040: Capacity temporarily exceeded, please try again.`** (Workers AI `@cf/qwen/qwen3.8-27b` 용량 오류 → ask-pipeline이 `local-template` 폴백으로 답해 평가기가 error로 셈). 1차 `evt_mwoa2exl_bmfq49`(s04), 2차 `evt_mwoaia8w_dgowxq`(s10) 둘 다 확인 (`t2-live-smoke/trace-*.json`).
- 이번 배포는 질문 경로(`ask-pipeline.ts`·`agent-session.ts`·평가 runner·큐 소비자)를 바꾸지 않았다. 바뀐 것은 새 라우트·새 DO·도우미 export뿐이다. 그래서 회귀로 보지는 않지만, **같은 2문항이 두 번 연속 용량 오류였다는 점은 우연으로 단정하지 않는다** — 이 두 문항만 프롬프트가 길어 용량 한도에 먼저 걸리는지 등은 확인하지 못했다.
- **Merlin 확인 요청**: 모델 용량이 풀린 뒤(예: 03:00 KST 평가 크론 결과 또는 수동 1회) 6/6이 나오면 7번을 통과로 닫는다. 그때도 s04·s10만 3040이면 질문 탭 쪽 문제로 따로 봐야 한다. 지시대로 되돌리지 않았다.
- s07의 1차 fail(0.5)은 2차에서 0.8 pass — 심판 모델 흔들림으로 본다.
| 8 | legacy 라이브 스모크 | ✅ (범위 제한) | 아래 표. 로그인 뒤 화면(HR 질문 답변·템플릿 실행·채팅·결재함·LMS 내용·어시스턴트 실제 사용)은 시험 계정이 없어 확인하지 못했다 |

### 8번 라이브 스모크 (workers.dev, 배포 전 `7931eb4a` → 배포 후 `28548d29` → 최종 `ad64158d`)

`ad64158d`에서도 아래 기존 9건을 다시 쟀고(`t2-live-smoke/after2-*`, 배포 3분 뒤) 전부 배포 전과 sha256이 같다. `/api/agents/me` 비로그인 401도 같다.

| 대상 | 배포 전 | 배포 후 | 본문 sha256 |
|---|---|---|---|
| `GET /` (홈·로그인 화면) | 200, 138,237 B | 200, 138,237 B | 같음 |
| `GET /api/auth/me` (비로그인) | 401 | 401 | 같음 |
| `POST /api/ask` "연차 휴가는 1년에 며칠인가요?" (비로그인, Turnstile 없음) | 403 | 403 | 같음 |
| `GET /api/workflows/templates` (비로그인) | 401 | 401 | 같음 |
| `GET /api/chat/rooms` (비로그인) | 401 | 401 | 같음 |
| `GET /api/approval/box` (비로그인) | 401 | 401 | 같음 |
| `GET /api/lms/courses` (비로그인) | 401 | 401 | 같음 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 797 B | 200, 797 B | 같음 |
| `GET /meet.js` (V1+V2 자산) | 200, 13,830 B | 200, 13,830 B | 같음 |
| `GET /api/agents/me` (새 라우트, 비로그인) | 404 "unknown api route" | **401** "로그인이 필요합니다" | (의도한 변화) |
| `GET /api/agents/asst_someone/events` (비로그인) | — | 401 | |
| `GET /api/agents/me` (X-Admin-Secret만) | — | 401 (관리자 시크릿으로 안 열림) | |

파일: `t2-live-smoke/before-*`, `t2-live-smoke/after-*`.

**배포 직후 주의 (T1 주의 5 재현)**: 배포(01:01:34Z) 뒤 2분 안에 친 첫 스모크에서는 `/api/agents/me`가 여전히 404 "unknown api route"였다(옛 버전이 응답). 같은 코드를 로컬 `wrangler dev --local`로 띄우면 401이 나와 코드 문제가 아님을 확인했고, 01:03:34Z부터 라이브도 401. 표의 "배포 후" 값은 전부 그 뒤에 다시 잰 것이다.

### 배포 후 크론

`cf-wrangler.py tail people-os --format json`을 첫 배포(`28548d29`) 직후부터 걸었다 (`t2-live-smoke/tail-after-deploy.jsonl`). **01:15:28Z(10:15 KST) `*/15 * * * *` 이벤트: `scriptVersion 28548d29`, `outcome: "ok"`, `exceptions: []`, wallTime 377 ms** (워크플로우 스케줄 틱 + 정체 run 청소 + `sweepMeetings()`가 같은 분기에서 오류 없이 끝남). 그 사이 요청·DO 호출 전부 `outcome ok`, `exception`/`exceededCpu`/`canceled`/error 로그 0건. 평가 2회의 큐 처리(`eval-item`)도 같은 큐 소비자로 끝났다(평가가 끝까지 진행됨). 큐의 전사 메시지·RealtimeKit·03:00 평가 크론·07:00 다이제스트는 이 창에서 돌지 않아 확인하지 못했다. 최종 `ad64158d`는 DO 안 `send()` 예외 처리만 다르다.

## 원격 시험 Worker (T1 주의 12 — 실제 모델 시험 방법)

로컬 dev는 Workers AI(프록시 TLS)도 Vectorize도 못 쓰므로, 실제 Qwen + 실제 ask-pipeline 시험은 **별도 시험 Worker `people-os-t2-harness`** 로 했다.

- 설정: `t2-harness/wrangler.remote.toml` — 같은 `harness.ts`, 바인딩 AI·**운영 D1(5dff997a)·운영 KV CACHE·운영 R2 FILES·운영 Vectorize**(ask-pipeline이 읽어야 해서) + DO 2개(`HarnessAssistantAgent`, `AgentSession`). 큐·자산 없음. 시험 창 `OPEN_UNTIL = 1795143600000`(**11-20 12:00 KST**) 이후 403.
- 배포: `cf-wrangler.py deploy --config files/workflow-verify/think-full/t2-harness/wrangler.remote.toml`. 버전 `1f923d38-…` → 재배포 `16616005-eb51-4017-baaf-9300f9189c42`.
- 쓰는 법: `GET /h/real?user=<합성 id>&text=<질문>` (세션 없이 DO RPC를 직접 부르고 턴 끝까지 기다려 상태·이벤트를 돌려준다), `/h/history?user=`, `/h/abort?user=`.
- **부작용**: ask_rag가 운영 D1·R2에 **질문 트레이스 1건**을 남겼다(턴 1, 세션 id `wf_asst_u_t2r_t1_1`, 질문 "연차 휴가는 1년에 며칠인가요?"). 턴 2는 도구 없음, 턴 3은 `email_draft`만(LLM 호출, D1 쓰기 없음). 사용자 행은 만들지 않았다. 관측 탭에서 보이면 시험 흔적이다.
- 다음에 쓸 때: `OPEN_UNTIL`만 늘려 재배포하면 된다. **지울지는 Merlin 판단**: `cf-wrangler.py delete --name people-os-t2-harness` (운영 D1을 바인딩하고 있으니 다 쓰면 지우는 것을 권한다). T1의 `people-os-t1-harness`도 남아 있다.

## T1 주의 7 — Qwen thinking

**어시스턴트 턴에서는 thinking이 비어 있지 않았다.** 원격 실제 턴 3개, 모델 스텝 5개 전부 `reasoningText`가 있었다(`thinkingSteps 2/1/2`, `thinkingEmptySteps 0/0/0`). 내용은 영어였다 (예: "According to rule (a), questions about company regulations ... must be answered using the ask_rag tool"). T1(워크플로 agent, `llm` 도구 번역 과제)에서 비어 있던 것과 다르다 — 과제·프롬프트에 따라 달라지는 것으로 보인다. 턴 상태에 `thinkingSteps`·`thinkingEmptySteps`, `step` 이벤트에 `thinking`(300자)을 남기도록 해 두었으니 T3 화면에서 바로 쓸 수 있다. 한국어 화면에 영어 근거가 뜨는 것은 T3에서 결정할 일.

## T3에 넘길 주의사항

1. **AGENT_RUNTIME=think 전환 전 체크리스트**: (a) 라이브에서 agent 노드 워크플로 1개를 legacy로 돌려 기준을 남긴다(T1 주의 7, 아직 못 함 — 로그인 계정 필요). (b) 전환 배포 뒤 2~3분은 옛 버전이 응답한다 — 확인은 그 뒤에. (c) 진행 중인 legacy 단계는 legacy로 끝난다(단계 단위 고정). (d) 엔진의 run 30회 LLM 캡이 agent 뒤 LLM 노드에서 agent 사용량을 세지 않는 문제(T1 주의 1)가 아직 남아 있다.
2. **에이전트 화면 (T3)**: 붙일 API는 `GET /api/agents/me` → id, `POST /api/agents/:id/messages`, `GET /api/agents/:id/messages`(대화 + 최근 턴), `GET /api/agents/:id/events?after=`(2초 폴링, 또는 `Accept: text/event-stream`). 이벤트 이름·필드는 "설계 요약" 참조. 프런트는 이번에 만들지 않았다(`public/` 변경 없음).
3. **SSE 1안(chat() 콜백)**: submit 모드 턴에는 콜백을 붙일 수 없다. 토큰 단위 스트리밍이 필요하면 `runTurn({mode:"stream"})`을 Worker 라우트에서 열어야 하는데, 그러면 요청이 끊길 때 턴 처리(복구·대기열)를 다시 설계해야 한다. 지금 이벤트 로그는 스텝 단위(도구 시작·끝, 스텝 텍스트)다.
4. **추적**: 어시스턴트 턴은 `obs` 트레이스 표에 직접 남지 않는다 — ask_rag 호출만 기존 질문 트레이스(origin user/personal, 세션 id `wf_asst_…`)로 남는다. 관측 탭에 어시스턴트 턴(턴 상태·llmCalls)을 보이려면 DO의 `inspectState`/턴 상태를 읽는 관리자 API나 D1 요약 행이 필요하다(필요하면 0041).
5. **하위 에이전트**: 어시스턴트가 워크플로를 시작하거나 Think 하위 에이전트를 부르는 기능은 없다. 넣을 때도 `activeTools`로 좁히는 규칙과 "부작용 도구 없음" 규칙을 유지할 것. 넣으면 하위 에이전트 DO 이름 접두어를 `assistant:`·`think:`와 다르게.
6. **비용·남용**: 사용자당 동시 턴 2개 제한만 있고 일일 상한·레이트 리밋은 없다. 턴당 최대 LLM 20회 × 무제한 턴. 화면을 열기 전에 사용자별 일일 턴 상한(DO 저장소 카운터면 충분)을 넣을 것.
7. **대화 길이**: Think가 모델 입력을 잘라/정리해 주지만(`TurnContext.messages: truncated, pruned`), 대화 저장은 끝없이 쌓인다. "대화 지우기"(`clearMessages`) 라우트가 아직 없다.
8. **create_task 중복 가능 (at-least-once)**: 도구 실행 도중(D1 쓰기 뒤 원장 기록 전) DO가 죽으면 복구 턴이 다시 실행한다. 강제 종료 시험에서 `toolCalls 11`(스텝 10) — 끊긴 스텝의 도구가 한 번 더 불렸다. 모의 노드라 실제 할 일은 만들지 않았다.
9. **같은 턴 안의 같은 질문은 원장 결과를 재사용**한다(`toolReplay`). LLM 한도 시험에서 두 번째 `ask_rag "교대 B"`가 재사용됐다 — 의도한 동작이지만, 모델이 같은 질문을 반복하면 새 근거를 얻지 못한다(반복 한도 3이 함께 막는다).
10. **역할**: 지금은 hr_admin·user 모두 어시스턴트를 쓸 수 있다(`getSessionUser`가 허용하는 역할 전부). `ask_personal`·`summarize`는 노드가 소유자 검사를 한다(T1과 같음).

## AGENTS.md에 넣을 것 (이 세션은 `~/AGENTS.md`를 읽고 쓸 권한이 없어 못 넣었다 — Merlin이 옮겨 주세요)

- `-p` 세션의 로컬 curl: `env -u http_proxy … curl http://127.0.0.1:…`은 `Bash(curl *localhost*)`에 안 걸려 승인 대기가 된다. `curl -s --noproxy '*' "http://localhost:<port>/…"`로 쓴다.
- 셸 반복문(`for`/`until`/`break`)과 Monitor의 반복문은 승인 대기로 막힌다. 긴 작업은 `sleep N`을 **백그라운드**로 돌려 깨어난 뒤 curl 1회로 확인한다 (포그라운드 sleep은 막힘).
- people-os 배포 뒤 약 2분은 옛 버전이 응답한다 (01:01 배포의 새 라우트가 01:03까지 캐치올 404). 배포 후 스모크는 3분 뒤에. 새 라우트가 404면 코드를 의심하기 전에 `npx wrangler dev --local --port <p> --persist-to <작업 폴더>`로 재현한다.
- tail JSON은 들여쓰기가 있어 `"outcome": "ok"`처럼 콜론 뒤에 공백이 있다 (grep 패턴 주의).

## 정리할 것 (커밋에서 뺄 것)

- `files/workflow-verify/think-full/t2-harness/state/`, `state-main/` — 로컬 D1·DO 상태. `dev.log`·`dev2.log`·`dev3.log`·`dev-main.log`도.
- `files/workflow-verify/think-full/dryrun-t2/` — 원인 확인용 dry-run 빌드 산출물.
- 커밋할 것: `src/assistant/{agent,routes}.ts`, `src/index.ts`, `src/workflow/{types,think-agent}.ts`, `wrangler.toml`, `t2-harness/{harness.ts,wrangler.toml,wrangler.remote.toml,tsconfig.json,out-*.json,out-sse-a.txt}`, `t2-live-smoke/`, 이 파일.
