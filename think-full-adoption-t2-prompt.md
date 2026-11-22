# Think 전면 도입 T2 — 어시스턴트(영구 세션) + Hono 라우트 + 진행 이벤트 + ask-pipeline 도구

## 개요

계획 문서: `think-cloudflare-os-full-adoption-plan.md` 2장(범위, D·2.4)·4장(T2 일정). T1 완료(`files/workflow-verify/think-full/T1-RESULT.md` 참조). **사용자가 11-22 예정이던 T2를 11-20에 바로 시작하라고 지시했다.** P1(비동기 승인)은 T2 이후로 — 이 세션에서 하지 않는다.
**이 세션의 모델은 Opus 5.5 하나다. 세션 도중 모델을 바꾸지 않는다.**

- **시작 상태 (2026-11-20 09:45 KST, Merlin이 직접 확인)**: HEAD `bced0ee` (T1 커밋, 태그 `think-t1`). 라이브 배포 `7931eb4a`, `AGENT_RUNTIME=legacy`.
- **이미 설치됨**: wrangler **4.165.0** (정확히 고정), `@cloudflare/think 0.23.0`, `agents 0.33.0`, `ai 7.0.177`, `zod 4.6.7`, `@cloudflare/computer 0.8.0`, `@modelcontextprotocol/client 2.4.0`, `just-bash 3.6.1`. **`compatibility_date`는 올리지 않는다** (`2025-07-18` + `nodejs_compat` 유지).
- **프롬프트 v5 활성** (2026-11-20 09:05, `pv_086c7a84faaa4d19`): 답 마지막에 근거 기반 사용 절차를 덧붙인다. 골든셋 기준선: 평가 `run_33db237d37c24e15` (v5) **6/6 통과, avgJudge 0.8667**, verdict 전부 grounded. 이 수치가 T2 통과 기준 3번의 "전과 같다" 기준이다.
- **T1 구현물 (재사용할 것)**: `src/workflow/think-agent.ts` (`ThinkAgent extends Think<Env>`, 도구 변환·훅·승인 차단·한도·`deliver`), `src/workflow/agent-think.ts` (엔진 연결), 마이그레이션 0040 (`workflow_agent_steps`), v4 DO `ThinkAgent`. `ask_rag`·`ask_personal` 도구는 이미 있다 (`src/workflow/nodes.ts`의 `runAskNode` → `ask-pipeline`의 `runAsk`).

## 할 일 (T2 범위 — 계획 2.1 D + 2.4)

1. **어시스턴트 에이전트 (D)**: 사용자당 DO 1개, 영구 세션. 대화가 DO SQLite에 남고 DO 재시작(재배포) 뒤에도 이어진다. **워크플로 agent 단계와 상태를 공유하지 않는다** — DO id 네임스페이스를 분리하거나(예: `assistant:<userId>` 대 `think:<runId>:<stepIndex>`) 별도 클래스로 나누거나, 어느 쪽이든 워크플로 단계와 어시스턴트 대화가 섞이지 않게 한다. **다른 사용자의 어시스턴트에 접근하면 404** (403이 아니다).
2. **ask-pipeline 도구**: 어시스턴트의 답 생성은 기존 `ask-pipeline`을 **도구로** 부른다. `ask_rag`(공용 HR 규정)·`ask_personal`(개인 문서) 도구를 재사용한다. **질문 탭(`ask-pipeline` + `AgentSession` DO) 자체는 고치지 않는다** — 평가가 이 경로에 묶여 있다.
3. **Hono 라우트 (2.4)**:
   - `POST /api/agents/:id/messages` — DO를 RPC로 부른다. DO는 `runTurn({ mode: "submit" })`으로 받고 바로 돌려준다. 인증은 기존 세션 쿠키 + 역할 검사를 그대로 탄다. `routeAgentRequest`로 DO를 바깥에 직접 열지 않는다(열면 기존 이중 게이트를 우회한다).
   - `GET /api/agents/:id/events` — 진행 이벤트. 1안은 DO의 `chat()` 스트림 콜백을 SSE로 넘기는 것, 2안은 2초 폴링이다. 1안이 반나절 안에 안 되면 2안으로 간다.
   - `:id`가 호출자의 어시스턴트가 아니면 404.
