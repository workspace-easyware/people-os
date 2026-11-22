# Think 전면 도입 T3 — 에이전트 화면 + 하위 에이전트 + 추적 + AGENT_RUNTIME=think 전환

## 개요

계획 문서: `think-cloudflare-os-full-adoption-plan.md` 2장(범위, E·F·H)·4장(T3 일정). T1·T2 완료, reasoning low 변경 완료. **사용자가 low가 끝나면 T3를 바로 시작하라고 지시했다.** P1(비동기 승인)은 T3 이후로 — 이 세션에서 하지 않는다.
**이 세션의 모델은 Opus 5.5 하나다. 세션 도중 모델을 바꾸지 않는다.**

- **시작 상태 (2026-11-20 13:20 KST, Merlin이 직접 확인)**: HEAD `e4c2ec2` (reasoning low 커밋). 라이브 배포 `307cf8b6` (reasoning low, `AGENT_RUNTIME=legacy`). 태그 `think-t2`는 `97f3f60`에 있다.
- **이미 설치됨**: wrangler **4.165.0** (정확히 고정), `@cloudflare/think 0.23.0`, `agents 0.33.0`, `ai 7.0.177`, `zod 4.6.7`, `@cloudflare/computer 0.8.0`, `@modelcontextprotocol/client 2.4.0`, `just-bash 3.6.1`. **`compatibility_date`는 올리지 않는다** (`2025-07-18` + `nodejs_compat` 유지).
- **T2 구현물 (재사용할 것)**: `src/assistant/agent.ts` (`AssistantAgent`, 사용자당 DO `assistant:<userId>`), `src/assistant/routes.ts` (`GET /me`, `POST /:id/messages`, `GET /:id/messages`, `GET /:id/events` — 2초 폴링 + SSE 래퍼), `src/workflow/think-agent.ts` (`ThinkAgent`, 워크플로 agent 단계), 마이그레이션 0040·v5 DO. **프런트(`public/`)는 T2에서 만들지 않았다.**
- **골든셋 기준선**: low 평가 `run_df07177b374b43c4` **6/6, avgJudge 0.8167** (s04 0.8 — 03:00 자동 평가에서 재확인 예정). **오늘 수동 평가 한도 5회를 전부 썼다 — 이 세션에서 수동 평가를 돌리지 않는다** (429가 뜬다). 질문 경로 확인은 03:00 KST 자동 평가 결과로 한다.

## 할 일 (T3 범위 — 계획 2.1 E·F·H + 전환)

### 0. 전환 전에 먼저 넣을 것 (T2-RESULT "배포 전에 넣을 것")

화면을 열기 전에 아래 3개를 먼저 구현한다. 어시스턴트 남용 방지와 관측이 없으면 화면을 열 수 없다.

1. **사용자별 일일 턴 상한** (지금은 동시 2턴 제한만 있음). DO 저장소 카운터로 충분하다. 상한 값은 T2 하네스의 한도(10스텝·LLM 20회·28분)와 별개로, 하루 턴 수 상한이다. 초과 시 429 + 안내 메시지.
2. **대화 지우기 라우트** (`clearMessages`, `DELETE /api/agents/:id/messages` 또는 같은 목적의 라우트 1개). 본인 어시스턴트만, 404 규칙은 그대로.
3. **관측 탭에 어시스턴트 턴 표시** (필요하면 마이그레이션 **0041**). DO의 `inspectState`/턴 상태(`llmCalls` 포함)를 읽는 관리자 API나 D1 요약 행 중 구현이 가벼운 쪽으로. 기존 질문 트레이스(`ask_events`)는 건드리지 않는다. 필요 없으면 0041을 만들지 않고, 판단 근거를 T3-RESULT.md에 적는다.

### 1. 에이전트 화면 (F)

- 새 메뉴 **"에이전트"** (기존 메뉴 순서는 건드리지 않고, "워크플로우" 다음에 둔다). 순수 HTML+JS로 만든다 (React 없음, 빌드 없음).
- 붙일 API 4개 (T2에서 준비됨): `GET /api/agents/me` → 내 어시스턴트 id, `POST /api/agents/:id/messages` (메시지 보내기), `GET /api/agents/:id/messages` (대화 읽기), `GET /api/agents/:id/events?after=` (2초 폴링 진행 이벤트).
- 화면에 보이는 것: 내 에이전트 목록(어시스턴트 + 워크플로 agent 실행), 실행 중 표시, 도구 호출 기록, 승인 대기. 판단 근거(`thinking`)는 어시스턴트 턴에서 비어 있지 않음이 T2에서 확인됐다 (영어) — 화면에 그대로 보여 주고, 한국어로 바꿀지는 T3 범위 밖으로 둔다.
- 승인 자체는 기존 승인 흐름(`approval.js`·결재함)을 쓴다 — 화면은 승인 대기를 보여 주는 것까지만 하고 승인 처리 UI를 새로 만들지 않는다.
- 토큰 단위 스트리밍은 이번에 하지 않는다 (submit 모드 턴에는 `chat()` 콜백을 붙일 수 없어 구조를 다시 설계해야 한다 — T2-RESULT 참조). 스텝 단위 진행(도구 시작·끝, 스텝 텍스트)으로 충분하다.

