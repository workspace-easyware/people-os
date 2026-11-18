# People OS 워크플로우·에이전트 빌더 — FULL 구현 계획

> 작성: 2026-11-18 (코디네이터). 근거: `workflow-agent-builder-proposal.md`(410행) + 코드베이스 실측.
> **사용자 지시 (2026-11-18 02:16): "클로드 코드 통해 계획 수립 업데이트하고 개발진행해, 전체 한꺼번에 full로 진행해라. 토큰 많다."**
> 제안서의 "공모전 동결 전에는 만들지 않는다"는 전제는 사용자가 직접 뒤집었다. 전 단계(full)를 한 번에 진행한다.
> 단, **동결(11-25)·제출(11-27)이 코앞이므로 세션마다 배포 후 데모 회귀 확인을 한다.** 회귀가 나오면 즉시 중단하고 PROGRESS.md에 기록한다.

## 0. 목표와 범위

개인이 자기 워크플로우·에이전트를 만드는 기능. 제안서 4.1(선형 워크플로우) + 4.2(에이전트 루프·조건 분기·스케줄) + 4.3(비주얼 캔버스·공유·웹훅)을 전부, 한 번의 연속 작업으로 만든다.

- **만드는 것**: 워크플로우 정의(D1 JSON) + 실행기(Queues, 단계마다 메시지 1개) + 노드 12개 + 승인 게이트 + 폼 빌더 UI + 에이전트(ReAct, DO 상태) + 조건 분기 + 스케줄/이벤트 트리거 + 공유/템플릿 + 웹훅 노드 + 비주얼 캔버스(SVG) + 관측/홈 카드.
- **만들지 않는 것** (제안서 4.1.6 그대로): 코드 노드, 외부 SaaS 연동 1500개, 별도 서버/벡터 DB/Python. Workers-only를 지킨다.

## 1. 아키텍처 결정 (제안서에서 확정 + 코디네이터 판단)

| 결정 | 내용 | 근거 |
|---|---|---|
| 정의 저장 | D1 `workflows.definition_json`. v1 = 선형 steps 배열, v2 = `next` 간선 추가(조건 분기). v1→v2는 읽기 시 변환, D1 마이그레이션 불필요 | 제안서 4.1.1 + 4.2.2 |
| 실행 | `PIPELINE` 큐 재사용. 새 메시지 타입 `workflow-step`을 `QueueMessage` 유니온에 추가. 단계마다 메시지 1개, 다음 단계는 현재 단계 완료 후 전송(직렬 체인) | 제안서 4.1.3, `src/index.ts:129,1901` |
| 노드 레지스트리 | `src/workflow/nodes.ts` — 기존 함수를 노드로 감싼다. 노드 인터페이스는 WF-1에서 `src/workflow/types.ts`에 먼저 정의 (WF-2·WF-3이 그 타입을 쓴다) | 제안서 4.1.4 |
| 에이전트 상태 | 새 DO 클래스 `WorkflowAgent`(SQLite), 바인딩 `WORKFLOW_AGENT`. wrangler.toml에 `[[durable_objects.bindings]]` + `[[migrations]] tag="v2" new_sqlite_classes=["WorkflowAgent"]` 추가. **폴백**: DO가 로컬 검증에서 막히면 D1 `workflow_runs.agent_state_json`으로 전환 (세션이 판단해 PROGRESS에 기록) | 제안서 4.2.1 |
| 승인 게이트 | `notifications` 테이블 재사용 (결재 `APPROVAL_REQUEST` 패턴, 새 타입 `WORKFLOW_APPROVAL`). `requiresApproval` 단계에서 run을 `waiting_approval`로 멈춤. 승인/거절 API가 엔진의 `resumeWorkflowRun`을 부름 | 제안서 4.1.3, `migrations/0024_approval.sql:106` |
| 라우트 | `src/workflow/routes.ts`, `app.route("/api/workflows", workflowApp)` (`src/index.ts:1793` 부근, 기존 마운트 패턴) | 기존 패턴 |
| UI | `public/workflow.js` + `workflow.css`, 메뉴는 강의실 다음(개인 업무 검색 앞). 탭 키 `'workflow'`, TABS·COACHEE_TABS 둘 다 포함(전원 사용). 아이콘은 Lucide 스타일 인라인 SVG | `public/index.html:525,533` |
| 캔버스 | **SVG 자체 캔버스** (`public/workflow-canvas.js`). ReactFlow는 번들러가 필요해 안 쓴다. 프런트 무빌드 원칙 유지 | 제안서 4.3 |
| 스케줄 크론 | wrangler.toml triggers에 `"*/15 * * * *"` 추가. **주의**: `scheduled()`는 현재 `EVAL_CRON`이면 평가, 그 밖은 전부 다이제스트로 간다. 새 크론이 다이제스트로 떨어지지 않게 3개 크론을 명시 분기할 것 | `src/index.ts:1889`, `wrangler.toml` triggers |
| 격리 | 모든 테이블 `owner_id`, 모든 조회는 `owner_id = 내 id`로 거름. 실행은 항상 **실행한 사람의 권한**으로 돈다. 남의 run id 직접 접근은 404 | 제안서 4.1.5 |
| 가드 | 동시 실행 3개/사용자, 하루 실행 20회/사용자(KV 카운터), run당 최대 50단계·최대 30분·LLM 호출 상한. 초과 시 429 | 제안서 4.1.5 |
| transcribe 노드 단순화 | **v1은 "이미 전사 완료된 문서/녹음"만 동기 처리.** 미완료면 단계 실패 + 안내("전사가 끝난 뒤 다시 실행"). 큐 지연 전송이 없어 "기다렸다가 이어가기"를 깔끔히 못 하므로, 비동기 대기는 후속 과제로 남긴다 | 코디네이터 판단 (Queues에 delay 없음) |

