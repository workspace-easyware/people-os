# 워크플로우·에이전트 빌더 FULL — 진행 기록

> 코디네이터 작업 기록. 사용자 지시 (2026-11-18 02:16): 전 단계 full로 한 번에 진행. 토큰 많다.
> 계획: `workflow-agent-builder-FULL-PLAN.md` / 제안서: `workflow-agent-builder-proposal.md` (수정 금지)

## 상태 요약

- **현재 세션**: **DO-1c 그룹채팅 백엔드 완료** (Sonnet, 새 하네스 71/71 + 회귀 DO-1a 41/41·DO-1b 77/77, tsc 통과, 0030 새로 안 만듦·미배포). **DO-1d 그룹채팅 UI 진행 중** (Sonnet, 백그라운드 `proc_1038352418b6`). 프롬프트 `do-1d-group-chat-ui-prompt.md` 신규 작성. **다음: DO-1d 완료 확인 → DO-2 알림 푸시 → DO-3 레이트 리미터 → DO-MIG 배포 + 라이브 검증 → DO-VERIFY**
- **라이브 버전**: `b11b6a5c-c1e7-4ad7-9905-a91866481787` (D-3b, 마이그레이션 0027·0028·0029 적용됨)
- **라이브 버전**: `2db1528c-af9d-488d-aecb-c5a51d934177` (D-3, 마이그레이션 0027·0028·0029 적용됨)
- **추가 범위 (2026-11-18 02:27 지시)**: DO 3건(코칭 채팅·알림 푸시·정밀 레이트 리미터)은 워크플로우 빌더 완료(WF-12) 후 순차 편입. 계획서 `durable-objects-use-cases-plan.md` 참조. FULL-PLAN §5에 세션 목록(DO-1a~DO-VERIFY) 추가 완료. 마이그레이션 태그 결정: v2=[WorkflowAgent](WF-6), v3=[ChatRoom, NotificationHub, RateLimiter](DO-MIG) — 4개 한 태그가 아니라 나눈 이유와 부모 확인 요청은 FULL-PLAN §5에 기록.
- **범위 확장 (2026-11-18 09:06, 사용자 승인 "응, 둘 다 넣어줘")**: Phase 4 채팅(DO-1)이 코칭 1:1만이 아니라 **직원↔직원 1:1 + 그룹채팅**까지 커버한다. 같은 ChatRoom DO 아키텍처. 그룹 추가분은 DO-1c(백엔드: D1 멤버십·추가/제거·미읽음) + DO-1d(UI) 2개 세션으로 추가. Phase 4 합계 약 4~6세션 → **약 6~8세션**. 순서 변동 없음 (WF-12 뒤). 상세는 아래 "Phase 4 범위 확장" 섹션 + DO 계획서 D1절 + FULL-PLAN §5 참조.

## 세션 기록

### WF-0 계획 수립 (코디네이터, 2026-11-18)
- 완료. `workflow-agent-builder-FULL-PLAN.md` 작성.
- 결정 사항: 정의 D1 JSON(v1 선형→v2 간선), 실행 PIPELINE 큐 재사용(`workflow-step`), 에이전트 상태 WorkflowAgent DO(+D1 폴백), 승인 게이트 notifications 재사용, 캔버스 SVG 자체 제작(무빌드), 스케줄 크론 `*/15 * * * *` + scheduled() 3방향 명시 분기, transcribe 노드 v1 단순화(이미 전사 완료된 것만 동기 처리).
- 마이그레이션: 0027(코어) / 0028(스케줄) / 0029(공유).

### WF-1 데이터 모델 + CRUD API + 공용 타입 (Sonnet, 완료 2026-11-18)
- 프롬프트: `wf-full-1-datamodel-prompt.md`
- 산출: `migrations/0027_workflows.sql`, `src/workflow/{types,store,routes}.ts`, index.ts 마운트 1줄(1799행), `files/workflow-verify/wf1/RESULT.md` (검증 산출물은 `files/people-os/files/workflow-verify/wf1/`에 있음)
- 검증: tsc 통과(코디네이터 재확인 완료), 로컬 마이그레이션 0001~0027 적용 + 재실행 무에러, curl 시나리오 34건 전부 통과(401×4, 400×6, 201, 404 격리×6, 413×2, 연쇄 삭제). 정직한 미검증: definition 단독 256KB 분기, `resolveVars` 단위 실행(tsc만).
- **참고**: 백그라운드 exec이 SIGTERM으로 죽었으나(런타임 재시작 추정) 작업물은 전부 디스크에 남았고 RESULT.md까지 작성됨. 세션 재실행 없이 파일·tsc로 완료를 확인하고 WF-2로 진행.

### WF-2 노드 레지스트리 12개 (Sonnet, 완료 2026-11-18)
- 프롬프트: `wf-full-2-nodes-prompt.md`
- 산출: `src/workflow/nodes.ts` (512행), `types.ts`에 `NodeContext.approved?` 추가, 검증 산출물은 goal 루트 `files/workflow-verify/wf2/RESULT.md` + `results.json` (WF-1과 위치가 다름. 이후 세션은 goal 루트 `files/workflow-verify/wf<N>/`로 통일)
- 검증: **77/77 통과** (로컬 D1 0001~0027·R2·KV, AI·Vectorize·fetch는 mock). 격리 확인(D1 폴백 경로), send_email 승인 전 fetch 0회, transcribe 미완료 실패 문구, create_task/calendar/draft_pptx owner=실행자.
- 미검증: 실제 Workers AI 응답 품질·JSON 파싱률, Vectorize 경로(코드 읽기만), 실제 Resend 발송, PPTX PowerPoint 열기, 배포·원격 D1.
- **WF-3이 알아둘 것**: `summarizeDocument`·`buildDeck`·리플렉션 프롬프트가 `nodes.ts`에 **복제**됨 (index.ts 미수정 때문 — index.ts가 바뀌면 맞춰야 한다. 나중에 공용 모듈 추출 권장). `dueDate`는 tasks 기한 열이 없어 제목 뒤 `(기한 YYYY-MM-DD)`로 붙인다. `llm`은 프롬프트 12,000자·출력 20,000자로만 자른다. `{{steps.s1.x}}`와 `{{steps.s1.output.x}}` 둘 다 풀린다. `resolveVars`는 ASCII 경로만. `reflect_*`는 reflections 행 저장(session_id=`wf_<runId>_<stepIndex>`). `send_email`은 검증이 승인 게이트보다 먼저. `summarize`는 공용 문서에 hr_admin만.

### WF-3 실행 엔진 (Opus, 완료 2026-11-18)
- 프롬프트: `wf-full-3-engine-prompt.md`
- 산출: `src/workflow/engine.ts` (20,520B), `src/workflow/approvals.ts`, routes.ts 배선(첫 단계 enqueue + 속도 제한), index.ts 최소 변경(QueueMessage 유니온 + queue() 분기 1921행 + scheduled() sweep 1900행), 검증 산출물 goal 루트 `files/workflow-verify/wf3/`
- 검증: 성공 체인(출력 전달)·실패 시 run failed·멱등성(중복 전달에도 task 1개)·재시도(엔진 오류만)·승인 멈춤/재개/취소·캡(31분 경과 실패, LLM 30회 상한)·속도 제한(동시 4개·하루 21회 429, KV 오류 시 fail-open)·sweep(평가 크론 분기에서 동작)·기존 메시지 회귀(transcript-pipeline 실제 1건 done까지).
- **명세와 달라진 점 (세션 판단, RESULT.md 기록)**: 30분 제한은 run 시작과 마지막 승인 중 늦은 쪽부터 잰다 (승인 대기 시간이 예산을 먹지 않게). 멈춘 단계는 `pending`으로 되돌린다 (승인 메시지가 다시 집을 수 있게). 승인은 멈춘 단계에만 유효. 단계 자체 실패(잘못된 입력)는 재시도 없이 run failed — 엔진 오류(DB/큐)만 큐 재시도. 일일 경계는 KST. 노드가 자체적으로 멈춘 경우에도 알림을 만든다.
- 미검증: 실제 Cloudflare 큐(배치·재시도 횟수·DLQ·동시 소비자 경합), 실제 Workers AI/Resend, 실제 크론 트리거. 배포·원격 D1 없음.
- **WF-4가 이어받을 것**: `resumeWorkflowRun`/`cancelWorkflowRun`은 `src/workflow/engine.ts`에 있고 **소유권 검사를 안 한다** — WF-4 API가 먼저 `getRun(db, user.id, runId)`로 소유권을 확인할 것. 알림 link는 `/#workflow/<workflowId>?run=<runId>` (WF-5 UI가 이 해시를 처리해야 한다). 알림 조회는 `ref_type='workflow_run'` + `ref_id=<runId>`.
- **AGENTS.md 추가**: `migrations apply * --local` 허용 규칙은 `--local`이 마지막 인자일 때만 매칭된다 (WF-3 세션 제보).

### WF-4 승인 게이트 (Sonnet, 완료 2026-11-18)
- 프롬프트: `wf-full-4-approval-prompt.md`
- 산출: `src/workflow/routes.ts`에 `POST /runs/:runId/approve`·`/reject` 추가 (+ `decide` 공용 함수), 검증 산출물 goal 루트 `files/workflow-verify/wf4/`
- 검증: **28/28, 2회 연속**. 승인 경로(waiting_approval → succeeded, task 1개, mock 메일 1통, 알림 읽음), 거절 경로(cancelled, 대기 단계 skipped, task/메일 없음), 타인 404, 잘못된 상태 409, 이중 승인 409, 익명 401, 대기 목록(기존 알림 API에서 보임, 처리 후 unread=1에서 사라짐), 승인 중 큐 전송 실패 시 409 + run을 waiting_approval로 복구 + 알림 미읽음 유지.
- 대기 목록 방식: 새로 만들지 않음. 기존 `GET /api/approval/notifications?unread=1`에서 `type==='WORKFLOW_APPROVAL'`만 필터. 단, 응답에 `body`가 없고 워크플로우명·단계명이 `title` 문자열에 섞여 있다. 구조화된 목록이 필요하면 `GET /api/workflows/approvals/pending`을 따로 추가해야 한다.
- 미검증: 실제 Queues/AI/Resend(mock), 배포·원격 D1, 승인·거절 동시 호출 경합(엔진 조건부 UPDATE가 막는 구조, 순차 이중 승인만 확인), 알림 읽음 처리가 엔진 호출 뒤 별도 쿼리라 실패 시 run은 전환되고 알림이 미읽음으로 남을 수 있음, `read_at`이 `datetime('now')`라 다른 경로의 ISO 형식과 다름(읽음 판정에는 영향 없음).
- **WF-5가 이어받을 것**: 승인 `POST /api/workflows/runs/:runId/approve`, 거절 `POST /api/workflows/runs/:runId/reject` (빈 본문 + 세션 쿠키, 401/404/409 처리). 대기 목록은 `GET /api/approval/notifications?unread=1` 필터. run 상세 `GET /api/workflows/runs/:runId`. 알림 link `/#workflow/<workflowId>?run=<runId>` 해시 지원 필수.