4. **도구 좁히기 (필수)**: 어시스턴트의 활성 도구는 `activeTools`로 반드시 좁힌다. Think가 턴마다 섞어 주는 기본 도구 7개(워크스페이스 등)가 어시스턴트 턴에 나오면 안 된다. `getTools()`를 바꿀 때도 같은 규칙을 지킨다 (T1 주의 8).
5. **어시스턴트 도구 집합**: `ask_rag`, `ask_personal`, `summarize`, `llm`, `email_draft`, `create_task`를 기본으로 한다. **부작용 도구(`send_email`·`webhook`)는 어시스턴트 활성 도구에서 제외한다** — 어시스턴트는 초안(`email_draft`)까지만 만들고 발송은 하지 않는다. T1의 `beforeToolCall` 승인 차단은 ThinkAgent를 재사용하면 그대로 따라온다.
6. **한도**: T1의 agent 한도(10스텝, LLM 20회, 28분, 같은 도구 3회 반복)를 어시스턴트 턴에도 같은 방식으로 건다 (DO 저장소 누적값 기준). 어시스턴트 턴은 워크플로 run이 아니므로 run 전체 LLM 30회 캡에는 묶지 않되, 턴의 LLM 호출 수는 Think output의 `llmCalls`로 기록해 관측에서 볼 수 있게 한다.
7. **마이그레이션**: D1 마이그레이션은 필요할 때만 추가한다. 필요하면 다음 번호는 **0041**이다. 적용 전 `cf-wrangler.py d1 migrations list people-os-db --remote`로 0040 추적 상태를 먼저 본다. DO 바인딩이 새로 필요하면 `wrangler.toml`에 v5 마이그레이션(`new_sqlite_classes`)만 추가하고 기존 v1~v4와 바인딩은 건드리지 않는다.
8. **이번 배포도 `AGENT_RUNTIME=legacy`로 한다.** T2는 어시스턴트 추가이지 think 전환이 아니다. 전환은 T3에서 한다.

## T1에서 넘겨받은 주의사항 (반드시 지킬 것)

1. **중단된 도구는 복구 턴에서 다시 실행된다.** 부작용 도구는 어시스턴트 도구 집합에 없으므로 해당 없지만, `create_task` 같은 일반 도구는 복구 턴에서 중복 실행될 수 있다 (at-least-once). 멱등 키가 있으면 재사용한다.
2. 복구 턴은 `requestId`가 바뀐다. `submissionId`·`idempotencyKey`는 그대로다.
3. `onChatResponse`의 `recovered`는 복구 턴에서도 `false`였다. 복구 여부는 `continuation: true` 또는 `trigger: "recovery-continue"`로 판별한다.
4. 메모리 필드(인스턴스 변수)는 종료 때 사라진다. 턴 시작 시각·한도 상태는 저장소에 둔다.
5. 재배포 직후 한동안 옛 코드의 DO가 살아 있다. 재시작 지속성 시험은 새 코드가 확실히 뜬 뒤에 한다.
6. Qwen 응답 시간 편차가 크다 (스텝당 1~35초). 시간 상한은 스텝 경계에서만 걸리므로 활성 30분 캡은 여유 있게 잡는다.
7. **Qwen의 `thinking`이 비어 있다.** 실제 Qwen 턴에서 도구 스텝의 `reasoningText`가 비어 있다. T3 화면에서 판단 근거를 보여 주려면 별도 확인이 필요하니, 어시스턴트 턴의 스텝 기록에 thinking이 비어 있는지 여부를 T2-RESULT.md에 적어 둔다.
8. **건드리지 말 파일**: `src/meet/*`(특히 `transcript.ts`), `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`.
9. **`src/index.ts`가 겹친다.** V1+V2가 고친 3곳을 보존한다: import 1줄, `advanceRecording`의 완료 분기를 `finishTranscript()`로 추출한 부분, `setMeetHooks` + 15분 크론의 `sweepMeetings()` 1줄.
10. **15분 크론(`*/15`)을 공유한다.** 워크플로우 스케줄 틱과 `sweepMeetings()`가 같은 분기에서 돈다. 워크플로우 분기를 고치면 회의 정리·전사 폴백이 같이 깨진다.
11. **`PIPELINE` 큐를 공유한다.** 회의 전사가 `finishTranscript()`로 같은 큐에 들어간다. 큐 소비자를 건드리면 회귀 6번에 걸린다.
12. **로컬 dev는 Workers AI를 못 부른다** (샌드박스 프록시 TLS 오류). 실제 모델 시험은 원격 시험 Worker가 필요하다. T1의 `people-os-t1-harness`는 시험 창(11-20 03:30 KST)이 지나 403이다. 새로 시험 Worker를 만들거나 하네스를 원격으로 돌릴 방법을 T2-RESULT.md에 적는다.