### 2. 하위 에이전트 (E)

- **1곳: 어시스턴트의 "조사" 위임.** 부모(어시스턴트)가 `agentTool()`/`runAgentTool()`로 자식(자료 수집)을 부르고 결과를 합쳐 답한다. 자식은 바인딩·마이그레이션이 필요 없다.
- 자식 DO 이름 접두어는 `assistant:`·`think:`와 다르게 한다.
- 자식도 `activeTools`로 도구를 좁히는 규칙과 "부작용 도구 없음" 규칙을 유지한다.

### 3. 추적 (H)

- `[observability.traces]`를 켜 대시보드 Agents 화면에 스팬이 보이게 한다. 기존 D1+R2 트레이스는 그대로 둔다.
- 대시보드에서 스팬이 보이는지 여부는 T3-RESULT.md에 적는다 (대시보드 직접 확인은 Merlin이 한다).

### 4. AGENT_RUNTIME=think 전환

- `wrangler.toml` `[vars] AGENT_RUNTIME = "think"`로 바꾸고 배포한다.
- **전환 전 체크리스트**:
  a. legacy 비교 기준선은 이미 있다 — **다시 만들지 않는다.** 오늘 08:35 VM 테스트에서 "T1 테스트용 agent" 워크플로 `wf_mwo6tt5c_lfyb1p`, 실행 `wfrun_mwo6tzvm_tofn09`를 legacy로 성공적으로 돌렸다 (할 일 `task_mwo6vb28_oodh5u` 생성). think 비교는 같은 목표의 agent 워크플로 1개를 think로 돌려 완료 여부·멈춤 사유·승인 요청 횟수를 비교한다.
  b. 전환 배포 뒤 2~3분은 옛 버전이 응답한다 — 확인은 그 뒤에 한다.
  c. 진행 중인 legacy 단계는 legacy로 끝난다 (단계 단위 고정). 전환 순간에 걸친 run은 그대로 둔다.
  d. 엔진의 run 30회 LLM 캡이 agent 뒤 LLM 노드에서 agent 사용량을 세지 않는 문제(T1 주의 1)는 아직 남아 있다 — 이번에 고치지 않고 T3-RESULT.md에 "남은 문제"로 적는다.

## T1·T2에서 넘겨받은 주의사항 (반드시 지킬 것)

1. **중단된 도구는 복구 턴에서 다시 실행된다.** `create_task`는 실행 도중 DO가 죽으면 한 번 더 실행될 수 있다 (at-least-once). 부작용 도구(메일·웹훅)는 어시스턴트 도구 집합에 없다.
2. 복구 턴은 `requestId`가 바뀐다. `submissionId`·`idempotencyKey`는 그대로다.
3. `onChatResponse`의 `recovered`는 복구 턴에서도 `false`였다. 복구 여부는 `continuation: true` 또는 `trigger: "recovery-continue"`로 판별한다.
4. 메모리 필드(인스턴스 변수)는 종료 때 사라진다. 턴 시작 시각·한도 상태는 저장소에 둔다.
5. 재배포 직후 한동안 옛 코드의 DO가 살아 있다.
6. Qwen 응답 시간 편차가 크다 (스텝당 1~35초). 시간 상한은 스텝 경계에서만 걸리므로 활성 30분 캡은 여유 있게 잡는다.
7. **건드리지 말 파일**: `src/meet/*`(특히 `transcript.ts`), `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`.
8. **`src/index.ts`가 겹친다.** V1+V2가 고친 3곳을 보존한다: import 1줄, `advanceRecording`의 완료 분기를 `finishTranscript()`로 추출한 부분, `setMeetHooks` + 15분 크론의 `sweepMeetings()` 1줄.
9. **15분 크론(`*/15`)을 공유한다.** 워크플로우 스케줄 틱과 `sweepMeetings()`가 같은 분기에서 돈다. 워크플로우 분기를 고치면 회의 정리·전사 폴백이 같이 깨진다.
10. **`PIPELINE` 큐를 공유한다.** 회의 전사가 `finishTranscript()`로 같은 큐에 들어간다. 큐 소비자를 건드리면 회귀 6번에 걸린다.
11. **로컬 dev는 Workers AI를 못 부른다** (샌드박스 프록시 TLS 오류). 실제 모델 시험은 원격 시험 Worker가 필요하다 (T1·T2 하네스 패턴 재사용, `OPEN_UNTIL` 시험 창을 둔다. 시험이 끝나면 시험 Worker는 지운다).
12. **배포 명령 주의 (2026-11-20 low 세션 교훈)**: 배포는 절대 경로로 직접 실행한다 — `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy` (python3 경유·env 접두어 금지). "This command requires approval"로 막히면 우회하지 말고 즉시 보고하고 멈춘다 (Merlin이 직접 배포한다).
13. **오늘 수동 평가 한도 5회를 전부 썼다.** 이 세션에서 `POST /api/obs/evals/runs`를 부르지 않는다. 질문 경로 회귀는 03:00 KST 자동 평가로 확인한다.

