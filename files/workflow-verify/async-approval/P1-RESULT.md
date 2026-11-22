# 비동기 승인 + 시뮬레이션 P1 결과 (2026-11-21, Opus 5.5 단일 세션)

## 판정

| # | 통과 기준 | 판정 | 근거 |
|---|---|---|---|
| 1 | `npx tsc --noEmit` 오류 0 | 통과 | 출력 없음 (exit 0) |
| 2 | 로컬 하네스 10개 항목 | **10/10 통과** | 아래 "하네스 증거" |
| 3 | 0042 원격 적용 | 통과 | `migrations list --remote` → 미적용은 0042 하나뿐 → `apply --remote` ✅ (5dff997a = 운영 DB). `sqlite_master`에 테이블 + autoindex 2 + 인덱스 2 확인 |
| 4 | 라이브 배포 + 스모크 | 통과 (6개 엔드포인트 배포 전후 상태·크기 같음, 본문 4개 `cmp` 동일) | 버전 **`fc2ed076-ac4b-41ff-831b-4d5dfc790750`** (이전 `a685a42f`) |
| 5 | 결과 파일 | 이 파일 | |

## 구현한 파일

| 파일 | 변경 |
|---|---|
| `migrations/0042_workflow_pending_actions.sql` (새) | `workflow_pending_actions` 테이블 (설계 원본 §3.1 항목 1의 열 그대로, `id` PRIMARY KEY, `UNIQUE(run_id, step_index, turn)`), 인덱스 `run_id`, `(owner_id, status)`. 추가만 |
| `src/workflow/types.ts` | `ApprovalMode`, `DEFERRABLE_NODES = ['send_email','webhook']`, `WorkflowStepDef.approvalMode?`, `NodeContext.deferActions?`. `validateDefinition`: approvalMode 검사(값·타입·GET 웹훅) + 저장된 step에 `approvalMode` 보존 + 지연 단계 출력 참조 거부 |
| `src/workflow/nodes.ts` | `pendingActionId()`(결정적 id `wfpa_<runId>_<stepIndex>`, agent용 `_t<turn>` 자리만), `deferAction()`(INSERT OR IGNORE). `send_email`·`webhook`: 검증 → `approved !== true && deferActions` 이면 대기 동작 + 시뮬레이션 출력, 아니면 기존 그대로 |
| `src/workflow/engine.ts` | 승인 게이트(7번): `isDeferred(step)`이면 `pauseForApproval` 없이 `ctx.deferActions = true`로 `executeNode`. `sweepStaleWorkflowRuns`: 7일 지난 `queued` 대기 동작 → `expired`(`decided_at` 기록). 반환 형태 그대로, 테이블이 없으면 건너뜀 |
| `src/workflow/routes.ts` | `GET /runs/:runId` 응답에 `pendingActions`(그 run·소유자의 `queued` 행 수) 추가. 테이블이 없으면 0 |

건드리지 않은 것: agent 경로(`agent.ts`·`agent-do.ts`·`agent-think.ts`·`src/assistant/*`), `index.ts`, UI(`public/*`), 동기식 승인 경로(`pauseForApproval`·`resumeWorkflowRun`·`cancelWorkflowRun`·approve/reject 라우트), 템플릿, `wrangler.toml`. 새 라우트 없음.

### 설계 결정 (프롬프트에서 열려 있던 것)
- **참조 거부 패턴**: `resolveVars`는 `{{steps.<id>.output.x}}`뿐 아니라 `{{steps.<id>.x}}`도 같은 출력으로 푼다. 그래서 `output` 경로만이 아니라 `{{ steps.<id>.` / `{{steps.<id>}}` 전체를 잡는다 (다른 모든 단계의 config를 JSON 문자열로 만들어 검사 — 앞 단계도 포함, 보수적). id의 정규식 특수문자는 이스케이프.
- **`pendingActions`는 응답 최상위** (`{ run, pendingActions }`). `run` 객체 모양은 그대로라 기존 UI에 영향 없음.
- **`args_json` = 치환된 최종 config 그대로** (웹훅 헤더 값 포함 — P2가 실행하려면 필요). 공유·템플릿 경로에는 이 테이블이 나가지 않는다. P2 승인함 API는 헤더 **값**을 가려서 보여야 한다 (아래 P2 항목).
- **엔진의 이중 확인**: `validateDefinition`이 막지만 엔진의 `isDeferred`도 `DEFERRABLE_NODES`를 다시 확인한다 (DB에 직접 들어간 정의 방어). `approved === true`면 `deferActions`를 켜지 않는다 → 승인 우선.

## 하네스 증거 (`p1-harness/`)