### WF-5 폼 빌더 UI (Sonnet, 완료 2026-11-18)
- 프롬프트: `wf-full-5-builder-ui-prompt.md`
- 산출: `public/workflow.{js,css}`, index.html 배선 8곳 중 7곳(홈 카드는 WF-11로 보류). 검증 산출물 goal 루트 `files/workflow-verify/wf5/RESULT.md`.
- 검증: node --check·tsc 통과, 로컬 dev 왕복(워크플로우 생성→실행→승인 대기→승인, 단 승인 뒤 run이 `failed` — 하네스에 Resend mock이 없어 실제 외부 호출이 샌드박스에서 실패한 것. 승인 경로 자체는 WF-4에서 28/28 검증됨). 미검증: 브라우저 시각 확인.

### WF-6 에이전트 루프 (Opus, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-6-agent-prompt.md`
- 산출: `src/workflow/agent-do.ts`(WorkflowAgent DO), `src/workflow/agent.ts`(advanceAgentTurn), engine.ts(agent 분기 + `agentHooks`), types.ts(`agent` 노드·검증·`agentTurn`), nodes.ts(`executeNode("agent")` 예외, `extractJson` export), approvals.ts(알림 id에 턴), index.ts(DO export 1줄 + Env 1줄), wrangler.toml(WORKFLOW_AGENT 바인딩 + **migrations v2**), workflow.js(agent 폼 3필드). 검증 산출물 goal 루트 `files/workflow-verify/wf6/`.
- 검증: tsc 통과, Miniflare DO 하네스 **52/52 ×2** — 루프 종료, max_steps, repeat_tool, 파싱 실패 3연속 failed, 승인 게이트(멈춤·승인 후 같은 행동 실행·다음 send_email 재승인), DO 직렬화(동시 advance → 1턴), 재전달 멱등(모든 메시지 2번 → 도구 1번), timeout·llm_cap, 격리, 회귀(llm→create_task, 일반 send_email, transcript-pipeline).
- **명세와 다른 점 (코디네이터 확인 요망)**: (1) 승인은 pending 행동 1개에만 유효 — 명세대로 `approved`를 다음 턴에 넘기면 같은 agent 단계의 이후 send_email이 승인 없이 발송된다. (2) 승인 알림 id에 턴 번호(`_t<n>`) — 기존 id로는 두 번째 승인 알림이 INSERT OR IGNORE로 안 생긴다. (3) `requiresApproval:true` agent = 모든 도구 승인. (4) DO timeout과 엔진 30분 캡이 같은 임계값이라 실제로는 엔진이 먼저 run을 failed로 만든다 — "멈춤=성공"을 원하면 DO 쪽을 당길 것.
- 스키마 변경 없음 (D1 폴백 불필요). WF-2 복제 부채 미변경.
- 미검증: 실제 Qwen3 JSON 파싱률·품질, 원격 DO(v2), 실제 Queues/Resend, 브라우저 화면.
- **D-2가 할 것**: v2 태그가 포함된 wrangler.toml로 배포(DO 마이그레이션 자동 적용) → 라이브에서 목표만 준 agent 워크플로우 1개(create_task 위주) + send_email 포함 1개로 승인 멈춤 확인. 실제 모델의 형식 오류율을 보고 프롬프트 조정 여부 판단.

### WF-7 조건 분기 + 정의 v2 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-7-branching-prompt.md`
- 산출: types.ts(`condition`·`StepNext`·사이클/없는 단계 검증·`resolveNextStep`, `TOOL_NODE_TYPES`에서 condition 제외), nodes.ts(`conditionNode` — 6개 연산자), engine.ts(간선 추적, agent 단계도 동일 경로), workflow.js(condition 폼 3필드 + 단계 편집 시 `next` 보존). 검증 산출물 goal 루트 `files/workflow-verify/wf7/`.
- 검증: tsc·node --check 통과, Miniflare 하네스 **59/59** — true/false 양쪽 경로(안 탄 가지 단계 행 없음), 6개 연산자 양쪽, v1 선형 호환, 사이클·없는 단계·한쪽만 있는 next 400, agent 뒤 condition 분기, 승인 게이트·agent 루프 회귀, 큐 중복 전달 멱등.
- **설계 메모**: 정의는 DAG(사이클 금지) — 각 단계는 run당 최대 1번이라 WF-3 claim이 그대로 맞는다. `version`은 1 유지, `next` 없는 단계는 배열 다음 단계로 읽는다 (스키마 변경 없음). `stepOutputsBefore`를 "현재 단계를 뺀 모든 succeeded 단계"로 바꿨다 (간선이 배열 앞쪽으로 점프할 수 있어서). `run.current_step` = 마지막으로 실행한 단계 인덱스.
- **명세와 다른 점 (코디네이터 확인 — 받아들임)**: `next`가 없는 `condition`을 허용했다 (분기 없이 배열 순서로 진행). 폼 빌더는 `next`를 만들 수 없어 엄격하게 하면 condition 워크플로우가 저장되지 않는다. `next`가 있는데 형태가 틀리면 400. 엄격하게 하려면 `validateDefinition` 한 줄이면 된다.
- **알려진 한계 (WF-10에서 해결)**: (1) 배열 중간에서 경로를 끝낼 수단이 없다 — 분기한 두 경로가 따로 끝나려면 마지막에 합류하는 단계가 필요하다. "여기서 종료" 표식(`next: null` 등)을 WF-10 캔버스 때 추가한다. (2) 폼에서 단계를 삭제하면 그 단계를 가리키던 `next` 때문에 저장이 400이 된다 — 캔버스에서 삭제 시 간선 정리(또는 경고)를 넣는다.
- 미검증: 실제 Workers AI 응답 품질, 배포·원격 D1, 브라우저 화면, 간선 편집 UI(WF-10).
- **D-2가 할 것**: WF-6 agent와 함께 라이브에서 condition 분기 워크플로우 1개(true/false 양쪽) 확인.

### WF-8 스케줄 + 이벤트 트리거 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-8-triggers-prompt.md`
- 산출: `migrations/0028_workflow_schedules.sql`, `src/workflow/schedules.ts`(크론 매처·KST 변환·`runDueSchedules`·`runEventTriggers`), routes.ts(스케줄 생성·목록·토글·삭제 API), wrangler.toml(크론 `*/15 * * * *` 추가), index.ts(`scheduled()` 3방향 명시 분기 EVAL→WORKFLOW→다이제스트 + 전사 완료 지점에 `runEventTriggers` 호출·try/catch). 검증 산출물 goal 루트 `files/workflow-verify/wf8/`.
- 검증: tsc 통과, Miniflare 하네스 **56/56** — 크론 분기 회귀(0 18→평가만, 0 22→다이제스트만, */15→스케줄만, 다이제스트 15분마다 돎 없음), 슬롯 내림(09:07 틱→09:00 실행, 09:16 틱→미실행), KST 변환(UTC 금 15:30 = KST 토 00:30), 중복 방지(`last_run_at` 가드), 속도 제한 시 skipped, 워크플로우 삭제 시 스케줄 CASCADE, 전사 `done`일 때만 이벤트 run 생성 + 트리거 실패해도 전사 `done` 유지, API 왕복·잘못된 cron 400·`transcript_completed` 외 event 400·타인 404, 회귀(일반 실행·승인·agent·condition·전사 파이프라인).
- **코디네이터 확인 사항 (세션 제보, 판단함)**:
  - 워크플로우당 스케줄 상한 10개 — 받아들임 (명세에 없던 값이나 남용 방지용으로 합리적).
  - **`draft`/`paused` 워크플로우도 스케줄이 돌았다 — 코디네이터가 직접 수정함** (세션 종료 후, `schedules.ts` 두 쿼리에 `AND w.status = 'active'` 추가, tsc 재확인 통과). 일시정지한 워크플로우가 스케줄로 도는 것은 사용자 의도에 반하므로, D-2 배포 전에 고쳤다. 수동 실행은 draft도 가능하다 (D-1 E2E에서 확인 — 테스트용 실행은 허용).
  - 분이 15의 배수가 아닌 cron(예: `7 9 * * *`)은 15분 틱에 영영 맞지 않는다 — v1 한계로 받아들임. **WF-11 스케줄 UI에서 분 입력 시 0/15/30/45만 허용하거나 경고 문구를 넣는다.**
- 미검증: 실제 Cloudflare 크론 전달, 배포·원격 D1, 브라우저 화면, 스케줄 UI(WF-11).
- **D-2가 할 것**: 원격 D1에 0028 적용(`d1_migrations` 기록 확인) + v2 DO 마이그레이션 포함 배포 → 라이브에서 스케줄 run 생성 1건 + agent run + condition 분기 확인.

## 배포 이력