## 통과 기준 (계획 4장)

- `npx tsc --noEmit` 오류 0.
- **로컬 하네스 전부 통과** (아래).
- `AGENT_RUNTIME=think` 배포 후 **think 경로 동작 + legacy 기존 동작 변화 없음**.

### 로컬 하네스

1. `npx tsc --noEmit` 오류 0.
2. 일일 턴 상한: 상한을 넘기면 429 + 안내, 다음 날(또는 카운터 초기화 뒤) 다시 된다.
3. 대화 지우기: 지운 뒤 `GET messages`가 비고, 다른 사용자 대화는 안 지워진다.
4. 관측 탭 어시스턴트 턴 표시: 관리자 API 또는 관측 화면에서 어시스턴트 턴(턴 상태·`llmCalls`)이 보인다. (0041을 안 만들기로 판단했으면 그 판단과 근거를 적는다.)
5. 에이전트 화면: 메뉴 진입 → 어시스턴트 목록 → 메시지 보내기 → 진행 이벤트(도구 호출 기록)가 보이고, 답이 돌아온다. (로컬 dev는 Workers AI를 못 부르므로 실제 모델 부분은 원격 시험 Worker에서 한다.)
6. 하위 에이전트: 어시스턴트가 조사 위임을 부르면 자식 결과가 부모 답에 들어온다.
7. think 전환: agent 노드 워크플로 1개를 think로 끝까지 실행 — legacy 기준선(`wf_mwo6tt5c_lfyb1p`)과 완료 여부·멈춤 사유·승인 요청 횟수를 비교한다. 승인 전에 메일·웹훅이 나가지 않았음을 확인한다.
8. 한도: 동시 3·하루 20·활성 30분·LLM 30회가 Think 경로에서도 걸린다 (agent 뒤 LLM 노드 합산 문제는 제외하고 T3-RESULT.md에 "남은 문제"로 적는다).
9. think 라이브 스모크 (workers.dev 경유): 홈·로그인·HR 규정 질문(403 Turnstile)·템플릿 5개 중 1개 실행·채팅 진입·결재함 진입·LMS 진입·에이전트 화면 진입 — 배포 전과 동일하게 동작. 로그인 뒤 화면 동작은 시험 계정이 없어 확인이 어려우면 범위를 명시한다.

## 제약

- **배포는 직렬로.** 다른 세션과 동시 배포 금지. 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`를 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. **라이브 확인은 workers.dev 경유** (`https://people-os.workspace-easyware.workers.dev`)로 한다.
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다. 라이브 관리자 엔드포인트 확인이 필요하면 `~/workspace/user/`의 시크릿 파일을 읽기만 하고 값은 절대 출력하지 않는다.
- 하네스·검증 상태는 `files/workflow-verify/think-full/` 아래에 둔다 (`/tmp` 금지 — 런타임 재시작 시 지워진다).
- **커밋·태그는 하지 않는다.** `git add`가 이 세션에서 승인 대기로 막힐 수 있다. 커밋·태그(`think-t3` 롤백 지점 포함)는 Merlin이 직접 한다. 파일 작업만 마치고 보고한다.
- 배포 후 라이브에 회귀가 보이면 즉시 보고하고, 지시 없이 되돌리지 않는다 (롤백은 Merlin이 판단한다 — `AGENT_RUNTIME=legacy` 재배포 + 메뉴 숨김).

## 결과 파일

`files/workflow-verify/think-full/T3-RESULT.md`에 적는다: 구현한 것(파일·DO·라우트·마이그레이션·vars), 하네스 9항목 각각의 통과/실패와 증거(명령 결과, 라이브 버전 ID, URL, 응답), think 배포 후 라이브 변화 확인 내역, 남은 문제(30회 캡 합산·토큰 스트리밍·영어 thinking 등), 11-24 회귀 검증에 넘길 사항.

## 보고

마지막에 보고할 것: 통과 기준 3항목 판정, 라이브 배포 버전 ID, 하네스 9항목 결과 요약, 남은 문제.