방식: `wrangler dev --local` (포트 8812, `state/`), 로컬 D1에 0001~0042 전부 `migrations apply --local`로 적용 (0042 ✅). 하네스는 운영 `workflowApp` 라우트를 그대로 마운트(세션 쿠키 인증 포함)하고, 큐는 메모리 가짜(`/h/drain`이 운영 `processWorkflowStep`으로 처리), `globalThis.fetch`를 가로채 Resend·웹훅 호출을 기록만 한다 (`RESEND_API_KEY`는 가짜 값 — 그래서 동기식 승인 경로가 실제로 "발송"까지 간다).

| 항목 | 결과 | 증거 파일 |
|---|---|---|
| 지연 메일 + 뒤 단계 | run `succeeded`(멈춤 없음), 단계0 `send_email` succeeded 출력 `{providerId:null, simulated:true, pendingActionId:"wfpa_wfrun_mwp6oxp6_dfdwkw_0", to:["kim@example.com"], subject:"[P1] 분기 리뷰 안내"}`, 단계1 `create_task` succeeded(할 일 "분기 리뷰 후속 확인"). 대기 동작 1행 `queued`, `args_json` = `{"to":"kim@example.com","subject":"[P1] 분기 리뷰 안내","body":"안녕하세요, 분기 리뷰 건입니다."}` (입력 치환 완료), `simulated_output_json` = 단계 출력과 같음. fetch 0, `emails` 0, 알림 0 | `out-a-state.json` |
| run 상세 `pendingActions` | 운영 라우트 `GET /api/workflows/runs/:id` → `"pendingActions":1` | `out-a-run-detail.json` |
| 지연 웹훅(POST, method 생략) | run `succeeded`, 출력 `{status:null, ok:null, simulated:true, pendingActionId, method:"POST", url:"https://example.com/hook/abc"}`, 대기 동작 1행 (`args_json`에 치환된 url·headers·body), fetch 0 | `out-b-state.json` |
| 저장 거부 (i) 출력 참조 | 400 "steps[1]가 지연 승인 단계(mail)의 출력을 참조합니다…" | `rej-i-ref.json` |
| 저장 거부 (ii) GET 웹훅 | 400 "GET 웹훅은 지연 승인할 수 없습니다" | `rej-ii-get.json` |
| 저장 거부 (iii) 다른 타입 / 다른 값 | `create_task`+deferred → 400, `approvalMode:"later"` → 400 | `rej-iii-type.json`, `rej-iii-value.json` |
| 동기식 불변 | approvalMode 없는 send_email: 저장 시 `requiresApproval:true` 강제(기존), run `waiting_approval` + 알림 1건(`wfapr_…_0`), 대기 동작 0. 승인 → 200 running → 드레인 → Resend 호출 1회 + `emails` 1행, run `succeeded` 출력 `{providerId:"re_fake_1"}`. 다른 run 거절 → `cancelled` "승인 거절로 취소됨", 단계 `skipped` | `out-c1-before.json`, `out-c1-after.json`, `out-c2-after.json` |
| 큐 재전달 멱등 | 지연 단계를 "엔진 예외 뒤 재전달" 상태(step failed, run running)로 되돌리고 같은 메시지 재처리 → 노드가 다시 돌아도 대기 동작 1행 그대로, 할 일 중복 없음, fetch 0 | `out-idem-state.json` |
| 만료 | 8일 전 `queued` 행 → 운영 `sweepStaleWorkflowRuns` 후 `expired`(decided_at 기록), 방금 만든 행은 `queued` 유지. sweep 반환 `{failed:0, cancelled:0}` 형태 그대로 | `/h/expire` 응답 (아래) |
| 검증 우선 | 주소 틀린 지연 메일 → 단계 failed "받는 사람 주소가 올바르지 않습니다.", run failed, 대기 동작 0, 뒤 단계(할 일 "should not run") 실행 안 됨. `http://127.0.0.1/admin` 지연 웹훅 → 단계 failed "차단된 주소입니다: 사설·루프백…", 대기 동작 0, fetch 0 | `out-d-state.json`, `out-e-state.json` |

하네스 전체에서 fetch는 정확히 1번 — 동기식 승인 후 Resend 호출뿐 (지연 경로 fetch 0).

만료 응답: `{"sweep":{"failed":0,"cancelled":0},"rows":[{"id":"wfpa_new_0","status":"queued",…},{"id":"wfpa_old_0","status":"expired","created_at":"2026-11-12T16:20:19.597Z","decided_at":"2026-11-20T16:20:19.647Z"}]}`

## 라이브 (`p1-live-smoke/`)

