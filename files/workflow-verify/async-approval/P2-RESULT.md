# 비동기 승인 + 시뮬레이션 P2 결과 (2026-11-21, Opus 5.5 단일 세션)

범위: 설계 §3.1 항목 4(에이전트 경로 지연)·5(승인 결정 API + 큐 소비자). UI(항목 6, P3)는 건드리지 않았다.

## 판정

| # | 통과 기준 | 판정 | 근거 |
|---|---|---|---|
| 1 | `npx tsc --noEmit` 오류 0 | 통과 | 출력 없음 |
| 2 | 로컬 하네스 10개 항목 | **10/10 통과** | 아래 "하네스 증거" (+ 저장 거부 2건, 입력 검증 400·401) |
| 3 | D1 마이그레이션 없음, 0042까지 적용 확인 | 통과 | `cf-wrangler.py d1 migrations list people-os-db --remote` → "No migrations to apply!" |
| 4 | 라이브 배포 + 스모크 | 통과 (기존 6개 상태·크기 같음, 본문 4개 `cmp` 동일. 새 API 2개 비로그인 401) | 버전 **`720700f8-8117-417e-9da2-be05913f2e6e`** (이전 `fc2ed076`) |
| 5 | 결과 파일 | 이 파일 | |

## 구현한 파일

| 파일 | 변경 |
|---|---|
| `src/workflow/types.ts` | `NodeContext.deferTurn?`, `WorkflowActionMessage`, `isDeferredAgentStep()`. `validateDefinition`: approvalMode를 `agent`에도 허용, 단 `requiresApproval:true` agent + deferred는 거부(아래 설계 결정). 지연 거부 규칙 (i)는 agent에도 그대로 적용 |
| `src/workflow/nodes.ts` | `deferAction`이 `ctx.deferTurn`이 있으면 id `wfpa_<runId>_<stepIndex>_t<turn>` + `turn` 열 기록 (없으면 P1과 같음). 그 밖의 P1 코드는 그대로 |
| `src/workflow/agent.ts` | legacy 지연: 지연 모드 agent 단계에서 gated 도구가 send_email·webhook이면 `executeNode(…, {approved:false, deferActions:true, deferTurn:r.turn})` → 관찰 `"(승인 대기열에 넣음 — 승인되면 실행됩니다) 아직 실행되지 않았습니다. 같은 동작을 다시 부르지 마세요. {시뮬레이션 출력}"` → `hooks.requeue(nextTurn)`. 검증 실패는 도구 실패 관찰. DO `/pending` 안 씀. 동기식 분기 그대로 |
| `src/workflow/think-agent.ts` | `ThinkJob.deferred?`. 지연 모드에서 `beforeToolCall`은 send_email·webhook을 차단하지 않음(pending·approval_required 없음), `runTool`이 `deferActions`+`deferTurn`으로 `execNode` → 모델에 `{queued:true, executed:false, notice:"대기열에 넣었습니다. 아직 실행되지 않았습니다. 승인되면 실행됩니다. …", providerId:null, simulated:true, pendingActionId, …}`. 시스템 프롬프트 규칙 (e)는 job.deferred일 때만 지연 문구(`SYSTEM_PROMPT_DEFERRED`), 동기식 문구는 그대로. 턴 번호 할당 `deferTurn(key)` (원장 키별 고정, 겹치면 다음 빈 번호) |
| `src/workflow/agent-think.ts` | `startStep`에 `deferred: isDeferredAgentStep(step)` 전달 |
| `src/workflow/pending-actions.ts` (새) | `listPendingActions`, `decidePendingActions`, `processWorkflowAction`, 인자 요약(`summarizeArgs` — 웹훅 헤더는 키만, 메일 본문은 200자 미리보기) |
| `src/workflow/routes.ts` | `GET /pending-actions`, `POST /pending-actions/decide` (`/:id`보다 먼저 등록) |
| `src/index.ts` | `QueueMessage` 유니온에 `WorkflowActionMessage`, `queue()`에 `workflow-action` 분기 1개 추가 (다른 분기·크론·V1+V2 무변경) |

건드리지 않음: `public/*`, 동기식 승인 경로(`pauseForApproval`·`resumeWorkflowRun`·`cancelWorkflowRun`·approve/reject 라우트), `agent-do.ts`(legacy DO, `/pending`·`/take-pending` 그대로), engine.ts, 템플릿, wrangler.toml, 마이그레이션.

