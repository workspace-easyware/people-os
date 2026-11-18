# WF-8 프롬프트 — 스케줄 + 이벤트 트리거

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.2.2 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-8행 + WF-1~WF-7 산출물(`src/workflow/{types,store,routes,engine,approvals,nodes,agent}.ts`) + 검증 문서(`files/workflow-verify/wf3/RESULT.md`의 속도 제한·정체 청소, `wf7/RESULT.md`의 설계 메모).
> 모델: Sonnet. 이 세션은 **스케줄 + 이벤트 트리거만** 만든다. 공유(WF-9), 캔버스(WF-10), 관측(WF-11)은 **하지 않는다**. **배포하지 않는다** — D-2에서 코디네이터가 0028 적용·배포·라이브 검증을 한다.
> **주의: `src/index.ts`를 만진다.** `scheduled()` 분기와 전사 완료 지점(`processPipelineMessage`)만 최소한으로 고친다. **이 세션은 `scheduled()`를 만지는 유일한 세션이다** — 분기를 틀리면 다이제스트가 15분마다 돌거나 평가가 안 돈다. 기존 메시지 타입·큐 분기·승인 게이트·에이전트 루프·조건 분기의 동작은 절대 바꾸지 않는다.

## 목표

워크플로우가 "매일 09:00에 돌리기" 같은 스케줄로 스스로 돌고, "새 전사본이 생기면 돌리기" 같은 사건에도 반응한다. 이 세션이 끝나면 스케줄에 등록된 워크플로우가 정해진 시각에 run을 만들고, 전사가 끝나면 해당 워크플로우가 전사본 id를 input으로 받아서 돈다. 평가·다이제스트 크론은 그대로 돈다.

## 할 일

### 1. 마이그레이션 0028 (`migrations/0028_workflow_schedules.sql`)

- `workflow_schedules` 테이블을 만든다:
  ```sql
  CREATE TABLE IF NOT EXISTS workflow_schedules (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'event')),
    cron TEXT,              -- trigger_type='schedule'일 때 5필드 cron (분 시 일 월 요일), KST 기준
    event TEXT,             -- trigger_type='event'일 때 이벤트 이름 (v1은 'transcript_completed'만)
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,       -- 마지막으로 run을 만든 시각 (ISO)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wf_schedules_workflow ON workflow_schedules(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_wf_schedules_owner ON workflow_schedules(owner_id);
  CREATE INDEX IF NOT EXISTS idx_wf_schedules_trigger ON workflow_schedules(trigger_type, enabled);
  ```
- `trigger_type='schedule'`면 `cron` 필수, `'event'`면 `event` 필수 — 이 검사는 API에서 한다 (CHECK 제약은 타입만 본다).
- `workflows` 테이블 자체는 건드리지 않는다 (0027 그대로).

### 2. 크론 매처 + 스케줄 실행 (`src/workflow/schedules.ts`, 신규)

- `matchesCron(cron: string, nowKst: Date): boolean` — 5필드 cron을 평가한다. 지원하는 형식: `*`, 숫자, `,` 목록, `-` 범위, `/` 간격 (예: `0 9 * * *` 매일 09:00, `0 9 * * 1-5` 평일 09:00, `*/30 * * * *` 30분마다). 월·요일 이름(JAN·MON)은 지원하지 않는다 — 숫자로만 쓴다. 형식이 틀리면 `false`를 돌려준다 (에러를 던지지 않는다 — 스케줄 하나가 틀렸다고 전체 크론이 죽으면 안 된다).
- **KST 기준**: Worker는 UTC로 돈다. 매처에 넣기 전에 현재 시각을 KST(UTC+9)로 바꾼다. `new Date()`를 UTC 기준으로 쓰지 않는다 — KST 변환 헬퍼를 이 파일에 두고, 변환이 맞는지 테스트에 넣는다 (UTC 00:00 = KST 09:00).
- `runDueSchedules(env, now: Date): Promise<{ created: number; skipped: number }>` — 크론이 돌 때 부른다:
  1. `enabled=1 AND trigger_type='schedule'`인 스케줄을 전부 읽는다 (한 번에 100개까지 — 그 이상은 다음 틱에).
  2. 각 스케줄의 `cron`이 현재 15분 슬롯에 맞는지 본다. **15분 틱이라 정확히 맞아야 한다**: `now`를 15분 단위로 내림한 시각으로 매칭한다 (예: 09:07 틱은 09:00으로 내림 → `0 9 * * *`와 맞는다. 09:16 틱은 09:15로 내림 → 안 맞는다). 이 내림 규칙을 주석 + RESULT.md에 적는다.
  3. 맞는 스케줄마다 run을 만든다: `createRun(db, ownerId, workflowId, {})` + 첫 단계 큐 투입 (`PIPELINE.send(stepMessage(...))` — WF-3의 routes.ts 배선과 같은 방식). **속도 제한을 지킨다**: `checkWorkflowRateLimit`이 실패(동시 3개·하루 20회 초과)하면 그 스케줄은 건너뛰고 `skipped`에 센다 (에러를 던지지 않는다).
  4. run을 만든 스케줄은 `last_run_at`을 지금 시각으로 갱신한다. **중복 방지**: `last_run_at`이 현재 15분 슬롯 안에 이미 있으면 건너뛴다 (크론이 두 번 돌거나 재시도돼도 같은 슬롯에 run을 2개 만들지 않는다).
  5. 워크플로우가 삭제됐거나 소유자가 바뀌었으면 그 스케줄은 건너뛴다 (조용히 — 에러를 던지지 않는다).
