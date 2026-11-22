# 비동기 승인 + 시뮬레이션 P3 프롬프트 (Opus 5.5 단일 세션)

## 배경

P1·P2가 끝났다. P1: `workflow_pending_actions` 테이블(0042), 노드 시뮬레이션, 엔진 지연 경로. P2: 에이전트 경로 지연(legacy+Think), 결정 API(`GET /api/workflows/pending-actions`, `POST /api/workflows/pending-actions/decide`), 큐 소비자(`workflow-action`). **P3 범위 = 설계 원본(`think-cloudflare-os-adoption-plan.md` §3.1) 항목 6: 승인함 UI + run 상세 표시.** API·엔진·에이전트는 건드리지 않는다.

## 먼저 읽을 것

- `files/workflow-verify/async-approval/P2-RESULT.md`의 "P3에 넘길 것" (API 응답 모양·행 필드·hr_admin 규칙) — **API 응답 모양이 그 문서와 다르면 실제 코드를 따른다.**
- `public/workflow.js` (923행) — 워크플로우 화면 전체. 아래 "현재 UI 사실"을 읽고 확인할 것.
- `files/workflow-verify/async-approval/P1-RESULT.md` (run 상세 `pendingActions` 개수, 거절 화면 인계).

## 현재 UI 사실 (검증됨 — 읽고 확인할 것)

- `wfLoadPending()` (`public/workflow.js:198`): `#wfPending` 박스에 `GET /api/approval/notifications?unread=1`에서 `type === 'WORKFLOW_APPROVAL'`인 알림을 "승인 대기 (N)"으로 보여주고, 각 행에 "열기" 버튼(해당 run 상세로 이동). **이것은 동기식 승인(`waiting_approval` run)용이다. 그대로 둔다.**
- `wfOpenRun(runId)` (`:856`): `GET /api/workflows/runs/:id`로 run 상세를 불러온다. `queued`·`running`이면 3초마다 다시 불러온다. `waiting_approval`·`succeeded`·`failed`이면 `wfLoadPending()`을 부른다. **P1이 응답 최상위에 `pendingActions`(queued 수)를 더했다** — `j.pendingActions`로 읽는다.
- `wfRenderRunDetail()` (`:883`): run 상태 배지·에러·`waiting_approval`일 때 승인/거절 버튼(`wfDecide`)·단계 타임라인(단계 이름·타입 배지·상태 배지·소요·출력 요약 `wfOutSummary`·에러)을 보여준다.
- `wfDecide(action)` (`:909`): `POST /api/workflows/runs/:id/approve|reject`를 부르고 run 상세를 다시 불러온다.
- 단계 편집기 (`:650` 부근): `def.approval`인 단계에는 "이 단계는 실행 중 승인이 필요합니다."라는 안내가 뜬다.
- `WF_RUN_KO` (`:27`): run 상태 한글 라벨. `WF_STEP_KO`도 있다(파일 안에서 찾을 것).
- **`public/approval.js`는 전자결재(결재함) UI이다. P3에서 건드리지 않는다.** 대기 동작 승인함은 워크플로우 화면(`public/workflow.js`)에 만든다.

## P3 범위 (이것만 한다)

### 1. 승인함 "대기 동작" 묶음 (워크플로우 화면)

- 기존 "승인 대기"(알림 박스) 옆에 **"대기 동작" 섹션**을 만든다. `GET /api/workflows/pending-actions?status=queued&limit=100`을 불러온다(기본은 `queued`만 — 승인 대기 중인 것).
  - 각 행: 노드 타입 배지(`send_email`·`webhook`), 요약(메일: 받는 사람·제목 / 웹훅: 메서드·URL — API가 주는 `args` 요약 그대로 쓴다. **헤더 값·메일 본문 전문은 API가 안 주니 화면에도 안 나온다**), 워크플로우 이름·run id(클릭하면 해당 run 상세로 이동), 만든 시각, 상태 배지.
  - 각 행에 체크박스. **전체 선택** 체크박스 + **일괄 승인 / 일괄 거절** 버튼. `POST /api/workflows/pending-actions/decide` `{ ids, action }`를 부른다. 승인 전 `confirm()`으로 확인한다(승인하면 실제로 메일이 나가거나 웹훅이 호출된다는 뜻을 적는다).
  - 결정 API는 HTTP 200 + 행별 `{ id, status, code }`이다. 행별 code가 404·409인 행은 목록에 에러 문구를 보여주고 나머지는 갱신한다. 결정 뒤 목록을 다시 불러온다. 승인된 행은 상태가 `approved`로 보이다가 수 초 안에 `executed`·`failed`가 되므로, **결정 뒤 4초 뒤에 목록을 한 번 더 불러온다.** `approved`·`executing`인 행이 있으면 3초 간격으로 목록을 다시 불러온다(전부 최종 상태가 되면 멈춘다).
  - **hr_admin 규칙**: 남의 행은 볼 수 있지만 결정할 수 없다(API가 404를 돌려준다). 남의 행에는 체크박스·결정 버튼을 숨기고 소유자를 보여준다. 본인 행만 결정할 수 있다.
  - 상태 필터(`queued`·`approved`·`executing`·`executed`·`rejected`·`failed`·`expired`·전체)를 둔다. `executing`인 행은 **"실행 중(확인 필요)"** 으로 보여준다(P2 남은 문제 3 — 실행 뒤 기록 실패로 `executing`에 stuck될 수 있다. P3에서는 스윕을 만들지 않고 화면에만 이렇게 표시한다).
  - 빈 목록이면 "대기 중인 동작이 없습니다."를 보여준다. 목록 불러오기 실패(401 등)는 기존 `wfFail` 패턴으로 처리한다.