### 재사용 지점 (실측 완료 — 세션은 이 위치에서 찾을 것)

| 노드 | 재사용 | 위치 |
|---|---|---|
| `ask_rag` / `ask_personal` | `runAsk(env, input, {pool})` | `src/ask-pipeline.ts:525` |
| `summarize` | `summarizeDocument(env, docId)` | `src/index.ts:669` |
| `reflect_coach` / `reflect_coachee` | POST `/api/coaching/reflect` 로직 (서버 내부 함수로 추출해 재사용) | `src/index.ts:1206` |
| `draft_pptx` | pptxgenjs 덱 생성 (`new PptxGenJS()`, decks INSERT) | `src/index.ts:394,1401` |
| `email_draft` | `draftEmailReply` 패턴 | `src/index.ts:1842` |
| `send_email` | `sendEmail(env, {...})` (Resend, 승인 필수) | `src/email/send.ts:25` |
| `create_task` | POST `/api/tasks` 로직 | `src/index.ts:1346` |
| `create_calendar_event` | 캘린더 C1 POST `/events` | `src/calendar/routes.ts` |
| `llm` | `env.AI.run(Qwen3)` | 기존 ask-pipeline 패턴 |
| `transcribe` | 전사 완료 여부 조회만 (위 단순화 참고) | recordings/doc 조회 |

### 마이그레이션 계획

| 마이그레이션 | 내용 | 세션 |
|---|---|---|
| `0027_workflows.sql` | `workflows`, `workflow_runs`, `workflow_run_steps` (+ 인덱스). 제안서 4.1.1 SQL 그대로 | WF-1 |
| `0028_workflow_schedules.sql` | `workflow_schedules` (스케줄 트리거) | WF-8 |
| `0029_workflow_sharing.sql` | `workflow_shares`, `workflows.is_template` 컬럼 추가 | WF-9 |

## 2. 세션 목록 (의존 순서대로, 직렬 실행)