### D-1 Phase 1 배포 (코디네이터, 2026-11-18)
- **버전: `4664a02e-e620-48f0-a4d6-c9ad01c268f2`** (배포 완료). 원격 D1에 0027 적용 확인 (d1_migrations 기록 + workflows/workflow_runs/workflow_run_steps 3개 테이블 존재).
- 기본 라이브 확인 통과: `/api/health` 200, 홈 200, `workflow.js` 200, `workflow.css` 200, 익명 `/api/workflows` 401, workers.dev health 200.
- **라이브 E2E 완료 (2026-11-18 07:57 KST, 코디네이터 직접 수행 — 사용자 승인 후 재시도)**:
  - 테스트 사용자 `wftest@peopleos.site`(id `b5635d6b-…`) 생성 → 비밀번호 설정 → 로그인(쿠키 저장). 전부 workers.dev 경유라 승인 카드 없이 진행됨.
  - **워크플로우 E2E 통과**: `llm → create_task` 워크플로우(`wf_mwlae72d_p02mla`) 실행 → run `wfrun_mwlaea2g_qd9cwv` **succeeded**(17초). Qwen3 실제 응답 + `{{steps.s1.output.text}}` 변수 치환으로 할 일(`task_mwlaen4l_efh0kw`) 생성 확인.
  - **승인 E2E 통과**: `send_email` 워크플로우(`wf_mwlaf8t6_vzmavk`) 실행 → run `wfrun_mwlafbpe_xoebxc` **waiting_approval**(메일 미발송 확인) + `WORKFLOW_APPROVAL` 알림 생성(link `/#workflow/…?run=…`) → 승인 → **succeeded**, Resend providerId `01a1ebb6-…` 확인. 메일은 `hr.jhkang@peopleos.site`로 실제 발송됨(제목 `[테스트] 워크플로우 승인 E2E`).
  - **데모 회귀 전부 통과**: 홈 200, HR RAG ask 200(grounded=true, 암묵지 문서 `doc_mweyu70u_477s8v` 인용, sessionVia durable-objects), 라이브러리 200, 메일함 200(빈 목록, 주소 `wftest@peopleos.site`), 캘린더 200(빈 목록).
  - **정리 완료**: 워크플로우 2개·할 일 1개 API로 삭제, 테스트 사용자 + 세션 D1에서 삭제(`files/workflow-verify/d1-e2e-cleanup.sql`, changes 4, d1q.py로 사용자·세션 0건 확인), 쿠키 파일 삭제. 알림·ask_events 흔적 1건씩은 삭제된 사용자 키로 남아 조회되지 않음.
  - **교훈**: (1) 라이브 E2E는 **workers.dev 경유**로 할 것 — `curl *peopleos.site*`는 settings.json 허용 규칙에 없어 승인 카드가 뜨고, 사용자가 자는 동안 10분 타임아웃됐다. workers.dev는 같은 Worker·같은 D1이라 검증 효력이 같다. (2) `cf-wrangler.py`가 npx `ENOTEMPTY`로 실패하면 `~/.npm/_npx/<해시>/` stale 캐시를 `rm -rf`하고 재시도할 것 (2026-11-18 발생, 재시도 2회 실패 후 캐시 삭제→성공).

### WF-6b 에이전트 JSON 파싱 수정 (Sonnet, 완료 2026-11-17, 미배포)
- **원인**: D-2 라이브에서 도구를 고르는 에이전트 run이 전부 failed. Qwen3가 `"action"`에 도구 이름(`"create_task"`)을 썼고 `parseDecision`은 `"tool"`/`"finish"`만 받았다. 프롬프트의 형식 설명이 모호했다. WF-6 하네스는 스크립트 응답만 써서 못 잡았다.
- **수정** (`src/workflow/agent-do.ts` 한 파일): ① `action`이 허용 도구 이름이면 도구 호출로 수용(`tool` 필드 우선, 없거나 무효면 action 값). 허용 밖 이름은 기존 오류. ② `SYSTEM_PROMPT`에 "action에는 tool/finish만, 도구 이름은 tool 필드" + 전체 JSON 예시 2개. ③ `extractJson`은 변경 안 함(필요 없었음).
- **검증**: `tsc` 통과. WF-6 하네스 재실행 **65/65**(기존 52 + 신규 `parseDecision` 13, 실제 실패 출력 회귀 테스트 포함). 상세는 `files/workflow-verify/wf6b/RESULT.md`.
- **D-2b에서 할 일**: 배포 → 같은 목표로 에이전트 워크플로우 라이브 재실행 → succeeded + 할 일 생성 확인, 여러 번 돌려 Qwen3 준수율 관찰 → 정리. (실제 모델 준수율·원격 DO는 미검증.)

### WF-9 공유/템플릿 + 웹훅 노드 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-9-sharing-webhook-prompt.md` (코디네이터 신규 작성)
- 산출: `migrations/0029_workflow_sharing.sql`, `src/workflow/sharing.ts`(신규), routes.ts(공유·복사·템플릿 API), store.ts(`getWorkflowById`, `is_template`), types.ts(`webhook` 노드 타입·`APPROVAL_REQUIRED_NODES`에 webhook 추가·에이전트 기본 도구에서 webhook 제외), nodes.ts(`webhookNode`·`checkWebhookUrl`), engine.ts·agent.ts(승인 알림 요약 webhook 분기 — 헤더 값 제외), `public/workflow.{js,css}`(웹훅 폼·공유 섹션·공유받은 목록·복사 버튼). 검증 산출물 goal 루트 `files/workflow-verify/wf9/`.
- 검증: tsc 통과(코디네이터 재확인), `node --check public/workflow.js` 통과, Miniflare 하네스 **89/89** — 공유 격리(타인 404·view/copy 구분·복사본 소유자·비공개), 부서 범위(같은 부서만·NULL 부서 불가·이동 즉시 반영), 템플릿(hr_admin만 지정·일반 사용자 403·복사본 is_template=0), 공유 관리(upsert·CASCADE), SSRF 차단(명세 8개 + 추가 28개 URL 전부 fetch 0회 차단, 공인 주소 통과), 웹훅 승인(미승인 fetch 0·승인 후 1회·거절 fetch 0), 타임아웃·상한(10초·256KB·Content-Length 차단·4xx는 성공 출력), 회귀 wf6 65/65·wf7 59/59.
- **명세와 다른 점 (코디네이터 확인 — 받아들임)**: (1) Content-Length 차단은 fetch 뒤 본문 읽기 전에 한다 (헤더는 fetch 후에야 알 수 있음). (2) 점 없는 단일 라벨 호스트(`http://intranet/`)도 차단 — 추가 보수 규칙. (3) GET·DELETE에 body가 있으면 실행 시점 failed. (4) 본문이 있으면 content-type은 application/json으로 강제. (5) **hr_admin 템플릿 지정 UI 토글 없음** — API(`PATCH is_template`)로만 가능. WF-11 다듬기에서 넣을지 검토.
- **알려진 한계**: DNS 리바인딩 차단 불가 (Workers 런타임은 fetch 전 DNS 조회 불가 — 리터럴 IP·예약 호스트명만 차단). `redirect: "manual"`로 3xx 우회 차단. 실제 외부 웹훅 호출은 로컬 mock만 — D-3에서 httpbin으로 라이브 확인.
- **wf8 하네스 4건 실패 — 원인 확인 및 코디네이터 수정**: wf8 하네스(`mkWf`)가 워크플로우를 draft로 만드는데, 코디네이터의 `status='active'` 수정(23:27, WF-8 이후) 때문에 스케줄 틱 테스트가 run 0개로 실패했다. WF-9 코드 원인이 아니다. **코디네이터가 하네스를 수정함** (`mkWf` 뒤에 `UPDATE workflows SET status='active'` 추가) → 재실행 **56/56 통과**. 스케줄 틱 WF-9 이후 코드 재검증 완료.
- **D-3이 할 것**: 원격 D1에 0029 적용(`d1_migrations` 기록) + 배포 → 라이브에서 공유(all+copy)·복사·템플릿(hr_admin 테스트 계정)·웹훅(httpbin 실제 호출 + SSRF 차단) 확인 + 데모 회귀.

### WF-10 비주얼 캔버스 (Opus, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-10-canvas-prompt.md` (코디네이터 신규 작성)
- 산출: `public/workflow-canvas.{js,css}`(신규), `public/workflow.js`(폼/캔버스 전환·간선 정리·단계 카드 라벨), `public/index.html`(배선 2곳), `src/workflow/types.ts`(`StepNext`에 `null` 허용·`resolveNextStep`에서 `null`→end), `src/workflow/engine.ts`(종료 처리, 그 외 동작 변경 없음). 검증 산출물 goal 루트 `files/workflow-verify/wf10/`(RESULT.md는 코디네이터가 하네스 출력으로 재구성 — 아래 참고).
- 검증: tsc 통과(코디네이터 재확인), `node --check` 통과, Miniflare 하네스 **41/41** — `next: null` 종료(일반·condition 양쪽·둘 다 null, 실행 시 뒤 단계 미실행), 삭제 정리(일반 `next` 삭제·condition 한쪽 `null`·폴백 순환 시 `null`로 전환), 정의 JSON 왕복(폼↔캔버스 간선 일치·위치 필드 없음·v1 호환), 자동 배치·간선 삭제·사이클 거부. 회귀 wf6 65/65·wf7 59/59·wf9 89/89.
- **WF-7 한계 2건 해결됨**: (1) 배열 중간 종료 — `next: null` 표식. (2) 삭제 시 dangling `next` — 공용 `wfCleanupEdgesAfterDelete`로 폼·캔버스 둘 다 정리 + 알림 1줄.
- **세션 중단 2회**: 1차 시도 시작 109초 만에 SIGTERM(작업물 0건) → 재실행, 2차 시도 13.5분 만에 SIGTERM(런타임 재시작 추정). 2차 시도에서 구현·하네스까지 전부 디스크에 남아 있었고(41/41 통과), RESULT.md만 없어서 **코디네이터가 `results.json`·회귀 파일·코드로 재구성함**. 미검증: 브라우저 드래그 손맛·SVG 렌더링(순수 로직만 검증), 배포·원격 D1.
- **D-3b가 할 것**: WF-10 + WF-11 묶어 배포 → 라이브에서 캔버스 간선 편집·종료 표식 실행 + 데모 회귀.