### 2. run 상세: 시뮬레이션된 단계 표시 + 대기 동작 수

- `wfRenderRunDetail()` 타임라인에서 **단계 출력에 `simulated: true`가 있으면 "승인 대기" 배지**를 단다(기존 상태 배지 옆). 출력 요약에는 시뮬레이션 출력이 그대로 보인다.
- run 상세 상단에 `pendingActions`가 0보다 크면 **"대기 동작 N개" 배지**를 보여준다(P1이 준 `j.pendingActions`). 클릭하면 "대기 동작" 섹션으로 이동한다(또는 해당 run의 대기 동작만 필터한 목록을 보여준다 — `?run_id=` 필터가 있다).
- `wfOpenRun`의 폴링: run이 `succeeded`인데 `pendingActions > 0`이면 대기 동작 섹션도 함께 새로고침한다.

### 3. 거절 화면: "이 동작 뒤에 이미 실행된 단계" (P1 인계)

- 거절된(`rejected`) 대기 동작 행을 펼치면(또는 "상세" 버튼) **그 동작 뒤에 이미 실행된 단계**를 보여준다. run 상세(`GET /api/workflows/runs/:runId`)에서 `step_index`가 그 동작의 `step_index`보다 크고 상태가 `succeeded`인 단계를 골라 이름·타입·종료 시각을 보여준다. 문구: "이 동작을 거절해도 뒤에 이미 실행된 단계는 되돌려지지 않습니다." (설계상 한계 — 되돌림을 구현하지 않는다.)
- `queued`인 행을 펼치면 run 상세로 가는 링크와 시뮬레이션 출력 요약을 보여준다.

### 4. 단계 편집기: 승인 방식 선택 (지연 모드를 UI에서 쓸 수 있게)

- `send_email`·`webhook`·`agent` 단계의 편집기에 **"승인 방식" 선택**을 둔다: `동기식(실행 중 멈추고 승인 대기)`(기본값, `approvalMode` 없음) / `지연(대기열에 쌓고 run은 계속)`(`approvalMode: "deferred"`). 선택값은 단계 정의에 `approvalMode`로 저장한다.
- 저장 시 400 에러(뒤 단계 출력 참조·GET 웹훅·`requiresApproval:true`+지연 agent 등)가 오면 그 메시지를 편집기에 그대로 보여준다.
- 템플릿 정의는 바꾸지 않는다. (템플릿별 지연 적용 — 회의 자동화·주간 보고의 메일 발송과 agent 단계 — 은 P3 범위 밖이다. 템플릿은 지금처럼 동기식으로 남는다.)

## 건드리지 말 것

- **API·엔진·에이전트·큐 소비자 일절**: `src/workflow/*`, `src/index.ts`, 마이그레이션. P3는 `public/workflow.js`(필요하면 워크플로우 CSS — 파일이 있는지 확인하고, 없으면 `styles.css`의 기존 클래스를 쓴다)만 바꾼다.
- **`public/approval.js`(결재함)·`public/chat.js`·`public/meet.*`·`src/meet/*`·`src/chat/*`**: 건드리지 않는다.
- **동기식 승인 UI**: `wfLoadPending()`의 알림 박스, run 상세의 `waiting_approval` 승인/거절 버튼(`wfDecide`)은 그대로 둔다.
- **기존 문구**: 인트로의 "메일 발송 단계는 실행 중 사람의 승인을 거칩니다."는 지연이 선택 사항이라 여전히 맞다 — 바꾸지 않는다.

## 통과 기준