| # | 세션 | 모델 | 목표 | 프롬프트 파일 | 주요 파일 | 검증 |
|---|---|---|---|---|---|---|
| WF-1 | 데이터 모델 + CRUD/실행 API + 공용 타입 | Sonnet | 0027 적용, `workflows`/`workflow_runs`/`workflow_run_steps` D1, CRUD + 실행 생성 API, `src/workflow/types.ts`(NodeContext/NodeResult/`resolveVars`/승인 요청 타입) + `store.ts` | `wf-full-1-datamodel-prompt.md` | `migrations/0027_workflows.sql`, `src/workflow/{types,store,routes}.ts`, `src/index.ts`(마운트) | tsc, 로컬 D1 마이그레이션, curl CRUD 왕복 |
| WF-2 | 노드 레지스트리 12개 | Sonnet | `src/workflow/nodes.ts` — 12개 노드를 WF-1 타입으로 구현. 변수 치환 `{{input.x}}`/`{{steps.s1.output.y}}` 적용 | `wf-full-2-nodes-prompt.md` | `src/workflow/nodes.ts` | tsc, 단위 하네스(노드별 mock 입력) |
| WF-3 | 실행 엔진 | Opus | 큐 `workflow-step` 소비, 단계 직렬 체인, 멱등성(이미 succeeded면 건너뜀), 재시도/DLQ(기존 max_retries 3), 캡(50단계/30분), `waiting_approval` 멈춤 + `resumeWorkflowRun`, 정체 run 청소(`scheduled()` 평가 크론 분기에 sweep 추가) | `wf-full-3-engine-prompt.md` | `src/workflow/engine.ts`, `src/index.ts`(QueueMessage 유니온 + queue() 분기 + scheduled() sweep) | tsc, 로컬 큐 하네스(성공/실패/재시도/멱등), 기존 메시지 타입 회귀 |
| WF-4 | 승인 게이트 | Sonnet | 승인 요청 생성(알림 `WORKFLOW_APPROVAL`), 승인/거절 API, 승인 시 `resumeWorkflowRun` 호출, 거절 시 run `cancelled` | `wf-full-4-approval-prompt.md` | `src/workflow/approvals.ts`, routes 확장 | tsc, 승인→이어가기 / 거절→취소 왕복 |
| WF-5 | 폼 빌더 UI | Sonnet | 워크플로우 목록, 단계 카드(추가/삭제/순서 변경/설정 폼), 실행 버튼, 실행 기록·단계 타임라인, 메뉴 배선(강의실 다음) | `wf-full-5-builder-ui-prompt.md` | `public/workflow.{js,css}`, `public/index.html`(8곳) | node --check, 로컬 화면 동작, 401 익명 |
| D-1 | **배포 + 라이브 검증 (Phase 1)** | 코디네이터 | 0027 원격 적용 → 배포 → 라이브 E2E(워크플로우 생성→실행→승인→완료) + 데모 회귀(홈/로그인/RAG/라이브러리) | — | — | 버전 ID 기록, PROGRESS 갱신 |
| WF-6 | 에이전트 루프 | Opus | `WorkflowAgent` DO + ReAct 루프(목표→도구 선택→실행→관찰, 최대 10턴, 동일 도구 3연속 시 멈춤), 도구 선택은 레지스트리 도구만, `send_email` 등 외부 행동은 승인 게이트 그대로 | `wf-full-6-agent-prompt.md` | `src/workflow/agent-do.ts`, `src/workflow/agent.ts`, `wrangler.toml`(DO 바인딩 + v2 마이그레이션), `src/index.ts`(export) | tsc, 로컬 DO 하네스, 루프 종료 조건 테스트 |
| WF-7 | 조건 분기 + 그래프 정의 v2 | Sonnet | `condition` 노드, 정의 v2(`next` 간선), 엔진이 간선을 따르게 확장, v1 읽기 시 변환 | `wf-full-7-branching-prompt.md` | `src/workflow/types.ts`, `engine.ts`, `nodes.ts` | tsc, 분기 양쪽 경로 테스트 |
| WF-8 | 스케줄 + 이벤트 트리거 | Sonnet | 0028, `*/15 * * * *` 크론 + `scheduled()` 3방향 명시 분기(평가/다이제스트/워크플로우), due 스케줄 run 생성, 전사 완료 시 트리거(`transcript_completed`) | `wf-full-8-triggers-prompt.md` | `migrations/0028_workflow_schedules.sql`, `src/workflow/schedules.ts`, `src/index.ts`(scheduled + pipeline 완료 지점), `wrangler.toml` | tsc, 크론 분기 회귀(평가/다이제스트가 새 크론에 안 걸림), 스케줄 run 생성 |
| D-2 | **배포 + 라이브 검증 (Phase 2)** | 코디네이터 | 0028 원격 적용 → 배포 → 라이브 E2E(에이전트 run, 조건 분기, 스케줄) + 데모 회귀 | — | — | 버전 ID 기록, PROGRESS 갱신 |
| WF-9 | 공유/템플릿 + 웹훅 노드 | Sonnet | 0029, 공유 범위(본인/부서/전체)·권한(보기/복사), 템플릿(hr_admin 조직 템플릿), 복사, `webhook` 노드(allowlist, 사설 IP·메타데이터·localhost 차단, 10초 타임아웃, 256KB 상한) | `wf-full-9-sharing-webhook-prompt.md` | `migrations/0029_workflow_sharing.sql`, `src/workflow/sharing.ts`, `nodes.ts`(webhook) | tsc, 공유 격리 테스트(남의 워크플로우 404), SSRF 차단 테스트 |
| WF-10 | 비주얼 캔버스 | Opus | SVG 자체 캔버스(노드 배치·드래그·간선 연결·삭제), 폼 빌더와 동일 정의 JSON 공유, v2 그래프 표시, 빌드 단계 없음 | `wf-full-10-canvas-prompt.md` | `public/workflow-canvas.{js,css}`, `workflow.js` 연동 | node --check, 로컬 화면 동작, 정의 JSON 왕복 |
| WF-11 | 관측 + 홈 카드 + 다듬기 | Sonnet | run 타임라인(단계별 소요·LLM 호출 수)을 관측 화면에, 홈 "내 워크플로우" 카드, 에러 문구 한국어 다듬기 | `wf-full-11-observability-prompt.md` | `public/workflow.js`, obs 연동, `public/index.html`(홈 카드) | node --check, 화면 확인 |
| D-3 | **배포 + 라이브 검증 (Phase 3)** | 코디네이터 | 0029 원격 적용 → 배포 → 라이브 E2E(공유/템플릿/웹훅/캔버스) + 데모 회귀 | — | — | 버전 ID 기록, PROGRESS 갱신 |
| WF-12 | 최종 전체 검증 | 코디네이터 | 전 시나리오 E2E(선형·승인·에이전트·분기·스케줄·공유·캔버스) + 데모 전체 회귀(홈/로그인/RAG ask/라이브러리/메일/결재/캘린더) + 최종 버전 기록 | — | `files/workflow-verify/RESULT.md` | 전부 통과 시 완료 보고 |

