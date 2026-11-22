# 비동기 승인 + 시뮬레이션 P3 결과 (2026-11-21, Opus 5.5 단일 세션)

범위: 설계 §3.1 항목 6 — 승인함 UI(대기 동작) + run 상세 표시 + 단계 편집기 승인 방식. **API·엔진·에이전트·큐 소비자·마이그레이션은 건드리지 않았다.** 바꾼 파일은 `public/workflow.js`, `public/workflow.css` 둘뿐이다.

## 판정

| # | 통과 기준 | 판정 | 근거 |
|---|---|---|---|
| 1 | `npx tsc --noEmit` 0 + `node --check public/workflow.js` 0 | 통과 | 둘 다 출력 없음 (`NODE_OK`, `TSC_OK`). 하네스가 서빙한 `workflow.js`도 `node --check` 통과 + 원본과 `cmp` 동일 |
| 2 | API 수준 검증 (UI 호출 순서) | 통과 | 아래 "하네스 증거" 1~8. 목록·응답 JSON에 `p2-secret-token` 0회, 269자 본문의 꼬리 표식 0회 |
| 3 | 라이브 배포 + 스모크 | 통과 (기존 8개 응답 `cmp` 동일, 홈 HTML `cmp` 동일. 바뀐 것은 `workflow.js`·`workflow.css` 본문뿐 — 배포본이 로컬 소스와 `cmp` 동일) | 버전 **`81505638-2845-4636-8b39-c9556c58f194`** (이전 `720700f8`) |
| 4 | 결과 파일 | 이 파일 | |
| — | 브라우저 클릭 검증 | **Merlin 몫** (11-24) | 세션에 브라우저·로그인 계정 없음. 아래 "11-24에 넘길 것" |

## 구현한 것 (`public/workflow.js`, 추가 위주 — 기존 줄 변경 3곳)

### 1. "대기 동작" 섹션 (`#wfActions`, 기존 `#wfPending` 바로 아래)
- `wfPaLoad()`가 `GET /api/workflows/pending-actions?status=queued&limit=100`(기본 필터 queued)을 부른다. `workflowOpen`에서 `wfLoadPending()` 다음에 호출.
- 행: 노드 타입 배지(메일 발송·웹훅 호출) · 상태 배지 · (turn이 있으면) "에이전트" 배지 · 요약(메일 `받는 사람: … · 제목: …` / 웹훅 `METHOD URL`, API `args` 그대로) · 워크플로우 이름·run id(본인 행은 링크 → `wfSelect(workflow_id, run_id)`로 run 상세) · 만든 시각. 실패 행은 `error`.
- 체크박스(본인 + queued 행만) · **전체 선택** · **일괄 승인 / 일괄 거절**(선택 수 표시) · 새로고침. 승인 전 `confirm()`: "승인하면 메일이 실제로 발송되고 웹훅이 실제로 호출됩니다. 되돌릴 수 없습니다." (거절도 확인창 — 뒤 단계는 되돌려지지 않는다는 문구 포함). 50개씩 나눠 `POST /pending-actions/decide`.
- 행별 code 처리: 200은 선택 해제, 404 → "대기 동작을 찾을 수 없습니다 (본인 동작이 아니거나 없는 동작).", 409 → API `error`("이미 결정된 동작입니다 (executed).") 를 그 행 아래에 표시. 목록에서 사라진 행(409로 상태가 바뀐 행 등)의 사유는 상단 메시지(`wfMsg`)에 함께 적는다.
- 결정 뒤 즉시 재조회 + **승인이면 4초 뒤 1회 더**. `approved`·`executing` 행이 있으면 3초 간격 재조회, 전부 최종 상태면 멈춤. **폴링 상한 40회(2분)** — `executing`에 stuck된 행 때문에 무한 폴링하지 않게 했다(사용자 새로고침·필터 변경·결정 시 상한 초기화).
- 기본 필터가 queued라 결정한 행은 목록에서 바로 빠진다 → 이번 화면에서 결정한 행은 "방금 결정한 동작" 소제목 아래 계속 보여준다(전체 목록을 한 번 더 불러 id로 고름). approved → executed/failed 변화를 볼 수 있다.
- 상태 필터: 승인 대기·승인됨(실행 대기)·**실행 중(확인 필요)**(`executing`)·실행됨·거절됨·실패·만료·전체.
- **hr_admin**: 응답에 `owner_id`가 있고 `currentUser.id`와 다르면 체크박스·run 링크를 숨기고 "소유자 <id> (본인만 결정할 수 있습니다)"를 보여준다.
- 빈 목록 "대기 중인 동작이 없습니다."(queued) / "조건에 맞는 동작이 없습니다."(그 외). 불러오기 실패는 `wfFail`(401이면 "로그인이 필요합니다").
- `workflowLeave()`에서 섹션 타이머(폴링·4초)를 정리한다.

