# Think 전면 도입 T0 관문 결과 (2026-11-19 밤)

## 판정

**T1로 간다.** 관문 6항목 모두 통과. 계획 6장 대안은 쓰지 않는다.

| # | 관문 | 판정 | 핵심 증거 |
|---|---|---|---|
| 1 | wrangler 4에서 기존 People OS 빌드·배포 가능 | ✅ 통과 | `npx tsc --noEmit` 오류 0, `cf-wrangler.py deploy --dry-run` 정상 종료 |
| 2 | Think 0.23.0 배포, 한 턴 완료 | ✅ 통과 | `/turn?run=v1` → `completed`, 3스텝, 10.6초 |
| 3 | Qwen 도구 선택 8/10 이상 | ✅ 통과 | `/tools?run=v1` → **10/10** (중단된 세션에서는 9/10) |
| 4 | 스텝·시간 상한, 부작용 도구 차단 | ✅ 통과 | `max_steps` / `time_limit` / `approval_required`, 발송 0건 |
| 5 | 10스텝 턴 3회, CPU 오류 없음 | ✅ 통과 | 3회 모두 `completed`, 10스텝, 약 31초 |
| 6 | 실행 중 DO를 죽여도 복구 또는 실패 전달 | ✅ 통과 (조건 있음) | 강제 종료 후 자동 복구돼 `completed`. 재배포만으로는 턴이 끊기지 않았다 |

관문 2~5는 중단된 세션의 기록에 기대지 않고 이 세션에서 빌드 2(`6fcdc764`)에 대해 다시 실행했다.

## 환경

- 게이트 Worker: `people-os-think-gate`, `https://people-os-think-gate.workspace-easyware.workers.dev`
- 배포 버전: 빌드 1 `2f18eb8e-501c-4173-bfec-098f02eda9aa` (12:35:39Z) → 빌드 2 `6fcdc764-6f45-4d5b-a547-a75dbc01fe92` (12:40:15Z) → 빌드 3 `05f11392-aaeb-4a61-8491-b835ad94bec0` (이 세션, 현재 라이브)
- 운영 Worker `people-os`에는 배포하지 않았다 (dry-run만).
- 시험 창: `GATE_OPEN_UNTIL = 1795104000000` (2026-11-20 01:00 KST). 그 뒤 모든 요청이 403이 된다. 따로 닫는 배포는 하지 않았다.
- 모델: `@cf/qwen/qwen3.8-27b`. kimi 대체 시험은 필요 없었다.

## wrangler 4 · compatibility_date · 버전 고정

- `wrangler` `^3.95.0` → **`4.165.0`** (정확히 고정), `@cloudflare/workers-types` → `4.20260702.1`.
- 추가된 의존성 (전부 범위 없이 정확히 고정): `@cloudflare/think 0.23.0`, `agents 0.33.0`, `ai 7.0.177`, `zod 4.6.7`, `@cloudflare/computer 0.8.0`, `@modelcontextprotocol/client 2.4.0`, `just-bash 3.6.1`.
- **`compatibility_date`는 올리지 않았다.** 운영 `wrangler.toml`과 게이트 둘 다 `2025-07-18` + `nodejs_compat` 그대로이고, Think 0.23.0이 이 날짜에서 배포·실행된다. 계획 R1의 "날짜 상향" 위험은 발생하지 않는다.
- 운영 `wrangler.toml`은 수정하지 않았다.

## 관문별 증거

### 1. 기존 People OS 빌드

- `npx tsc --noEmit`: 출력 없음 (오류 0).
- `cf-wrangler.py deploy --dry-run --outdir files/workflow-verify/think-full/dryrun-w4`: wrangler 4.165.0, 자산 46개, 업로드 1496.81 KiB (gzip 374.81 KiB), 바인딩 전부 인식 (DO 5종, KV, 큐, D1, Vectorize, R2, AI, ASSETS, vars 4개), `--dry-run: exiting now.`
- 한계: 실제 운영 배포는 하지 않았다. 런타임 동작(큐 소비자, RealtimeKit, cron)은 T1의 legacy 배포와 11-24 회귀에서 확인해야 한다.

### 2. 한 턴 완료

`GET /turn?run=v1` → `status: completed`, 3스텝(`ask_rag` 2회 → 답), 10,567ms, `stop: done`.

### 3. 도구 선택