### 설계 결정 (프롬프트에서 열려 있던 것)
- **`requiresApproval:true` + `approvalMode:"deferred"` agent는 저장 거부**: "모든 도구 승인"이면 create_task 등도 승인 대상인데 시뮬레이션은 send_email·webhook만 가능하다. 섞으면 지연 단계가 일부 도구에서 멈추게 된다. 런타임도 이중 방어로 지연은 `DEFERRABLE_NODES`에만 적용 (그 밖의 gated 도구는 동기식 차단 그대로).
- **결정 API의 hr_admin**: 목록은 전부 보지만(`owner_id` 포함) **결정은 본인 것만** (실행자가 소유자이므로). 남의 id는 hr_admin이어도 404.
- **결정 API 응답**: HTTP 200 + 행별 `{id, status, code}` (code 200/404/409/500). 남의 id·없는 id는 같은 404 `"not_found"`. 큐 전송 실패 시 행을 `queued`로 되돌리고 code 500.
- **소비자 at-most-once**: 노드 실행 전 엔진 예외면 `executing→approved`로 되돌리고 throw(재시도). 노드 실행 뒤 기록이 실패하면 throw하되 행은 `executing`에 남는다(재전달은 점유 실패 → 재실행 없음). 실패도 `executed_at`(시도 시각)을 기록.
- **Think 턴 번호**: legacy는 `r.turn`. Think는 모델 스텝 번호(`steps`) 기준이고, 원장 키(도구+입력)별로 저장해 복구 턴이 같은 호출을 다시 돌려도 같은 id(INSERT OR IGNORE)가 된다. 한 스텝에 서로 다른 동작이 둘이면 다음 빈 번호.
- **사전 검증 실패에도 Think는 턴 번호를 하나 할당**한다 (행은 안 생김, 번호만 소비 — 무해).

## 하네스 증거 (`p2-harness/`)

방식: `wrangler dev --local` (포트 8813, `state/`), 로컬 D1에 0001~0042 전부 `migrations apply --local` ✅. 운영 `workflowApp`(세션 쿠키)을 그대로 마운트, **로컬 실제 큐**(p2-harness-pipeline) — queue()가 운영 `processWorkflowStep`·`processWorkflowAction`을 부른다. 모델은 대본 모의(legacy `callModel` 서브클래스, Think `MockLanguageModelV4`; 목표의 `[S:…]` 표식으로 대본 선택). `globalThis.fetch`를 가로채 Resend·웹훅 호출을 기록만 한다(`RESEND_API_KEY` 가짜). KV `hold-actions`로 workflow-action을 보관했다가 `/h/release`로 운영 소비자에 넘길 수 있다(재전달·비활성 시험용). 런타임: 기본 think, 워크플로별 KV `mode:<wfId>=legacy`.