### 2. run 상세
- `wfOpenRun`이 `j.pendingActions`를 `wfRunPending`에 담는다. 0보다 크면 상단에 **"대기 동작 N개"** 배지(버튼) → `wfPaShowRun(runId)`: 그 run의 queued만 `run_id=` 필터로 보여 주고 섹션으로 스크롤("실행 필터 해제" 버튼).
- 타임라인: 단계 출력에 `simulated: true`면 상태 배지 옆에 **"승인 대기"** 배지(툴팁: 시뮬레이션 단계, 대기 동작에서 승인해야 실행). 출력 요약은 그대로.
- run이 `succeeded`이고 `pendingActions > 0`이면 대기 동작 섹션도 새로고침. 섹션에서 결정한 행이 열린 run 것이면 run 상세를 다시 불러 배지를 갱신.

### 3. 행 펼치기("상세")
- 공통: 메일 본문 미리보기(`bodyPreview`, `bodyLength`자 중 앞부분) / 웹훅 헤더 **이름만**("값은 표시하지 않습니다")·본문 미리보기, 시뮬레이션 출력 요약, 결정·실행 시각, 실행 결과.
- queued(본인): "이 동작을 만든 실행 상세로 이동" 버튼.
- rejected: "이 동작을 거절해도 뒤에 이미 실행된 단계는 되돌려지지 않습니다." + `GET /api/workflows/runs/:runId`에서 `step_index > 동작의 step_index && status === 'succeeded'` 단계의 이름·타입·종료 시각. 남의 행이면 "다른 사용자의 실행이라 단계 목록을 볼 수 없습니다."(run 상세가 소유자 전용).
- executing: "실행을 시작했지만 결과가 기록되지 않았습니다. … 받는 쪽에서 확인하세요. 다시 실행하지 않습니다."

### 4. 단계 편집기 "승인 방식"
- `send_email`·`webhook`·`agent` 편집기에 select `동기식 (실행 중 멈추고 승인 대기)`(기본, `approvalMode` 없음) / `지연 (대기열에 쌓고 실행은 계속)`(`approvalMode: "deferred"`). 지연 선택 시 안내 문구(뒤 단계 참조 불가, GET 웹훅 불가 / agent는 고른 메일·웹훅에만 적용).
- 클라이언트 사전 확인: GET 웹훅 + 지연, `requiresApproval:true` agent + 지연 → 편집기 오류.
- 저장 400: 기존처럼 `wfMsg`에 쓰고, 메시지에 `steps[N]`이 있으면 **그 단계 편집기를 열어 오류 칸에 서버 메시지를 그대로** 보여준다.
- 단계 목록에 "지연 승인" 배지.
- 부수 변경 1: 편집 완료(`done()`)가 단계를 새로 만들 때 approval 노드가 아닌 단계(agent 등)의 기존 `requiresApproval` 값을 보존한다. 이전에는 JSON으로 준 agent의 `requiresApproval:true`가 폼 편집 한 번에 사라졌다(승인 범위가 조용히 줄어드는 문제) — 지연 검사에 필요해서 함께 고쳤다.
- 템플릿 정의는 바꾸지 않았다.