`GET /tools?run=v1` → `correct: 10 / total: 10`. `ask_rag` 4/4, `create_task` 3/3, `email_draft` 3/3. 문항당 3~34초, 전부 `completed`.

### 4. 한도와 승인 차단

| 시험 | 결과 |
|---|---|
| `/limits?kind=steps` (maxSteps 3) | 3스텝에서 멈춤, `stop: max_steps`, `completed` |
| `/limits?kind=time` (상한 9초) | 1스텝 뒤 멈춤, `stop: time_limit`, `completed`, 12.6초 |
| `/limits?kind=approval` (`send_email`) | `blocked: send_email:approval_required`, `stop: approval_required`, `completed`, **`sent: 0`** |

시간 상한은 스텝 경계에서만 걸린다. 진행 중인 모델 호출·도구 실행을 끊지는 않으므로 상한 9초에 12.6초가 걸렸다.

### 5. 10스텝 턴

`/ten?run=v1|v2|v3` → 세 번 모두 `completed`, 10스텝(`count_step` 9회 + 답 "완료"), 30.9초 / 30.7초 / 31.5초. CPU 한도 오류 없음 (Workers Paid 기준).

### 6. 킬 테스트

세 번 시험했다. 각 턴은 `count_step`(12초 대기) 9회짜리 제출(`runTurn({mode: "submit"})`)이다.

| 실행 | 죽인 방법 | 결과 |
|---|---|---|
| k1 (`508cef63…`) | +29초에 빌드 2 배포 | **끊기지 않음.** 빌드 1 인스턴스가 그대로 +166.5초에 `completed` |
| k2 (`959b18d5…`) | +25초쯤 빌드 3 배포 | **끊기지 않음.** 빌드 2 인스턴스가 +186.8초에 `completed`. 새 빌드 생성자는 턴이 끝난 뒤(+246초)에야 실행 |
| k3 (`ac9620f7…`) | +29.7초에 `ctx.abort()`로 강제 종료 | **자동 복구.** +31.6초 새 인스턴스 → `chatRecovery` → `beforeTurn {trigger: "recovery-continue", continuation: true}` → +260초 `chatResponse completed` → `submissionStatus completed` |

확인된 것:

- 재배포는 실행 중인 턴을 2회 중 2회 끊지 않았다 (약 2.5분 동안 옛 코드로 끝까지 실행). 따라서 "재배포로 죽인다"는 원래 시험 방법으로는 복구 경로를 밟지 못했고, 복구는 `ctx.abort()` 강제 종료로 확인했다.
- 강제 종료 뒤에는 외부 요청 없이도 2초 안에 복구가 시작됐고, 제출 상태가 `completed`로 끝나 `onSubmissionStatus`(엔진에 알리는 자리)가 호출됐다.

확인하지 못한 것:

- 복구가 포기되는 경로(`interrupted`/`error`로 정리돼 엔진에 실패가 전달되는 경우). 복구가 성공해서 이 경로는 밟지 않았다.
- 플랫폼이 실제로 DO를 내리는 경우(재배포 후 장시간, 런타임 업데이트)의 동작. `ctx.abort()`와 같다고 가정한 것이다.

## T1에 넘길 주의사항

### Think 동작에서 확인한 것 (k3 기록 근거)

1. **중단된 도구는 다시 실행된다.** `count_step n=2`가 실행 도중 끊겼고, 복구 턴이 같은 호출을 다시 했다. 부작용 도구(메일·웹훅)는 승인 차단과 별개로 멱등 키가 있어야 한다.
2. **복구 턴에서 스텝 번호가 0부터 다시 센다.** k3는 중단 전 2스텝 + 복구 후 10스텝으로 `maxSteps: 10`을 넘겨 12스텝을 돌았다. 스텝 상한과 run 전체 LLM 30회 캡은 훅의 `stepNumber`가 아니라 DO 저장소의 누적 값으로 세야 한다.
3. **복구 턴은 `requestId`가 바뀐다** (`ac9620f7…` → `6e1ca17e…`). `submissionId`와 `idempotencyKey`는 그대로다. 엔진 연결은 `submissionId` 기준으로 한다.
4. `onChatResponse`의 `recovered`는 복구 턴에서도 `false`였다. 복구 여부는 `continuation: true` 또는 `trigger: "recovery-continue"`로 판별한다.
5. 메모리 필드(`blocked`, `timeUp` 같은 인스턴스 변수)는 종료 때 사라진다. 승인 대기·시간 상한 상태는 저장소에 둔다. 턴 시작 시각은 게이트 코드처럼 저장소에 두면 복구 뒤에도 원래 시각 기준으로 잰다.
6. 재배포 직후 한동안 옛 코드의 DO가 살아 있다. `AGENT_RUNTIME` 전환·롤백 배포 뒤에도 진행 중인 턴은 옛 코드로 끝난다 (계획 R11과 같은 방향이지만 배포 시점 기준으로도 성립한다).
7. 활성 도구를 줄여도 `beforeTurn`의 `tools`는 12개였다 (Think 기본 도구 포함). 운영에서는 `activeTools`로 반드시 좁힌다.
8. Qwen 응답 시간 편차가 크다 (스텝당 1~35초). 시간 상한은 스텝 경계에서만 걸리므로 활성 30분 캡은 여유 있게 잡는다.