## 통과 기준 (계획 4장)

- `npx tsc --noEmit` 오류 0.
- **로컬 하네스 전부 통과** (아래).
- `AGENT_RUNTIME=legacy` 배포 후 **라이브 변화 없음** (워크플로·질문·채팅·결재·LMS 기존 동작 동일).

### 로컬 하네스

1. `npx tsc --noEmit` 오류 0.
2. 어시스턴트 DO 생성 → 메시지 전송 → 턴 완료 (ask_rag 도구가 실제로 `runAsk`를 불러 근거 있는 답을 냄).
3. **영구 세션**: DO를 죽이고(재배포 또는 인스턴스 재생성) 다시 불러도 이전 대화가 남는다.
4. **격리**: 다른 사용자의 어시스턴트 id로 요청하면 404. 자기 것은 200.
5. **진행 이벤트**: `GET /api/agents/:id/events`로 턴 진행(도구 호출 시작·종료)이 보인다 (SSE 1안 또는 2초 폴링 2안 중 택한 것).
6. **한도**: 10스텝·LLM 20회·28분·같은 도구 3회 반복이 DO 저장소 누적값 기준으로 걸림.
7. **질문 탭 회귀**: 골든셋 평가 재실행 결과가 전과 같다 (6/6, avgJudge 0.8667 기준 — `run_33db237d37c24e15`와 비교). 평가 실행은 관리자 API(`POST /api/obs/evals/runs` + `X-Admin-Secret`)로 한다. 시크릿은 `~/workspace/user/people-os-admin-secret.txt`에서 읽기만 하고 값은 절대 출력하지 않는다.
8. legacy 라이브 스모크 (workers.dev 경유): 홈·로그인·HR 규정 질문 1개·템플릿 5개 중 1개 실행·채팅 진입·결재함 진입·LMS 진입 — 배포 전과 동일하게 동작. 로그인 뒤 화면 동작은 시험 계정이 없어 확인이 어려우면 범위를 명시한다.

## 제약

- **배포는 직렬로.** 다른 세션과 동시 배포 금지. 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`를 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. **라이브 확인은 workers.dev 경유** (`https://people-os.workspace-easyware.workers.dev`)로 한다.
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다. 라이브 관리자 엔드포인트 확인이 필요하면 `~/workspace/user/`의 시크릿 파일을 읽기만 하고 값은 절대 출력하지 않는다.
- 하네스·검증 상태는 `files/workflow-verify/think-full/` 아래에 둔다 (`/tmp` 금지 — 런타임 재시작 시 지워진다).
- **커밋·태그는 하지 않는다.** `git add`가 이 세션에서 승인 대기로 막힐 수 있다. 커밋·태그(`think-t2` 롤백 지점 포함)는 Merlin이 직접 한다. 파일 작업만 마치고 보고한다.
- 배포 후 라이브에 회귀가 보이면 즉시 보고하고, 지시 없이 되돌리지 않는다 (롤백은 Merlin이 판단한다).

## 결과 파일

`files/workflow-verify/think-full/T2-RESULT.md`에 적는다: 구현한 것(파일·DO·라우트·마이그레이션·vars), 하네스 8항목 각각의 통과/실패와 증거(명령 결과, 라이브 버전 ID, URL, 응답), legacy 배포 후 라이브 변화 없음 확인 내역, T3에 넘길 주의사항 (하위 에이전트·에이전트 화면·추적·`AGENT_RUNTIME=think` 전환 전 체크리스트 포함).

## 보고

마지막에 보고할 것: 통과 기준 3항목 판정, 라이브 배포 버전 ID, 하네스 8항목 결과 요약, T3에 넘길 사항.