### WF-11 관측 + 홈 카드 + 다듬기 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `wf-full-11-observability-prompt.md` (코디네이터 신규 작성)
- 산출: `src/obs/routes-workflows.ts`(신규, `GET /api/obs/workflow-runs` + `/:runId`, hr_admin 전용 읽기 전용), `src/index.ts`(workflowRunsApp을 tracesApp보다 먼저 마운트 — tracesApp의 `use("*")` 가드가 경로를 가로채지 않게), `public/obs/workflows.js`(신규, 관측 "워크플로우" 탭 — 목록 + 단계 타임라인 막대), `public/index.html`(관측 하위 탭·홈 "내 워크플로우" 카드), `public/workflow.js`(홈 카드·스케줄 섹션·hr_admin 템플릿 토글·문구 정리), `src/workflow/agent-do.ts`(`AGENT_TIMEOUT_MS` 30→28분), `src/workflow/nodes.ts`(create_task 설명에 dueDate 선택 사항 명시), routes.ts·types.ts·engine.ts(에러 문구 한국어 정리). 검증 산출물 goal 루트 `files/workflow-verify/wf11/`.
- 검증: tsc 통과(코디네이터 재확인), `node --check` 통과, API 하네스 **38/38** (익명 401·일반 사용자 403·hr_admin 200, LLM 호출 수 = LLM 노드 수 + agent turns, agent run LLM 호출 3 = turns 3), 화면 로직 하네스 **47/47** (가짜 DOM으로 실제 `public/*.js` 실행 — 홈 카드 위치·버튼·승인 대기 배지·fail-soft, 스케줄 UI 왕복·분 7 경고, 템플릿 토글 가시성). 회귀 wf10 41/41·wf9 89/89·wf8 56/56·wf7 59/59·wf6 65/65.
- **명세와 다른 점 (코디네이터 확인 — 받아들임)**: (1) 분 `*`(매 분)는 경고하지 않는다 (모든 슬롯에서 맞으므로). (2) wf6 회귀는 복사본으로 돌렸다 (create_task 설명 검사 정규식 1곳만 새 설명으로 갱신 — 원본 `wf6/worker.ts`는 안 건드림). (3) wf10 하네스 첫 실행의 "잔여 0" 실패 1건은 WF-10 UI 세션이 남긴 로컬 scratch 데이터 때문 — 무관, 행 삭제 후 재실행 41/41. (4) `ui.cjs`·`ui-worker.ts`·`ui-wrangler.toml`은 안 돌린 초안 — 같은 검증을 `ui-run.ts`로 옮겨 실행함 (`results-ui.json`이 근거).
- **알려진 한계**: 브라우저 화면 시각 확인 없음 (가짜 DOM으로 로직만 확인, 레이아웃·색·막대 모양 미확인). 실제 28분 타임아웃은 주입값으로만 확인. 관측 목록 LIMIT 200 — run이 매우 많을 때 성능 미측정. 남은 영어 문구: `nodes.ts`의 `"no json object in ai response"`·`"empty ai summary"`는 WF-2 복제 부채(`index.ts` 복제본)에 있어 이번에 못 고침 — 복제 부채 정리 때 함께 한국어로 바꿀 것.
- **하네스 서버 정리 완료**: 세션이 남긴 wrangler dev 서버(8816~8820·8830~8832)는 시간 제한으로 전부 종료됨을 코디네이터가 `ss`로 확인.
- **D-3b가 할 것**: WF-10 + WF-11 묶어 배포(마이그레이션 없음, 코드만) → 라이브에서 캔버스·관측 탭·홈 카드·스케줄 UI 확인 + 데모 회귀.

### DO-1a 실시간 채팅 DO + API (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-1a-chat-room-prompt.md` (코디네이터 신규 작성)
- 산출: `src/chat/room.ts`(신규, ChatRoom DO — 메시지 최근 200개·members 테이블·Hibernation), `src/chat/routes.ts`(신규, `POST/GET /dm/:userId/messages`·`GET /dm/:userId/ws`), `src/index.ts`(ChatRoom export·Env·`/api/chat` 마운트), `wrangler.toml`(CHAT_ROOM 바인딩만 — v3 태그 없음, 배포 금지 구간 준수). 검증 산출물 goal 루트 `files/workflow-verify/do1a/`.
- 검증: tsc 통과(코디네이터 재확인), Miniflare 하네스 **41/41** — 송수신(양쪽 WebSocket 도착)·히스토리(오프라인 메시지·50개·before 페이징·200개 상한)·격리(익명 401·자기 자신 400·없는 사용자 404·빈/4001자 400)·회귀(로그인·워크플로우 실행). 하네스 서버(8817) 종료 확인.
- **명세와 다른 점 (코디네이터 확인 — 받아들임)**: 제3자 C의 404를 라우트에서 직접 막지 않았다 — 방 키가 `(나, 상대)` 정렬이라 C는 A-B 방 주소를 만들 수 없어서 격리가 구조적으로 된다 (C가 `/dm/A`를 부르면 C↔A 방이 열릴 뿐). DO의 members 방어선(요청자가 members에 없으면 DO가 404)은 직접 호출로 확인됨. 공백만 있는 본문은 400으로 처리.
- **DO-1b로 넘기는 것**: WebSocket 업그레이드의 Origin 검사는 POST에만 있음 — DO-1b에서 업그레이드 요청에도 넣을 것.
- **미검증**: 실제 Cloudflare WebSocket·휴면 후 재개, 원격 DO·배포(v3 미적용이라 지금 deploy는 실패가 정상), 브라우저 화면, 그룹 방(DO-1c), 방 목록(DO-1b).

### DO-1b 채팅 UI + 배선 (1:1) + 방 목록 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-1b-chat-ui-prompt.md` (코디네이터 신규 작성)
- 산출: `public/chat.{js,css}`(신규), `public/index.html`(채팅 메뉴 — 코칭 리플렉션 다음, 코칭 대상에게도 보임), `migrations/0030_chat_rooms.sql`(신규 — DO-1c와 공유), `src/chat/routes.ts`(방 목록 API·전송 시 D1 upsert·WS Origin 검사), `src/approval/routes.ts`(`/users` SELECT에 `coaching_role` 1컬럼 추가). 검증 산출물 goal 루트 `files/workflow-verify/do1b/`.
- 검증: tsc 통과(코디네이터 재확인), `node --check public/chat.js` 통과, 로컬 하네스 **77/77** (방 목록 API·메시지 왕복·WebSocket 실시간·화면 로직 가짜 DOM) + DO-1a 회귀 **41/41**. 하네스 dev 서버 종료 확인.
- **명세와 다른 점 (코디네이터 확인 — 받아들임)**: (1) `/api/approval/users`는 이름·이메일만 검색하고 부서는 검색하지 않는다 (프롬프트의 "부서 검색"이 실제와 달랐음). (2) 그룹 행은 목록에 이름만 보이고 열리지는 않는다 (DO-1c·DO-1d에서 연다).
- **DO-1c로 넘기는 것 (중요)**: `chat_rooms.updated_at`의 컬럼 기본값은 SQLite `datetime('now')` 형식("YYYY-MM-DD HH:MM:SS")인데 앱은 ISO8601로 쓴다 — 형식이 섞이면 목록 정렬이 틀어진다. **DO-1c는 그룹 행을 만들·갱신할 때 `updated_at`을 ISO 형식으로 명시할 것.**

### DO-1c 그룹채팅 백엔드 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-1c-group-chat-prompt.md` (코디네이터 신규 작성)
- 산출: `src/chat/routes.ts`(그룹 생성·멤버 조회/추가/제거·그룹 메시지/히스토리/WS·`POST /rooms/:roomId/read`, `GET /rooms` 그룹 행에 `unread`), `src/chat/room.ts`(소켓에 `user_id` 부착·`sync-members` 후 비멤버 소켓 닫기). 0030 마이그레이션 새로 안 만듦 (DO-1b 파일 그대로). 검증 산출물 goal 루트 `files/workflow-verify/do1c/`.
- 검증: tsc 통과(코디네이터 재확인), 새 하네스 **71/71** + 회귀 DO-1a 41/41·DO-1b 77/77. `updated_at` ISO 명시 확인 (`toISOString` 사용).
- **세션 판단 (코디네이터 확인 — 받아들임)**: (1) 보낸 사람의 `last_read_seq`는 자기 메시지 seq까지 자동 상승 (안 그러면 내 글이 내 미읽음으로 세어짐). (2) 읽음 확인은 방 최신 seq보다 큰 값을 최신으로 제한. (3) D1 멤버인데 DO가 404면 멤버 재동기화 후 1회 재시도. (4) hr_admin은 비멤버여도 멤버 추가·제거만 가능 (목록·메시지·WS는 멤버만). (5) 생성자를 hr_admin이 내보낼 때도 `transfer_to` 요구.
- **DO-MIG 라이브 검증 때 확인할 것**: 방 목록이 최대 200행이고 그룹 행마다 DO를 한 번씩 부른다 — 방이 많은 사용자의 목록 지연을 라이브에서 측정할 것.
- **미검증**: 실제 Cloudflare WebSocket·휴면 후 동작, 원격 DO(v3 미적용)·원격 D1(0030 미적용), 그룹 UI·읽음 확인 호출 지점(DO-1d).

### DO-1d 그룹채팅 UI (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-1d-group-chat-ui-prompt.md` (코디네이터 신규 작성)
- 산출: `public/chat.js` 확장 (그룹 만들기 폼·그룹 대화창·멤버 목록/추가/제거·미읽음 배지·읽음 확인 디바운스). 백엔드(`src/**`)·`wrangler.toml` 변경 없음. 검증 산출물 goal 루트 `files/workflow-verify/do1d/` (수정 전 백업 `chat.do1b.orig.js`는 코디네이터가 삭제함).
- 검증: `node --check`·tsc 통과(코디네이터 재확인), 화면 로직 하네스 **64/64** (가짜 DOM·가짜 WebSocket·mock API로 실제 `chat.js` 실행) + 회귀 DO-1b 77/77·DO-1c 71/71·DO-1a 41/41. `chat.js`에 `innerHTML` 사용 없음 (textContent만).
- **미검증**: 브라우저 시각 확인·모바일 전환·한글 입력(IME) 실기기 동작, 실제 Cloudflare WebSocket, 원격 DO(v3)·D1(0030) 미적용, 실제 백엔드와 새 `chat.js`를 잇는 end-to-end (UI는 mock API로만 검증) — DO-MIG 라이브 확인 필요.
- **채팅(DO-1a~DO-1d) 완료**: 1:1(코칭·직원) + 그룹채팅, 멤버십 D1, 미읽음, 멤버 관리까지 로컬 검증 완료. 남은 것은 DO-MIG 배포 + 라이브 검증.

