# Think 전면 도입 T1 — 운영 Worker에 ThinkAgent DO(v4) + 도구 변환 + 승인 차단 + 한도 훅 + 엔진 연결

## 개요

계획 문서: `think-cloudflare-os-full-adoption-plan.md` 2장(범위)·4장(T1 일정). T0 관문은 통과했고 T1로 간다(`files/workflow-verify/think-full/T0-RESULT.md` 참조).
**이 세션의 모델은 Opus 5.5 하나다. 세션 도중 모델을 바꾸지 않는다.**

- **시작 상태 (2026-11-20 00:57 KST, Merlin이 직접 확인)**: HEAD `b496035` (T0 커밋). 기준점 태그 `pre-think`는 `b30b244`에 있다.
- **이미 설치됨**: wrangler **4.165.0** (정확히 고정), `@cloudflare/think 0.23.0`, `agents 0.33.0`, `ai 7.0.177`, `zod 4.6.7`, `@cloudflare/computer 0.8.0`, `@modelcontextprotocol/client 2.4.0`, `just-bash 3.6.1`. **`compatibility_date`는 올리지 않는다** (`2025-07-18` + `nodejs_compat` 유지). 운영 `wrangler.toml`은 T0에서 건드리지 않았다.
- **게이트 Worker 참고용**: `people-os-think-gate` 빌드 3 `05f11392`, 소스는 `think-gate/src/index.ts`에 있다. **시험 창은 2026-11-20 01:00 KST에 닫혔다** — 라이브 게이트 엔드포인트는 이제 403이다. **라이브 게이트 호출에 의존하지 말고 게이트 소스 코드를 참고 구현으로 쓴다.**

## 할 일 (T1 범위 — 계획 2장)

1. **새 DO `ThinkAgent`** = `Think` 서브클래스. `wrangler.toml`에 v4 마이그레이션(`new_sqlite_classes = ["ThinkAgent"]`)과 필요한 바인딩만 추가한다. 다른 `wrangler.toml` 변경은 하지 않는다.
2. **도구 변환**: `NODE_REGISTRY`의 15종 노드를 AI SDK 도구로 변환한다 (설명·입력 키가 이미 있다). `beforeTurn`에서 `activeTools`로 활성 도구를 반드시 좁힌다 (T0에서 활성 도구를 줄여도 `tools`가 12개로 나왔다 — Think 기본 도구 포함).
3. **승인 차단 (G)**: 부작용 도구(`send_email`·`webhook`)는 `beforeToolCall`에서 막고 기존 승인 게이트(`approvals.ts`, 승인 API, `approval.js` 화면)로 보낸다. 승인 전에는 발송 0건이어야 한다.
4. **한도 훅**: 현재 agent 한도(10스텝, LLM 20회, 28분, 같은 도구 3회 반복 시 멈춤)를 Think 훅으로 다시 만든다. `beforeStep`에서 스텝 수·경과 시간, `beforeToolCall`에서 반복을 센다. **스텝 상한과 run 전체 LLM 30회 캡은 훅의 `stepNumber`가 아니라 DO 저장소의 누적 값으로 센다** (T0 k3: 복구 턴에서 스텝 번호가 0부터 다시 세져 12스텝을 돌았다).
5. **엔진 연결 (C)**: 엔진은 agent 단계 메시지를 받으면 `ThinkAgent`에 `submit`(키 = `runId:stepIndex`)하고 끝낸다. DO가 루프를 스스로 돌고, 끝나면 결과를 D1에 쓰고 `workflow-step` 메시지를 넣어 엔진을 깨운다. 엔진 연결은 `submissionId` 기준으로 한다 (복구 턴은 `requestId`가 바뀐다).
6. **옛 런타임은 지우지 않는다**: `[vars] AGENT_RUNTIME = "think" | "legacy"`로 고르고 `WorkflowAgent` 클래스·바인딩·v2 마이그레이션은 남긴다. **이번 배포는 `AGENT_RUNTIME=legacy`로 한다** — Think 코드는 들어가되 dormant 상태로, 라이브 변화가 없음을 확인하는 것이 T1의 목적이다.
7. **관측 호환**: Think 쪽 출력을 지금의 `turns` 모양으로 맞춰 써서 관측 API(`obs/routes-workflows.ts`가 단계 output의 `turns`를 읽는다)는 고치지 않는다.
8. **마이그레이션 번호**: Think용은 **0040부터** (0039는 `0039_meetings_v2.sql`). 적용 전 `cf-wrangler.py d1 migrations list people-os-db --remote`로 0039 추적 상태를 먼저 본다.

## T0에서 넘겨받은 주의사항 (반드시 지킬 것)