### 화상회의 V1+V2 (`video-conference-v0/RESULT.md` 9절)와 겹치는 곳

9절은 "배포 안 함"으로 적혀 있지만 그 뒤 커밋 `b30b244`(HEAD, `pre-think` 태그)에 들어갔다. 라이브 배포 여부와 원격 D1 0039 적용 여부는 이 세션에서 확인하지 않았다.

- **건드리지 말 파일**: `src/meet/*`(특히 새 파일 `transcript.ts`), `src/chat/room.ts`(이벤트 종류에 `meeting_started`·`meeting_ended` 추가됨), `src/chat/routes.ts`(`broadcastRoomEvent`, `postSystemMessage` 추가됨), `public/meet.*`, `public/chat.js`, `public/approval.js`.
- **`src/index.ts`가 겹친다.** V1+V2가 3곳을 고쳤다: import 1줄, `advanceRecording`의 완료 분기를 `finishTranscript()`로 추출, `setMeetHooks` + 15분 크론에 `sweepMeetings()` 1줄. T1이 `ThinkAgent` export와 라우트를 넣을 때 이 3곳을 보존한다.
- **15분 크론(`*/15`)을 공유한다.** 워크플로우 스케줄 틱과 `sweepMeetings()`가 같은 분기에서 돈다. T1이 워크플로우 분기를 고치면 회의 정리·전사 폴백이 같이 깨진다.
- **`PIPELINE` 큐를 공유한다.** 회의 전사가 `finishTranscript()`로 같은 큐에 들어간다. `ask-pipeline` 도구(T2)나 큐 소비자를 건드리면 회귀 6번에 걸린다.
- **마이그레이션 번호**: 0039는 `0039_meetings_v2.sql`이 쓴다. Think용은 계획대로 0040부터. 적용 전 `d1 migrations list --remote`로 0039 추적 상태를 먼저 본다 (9.4절: 코드가 0039보다 먼저 배포되면 start가 500).
- **`wrangler.toml`**: V1+V2는 바꾸지 않았다. T1은 v4 마이그레이션(`new_sqlite_classes = ["ThinkAgent"]`)과 바인딩 추가만 한다.
- **9절의 미확인 항목은 그대로 남아 있다**: 전사 검색(항목 20), 채팅 화면의 버튼·카드(항목 21), 실제 영상 타일(항목 22), INACTIVE 전환이 전사 생성을 막는지. wrangler 4로 처음 운영 배포할 때 이 항목들이 wrangler 탓인지 원래 문제인지 구분하려면, T1 legacy 배포 전에 현재 라이브에서 한 번 확인해 두는 편이 좋다.

### 정리할 것

- `think-gate/files/workflow-verify/think-full/dryrun-gate/` — 중단된 세션이 `--outdir`를 설정 파일 기준 상대 경로로 써서 생긴 빌드 산출물 사본이다. 지워도 된다 (이 세션에서는 지우지 않았다).
- `dryrun-w4/`, `dryrun-gate/`의 `index.js`·`.map`은 빌드 산출물이다 (게이트 쪽 6.8MB). 커밋에서 빼는 것을 권한다.
- 게이트 Worker에 이 세션이 `/kill-abort` 경로와 `gateAbort()`를 추가했다 (빌드 3).
- **커밋·태그는 하지 않았다.** `pre-think` 태그는 `b30b244`에 있다. 커밋할 것: `package.json`, `package-lock.json`, `think-gate/`, 이 결과 파일, 계획·프롬프트 문서.