### DO-2 실시간 알림 푸시 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-2-notification-push-prompt.md` (코디네이터 신규 작성)
- 산출: `src/notifications/hub.ts`(NotificationHub DO, 사용자 1명당 1개, WebSocket Hibernation, 저장 없음)·`push.ts`(`pushNotification()`, 예외·비-2xx 조용히 무시)·`routes.ts`(`/api/notifications/ws`, 세션 쿠키·출처·업그레이드 검사는 채팅과 동일). `src/index.ts` 마운트+export+Env, `src/approval/machine.ts`는 D1 batch 성공 확인 뒤 batch 밖에서 푸시(`performAction`에 선택 인자 `pushEnv` 추가, `routes.ts` 2곳이 `c.env` 전달), `src/workflow/approvals.ts`는 INSERT 1행 확인 시만 푸시. `wrangler.toml`에 `NOTIFICATION_HUB` 바인딩만 추가(v3 태그 없음). `public/approval.js`에 소켓 1개·토스트·미읽음 +1·결재함 재조회·5초 재연결(최대 5회) 추가, 기존 폴링 유지. `index.html` 수정 없음(소켓은 `apvHome()` 안에서 시작, 로그아웃 시 `ntfPaintCount(0)`에서 정리). 생성 지점 grep 결과 알림 INSERT는 2곳뿐이라 둘 다 연결.
- 검증: tsc 통과(코디네이터 재확인), 백엔드 하네스 **32/32**(실제 index.ts·실제 DO·로컬 D1, 케이스 1~4: 푸시 수신·연결 없음 시 D1 유지·타인 격리·푸시 실패 시 INSERT 유지) + UI 하네스 **46/46**(토스트 5초 소멸·클릭 이동·재조회 조건·5초 재연결·5회 후 중단·XSS 방어) + 회귀 DO-1a 41/41·DO-1b 77/77·DO-1c 71/71·DO-1d 64/64. 검증 산출물 `files/workflow-verify/do2/` (results.json 32/32, ui-results.json 46/46, 회귀 4종). `approval.js`의 `innerHTML` 3건(44·47·61행)은 기존 탭 렌더링 코드(상수·정적 문자열)이며 이번 작업의 토스트는 textContent만 쓴다.
- **주의할 점**: 푸시는 `performAction` 안에서 await한다 — 지연이 문제가 되면 `waitUntil`로 옮길 수 있다(세션 제안, 미적용).
- **미검증**: 실제 Cloudflare 엣지 WebSocket·휴면 뒤 푸시 전달(로컬 Miniflare만 확인), 원격 DO 미적용(v3 태그 없음), 실제 브라우저 토스트 위치·로그인 흐름, 워크플로우 엔진 전체 경로(`requestWorkflowApproval` 헬퍼 직접 호출로만 확인) — DO-MIG 라이브 확인 필요.

### DO-3 DO 정밀 레이트 리미터 (Sonnet, 완료 2026-11-18, 미배포)
- 프롬프트: `do-3-rate-limiter-prompt.md` (코디네이터 신규 작성)
- 산출: `src/ratelimit/limiter.ts`(RateLimiter DO, 키 1개=인스턴스 1개 `idFromName('rl:ask:'+clientKey)`, 토큰 버킷 용량 20·3초당 1개 보충, lazy refill+Alarm, DO storage 저장, 인메모리 캐시 없음, `POST /check` → `{allowed, remaining, resetInSec}`), `src/index.ts`(`checkAskRateLimit()`이 DO 우선, 1초 타임아웃·예외·비-2xx·형식 오류 시 기존 KV 구현(`checkAskRateLimitKv`, 코드 그대로)으로 폴백, KV 실패 시 fail-open, 반환 형태 불변이라 `/api/ask`·`/api/personal/ask` 호출 지점 수정 없음). `wrangler.toml`에 `RATE_LIMITER` 바인딩만 추가(v3 태그 없음 — 코디네이터 확인, 태그는 v1·v2만 존재).
- 검증: tsc 통과(코디네이터 재확인), 하네스 **24/24**(main 23 + 재시작 1): 버스트 20 허용·21번째 차단, **동시 30요청 → 정확히 20 허용/10 차단**(대조로 KV 경로는 동시 30요청 전부 허용 — KV 레이스 실증), 보충(6초→2개, 2분→용량 20 상한, 알람 단독 보충), 키 격리, 폴백(DO 예외·바인딩 없음·500·형식 오류→KV 기준, DO·KV 모두 실패→fail-open, DO 정상 시 KV 미사용), 재시작 후 버킷 유지(27.3초 뒤 9건 허용 = 경과분 비례, 새 버킷 아님), 타임아웃(4초 지연 DO → 1.09초 만에 KV 폴백). 회귀 DO-1a 41/41·DO-1b 77/77·DO-1c 71/71·DO-1d 64/64·DO-2 백엔드 32/32·DO-2 UI 46/46 전부 통과. 검증 산출물 `files/workflow-verify/do3/` (RESULT.md, results.json 23/23, restart1/2.json). 첫 실행 2건 실패는 측정 방식 문제(코드 결함 아님 — workerd 내 `Date.now()` 측정 어긋남, 별도 요청+curl 벽시계로 재측정해 통과).
- **미검증**: 실제 Cloudflare 엣지 DO·Alarm 동작·지연(로컬 Miniflare만), 원격 DO 미적용, 실제 `/api/ask`·`/api/personal/ask` HTTP 전체 경로(AI·Vectorize 필요)는 타지 않음, 수백 동시 요청·장시간 알람 누수 미확인 — DO-MIG 라이브 확인 필요.
- **Phase 4 구현 완료(DO-1a~DO-3)**: 채팅 1:1+그룹, 알림 푸시, DO 레이트 리미터까지 로컬 검증 완료. 남은 것은 DO-MIG 배포 + 라이브 검증(DO-VERIFY).

### DO-MIG 배포 + 라이브 E2E (코디네이터, 완료 2026-11-18)
- **버전: `5ee615c9-0160-4b5e-bb03-14d69d7dc7e6`** (cf-wrangler.py deploy). 0030 원격 적용(`d1_migrations` 기록, chat_rooms·chat_room_members 존재 확인) + wrangler.toml v3 태그 `[ChatRoom, NotificationHub, RateLimiter]` 추가.
- **라이브 E2E 전부 통과** (테스트 사용자 dotest1/dotests2@peopleos.site, workers.dev 경유, 스크립트 `files/workflow-verify/do-mig/e2e.mjs` + `RESULT.md`): DM REST 201·WS 실시간 수신, 그룹 생성·메시지·미읽음 1→읽음 확인 후 0·그룹 WS 수신, 알림 푸시(send_email 워크플로우 → waiting_approval → NotificationHub WS로 WORKFLOW_APPROVAL `notify` 수신; 승인 안 해서 메일 미발송), 데모 회귀(health·HR ask grounded·라이브러리·메일함·캘린더 전부 200), **레이트 리미터 25회 동시 → 200=20·429=5·Retry-After=3**(DO 실제 동작 확인 — KV 폴백이었다면 전부 허용됐을 것이다).
- **DO-VERIFY 완료로 간주**: 위 라이브 E2E + 워크플로우 회귀(llm→create_task run succeeded 17초, 할 일 생성) + 각 DO 세션의 로컬 회귀(실패 0)를 모두 통과. 별도 DO-VERIFY 세션은 두지 않는다.
- **교훈 2건**: (1) 순차 21회 ask는 토큰 보충(3초당 1개) 때문에 제한이 안 걸린다 — 라이브 레이트 리밋 검증은 동시 버스트로 해야 한다. (2) curl 쿠키 파일의 `#HttpOnly_` 줄은 실제 쿠키 줄이다 — 주석으로 오인해 제외하면 전부 401이 된다.
- **서비스 재시작 발생**: llm run 폴링 중 exec 세션 재시작으로 중단됐으나 run은 서버에서 계속 진행돼 succeeded까지 완료 — 재시작 후 상태 조회로 확인.
- **정리 완료**: 할 일·워크플로우 2개 API 삭제, D1 정리 SQL `do-mig-e2e-cleanup.sql`(13행 삭제), 테스트 사용자·세션·테스트 그룹방 0건 확인, 쿠키 파일 삭제.
- **Phase 4 전부 완료 (DO-1a~DO-3 + DO-MIG + DO-VERIFY)**: 채팅 1:1+그룹, 알림 푸시, DO 레이트 리미터가 라이브 배포·검증까지 끝났다.
- 남은 것: 공모전 패키징(사용자 게이트: 11-25 기능 동결, 11-26 데모 영상+레포 공개, 11-27 제출). 미검증: 브라우저 실기기 확인(채팅 UI 시각·모바일·IME, 토스트 위치), Alarm 장기 동작·수백 동시 요청, `performAction` 안 푸시 await 지연 시 `waitUntil` 이동 검토.

### D-2 Phase 2 배포 (코디네이터, 2026-11-18)
- **버전: `63f8343c-a887-4e45-a58d-c3281db82be7`** (배포 완료). 원격 D1에 0028 적용 + `d1_migrations` 기록 확인. WORKFLOW_AGENT DO(v2 태그) 라이브. 크론 3개 등록.
- 테스트 사용자 재생성 `wftest@peopleos.site`(id `3be846be-2f8c-450a-b179-46a9b4cf2c8c`), 쿠키 `files/workflow-verify/d2-e2e-cookies.txt`.
- **condition**: join 없는 첫 테스트에서 true/false 양쪽 분기 모두 실행됨 — WF-7 알려진 한계 확인. 다이아몬드 테스트(양쪽 분기 → 합류 단계 s5) 깔끔히 통과: 단계 0,1,2,4 실행, false 분기 스킵, 합류 task 생성.
- **agent**: 1차 run 성공(finish/거절 — 모델이 create_task에 dueDate 필수로 오해, WF-11 다듬기 항목). 2차 run(기한 2026-11-30 포함 목표) **2회 연속 failed** — "모델 응답 형식 오류가 3번 연속". 원인: Qwen3가 `"action"`에 도구 이름(`"create_task"`)을 씀 → WF-6b 수정으로 이어짐.
- **스케줄 틱**: `wfs_mwlbr76e_8a8rwn`(cron `45 8 * * *`, 워크플로우 `wf_mwlbr0t3_im98bp` active) — **08:45 KST 틱 통과**: run `wfrun_mwlcbka9_044eth` 생성(23:45:29Z), **succeeded**, task `task_mwlcbviu_0y53jc` 생성, `last_run_at` 2026-11-17T23:45:28Z로 갱신 확인. D-2 라이브 검증 전부 완료(agent 3/3·condition 다이아몬드·스케줄 틱·데모 회귀).

### D-2b 재배포 — WF-6b 포함 (코디네이터, 2026-11-18)
- **버전: `66d17b05-34ca-4ec4-98c5-3589313333fb`** (배포 완료). WF-6b `agent-do.ts` 수정만 포함.
- **에이전트 라이브 재검증 3/3 성공** (같은 목표: `[테스트] 에이전트 할 일`, 기한 2026-11-30):
  - `wfrun_mwlc3ccr_ktdgfr` succeeded — turn 0 `"action": "tool"`, `create_task`, task `task_mwlc3k1w_jbdhd8` 생성.
  - `wfrun_mwlc4yvn_1tj295` succeeded — task `task_mwlc543z_7wfn74` 생성.
  - `wfrun_mwlc6a3u_5w7gbi` succeeded.
  - Qwen3 JSON 준수율 3/3. WF-6b 수정 라이브 검증 완료.