1. **중단된 도구는 복구 턴에서 다시 실행된다.** 부작용 도구(메일·웹훅)는 승인 차단과 별개로 **멱등 키**가 있어야 한다.
2. 복구 턴은 `requestId`가 바뀐다. `submissionId`·`idempotencyKey`는 그대로다. 엔진 연결은 `submissionId` 기준.
3. `onChatResponse`의 `recovered`는 복구 턴에서도 `false`였다. 복구 여부는 `continuation: true` 또는 `trigger: "recovery-continue"`로 판별한다.
4. 메모리 필드(인스턴스 변수)는 종료 때 사라진다. 승인 대기·시간 상한 상태는 저장소에 둔다. 턴 시작 시각도 저장소에 둔다.
5. 재배포 직후 한동안 옛 코드의 DO가 살아 있다. `AGENT_RUNTIME` 전환·롤백 배포 뒤에도 진행 중인 턴은 옛 코드로 끝난다.
6. Qwen 응답 시간 편차가 크다 (스텝당 1~35초). 시간 상한은 스텝 경계에서만 걸리므로 활성 30분 캡은 여유 있게 잡는다.
7. **건드리지 말 파일**: `src/meet/*`(특히 `transcript.ts`), `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`.
8. **`src/index.ts`가 겹친다.** V1+V2가 고친 3곳을 보존한다: import 1줄, `advanceRecording`의 완료 분기를 `finishTranscript()`로 추출한 부분, `setMeetHooks` + 15분 크론의 `sweepMeetings()` 1줄.
9. **15분 크론(`*/15`)을 공유한다.** 워크플로우 스케줄 틱과 `sweepMeetings()`가 같은 분기에서 돈다. 워크플로우 분기를 고치면 회의 정리·전사 폴백이 같이 깨진다.
10. **`PIPELINE` 큐를 공유한다.** 회의 전사가 `finishTranscript()`로 같은 큐에 들어간다. 큐 소비자를 건드리면 회귀 6번에 걸린다.

## 통과 기준 (계획 4장)

- `npx tsc --noEmit` 오류 0.
- **로컬 하네스 7항목 전부 통과** (아래).
- `AGENT_RUNTIME=legacy` 배포 후 **라이브 변화 없음**.

### 로컬 하네스 7항목

1. `npx tsc --noEmit` 오류 0.
2. `ThinkAgent` DO 생성 → `submit` → 턴 완료 (로컬 dev 또는 게이트 패턴 재사용).
3. 도구 변환: `NODE_REGISTRY` 15종이 AI SDK 도구로 변환되고 설명·입력 스키마가 유지됨.
4. 부작용 도구 차단: `send_email`·`webhook`이 `beforeToolCall`에서 막히고 승인 게이트로 가며, 미승인 발송 0건.
5. 한도 훅: 10스텝·run 전체 LLM 30회 캡·28분·같은 도구 3회 반복이 DO 저장소 누적값 기준으로 걸림.
6. 엔진 연결: `submit` 키 `runId:stepIndex`, 완료 시 D1 기록 + `workflow-step` 메시지 → 엔진 재개. agent 노드 워크플로 1개를 legacy 경로로 끝까지 실행해 봄.
7. legacy 라이브 스모크 (workers.dev 경유): 홈·로그인·HR 규정 질문 1개·템플릿 5개 중 1개 실행·채팅 진입·결재함 진입·LMS 진입 — 배포 전과 동일하게 동작.

## 제약

- **배포는 직렬로.** 다른 세션과 동시 배포 금지. 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`를 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. **라이브 확인은 workers.dev 경유** (`https://people-os.workspace-easyware.workers.dev`)로 한다.
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다. 라이브 관리자 엔드포인트 확인이 필요하면 `~/workspace/user/`의 시크릿 파일을 읽기만 하고 값은 절대 출력하지 않는다.
- 하네스·검증 상태는 `files/workflow-verify/think-full/` 아래에 둔다 (`/tmp` 금지 — 런타임 재시작 시 지워진다).
- **커밋·태그는 하지 않는다.** `git add`가 이 세션에서 승인 대기로 막힐 수 있다. 커밋·태그(`think-t1` 롤백 지점 포함)는 Merlin이 직접 한다. 파일 작업만 마치고 보고한다.
- 배포 후 라이브에 회귀가 보이면 즉시 보고하고, 지시 없이 되돌리지 않는다 (롤백은 Merlin이 판단한다).

## 결과 파일

`files/workflow-verify/think-full/T1-RESULT.md`에 적는다: 구현한 것(파일·DO·마이그레이션·vars), 하네스 7항목 각각의 통과/실패와 증거(명령 결과, 라이브 버전 ID, URL, 응답), legacy 배포 후 라이브 변화 없음 확인 내역, T2에 넘길 주의사항.

## 보고

마지막에 보고할 것: 통과 기준 3항목 판정, 라이브 배포 버전 ID, 하네스 7항목 결과 요약, T2에 넘길 사항.