### 그대로 둔 것
`wfLoadPending()`(동기식 알림 박스), `wfDecide()`·`waiting_approval` 승인/거절 버튼, 인트로 문구 "메일 발송 단계는 실행 중 사람의 승인을 거칩니다.", `public/approval.js`·`chat.js`·`meet.*`, `src/*` 전부. 원본 대비 `diff`: 추가 블록 + 변경 3줄(단계 목록 배지 줄, `wfSave` catch, run 상세 헤더 줄). 원본 사본: `p3-harness/workflow.before.js`.

### CSS (`public/workflow.css` 끝에 `.wf-pa*` 22줄)
기존 토큰(`--color-*`, `--space-*`, `--radius-sm`)만 사용.

## 하네스 증거 (`p3-harness/`)

방식: P2 하네스(`harness.ts`) 사본 — 운영 `workflowApp`·운영 큐 소비자(`processWorkflowStep`·`processWorkflowAction`)를 그대로 마운트, 외부 fetch는 가로채 기록만. `wrangler dev --local` 포트 8814, `state/`, 로컬 D1 0001~0042 `migrations apply --local` 전부 ✅. `[assets] directory = public` 을 더해 화면이 받는 `workflow.js`를 그대로 내려받았다. 사용자: A(`u_p3a`), B(`u_p3b`), hr_admin(`u_p3adm`). 워크플로우 `wf-p3-two.json`: 지연 메일(step 0) → 지연 웹훅(step 1, `Authorization: Bearer p2-secret-token`) → 할 일(step 2). run A·B·C·D (D는 본문 269자).

UI가 부르는 순서대로:

| # | 호출 (화면 동작) | 결과 | 증거 |
|---|---|---|---|
| 1 | `GET /pending-actions?status=queued&limit=100` (섹션 열기) | 200, 6행. 렌더링에 쓰는 필드 전부 있음: `id, run_id, workflow_id, workflow_name, step_index, turn(null), node_type, args{to,subject,bodyPreview,bodyLength / method,url,headerKeys,bodyPreview}, simulated_output, status, result, error, created_at, decided_at, executed_at`. `p2-secret-token`·`Bearer` 0회 | `out-1-list-queued.json` |
| 1b | `?run_id=<D>&status=queued` (배지 클릭 필터) | D의 2행만. `bodyLength 269`, 본문 꼬리 표식 `P3-BODY-TAIL-MARKER` 0회(200자에서 잘림) | `out-1b-list-runD.json` |
| 2 | `GET /runs/<A>` (run 상세) | run `succeeded`, step 0·1 출력 `simulated:true`(→ "승인 대기" 배지), step 2 succeeded, `pendingActions: 2`(→ "대기 동작 2개") | `out-2-runA-before.json` |
| 3a | decide 승인 1건 (A 메일) | HTTP 200 `[{code:200,status:"approved"}]` | `out-3a-approve-one.json` |
| 3b | 재조회 | A 메일 `executed`, `result {providerId:"re_fake_1"}` (로컬 큐가 빨라 첫 재조회에서 이미 최종) | `out-3b-list-after-approve.json` |
| 3c | decide 거절 1건 (A 웹훅) | `[{code:200,status:"rejected"}]` | `out-3c-reject-one.json` |
| 3d | `GET /runs/<A>` (거절 행 펼치기) | `pendingActions: 0`(배지 사라짐). step_index > 1 && succeeded = "후속 할 일"(create_task, 종료 16:54:02Z) → "이미 실행된 단계"에 이것이 나온다 | `out-3d-runA-after.json` |
| 4a | 일괄 승인 2건 (B 메일+웹훅) | 둘 다 code 200 → 최종 `executed` (메일 `re_fake_2`, 웹훅 `{status:200, ok:true}`) | `out-4a-batch-approve.json`, `out-6a-list-all-final.json` |
| 4b | 일괄 거절 2건 (D) | 둘 다 code 200 `rejected` | `out-4b-batch-reject.json` |
| 4c | 혼합 일괄 승인 (C 메일 · 실행된 A 메일 · 없는 id) | HTTP 200, 행별 `200 approved` / `409 "이미 결정된 동작입니다 (executed)."` / `404 not_found` — 화면의 행별 code 분기 그대로 | `out-4c-mixed.json` |
| 5a | B가 A의 동작 결정 | `404 not_found` | `out-5a-userB-decide.json` |
| 5b | B 목록 | `{"actions":[]}` | `out-5b-userB-list.json` |
| 5c | hr_admin 목록 | A의 행 + `owner_id:"u_p3a"`(≠ admin id → 화면이 체크박스 숨김·소유자 표시), 시험 토큰 0회 | `out-5c-admin-list.json` |
| 5d | hr_admin이 A의 동작 결정 | `404 not_found` | `out-5d-admin-decide.json` |
| 6 | 최종 전체 목록 + fetch 기록 | 실행됨 4(A메일·B메일·B웹훅·C메일), 거절 3(A웹훅·D 2건), queued 1(C웹훅). 외부 호출 정확히 4회(Resend 3 + 웹훅 1), 거절 3건은 호출 0. `?status=executing` → `[]`. 익명 목록 401 | `out-6a-list-all-final.json`, `out-6b-fetches.json` |
| 7 | 저장 400 (GET 웹훅 + 지연) | `400 "steps[1]: GET 웹훅은 지연 승인할 수 없습니다 …"` — 화면의 `/steps\[(\d+)\]/`가 2번째 단계 편집기를 연다 | `rej-get-webhook.json`, `out-7-rej-get-webhook.json` |
| 8 | 편집기가 만드는 정의 모양 저장 | agent 지연(requiresApproval 없음)·메일 지연·웹훅 동기식·PUT 웹훅 지연 → 201, `approvalMode` 왕복 유지 | `wf-ui-shape.json`, `out-8-ui-shape.json` |