## 3. 운용 규칙 (AGENTS.md 기준)

- **실행 패턴**: `cd <goal 루트> && { printf '%s' "<prompt>"; cat <프롬프트 파일>; } | ~/bin/claude-traced --model <sonnet|opus|fable> --add-dir <files/people-os> --permission-mode acceptEdits 2>&1 | tail -c 3000`. 백그라운드 exec로 실행, 완료 시 핸드오프로 반환. 프롬프트는 stdin으로만 (positional arg 금지). 세션당 모델 1개, 중간에 바꾸지 않는다.
- **배포**: 직렬로만. `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`로만 원격 작업 (plain `npx wrangler` 금지). 배포 전 `d1 migrations list ... --remote`로 확인 후 `d1 execute --remote --file migrations/<f>.sql -y`로 적용 (0017 교훈: apply가 중복 컬럼으로 실패할 수 있다). 배포는 `cf-wrangler.py deploy`.
- **검증**: 매 세션 `npx tsc --noEmit` + `node --check`(프런트 JS) + 로컬 하네스. 하네스·검증 산출물은 `files/workflow-verify/` 아래에 둔다 (런타임 재시작이 /tmp를 지우므로 /tmp 금지).
- **라이브 확인**: curl로만 (python urllib은 workers.dev에서 끊김). 로그인→쿠키 파일→후속 호출 패턴.
- **진행 기록**: 매 세션 후 `files/people-os/workflow-agent-builder-PROGRESS.md` 갱신 (완료/라이브 버전/다음/차단).
- **금지**: 비밀·비밀번호·토큰을 파일·프롬프트·메모리에 쓰지 않는다. GitHub 푸시는 하지 않는다 (부모가 별도로 처리). 제안서 파일은 수정하지 않는다.
- **회귀 가드**: 매 배포 후 데모 핵심 경로 확인 — `/api/health` 200, 홈 200, 로그인, RAG ask, 라이브러리. 깨지면 즉시 중단하고 PROGRESS에 기록 후 부모에게 보고.

## 4. 리스크 (제안서 6.1 + 코디네이터 추가)