- `runEventTriggers(env, event: string, input: Record<string, unknown>, ownerId: string): Promise<number>` — 사건이 생겼을 때 부른다:
  1. `enabled=1 AND trigger_type='event' AND event=?`인 스케줄 중 `owner_id`가 사건 소유자와 같은 것만 읽는다.
  2. 각 스케줄마다 run을 만든다 (input을 그대로 넣는다 — 예: 전사 완료면 `{ docId, recordingId }`). 속도 제한은 스케줄과 같은 규칙 (초과 시 건너뜀).
  3. 만든 run 개수를 돌려준다.

### 3. 스케줄 API (`src/workflow/routes.ts`에 추가 — 새 파일로 빼지 않는다)

- `POST /api/workflows/:id/schedules` — 스케줄 생성. 본문 `{ trigger_type: "schedule", cron: "0 9 * * *" }` 또는 `{ trigger_type: "event", event: "transcript_completed" }`. 워크플로우 소유자만 (타인 404). `cron` 형식이 틀리면 400 (매처로 한 번 평가해본다 — 단, "지금 맞는가"가 아니라 "형식이 맞는가"만 본다). `event`는 `transcript_completed`만 허용 (다른 값은 400). 응답 201 + 생성된 스케줄.
- `GET /api/workflows/:id/schedules` — 해당 워크플로우의 스케줄 목록 (소유자만).
- `PATCH /api/workflows/:id/schedules/:scheduleId` — `enabled` 토글만 받는다 (`{ enabled: true|false }`). 다른 필드 변경은 400.
- `DELETE /api/workflows/:id/schedules/:scheduleId` — 삭제 (소유자만, 타인 404).
- 스케줄이 있는 워크플로우를 삭제하면 스케줄도 같이 지워진다 (0028의 `ON DELETE CASCADE` + WF-1의 워크플로우 삭제가 runs·steps를 지우는 것과 같은 방식 — 실제로 지워지는지 테스트에 넣는다).

### 4. 크론 배선 (`wrangler.toml` + `src/index.ts` `scheduled()`)

- `wrangler.toml`의 `crons`에 `"*/15 * * * *"`를 추가한다 (기존 2개는 그대로 둔다).
- `src/index.ts`의 `scheduled()`를 **3방향 명시 분기**로 바꾼다 (현재는 EVAL_CRON이면 평가, 그 밖은 전부 다이제스트 — 이 구조가 새 크론을 다이제스트로 떨어뜨리는 함정이다):
  ```ts
  const WORKFLOW_CRON = "*/15 * * * *";
  async scheduled(event, env, ctx) {
    if (event.cron === EVAL_CRON) { ctx.waitUntil(runEvalCron(env, ctx)); ctx.waitUntil(sweepStaleWorkflowRuns(env)); return; }
    if (event.cron === WORKFLOW_CRON) { ctx.waitUntil(runDueSchedules(env, new Date(event.scheduledTime))); return; }
    ctx.waitUntil(generateDigest(env, new Date(event.scheduledTime)));
  }
  ```
  **주의**: `*/15`는 18:00·22:00에도 돈다. 그 시각에는 평가/다이제스트 크론과 워크플로우 크론이 **별개의 scheduled 이벤트**로 각각 들어온다 (`event.cron` 문자열로 구분된다). 이 점을 주석에 적는다. 분기 순서는 EVAL → WORKFLOW → 다이제스트(기본값) 순으로 둔다.