| 항목 | 결과 | 증거 |
|---|---|---|
| Legacy agent 지연 | run `succeeded`(agent → 뒤 단계 create_task까지), 대기 동작 1행 `wfpa_wfrun_mwp7c4a7_c8dq1r_0_t0` `queued` `turn 0`, `args_json` = `{to, subject, body}` 최종 인자, 관찰 `"(승인 대기열에 넣음 — 승인되면 실행됩니다) 아직 실행되지 않았습니다. … {\"providerId\":null,\"simulated\":true,\"pendingActionId\":…}"`, 알림 0, emails 0, fetch 0 | `out-a-legacy-defer.json` |
| Think agent 지연 | run `succeeded`, workflow_agent_steps `status completed`(approval 아님), DO `stop null`·`pending null`, 대기 동작 1행 `…qywylx_0_t0` `queued`, emails 0. 모델이 받은 도구 결과 `{queued:true, executed:false, notice:"대기열에 넣었습니다. 아직 실행되지 않았습니다…", simulated:true, …}`, 시스템 프롬프트에 지연 규칙 (e) 있음·동기식 문구 없음(`h_prompts`). 최종 답 "안내 메일은 승인 대기열에 들어갔고 아직 발송되지 않았습니다…"(대본) — "보냈습니다" 없음 | `out-b-think-defer.json` |
| 동기식 agent 불변 | legacy: run `waiting_approval`, 알림 `wfapr_…_0_t0`, 대기 동작 0 → `POST /runs/:id/approve` → Resend 1회 + emails 1행 → run `succeeded`(뒤 단계까지). Think 동기식도 같음(`agentRow.status approval` → 승인 → `succeeded`, 대기 동작 0) | `out-c1-legacy-sync-{before,after}.json`, `out-c2-think-sync-{before,after}.json` |
| 결정 API 승인 → 실제 실행 | A1 승인 → 소비자 실행 → 행 `executed`, `result_json {"providerId":"re_fake_3"}`, emails 행 "[P2] 분기 리뷰 안내". 웹훅(`…z4iy38_0_t1`) → 캡처 fetch `POST https://hooks.example.com/p2`(Authorization 원본 값 사용, x-trace 포함), `result_json {status:200, ok:true, …}` | `out-g1-approve-a1.json`, `out-g3-batch-state.json`, `out-k-list-a-final.json` |
| 결정 API 거절 | Think 동작 A2 → `rejected`, 실행 없음(emails에 "[P2] Think 안내" 없음, `executed_at null`) | `out-g2-reject-a2.json`, `out-k-list-a-final.json` |
| 일괄 결정 | 2건(메일+웹훅) 한 번에 승인 → 둘 다 `executed`. 다른 run: 1건 승인(`executed`)·1건 거절(`rejected`, 웹훅 fetch 없음) | `out-g3-batch-approve.json`, `out-g4a-approve.json`, `out-g4b-reject.json` |
| 권한 | 사용자 B가 A의 id + 없는 id로 decide → 둘 다 `404 not_found` (같은 응답). B 목록 `{"actions":[]}`. hr_admin 목록에 A의 행 + `owner_id` | `out-i-other-user-decide.json`, `out-i-list-b.json`, `out-j-list-admin.json` |
| 중복 승인 | 실행된 A1을 다시 승인 → `409 "이미 결정된 동작입니다 (executed)."`. 소비자 중복: 보관한 같은 메시지를 운영 `processWorkflowAction`으로 2번 처리 → 발송 1회(fetch 1, emails 1) | `out-h-dup-approve.json`, `out-l-release-twice.json`, `out-l-state.json` |
| 비활성 소유자 | C가 웹훅 승인(보관) → C 비활성 → 처리 → 행 `failed` "실행할 사용자(소유자)가 비활성이거나 없습니다.", 웹훅 fetch 없음 | `out-m-inactive-*.json`, `out-n-fetches-final.json` |
| 검증 우선 | legacy·Think 모두 주소 틀린 send_email → 관찰 "(실패) 받는 사람 주소가 올바르지 않습니다.", 대기 동작 0, run은 끝까지 감(에이전트가 최종 답으로 마무리) | `out-d-legacy-bad.json`, `out-e-think-bad.json` |

추가: 저장 거부 — 지연 agent 출력을 뒤 단계가 참조 → 400(규칙 i), `requiresApproval:true`+deferred agent → 400 (`out-rej-agent-*.json`). 새 라우트 비로그인 401, `ids:[]` 400, `status=bogus` 400. 하네스 전체 fetch 6회 = 동기식 승인 2 + 결정 API 승인 4(메일 3·웹훅 1). 승인 함 목록에 `p2-secret-token` 0회(`out-f-list-a-queued.json`).

## 라이브 (`p2-live-smoke/`)

배포 `720700f8-8117-417e-9da2-be05913f2e6e` (`AGENT_RUNTIME=think` 유지, D1 표시 id `36113f26…`는 wrangler 4 표시 오류 — AGENTS.md). 배포 전 스냅숏 → 배포 → 3분 대기 → 배포 후.

| 대상 | 배포 전 (`fc2ed076`) | 배포 후 (`720700f8`) | 본문 |
|---|---|---|---|
| `GET /` | 200, 139,478 B | 200, 139,478 B | `cmp` 동일 |
| `GET /api/workflows/runs/<없는 id>` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/workflows/templates` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/auth/me` | 401, 52 B | 401, 52 B | 같음 |
| `GET /api/agents/me` | 401, 52 B | 401, 52 B | 같음 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 1,182 B | 200, 1,182 B | `cmp` 동일 |
| **새** `GET /api/workflows/pending-actions` (익명) | 401 (이전엔 `/:id` 캐치가 401) | **401** "로그인이 필요합니다." | 의도 |
| **새** `POST /api/workflows/pending-actions/decide` (익명) | 404 (라우트 없음) | **401** "로그인이 필요합니다." | 의도한 변화 |