1. **Worker 실행 시간 제한** — 단계마다 메시지를 나눠 완화. 그래도 느린 단계(긴 요약)는 비동기 노드로 전환.
2. **에이전트 비용** — run당 LLM 호출 상한 + 기록에 호출 수 남김.
3. **격리 실수** — 실행은 항상 실행자 권한. 공유는 3단계에서 이 원칙을 먼저 검증.
4. **동결 직전 대규모 변경** — 사용자 지시로 진행하지만, 세션마다 배포·회귀 확인으로 리스크를 나눈다. 회귀 발생 시 그 세션에서 중단한다.
5. **`scheduled()` 분기 실수** — 새 크론이 다이제스트로 떨어지면 다이제스트가 15분마다 돈다. WF-8에서 명시 분기를 강제하고, 배포 후 크론 동작을 확인한다.

## 5. Phase 4 — Durable Objects 3건 (워크플로우 빌더 완료 후 순차 편입)

> 근거: `durable-objects-use-cases-plan.md` (Fable, 2026-11-18). **WF-12가 끝난 뒤에 시작한다. 중간에 끼워 넣지 않고, 배포도 병렬로 하지 않는다.**
> Agents SDK를 통째로 들이지 않는다 (패턴·예시만 참고). 프런트는 무빌드 정적 HTML/JS 유지.

| # | 세션 | 모델 | 목표 | 프롬프트 파일 | 주요 파일 | 검증 |
|---|---|---|---|---|---|---|
| DO-1a | 채팅 DO + API (1:1 두 방식) | Sonnet | `ChatRoom` DO(SQLite) + WebSocket Hibernation + REST 보내기/WebSocket 받기. 1:1 방 키 `chat:dm:<a>:<b>`(두 id 정렬) — 코치↔코칭 대상과 직원↔직원 모두 같은 방식 (DO는 역할을 안 본다, 참여자 선택만 다름). WebSocket 업그레이드 전 세션 쿠키 검증, 익명 불가, 방 밖 사용자 404. 최근 200개 메시지를 DO SQLite에 유지. D1 미러링·읽음 표시·타이핑 표시 안 함 | `do-1a-chat-room-prompt.md` | `src/chat/room.ts`, `src/chat/routes.ts`, `wrangler.toml`(CHAT_ROOM 바인딩 — 마이그레이션은 DO-MIG에서 일괄) | tsc, 로컬 Miniflare WebSocket 하네스 |
| DO-1b | 채팅 UI + 배선 (1:1) + 방 목록 | Sonnet | 채팅 탭(메뉴), `public/chat.{js,css}`, index.html 배선, 메시지 송수신 UI. 1:1 방 목록 — 코칭 상대 + 직원 선택으로 방 만들기. 방 목록용 D1 테이블 `chat_rooms` + `chat_room_members`를 마이그레이션 `0030_chat_rooms.sql`로 만든다 (DM 행 type='dm' — DO-1c가 그룹 행에 재사용, 원격 적용은 DO-MIG). `GET /api/chat/rooms` 목록 API + 메시지 전송 시 D1 행 upsert | `do-1b-chat-ui-prompt.md` | `public/chat.{js,css}`, `public/index.html`, `migrations/0030_chat_rooms.sql`, `src/chat/routes.ts` 확장 | node --check, 로컬 화면 동작 |
| DO-1c | 그룹채팅 백엔드 — D1 멤버십 + 추가/제거 + 미읽음 | Sonnet | 그룹 방 D1 테이블(`chat_rooms` + `chat_room_members` — **0030은 DO-1b에서 이미 만듦, 그룹 행에 재사용, 새로 만들지 않음**). 방 키 `chat:group:<roomId>`. 멤버 추가/제거 API (방 생성자 또는 hr_admin만, 제거 시 DO에 알려 WebSocket 끊기). 메시지 seq 단조 증가 + 멤버별 `last_read_seq`로 미읽음 수 계산, 읽음 확인 API. 비멤버 404. 생성자 퇴장 시 역할 이전 규칙 확정 | `do-1c-group-chat-prompt.md` | `src/chat/groups.ts`, `src/chat/routes.ts` 확장 | tsc, 로컬 하네스(멤버십·권한·미읽음) |
| DO-1d | 그룹채팅 UI | Sonnet | 그룹 생성(이름 + 멤버 선택), 멤버 목록 + 추가/제거 버튼, 방 목록의 미읽음 배지. 1:1 UI와 같은 채팅 탭 안에서 방 종류별로 표시 | `do-1d-group-chat-ui-prompt.md` | `public/chat.{js,css}` 확장, `public/index.html` | node --check, 로컬 화면 동작 |
| DO-2 | 알림 푸시 허브 + 배선 + UI | Sonnet | `NotificationHub` DO(사용자마다 1개), `notifications` INSERT 지점(결재 notify 등)에서 허브로 fetch 호출, 브라우저에 WebSocket 푸시, UI 토스트·배지 연동. 푸시 실패해도 알림 행은 D1에 남아 목록에서 볼 수 있다 | `do-2-notify-push-prompt.md` | `src/notifications/hub.ts`, 알림 생성 지점 배선, `public/` 토스트 | tsc, 로컬 하네스(결재 요청→푸시 수신) |
| DO-3 | DO 정밀 레이트 리미터 | Sonnet | `RateLimiter` DO(토큰 버킷 + Alarms, 공식 예시 패턴), `POST /api/ask`·`/api/personal/ask`의 분당 20회 제한을 KV에서 DO로. DO 실패 시 기존 KV 제한으로 폴백 (기존 코드 유지) | `do-3-rate-limiter-prompt.md` | `src/ratelimit/limiter.ts`, ask 라우트 배선, `wrangler.toml`(RATE_LIMITER 바인딩) | tsc, 제한 동작·폴백 테스트 |
| DO-MIG | **마이그레이션 + 배포 + 라이브 검증 (DO 3건)** | 코디네이터 | 태그 v3에 `new_sqlite_classes = ["ChatRoom", "NotificationHub", "RateLimiter"]`를 한 번에 추가 + 0030 그룹채팅 D1 테이블 원격 적용 → 배포 → 라이브 E2E(1:1 채팅 송수신·그룹채팅 멤버십/미읽음·알림 푸시·레이트 리미터) + 데모 회귀 | — | `wrangler.toml` | 버전 ID 기록, PROGRESS 갱신 |
| DO-VERIFY | 최종 전체 검증 | 코디네이터 | DO 3건 + 워크플로우 빌더 전체 회귀 + 데모 전체 회귀 | — | `files/workflow-verify/do/RESULT.md` | 전부 통과 시 완료 보고 |