### 5. 전사 완료 이벤트 트리거 (`src/index.ts` `processPipelineMessage`)

- 전사가 끝나서 `setPipelineStage(env, rec.id, "done")`이 성공한 **바로 뒤**에, 실패가 아니라 성공 경로에서만:
  ```ts
  await runEventTriggers(env, "transcript_completed", { docId: rec.doc_id, recordingId: rec.id }, doc.owner_id ?? rec.owner_id ...)
  ```
  (owner는 문서의 `owner_id`를 쓴다 — `doc` 행에서 이미 읽어온 값이다. 없으면 `rec`의 owner를 쓴다.)
- **이벤트 트리거가 실패해도 전사 파이프라인은 실패하지 않는다** — `runEventTriggers` 호출을 try/catch로 감싸고, 실패하면 `console.error`만 남긴다 (전사 완료 자체는 이미 `done`이다). 이 원칙을 주석에 적는다.
- 전사 실패 경로(`catch` → `failed`)에서는 트리거를 부르지 않는다.

## 검증 (반드시 `files/workflow-verify/wf8/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf8/`)

- `npx tsc --noEmit` 통과. `src/index.ts`를 건드렸으므로 `node --check`는 해당 없음 (tsc로 커버).
- 로컬 하네스 (WF-6·WF-7의 `wf6/`·`wf7/` 패턴 — `wrangler.toml` + `worker.ts` + Miniflare, AI·VECTOR·fetch는 mock):
  1. **크론 분기 회귀 (가장 중요)**: `scheduled()`를 3가지 cron 문자열로 각각 부른다 — `0 18 * * *` → 평가만 돌고 워크플로우 스케줄은 안 돈다, `0 22 * * *` → 다이제스트만 돌고 스케줄은 안 돈다, `*/15 * * * *` → 스케줄만 돌고 다이제스트·평가는 안 돈다. **다이제스트가 15분마다 도는 일이 없는지** 이 테스트로 확인한다.
  2. **스케줄 run 생성**: `0 9 * * *` 스케줄을 만들고 KST 09:00(UTC 00:00) 틱에서 run이 1개 생기고, 09:15 틱에서는 안 생긴다. 평일 스케줄(`0 9 * * 1-5`)은 토요일에 안 생긴다.
  3. **중복 방지**: 같은 슬롯에 크론을 2번 부르면 run이 1개만 생긴다 (`last_run_at` 가드).
  4. **속도 제한**: 하루 20회를 채운 사용자의 스케줄은 건너뛰고 `skipped`에 센다 (run이 안 생긴다).
  5. **비활성화·삭제**: `enabled=0` 스케줄은 안 돌고, 워크플로우 삭제 시 스케줄도 같이 지워진다.
  6. **이벤트 트리거**: 전사 완료(파이프라인 `done`) 시 `transcript_completed` 스케줄이 있는 워크플로우만 run을 만들고, input에 `docId`가 들어간다. 전사 실패 시 run이 안 생긴다. 이벤트 트리거가 실패해도 전사는 `done`으로 남는다.
  7. **API**: 스케줄 생성·목록·토글·삭제 왕복, 잘못된 cron 400, `transcript_completed` 외 event 400, 타인 워크플로우 404.
  8. **회귀**: 일반 워크플로우 실행 + 승인 게이트 + agent 루프 + condition 분기 + transcript-pipeline(전사 완료까지)이 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Cloudflare 크론 동작 — 로컬에서는 `scheduled()`를 직접 부른 것, 배포·원격 D1, 브라우저 화면, 스케줄 UI — WF-11에서 다룬다).

## 금지

- `scheduled()`의 평가·다이제스트 분기를 바꾸지 않는다 (새 분기를 **추가**만 한다). `queue()`의 기존 분기를 바꾸지 않는다.
- D1 마이그레이션 파일은 0028 하나만 만든다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 코드 실행 노드를 만들지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