로그인한 사용자의 지연 agent run·결정·실행은 라이브에서 돌리지 않았다(로그인 계정 없음 — P1과 같은 사정). 같은 운영 코드를 로컬 하네스가 확인했다.

## 남은 문제

1. **실제 모델(Qwen)의 지연 모드 문장은 확인하지 않았다.** 로컬 dev는 Workers AI를 못 부르고(TLS), 로그인 계정이 없어 라이브에서도 run을 못 돌렸다. 모의 모델로 "모델에 보이는 것"(지연 규칙 (e) + `queued:true, executed:false` + 안내 문장)과 턴 상태(approval 아님)는 확인했지만, Qwen이 실제로 "보냈습니다"라고 쓰지 않는지는 원격 시험 Worker(T1 방식, `people-os-t1-harness` 같은 분리 Worker)나 로그인 계정으로 확인해야 한다. 별도 Worker 배포는 이번 프롬프트 범위 밖이라 하지 않았다.
2. legacy 에이전트(agent-do.ts)의 시스템 프롬프트는 동기식·지연 공용이라 바꾸지 않았다 — 지연 안내는 관찰 문장에만 있다. 실제 모델이 관찰을 보고도 "보냈습니다"라고 쓰면 legacy 프롬프트에 지연 규칙을 추가해야 한다(현재 AGENT_RUNTIME=think라 새 단계는 Think).
3. 노드 실행 뒤 D1 기록이 실패하면 행이 `executing`에 남는다(설계상 at-most-once). 정리 스윕은 없다 — P3 UI에서 "실행 중(확인 필요)"으로 보여 주거나 이후 스윕을 추가할 것.
4. 로컬 dev 서버는 TaskStop으로 종료했다.

## P3에 넘길 것

- `GET /api/workflows/pending-actions?status=&run_id=&limit=` → `{ actions: [ { id, run_id, workflow_id, workflow_name, step_index, turn, node_type, args, simulated_output, status, result, error, created_at, decided_at, executed_at, owner_id? } ] }` (최신순, 기본 100·최대 200, `owner_id`는 hr_admin 응답에만).
  - `args` — send_email: `{ to, subject, bodyPreview(200자), bodyLength }` / webhook: `{ method, url, headerKeys[], bodyPreview(200자) }` (헤더 값 없음).
  - `result` — 실행 결과(웹훅 body 500자, json 필드 제거). `status` 값: queued | approved | executing | executed | rejected | failed | expired.
- `POST /api/workflows/pending-actions/decide` `{ ids: string[1..50], action: "approve"|"reject" }` → `{ results: [ { id, status, code, error? } ] }`. HTTP는 200(행별 code). 승인 직후 status는 `approved` — 실행 결과는 목록을 다시 불러 확인(보통 수 초 안에 executed/failed).
- hr_admin은 남의 동작을 볼 수만 있다 — UI에서 남의 행에 결정 버튼을 숨길 것.
- run 상세의 `pendingActions`(P1, queued 수)와 함께 쓰면 된다. 거절 화면의 "뒤 단계는 이미 실행됨" 안내는 P1 인계 그대로.

## 커밋에서 뺄 파일

- `files/workflow-verify/async-approval/p2-harness/state/`, `p2-harness/dev.log`, `p2-harness/.wrangler/`(생겼으면)
- 이 세션 전부터 있던 미추적 파일(`files/workflow-verify/think-full/dryrun-*`, `prompt-v5-draft.json`, `t3-live-smoke/tail-cron-1430.jsonl`, `async-approval-p2-prompt.md`, `muse-assistant-plan-prompt.md`) — 이번 세션과 무관

커밋할 것: `src/workflow/{types,nodes,agent,think-agent,agent-think,routes,pending-actions}.ts`, `src/index.ts`, `p2-harness/{harness.ts,wrangler.toml,wf-*.json,rej-*.json,out-*.json}`, `p2-live-smoke/*`, 이 파일.