- **데모 회귀 전부 통과 (D-2b)**: 홈 200, 라이브러리 200, 메일함(`/api/email/inbox`) 200, 캘린더(`/api/calendar/events?from=…T00:00:00Z&to=…`, ISO 타임스탬프 필수) 200, HR RAG ask 200(연차 규정 답변, grounded). 주의: `/api/mail/inbox`는 없는 경로(404), `/api/calendar/events`는 날짜만 주면 400 — 테스트 시 올바른 경로·형식 쓸 것.
- **남은 D-2 정리**: 스케줄 틱 결과 확인 후 테스트 워크플로우 5개(agent·condition·diamond·schedule·diagnostic)·스케줄·생성 task 3개·테스트 사용자 + 세션 삭제, 쿠키 파일 삭제. → **완료 (2026-11-18 08:50 KST)**: 할 일 8개·워크플로우 5개 API 삭제(200 전부), D1 정리 SQL `files/workflow-verify/d2-e2e-cleanup.sql` 실행(changes 4), 사용자·세션 0건 확인, 쿠키 파일 삭제. 알림·ask_events 흔적은 D-1과 동일하게 삭제된 사용자 키로 남아 조회되지 않음.

### D-3 Phase 3 배포 (코디네이터, 2026-11-18)
- **버전: `2db1528c-af9d-488d-aecb-c5a51d934177`** (배포 완료). 원격 D1에 0029 적용 + `d1_migrations` 기록 확인 (`workflow_shares` 테이블 존재).
- 테스트 사용자 3명 생성: `wftest@peopleos.site`(user, id `1c1ad8db-…`, 인사팀), `wftest2@peopleos.site`(user, id `945531ee-…`, 인사팀), `wftestadmin@peopleos.site`(hr_admin, id `8dc8c0cf-…`, 부서 없음). 부서는 D1에서 직접 지정.
- **공유 E2E 통과**: 비공개 워크플로우(`wf_mwlcxql2_qqrlm3`)는 wftest2 GET 404 → `all`+`copy` 공유 후 GET 200(`shared: true`, `can_copy: true`) → 복사 201(소유자 wftest2, `(복사)`, is_template=0) → 복사본 run **succeeded** → `/shared` 목록에 `shared_via: 'all'`로 보임.
- **부서 범위 E2E 통과**: `department`+`copy` 공유(`wf_mwlcz638_ufvy61`) — 같은 부서 wftest2 GET 200, 부서 없는 admin GET 404.
- **템플릿 E2E 통과**: admin이 템플릿 지정(`wf_mwlczd83_1159mu`) 200 → wftest GET 200·복사 201(소유자 wftest, is_template=0) → 일반 사용자가 `PATCH is_template` 시도 403.
- **웹훅 E2E 통과**: httpbin POST 워크플로우(`wf_mwlczrcf_o1gbq7`) 실행 → **waiting_approval**(승인 전 fetch 없음) → 승인 → **succeeded**, 실제 httpbin 응답 status 200·본문 에코 확인. **SSRF 라이브 차단 확인**: `http://169.254.169.254/latest/meta-data/` 워크플로우는 승인 후 **failed** — "차단된 주소입니다: 사설·루프백·링크 로컬 IP로는 호출할 수 없습니다 (169.254.169.254)". 참고: 엔진 승인 게이트가 노드 실행보다 먼저라, 막힌 주소도 일단 waiting_approval에 걸린 뒤 승인 뒤 실행 시점에 차단된다 (RESULT.md의 "승인 요청에 올리지 않고 바로 failed"와 다름 — 실행 시점 차단이 실제 동작, 안전성에는 문제 없음).
- **데모 회귀 전부 통과 (D-3)**: 홈 200, 라이브러리 200, 메일함 200, 캘린더 200, HR RAG ask 200(답변 267자).
- **정리 완료**: 워크플로우 7개·할 일 1개 API 삭제(200 전부), 테스트 사용자 3명 + 세션 D1 삭제(`files/workflow-verify/d3-e2e-cleanup.sql`, changes 9, 사용자 0건 확인), 쿠키 파일 3개 삭제.

### D-3b 배포 — WF-10 + WF-11 묶음 (코디네이터, 2026-11-18)
- **버전: `b11b6a5c-c1e7-4ad7-9905-a91866481787`** (배포 완료). 마이그레이션 없음 (코드만). `workflow-canvas.{js,css}`·`obs/workflows.js` 200 확인, 익명 `/api/workflows` 401·`/api/obs/workflow-runs` 401.
- 테스트 사용자 2명 생성: `wftest@peopleos.site`(user, id `234a9e96-…`), `wftestadmin@peopleos.site`(hr_admin, id `5f5fa244-…`).
- **캔버스 정의 왕복 + `next: null` 라이브 통과**: condition `{true: s3, false: null}` 정의 저장 → GET에서 간선 그대로 유지 → 실행 → **succeeded, 단계 s1(llm)·s2(condition)만 실행**, false 분기가 거기서 끝나 s3·s4 미실행. WF-10 종료 표식 라이브 확인.
- **관측 API 라이브 통과**: admin `GET /api/obs/workflow-runs` 200 (위 run 포함, `duration_ms` 등 필드 확인), 상세 `/:runId` 200 (단계 타임라인), 일반 사용자 403, 익명 401.
- **에이전트 dueDate 수정 라이브 통과**: 기한 없는 목표("[테스트] 에이전트 기한 없음") → agent run **succeeded**, 할 일 생성 (기한 문구 없음) — D-2의 거절 케이스 해결 확인.
- **데모 회귀 전부 통과 (D-3b)**: 홈 200, 라이브러리 200, 메일함 200, 캘린더 200, HR RAG ask 200(답변 278자).
- **정리 완료**: 할 일 1개·워크플로우 2개 API 삭제(200 전부), 테스트 사용자 2명 + 세션 D1 삭제(`files/workflow-verify/d3b-e2e-cleanup.sql`, changes 6, 사용자 0건 확인), 쿠키 파일 2개 삭제.

### WF-12 최종 전체 검증 (코디네이터 직접 수행, 2026-11-18)
- 대상 라이브 버전: `b11b6a5c-c1e7-4ad7-9905-a91866481787` (D-3b). 검증 산출물 goal 루트 `files/workflow-verify/RESULT.md`.
- **전 시나리오 통과**: 선형(llm→create_task, succeeded, 할 일 생성) · 승인(send_email waiting_approval → 승인 → succeeded, 실제 메일 발송) · 에이전트(기한 포함 목표, succeeded, 할 일 생성) · 조건 다이아몬드(0,1,2,4 실행, false 분기 스킵, 합류 task 생성) · 공유/복사(all+copy 201 → 복사 201) · 스케줄 틱(10:00 KST, run 생성·**succeeded**, `last_run_at` 갱신). 캔버스 `next: null`·웹훅·관측 API는 D-3/D-3b에서 같은 버전으로 검증됨 — WF-12에서 반복하지 않음.
- **데모 전체 회귀 전부 통과**: 홈 200, 라이브러리 200, 메일함 200, 결재함(`/api/approval/box`) 200, 결재 홈 200, 캘린더 200, HR RAG ask 200 (grounded=true).
- **발견 사항 2건 (둘 다 테스트·동작 이해 문제, 버그 아님)**: (1) 다이아몬드 첫 실행에서 양쪽 분기가 다 실행됨 — s3에 `next: s5`가 없어서 배열 순서로 s4까지 간 것. 정의를 고쳐 재실행하니 정상. 교훈: 분기 뒤 합류는 `next` 명시 필수. (2) 동시 실행 상한 3개 — 4개 run 동시 시작 시 4번째 거부 (`동시 실행 상한(3개)`, WF-3 제한 그대로).
- **정리 완료**: 할 일 8개·워크플로우 6개 API 삭제(200 전부), 테스트 사용자 2명 + 세션 D1 삭제(changes 6, 사용자 0건 확인), 쿠키 파일 2개 삭제.
- **워크플로우·에이전트 빌더 완료 (WF-1~WF-12)**. 남은 것은 Phase 4 DO 3건 + 공모전 패키징(11-25 동결·11-26 영상·공개 전환·11-27 제출 — 사용자 게이트).

## Phase 4 범위 확장 — 채팅에 직원 1:1 + 그룹채팅 추가 (2026-11-18 09:06, 사용자 승인)

- **결정**: DO-1 채팅이 세 가지 방식을 커버한다 — ① 코치↔코칭 대상 1:1 (원래), ② 직원↔직원 1:1 (추가), ③ 그룹채팅 (추가). 모두 같은 `ChatRoom` DO (방당 1개 + WebSocket Hibernation + 방 내 전원 브로드캐스트).
- **직원 1:1**: DO가 역할을 안 봐서 추가 공수 거의 없음 (참여자 선택 UI만 다름). 1:1 방 키 `chat:dm:<a>:<b>` (두 id 정렬).
- **그룹채팅 추가분 — DO-1c + DO-1d 2개 세션 신설**:
  - DO-1c (Sonnet): 그룹 백엔드 — D1 멤버십(`chat_rooms` + `chat_room_members`, 마이그레이션 `0030_chat_rooms.sql` 파일 작성, 원격 적용은 DO-MIG), 멤버 추가/제거(방 생성자 또는 hr_admin만), 메시지 seq + 멤버별 `last_read_seq` 미읽음, 비멤버 404.
  - DO-1d (Sonnet): 그룹 UI — 그룹 생성(이름 + 멤버 선택), 멤버 목록·추가/제거, 방 목록 미읽음 배지.
- **멤버십 저장 위치 — D1로 결정 (DO 스토리지 아님)**: "내 방 목록"은 모든 방을 훑어야 하는데 DO는 방마다 따로 살아서 목록을 못 만든다. 멤버십은 관계형 조회가 본질이라 D1이 맞고, 나머지 멤버십(사용자·부서)도 D1에 있다. 메시지만 DO SQLite.
- **세션 수**: Phase 4 합계 약 4~6세션 → **약 6~8세션** (D1 2~3 → 4~5). 순서 변동 없음 — WF-12 뒤에 그대로 진행, 배포도 DO-MIG에서 한 번만.
- **반영된 파일**: `durable-objects-use-cases-plan.md` D1절·합계표, `workflow-agent-builder-FULL-PLAN.md` §5 (DO-1a~DO-1d 행 + DO-MIG 라이브 E2E에 그룹채팅 포함).

## 차단 / 주의