정적 확인: 하네스가 서빙한 `served-workflow.js` `node --check` 통과·원본과 동일. `workflow.js`에서 호출하는 `wf*(`/`wfc*(` 함수 전부가 `workflow.js`·`workflow-canvas.js`·`index.html` 안에 `function`으로 정의돼 있음(grep 대조, 누락 0). 새 함수 17개 모두 정의 1회 + 호출 1회 이상. 새 `$('…')` id(`wfActions`, `wfPaAll`, `wfPaApproveBtn`, `wfPaRejectBtn`, `wff__approvalMode`, `wfStepErr`)는 모두 같은 파일에서 생성. `innerHTML` 사용 0(전부 textContent). (`static-check.mjs`는 `node <스크립트>` 실행이 승인 대기로 막혀 돌리지 못했다 — 같은 확인을 grep으로 했다.)

## 라이브 (`p3-live-smoke/`)

배포 `81505638-2845-4636-8b39-c9556c58f194` (`cf-wrangler.py deploy --config <절대 경로>`, 승인 막힘 없음. `AGENT_RUNTIME=think` 유지). 배포 전 스냅숏 → 배포 → 3분 대기 → 배포 후. D1 마이그레이션 없음.

| 대상 | 배포 전 (`720700f8`) | 배포 후 (`81505638`) | 본문 |
|---|---|---|---|
| `GET /` | 200, 139,478 B | 200, 139,478 B | `cmp` 동일 (index.html 무변경 — 섹션은 workflow.js가 만든다) |
| `GET /workflow.js` | 200, 52,373 B | 200, 72,774 B | 의도한 변화. 배포 전 = 원본 사본, 배포 후 = `public/workflow.js`와 `cmp` 동일 |
| `GET /workflow.css` | 200, 6,241 B | 200, 7,912 B | 의도한 변화 (`.wf-pa*`). 배포 후 = 소스와 `cmp` 동일 |
| `GET /api/workflows/pending-actions?status=queued&limit=100` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `POST /api/workflows/pending-actions/decide` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/workflows/runs/<없는 id>` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/workflows/templates` (익명) | 401, 41 B | 401, 41 B | `cmp` 동일 |
| `GET /api/auth/me` | 401, 52 B | 401, 52 B | `cmp` 동일 |
| `GET /api/agents/me` | 401, 52 B | 401, 52 B | `cmp` 동일 |
| `GET /api/obs/workflow-runs` (X-Admin-Secret) | 200, 1,182 B | 200, 1,182 B | `cmp` 동일 |