1. `npx tsc --noEmit` 오류 0 + `node --check public/workflow.js` 오류 0.
2. **API 수준 검증** (브라우저가 없어 클릭 검증은 Merlin이 로그인 후 한다 — 세션은 아래까지만 한다):
   - 화면이 부르는 API를 같은 순서로 확인한다: `GET /api/workflows/pending-actions?status=queued` → 목록 렌더링에 쓰는 필드가 전부 있는지, `POST /decide` (승인 1건·거절 1건·일괄 2건) → 행별 code 처리, `GET /api/workflows/runs/:id` → `pendingActions` 표시·시뮬레이션 배지·거절 뒤 단계 목록.
   - 로컬 하네스(새 폴더 `files/workflow-verify/async-approval/p3-harness/`, `wrangler dev --local` + 로컬 D1 0001~0042): P2 하네스의 운영 라우트를 재사용해 지연 동작 2건(메일+웹훅)을 만들고, UI가 부르는 것과 같은 API 호출 순서로 목록·결정·재조회가 되는지 확인한다. **실제 브라우저 렌더링은 하지 않는다** — 대신 `workflow.js`를 로컬로 받아 `node --check` + 새 함수들이 정의·호출되는지 정적 확인(없는 함수 참조가 없는지)한다.
   - `GET /api/workflows/pending-actions` 응답에 웹훅 헤더 값·메일 본문 전문이 안 나오는지 확인한다(목록 JSON에 `p2-secret-token` 같은 시험 값이 없는지).
3. 라이브 배포 + 스모크: 배포 전후 기존 엔드포인트 응답이 의도한 변화 외에는 같아야 한다. 홈 HTML은 의도한 추가(대기 동작 섹션 관련 스크립트 — workflow.js는 기존 파일이라 본문 크기가 바뀌는 것은 의도한 변화) 외에는 같아야 한다. 배포 직후 약 2분은 옛 버전이 응답하니 스모크는 3분 뒤에 한다.
4. 결과 파일 `files/workflow-verify/async-approval/P3-RESULT.md` 작성: 판정 표, 구현한 것, 검증 항목별 증거(브라우저 클릭 검증은 Merlin 몫이라고 적는다), 라이브 버전·스모크 결과, 남은 문제, 11-24 회귀 검증에 넘길 것(아래).

## 11-24 회귀 검증에 넘길 것 (P3-RESULT.md에 적는다)

- 로그인해서 **승인함 클릭 확인**: 워크플로우 화면 "대기 동작" 섹션 → 체크박스·전체 선택·일괄 승인/거절 → 실제 메일 발송·웹훅 호출 확인, run 상세 시뮬레이션 배지·"대기 동작 N개" 배지, 거절 행의 "이미 실행된 단계" 표시, 남의 행 결정 버튼 숨김(hr_admin).
- **실제 모델(Qwen)의 지연 모드 문장 확인** (P2 남은 문제 1): 지연 agent run을 로그인 상태에서 돌려 최종 답에 "보냈습니다"가 없는지 확인한다. 원격 시험 Worker나 로그인 run으로.
- legacy agent 시스템 프롬프트에 지연 규칙이 없는 것(P2 남은 문제 2) — 실제 모델이 관찰만 보고도 "보냈습니다"라고 쓰는지와 함께 본다.
- `executing`에 stuck된 행의 정리 스윕(아직 없음) — 필요하면 11-24에 판단한다.

## 작업 방식·주의사항 (검증된 교훈 — 반드시 지킬 것)

- **커밋·태그는 하지 않는다.** Merlin이 직접 한다. `git add`도 세션에서 막히니 시도하지 않는다.
- **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 **절대 경로로 직접 실행**한다 (python3 경유·env 접두어 금지). "This command requires approval"로 막히면 우회하지 말고 Merlin에게 보고하고 멈춘다. P2 세션 보고: `cd <dir> && cf-wrangler.py ...`가 승인 대기로 막히면 `--config <절대 경로>`를 넘겨 cd 없이 실행한다. 배포는 직렬로만 한다.
- **로컬 검증**: `npx wrangler dev --local`은 `--local`이 `dev` 바로 뒤에 와야 한다. 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/..."`로 한 URL씩. 셸 반복문(`for`/`until`)/포그라운드 `sleep`은 승인 대기로 막히니, 긴 대기는 `sleep N`을 백그라운드로 돌리고 깨어난 뒤 curl 1회로 확인한다. 셸 변수·`tee`·`sort`·`diff` 파이프는 막히니 값을 명령에 직접 쓴다. 예외: `S=$(cat <비밀 파일>); curl -H "x-admin-secret: $S" <URL>` 한 개는 된다.
- **비밀**: `X-Admin-Secret` 값은 `~/workspace/user` 안의 비밀 파일에서 읽는다 (`--add-dir /home/hatch/workspace/user`를 함께 줬다). 값을 채팅·파일·커밋에 적지 않는다.
- **건드리지 말 파일**: `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`. `src/index.ts`의 V1+V2 3곳·15분 크론·큐 소비자는 건드리지 않는다 (P3에서 `src/index.ts` 변경은 없다).
- **tail JSON은 들여쓰기가 있다**: `"outcome": "ok"`처럼 콜론 뒤에 공백이 있다.
- 결과 파일에 커밋에서 뺄 파일 목록(하네스 state·dev.log·dry-run 산출물)을 적어 둔다.