### Phase 4 운용 규칙

- **배포 금지 구간**: DO-1a~DO-3은 로컬 검증만 한다. 바인딩은 있으나 마이그레이션 미적용 상태라 `deploy`가 실패한다. 배포는 DO-MIG에서 한 번만 한다.
- **마이그레이션 태그 결정 (코디네이터 판단, Fable 계획서 §6.2와 다름 — 이유 아래)**:
  - 태그 v2 = `["WorkflowAgent"]` — WF-6에서 추가, D-2에 배포·라이브 검증.
  - 태그 v3 = `["ChatRoom", "NotificationHub", "RateLimiter"]` — DO-MIG에서 한 번에 추가.
  - 이유: wrangler는 마이그레이션 태그를 한 번만 적용한다. 이미 적용된 태그에 클래스를 추가할 수 없다. 4개를 한 태그에 넣으려면 에이전트 DO의 원격 활성화를 DO 항목이 끝날 때까지 미뤄야 하고, 그러면 Phase 2의 핵심인 에이전트 루프를 6개 세션 넘게 라이브 검증 없이 두게 된다 (D-2 체크포인트가 무의미해진다). 순차 실행이라 태그 충돌 위험은 이미 없다. 새 DO 3개는 v3 하나로 묶는다는 계획서의 묶음 의도는 지킨다. **부모가 한 태그 4개를 고집하면 WF-6 전에 알려줄 것 — 그 경우 에이전트 DO는 코드만 만들고 마이그레이션·라이브 검증을 DO-MIG으로 미룬다.**
- **안 하는 것** (계획서 §5): 게임룸, 선착순 예약/재고, 가상 대기열, 멀티테넌트 마이크로 DB, Containers 샌드박스, DO-per-mailbox 메일 이관, Agents SDK 통째 도입, 공동 문서 편집·라이브 퀴즈/투표(공모전 후).
- Agents SDK `examples/workflows/`(승인 게이트 + WebSocket 진행률)는 WF-4의 선택 참고용으로만 둔다. 필수가 아니다.