- **WF-6 알려진 편차 — DO 30분 타임아웃 조정 (WF-11 다듬기에서 처리)**: DO의 `timeout`과 엔진의 30분 run 상한이 같은 값이라, 30분에 걸리면 run이 "정상 멈춤"이 아니라 `failed`로 끝난다. DO 임계값을 28분으로 당기면 정상 멈춤으로 끝난다. WF-6 RESULT.md "설계 메모"에 기록됨. WF-11에서 1줄 수정으로 처리한다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 WF-6에서도 건드리지 않았다. 공용 모듈 추출은 별도 과제.

## 모델 교체 (Workers AI 폐기 대응, 2026-11-18) — 중단·롤백, 미완료

- 소스 3곳 교체 + tsc 통과 + 배포 `96915e89-18af-4ce4-abd2-e6650cd1dfa0`. 라이브 HR 질문에서 `qwen3.8-27b`가 OpenAI 형식(`choices[0].message.content`)으로 응답해 `responseText()`가 못 읽고 답변이 원시 JSON으로 나옴 (LLM 27초).
- 직전 버전 `5ee615c9-0160-4b5e-bb03-14d69d7dc7e6`으로 롤백, 정상 확인. **프로덕션은 아직 Qwen3-30B** (소스는 교체된 상태 — 소스와 프로덕션이 다름).
- 골든셋 평가 미실행. 필요 조치: `responseText()` 처리 추가 후 재배포·평가 (범위 밖이라 사용자 결정 대기). 11/20 폐기 전 필수. 상세: `files/workflow-verify/model-swap/RESULT.md`.

## 모델 교체 2차 (responseText 수정, 2026-11-18) — 배포 완료, 지연·평가 미해결

- `responseText()`가 `choices[0].message.content`를 읽고 reasoning/`<think>`를 버리도록 수정 (기존 `{response}` 경로 그대로). tsc 통과, 로컬 하네스 16/16. 비밀번호 토글 인라인 JS `node --check` 통과 → 함께 배포.
- 배포 **`8458c9e9-7a52-46cb-b260-9aebadba1d38`** — 프로덕션 = qwen3.8-27b (소스와 일치). D1 마이그레이션 없음.
- 라이브: health 200 전부 true. HR "연차는 며칠이야?" → 정상 텍스트, grounded=true, 근거 2건. **LLM 18.7초** (기준 2.3초) — 모델 기본 `reasoning_effort: xhigh` 때문. `reasoning_effort: "low"` 추가는 호출처 수정이라 사용자 결정 대기.
- 골든셋 평가 **미실행**: admin secret 파일이 세션 허용 경로 밖이라 읽기 차단. 개인 질문·메일함·캘린더는 로그인 세션 없음 (401, 인증 게이트 정상). 홈·라이브러리 200.
- 상세: `files/workflow-verify/responseText-fix/RESULT.md`.

## 그룹 이름 자동 지정 + 변경 (2026-11-18) — 배포 완료, 브라우저 확인 대기

- `POST /groups` name 선택: 비면 생성자 먼저 + `member_ids` 순서로 멤버 이름을 ", "로 이어 붙임(중복·본인 제거, 100자 초과는 말줄임 없이 절단), `chat_rooms.name`에 저장. 신규 `PATCH /groups/:roomId`: 멤버면 누구나 1~100자 이름 변경 (비멤버 404), D1만 갱신(DO에 방 이름 없음).
- 프론트: 생성 폼 이름 선택(필수 경고 제거), 그룹 머리글 연필(Lucide pencil 16px) 인라인 이름 변경. DM에는 없음.
- tsc·node --check 통과, 로컬 하네스 21/21, `/chat.js` 로컬 200. 배포 `de569328-e543-4708-a523-0b4102a4f84e`, health 200 전부 true. D1 마이그레이션 없음.
- 미검증: 브라우저에서 실제 그룹 생성·이름 변경(로그인 필요) — 사용자가 확인. 상세: `files/workflow-verify/group-name/RESULT.md`.

## 모델 교체 3차(reasoning_effort low) (2026-11-18) — 배포 완료

- `LLM_MODEL` 호출 12곳에 `reasoning_effort: "low"` 추가 (디버그 라우트 제외). 배포 `e73c1b61-d35d-4997-8bae-43d73ceca9ff`, health 200 전부 true, 홈·라이브러리 200.
- HR 질문 LLM 18.7초 → 6.0초 (목표 2~3초 미달), 답 정상·grounded. 골든셋 1회: 6/6, avgJudge 0.83 (기준선 0.9, 항목 s04 0.7이 가장 낮음). 재실행 안 함.
- 개인 질문 미실행 (로그인 세션 없음). 상세: `files/workflow-verify/reasoning-low/RESULT.md`.

## 모델 교체 4차(reasoning_effort medium) (2026-11-18) — 배포 완료

- `LLM_MODEL` 호출 12곳 `"low"` → `"medium"` (디버그 라우트 제외). 배포 `4f4d63db-93a6-4af9-b839-756b97497f7e`, health 200 전부 true, 홈·라이브러리 200.
- HR 질문 LLM 6.0초(low) → 70.2초(1회 측정), 답 정상·grounded·제12조 인용. 골든셋 1회: 6/6, avgJudge 0.8667 (low 0.8333, 기준선 0.9, s04 0.7→0.8). 재실행 안 함. 항목 latency 7.7~50.7초로 편차 큼.
- 개인 질문 미실행 (로그인 세션 없음). 상세: `files/workflow-verify/reasoning-medium/RESULT.md`.

## 채팅 presence·읽음·반응 (2026-11-18) — 배포 완료

- 프롬프트: `chat-presence-read-react-prompt.md` (Opus). 배포 **`5a7a6aae-7d3c-4f9b-b0bc-78b1d4331e44`**. D1 **0031_chat_reactions.sql** 원격 적용(적용 전 list로 0031만 미적용 확인, 트래커 정상).
- 산출: `src/chat/room.ts`(전역 로비 인스턴스 `chat:lobby` — presence는 Hibernation 소켓 태그·첨부에서 계산해 휴면에도 유지, ping auto-response, 방 `/event` 브로드캐스트), `src/chat/routes.ts`(`/lobby/ws`·`/presence`·반응 토글 API·메시지 조회에 reads+reactions·read 브로드캐스트·**DM 미읽음 계산**·DM 전송 시 보낸 사람 읽음·새 메시지 로비 알림), `public/chat.js`(로비 소켓·녹색 점·읽음 숫자·반응 pill/팝업·FAB 배지 DM 합산·chat_msg 즉시 갱신), `public/chat.css`, `migrations/0031_chat_reactions.sql`.
- 검증: tsc·node --check 통과. 로컬 E2E 38/38, 화면 로직 하네스 32/32, **라이브 E2E 38/38**(dotest1/dotest2@peopleos.site, 1:1+그룹: 녹색불 on/off·"1" 사라짐·반응 토글·접힌 상태 배지 1:1 포함). 상세 `files/workflow-verify/chat-presence-read-react/RESULT.md`.
- **교훈**: 이 세션은 `node` 스크립트가 막혀 있고 로컬 workerd는 프록시 뒤 외부 HTTPS 실패, `dev --remote`도 불가 → 하네스를 임시 Worker로 배포해 엣지에서 E2E 실행 후 즉시 삭제(헤더 키 보호). 테스트 계정은 비밀번호 없이 세션 해시만 D1에 넣어 만들었다.
- 정리 완료: 테스트 사용자·세션·방·반응 원격 삭제(0건 확인), 임시 하네스 Worker 삭제(404 확인), SEED·키 파일 삭제.
- 미검증: 실제 브라우저 시각·모바일 터치. 기존 DM은 배포 전 자기 글이 한 번 미읽음으로 잡힐 수 있음(방 열면 0).

## 소개·발표자료·데모 반영 + GitHub 푸시 (2026-11-18, Sonnet) — 배포·푸시 완료

- 프롬프트: `pitch-update-push-prompt.md`. 감사 근거: `files/workflow-verify/pitch-audit/RESULT.md`. 정적 파일만 변경 (Worker 코드 변경 없음). 배포 **`38cbdd4b-fc1f-4a17-9158-87fb00ea6681`** (cf-wrangler.py deploy, 에셋 2개: pitch-content.html·index.html).
- 고친 문서: `public/pitch-content.html`(P0 사실 오류 전부, 08 섹션 에이전트 루프 ④ 워크플로우, DO 5개 표, 레이트 리미터 DO, 04 장면 4, 11 신뢰 원칙 3줄, 12 한계 교체, 13 따라 하기 6단계 + 채팅), `README.md`(영문 요약·다이어그램·진입점·기능 표·기능 목록 18개 + 채팅·알림·에이전트 표·한계·모델·배포 리소스·시크릿·구조·정직한 상태), `DEMO-SCRIPT.md`(전면 개정: 로그인, 현행 메뉴 이름, 워크플로우 40초·채팅 15초 장면, 기존 장면 축소, 속도 전제 삭제), 앱 소개 탭 `public/index.html`(워크플로우·캘린더·조직관리·채팅·알림 추가, 477행 "초안까지만" 문구 교체).
- 라이브 `/pitch-content.html`: "워크플로우"·"qwen3.8-27b"·"캘린더" 포함 확인. tsc 통과.
- 이번 범위 밖(미반영): `architecture.svg`, `ARCHITECTURE.md`, `VERIFICATION.md`. reasoning low/medium 미결이라 속도 수치는 적지 않음.
- GitHub: `workspace-easyware/people-os` main, 스냅샷 6/8·7/8·8/8 (3배치). 루트 `architecture.svg` GitHub 사본 삭제는 11-26 공개 전환 전 별도.
- 상세: `files/workflow-verify/pitch-update/RESULT.md`.

## 전체 코드 점검·수정 + Cloudflare 기능 (2026-11-18, Fable 5.2) — 배포 완료, 브라우저 확인 대기