- 0042 원격 적용 → 배포 `fc2ed076-ac4b-41ff-831b-4d5dfc790750` (바인딩 표의 D1 id `36113f26…`는 wrangler 4의 표시 오류, 실제는 `5dff997a…` — AGENTS.md 기록과 같음). `AGENT_RUNTIME=think` 유지.

스모크: 배포 전(`a685a42f`) 스냅숏 → 배포 → 3분 대기 → 배포 후. 

| 대상 | 배포 전 | 배포 후 | 본문 |
|---|---|---|---|
| `GET /` | 200, 139,478 B | 200, 139,478 B | `cmp` 동일 (UI 변경 없음) |
| `GET /api/workflows/runs/<없는 id>` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/workflows/templates` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/auth/me` | 401, 52 B | 401, 52 B | 같음 |
| `GET /api/agents/me` | 401, 52 B | 401, 52 B | 같음 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 1,182 B | 200, 1,182 B | `cmp` 동일 |

의도한 변화(`pendingActions`)는 로그인한 소유자의 run 상세에서만 보인다. 라이브에서는 로그인 계정이 없어 확인하지 않았고, 로컬 하네스가 같은 운영 라우트로 확인했다(`"pendingActions":1`). 0042 테이블은 원격 `sqlite_master`에서 확인.

## 남은 문제

1. 로컬 dev 서버(포트 8812)는 세션에서 `kill`이 승인 대기로 막혔지만, 백그라운드 시간 한도로 종료됐다. `ss -ltnp`로 확인한 결과 남은 프로세스(workerd 고아 포함)는 없다 — 정리할 것 없음.
2. 라이브에서 지연 run을 실제로 돌려 보지는 않았다 (로그인 계정이 필요하고, P1에는 UI·결정 API가 없어 쌓인 행을 처리할 길이 없다 — 라이브에 시험 행만 남는다). 엔진 경로는 로컬 하네스가 운영 코드로 확인했다.
3. 15분 크론의 만료 UPDATE는 라이브에서 확인하지 않았다 (현재 라이브에 `queued` 행이 없어 바뀔 것도 없다). 크론 분기 코드(`index.ts`)는 그대로이고, 새 UPDATE는 try/catch 안이라 실패해도 기존 청소 결과를 해치지 않는다.

## P2에 넘길 것

- **승인·거절·실행 경로**: `GET /api/workflows/pending-actions`, `POST …/pending-actions/decide`, `workflow-action` 큐 메시지 + 소비자. 실행은 `executeNode(type, {…ctx, approved:true}, JSON.parse(args_json))`처럼 **이미 치환된 args**로 해야 한다 (resolveVars를 다시 돌려도 `{{`가 없어 무해하지만, stepOutputs 없이 돌리므로 치환을 기대하면 안 된다).
- **상태 전이는 조건부 UPDATE로**: `queued→approved→executing→executed|failed`, `queued→rejected`, `queued→expired`. 만료는 `status='queued'`만 건드리므로, 결정 API도 `WHERE status='queued'`로 경합을 막으면 된다.
- **승인함 응답에서 웹훅 헤더 값은 가린다** (`args_json.headers` — 공유 경로 `redactShared`와 같은 원칙). 실행에는 원본 값을 쓴다.
- **agent 지연**: id 접미 `_t<turn>`은 `pendingActionId(runId, stepIndex, turn)`에 자리만 있다. agent 경로에서 `deferActions`를 켜는 것과 `validateDefinition`의 agent 허용은 P2.
- 실행 시점 재검증: 승인까지 최대 7일 — 승인 시 `send_email`·`webhook` 노드가 검증·SSRF 검사를 다시 하므로(같은 노드 함수) 추가 작업은 없다.
- P3 UI: 거절 화면에 "이 동작 뒤에 이미 실행된 단계" 표시 (거절은 뒤 단계를 되돌리지 않음 — 설계상 한계).

## 커밋에서 뺄 파일

- `files/workflow-verify/async-approval/p1-harness/state/` (로컬 D1·KV 상태)
- `files/workflow-verify/async-approval/p1-harness/dev.log`
- `files/workflow-verify/async-approval/p1-harness/.wrangler/` (생겼으면)
- (이 세션 전부터 있던 미추적 파일: `files/workflow-verify/think-full/dryrun-*`, `prompt-v5-draft.json`, `t3-live-smoke/tail-cron-1430.jsonl`, `async-approval-p1-prompt.md` — 이번 세션과 무관)

커밋할 것: `migrations/0042_…sql`, `src/workflow/{types,nodes,engine,routes}.ts`, `p1-harness/{harness.ts,wrangler.toml,*.json(정의·out-*)}`, `p1-live-smoke/*`, 이 파일.