로그인 사용자의 화면 동작은 라이브에서 확인하지 않았다(로그인 계정 없음 — P1·P2와 같은 사정). 같은 API를 로컬 하네스가 화면 호출 순서로 확인했다.

## 남은 문제

1. **브라우저 렌더링·클릭은 확인하지 않았다** (브라우저·로그인 계정 없음). DOM 조립은 기존 `wfEl` 패턴만 써서 정적 오류 위험은 낮지만, 배치·줄바꿈·확인창 문구는 11-24에 눈으로 볼 것.
2. "승인 대기" 배지는 run 단계 출력의 `simulated:true`만 본다 — 대기 동작이 이미 승인·실행된 뒤에도 run 상세 타임라인 배지는 "승인 대기"로 남는다(단계 출력은 시뮬레이션 그대로라서). 실제 상태는 "대기 동작 N개"(queued 수, 0이면 사라짐)와 대기 동작 섹션에서 본다. 필요하면 배지 문구를 "시뮬레이션"으로 바꾸거나 run별 동작 상태를 합칠 것.
3. "방금 결정한 동작"은 필터가 queued 등일 때 전체 목록(limit 100)을 한 번 더 부른다. 동작이 100개를 넘으면 오래된 결정 행은 안 보일 수 있다(표시만의 문제).
4. `executing` stuck 정리 스윕은 여전히 없다(화면에 "실행 중(확인 필요)" + 안내만). 폴링은 2분 상한.
5. 거절 행의 "이미 실행된 단계"는 프롬프트대로 `step_index` 비교다. 조건 분기(`next`)로 순서가 배열 순서와 다른 워크플로우에서는 정확하지 않을 수 있다.
6. 로컬 dev 서버는 TaskStop으로 종료했고 포트 8814가 비어 있는 것을 확인했다.

## 11-24 회귀 검증에 넘길 것

- 로그인해서 **승인함 클릭 확인**: 워크플로우 화면 "대기 동작" 섹션 → 체크박스·전체 선택·일괄 승인/거절 → 실제 메일 발송·웹훅 호출 확인, run 상세 시뮬레이션 배지("승인 대기")·"대기 동작 N개" 배지(클릭 → run 필터), 거절 행 "상세"의 "이미 실행된 단계" 표시, hr_admin으로 남의 행 결정 버튼·체크박스 숨김. 편집기 "승인 방식" 선택 → 저장 → run → 대기 동작에 쌓이는지, GET 웹훅 지연 저장 시 편집기에 400 메시지.
- **실제 모델(Qwen)의 지연 모드 문장 확인** (P2 남은 문제 1): 지연 agent run을 로그인 상태에서 돌려 최종 답에 "보냈습니다"가 없는지. 원격 시험 Worker나 로그인 run으로. 이제 편집기에서 agent 단계를 "지연"으로 고를 수 있다.
- legacy agent 시스템 프롬프트에 지연 규칙이 없는 것(P2 남은 문제 2) — 실제 모델이 관찰만 보고도 "보냈습니다"라고 쓰는지 함께 본다.
- `executing`에 stuck된 행의 정리 스윕(아직 없음) — 필요하면 11-24에 판단.

## 커밋에서 뺄 파일

- `files/workflow-verify/async-approval/p3-harness/state/`, `p3-harness/dev.log`, `p3-harness/.wrangler/`(생겼으면), `p3-harness/served-workflow.js`(public/workflow.js와 동일 사본)
- 이 세션 전부터 있던 미추적 파일(`files/workflow-verify/think-full/dryrun-*`, `prompt-v5-draft.json`, `t3-live-smoke/tail-cron-1430.jsonl`, `async-approval-p3-prompt.md`, `muse-assistant-plan*.md`) — 이번 세션과 무관

커밋할 것: `public/workflow.js`, `public/workflow.css`, `p3-harness/{harness.ts,wrangler.toml,static-check.mjs,workflow.before.js,wf-*.json,rej-*.json,out-*.json}`, `p3-live-smoke/*`, 이 파일.