- 프롬프트: `full-review-ultra-prompt.md`. 배포 **`2fa42ca9-7493-436e-bbd3-25fe26d6a30c`** (cf-wrangler.py deploy 1회). D1 **0032_chat_room_last_seq.sql** 원격 적용 (적용 전 list로 0032만 미적용 확인).
- 점검: 감사 에이전트 6개(영역별) + `src/index.ts` 직접. 고친 것 **P0 5 / P1 18 / P2 15**.
- P0: 할 일 PATCH/DELETE 소유자 검사, 요약 API 읽기 게이트, 지식 공백 익명 게시 차단, `/api/obs/*` 관리자 전용(개인 검색 트레이스가 익명에게 읽혔음), 다이제스트의 남의 개인 문서 제목·요약 노출.
- P1 주요: 질문 레이트 리밋 우회, 리플렉션 범위, 긴 문서 임베딩 배치, 오래된 승인 메시지 차단, 공유 워크플로우 웹훅 헤더 값 가림, 비활성 계정 run 차단, 관리자 초기화 시 옛 비밀번호 무효화, 주제 가드 뒤집힘, 비용 동기화 정체, Turnstile 키 하나만 넣었을 때 잠김, 탭 이중 로드(홈 → 메일 상세 등 바로가기 깨짐), 문서 14곳 정정.
- P2 주요: 요청마다 돌던 스키마 exec 1회로, 색인 D1 batch, 방 목록의 방마다 DO 호출 제거(`chat_rooms.last_seq`), 정체 run 청소 15분마다, 만료 로그인 기록 정리, 정적 파일 보안 헤더.
- Cloudflare 기능: **Workers Logs** 구현 (`[observability]` + `src/obs/log.ts` 구조화 로그 — 내용 없이 식별자·상태·숫자만). Turnstile 로그인 확대·Analytics Engine·R2 presigned·Cache API·CSP는 넣지 않음 (이유는 RESULT.md 3절).
- 동작 변경: 익명·권한 없는 호출만 막힘. 되돌리는 방법은 RESULT.md 2절. 원본 백업 `files/workflow-verify/full-review/orig/` (`src/workflow/routes.ts` 원본만 없음 — 변경은 `redactShared` 추가뿐).
- 검증: tsc 통과, 로컬(마이그레이션 0001~0032 새 DB + 계정 3개) 권한·채팅 미읽음·워크플로우 승인 경로 통과. 라이브 health 200 전부 true, 로그인 화면·pitch 키워드 확인, HR 질문 grounded·제12조 인용(LLM 6.6초·총 10.8초, 1회).
- 미검증: 로그인 뒤 화면 전부(브라우저), Workers Logs 대시보드, `index.html` 인라인 스크립트 자동 문법 검사(node 실행이 권한에 막힘 — 고친 곳은 다시 읽어 확인).
- 사용자 결정 대기: 일반 사용자 비밀번호 변경 화면 위치, 로그아웃 시 새로고침, 암묵지 게시 hr_admin 전용 여부, `qwen3.8-27b` 단가, Turnstile 키 발급, reasoning low/medium. WF-2 복제 부채는 그대로 (요약·리플렉션이 이미 갈라져 있어 합칠 규칙 결정 필요).
- GitHub 푸시 안 함 (다음 스냅샷: src 다수, `src/obs/log.ts`, `migrations/0032`, public 4개, `wrangler.toml`, README, DEMO-SCRIPT).
- 상세: `files/workflow-verify/full-review/RESULT.md`.

## 브라우저 검증 문제 수정 (2026-11-18)
- 프롬프트: `browser-fix-prompt.md`. 배포 **`6f1ac4a8-f83f-402c-82a9-fd57a08038f0`** (cf-wrangler.py deploy 1회). 마이그레이션·백엔드 코드 변경 없음 (`public/index.html`, `public/workflow.js`만 수정).
- 고친 것: ③ 요약하기 버튼(업로드 없이도 활성화·자동 업로드 후 요약, 라이브러리 제목 클릭으로 요약 화면 열기) ④ "nullnull"(`append(null)`) ② 날짜 KST 변환 ⑥ 홈 로딩(메일 API를 기다리지 않고 섹션 즉시 표시 + "불러오는 중…") ⑤ LMS 영상(라이브 R2에서 `lms/sample.mp4`가 사라져 있었음 → 로컬 원본으로 복원, 왕복 바이트 동일 확인).
- 코드에서 재현되지 않은 것: ① 캘린더(라이브 D1 calendar_events가 0건 — 홈의 "11/21 코칭 세션"은 캘린더 데이터가 아님), ⑦ "Merlin 진행 중..." 토스트(앱 코드에 없음, 검증 도구 쪽 표시).
- 미검증: 브라우저 실제 화면 전부 (사용자 확인 필요). 상세: `files/workflow-verify/browser-fix/RESULT.md`.
- GitHub 푸시 안 함.

## LMS 유튜브 임베드 잘림 수정 (2026-11-19)
- 프롬프트: `lms-youtube-fix-prompt.md`. 배포 **`c591d2bb-c57c-48f6-843b-0bfec43559d1`** (cf-wrangler.py deploy 1회). 변경은 `public/lms.css` CSS 2줄뿐 (JS·API·DB·마이그레이션 없음).
- 원인: `#lmsPlayer`는 16:9인데 그 안의 `.lms-player` 래퍼 div에 높이 규칙이 없어 iframe `height:100%`가 기본 150px로 무너짐. 고침: `.lms-player{width:100%;height:100%}`.
- 점검: 14개 강의 모두 같은 유튜브 경로(`mountYoutube`)라 일괄 해결. R2 영상 플레이어는 별개 경로. 다른 결함은 못 찾음.
- rescene-room은 GitHub 접근 도구가 없어 참조 못 함 (표준 방식으로 수정).
- 검증: tsc·node --check 통과, 라이브 lms.css에 새 규칙 확인. 미검증: 브라우저 실제 화면(데스크톱·모바일) — 사용자 확인 필요.
- GitHub 푸시 안 함. 상세: `files/workflow-verify/lms-youtube/RESULT.md`.

## 워크플로우 기업용 템플릿 (2026-11-19)
- 프롬프트: `workflow-templates-prompt.md`. 배포 **`a08fdfae-4c34-4012-8a37-6afc0844dea3`** (cf-wrangler.py deploy 1회). D1 마이그레이션·새 노드 타입 없음 (기존 노드 15종만).
- 템플릿 5개 (코드 내장 `src/workflow/templates.ts`): 회의 자동화(4단계) · 휴가 신청 승인(2) · 주간 보고 자동 작성(3) · 신입 온보딩(6) · 지출 결재 요청(2). 읽기 전용 `GET /api/workflows/templates` 추가 (기존 API 불변).
- UI: 빈 화면에 "워크플로우가 뭐예요?" 한 줄 설명 + 템플릿 카드(이름·설명·단계 수·"승인이 필요한 단계" 배지·"이 템플릿으로 만들기"). 사이드바 "템플릿으로 시작하기" 버튼으로 언제든 돌아옴. 만들면 일반 워크플로우로 저장되고 이름·단계 설정을 바꿀 수 있으며, 실행 입력 예시가 "고급 입력"에 채워진다.
- "폼 입력" 단계는 폼 노드가 없어 실행 입력({{input.x}})으로 표현, "알림"은 확인용 할 일(create_task)로 대체.
- 검증: tsc·node --check 통과, 로컬 하네스 34/34 (템플릿 5개 생성·실행·승인 게이트), 라이브 workflow.js 새 코드 확인. 미검증: 브라우저 실제 화면, 실제 메일 발송(로컬은 RESEND_API_KEY 없음).
- GitHub 푸시 안 함. 상세: `files/workflow-verify/workflow-templates/RESULT.md`.

## Plaud 연동 (2026-11-19)
- 프롬프트: `plaud-integration-prompt.md`. 배포 **`555295d1-5e37-4f7a-be28-5eb0407678cb`** (cf-wrangler.py deploy 1회, 원격 마이그레이션 0033 적용).
- 녹음전사·문서저장 탭에 "Plaud" 카드: OAuth 연결(PKCE, 구글 캘린더 패턴, 토큰 암호화 저장) → Plaud MCP(Worker가 클라이언트) 녹음 목록 → "가져오기"로 전사(+요약)를 개인 문서로 저장·개인 RAG 색인. 중복 방지·전사 없음 표시·토큰 갱신 실패 시 연결 해제.
- OAuth: DCR 성공(공개 클라이언트, client_secret 없음). client_id는 비밀 아님 → wrangler.toml [vars]. 신규 시크릿 없음.
- 검증: tsc·node --check 통과, 로컬 모의 Plaud로 전 흐름 통과. 미검증: 실제 Plaud 계정 연결·Vectorize 색인·브라우저 화면·라이브 HTTP 점검(원격 curl 승인 없음) — 사용자 확인 필요.
- 수정 (2026-11-19): www.peopleos.site에서 "등록되지 않은 리디렉션 주소" → DCR 재등록(redirect URI 3개: peopleos.site·www·workers.dev), 새 client_id를 wrangler.toml에 반영, 허용 목록에 www 추가. 배포 **`d4309463-2ba7-4d7b-a170-128707e0c371`**. 브라우저 재확인 필요.
- GitHub 푸시 안 함. 상세: `files/workflow-verify/plaud-integration/RESULT.md`.
- 진단 (2026-11-19, 빈 목록 원인 확정용·임시): 마이그레이션 0034(`plaud_accounts.workspace_id`) 원격 적용, `/complete`·`/files`에서 get_current_user의 workspace_id 저장 + `/files`가 list_files 구조(keys·data_len)만 로그. 배포 **`f95498b7-7fe9-40fa-8271-6aff1cb77e68`**. 원인 확정 후 정리 예정.
- 수정 (2026-11-19, 빈 목록): Plaud MCP 응답 text에 인젝션 방어 래퍼가 붙어 JSON.parse 실패 → `call()`이 가장 바깥 {…}를 추출해 재파싱(`parseToolText`). 배포 **`fe744d0b-56f4-415b-8111-7385555d20ae`**. 브라우저에서 목록 20건 확인 필요.
- 수정 (2026-11-19, 행 레이아웃 + 오디오 fetch): `.taskrow`에 `flex-wrap:wrap`(오류 메모가 제목 폭을 0으로 눌러 한 글자씩 개행되던 문제) + `fetchAudio` `redirect:"follow"` 및 오류 이름/메시지 로그. 배포 **`ef4a4809-a122-4391-8a11-df4a67c416ec`**. 브라우저에서 첫 행 한 줄 표시·가져와서 전사하기 확인 필요.
- 기능 (2026-11-19, 전사 없는 녹음): "가져와서 전사하기" — get_file presigned_url(5분)을 즉시 fetch → R2 recordings/<id>/ → 기존 Whisper 전사(advanceRecording) → 완료 시 출처 머리말 붙은 개인 문서 + 파이프라인 큐 색인. 마이그레이션 0035. 배포 **`6690e643-0575-4e68-8a0f-fda41279c188`**. 브라우저에서 2026-10-31 17:03:08 녹음으로 확인 필요.
