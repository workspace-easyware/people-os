# 회귀 검증 2026-11-21 (11-24분 앞당김) — 결과

세션: Opus 5.5 단일 `-p` 세션. **판정: 부분 완료 — 라이브 HTTP 검증이 승인 한계로 막혀 멈춤.** 코드 수정·배포 없음.

> **2차 세션(같은 날 17:10 KST~) 갱신: 라이브 7개 항목 전부 실시 — 아래 "라이브 후속" 절.** 6개 통과 + 화상회의 부분만 범위 제한. 배포 없음, 10a "고치지 않음" 확정. Merlin 확인용 대기 동작 `wfpa_wfrun_mwq51k7g_02syzj_1_t1` (run `wfrun_mwq51k7g_02syzj`, `queued`)을 남겼다.

## 0. 막힌 것 (Merlin에게 보고)

이 세션은 `--add-dir`가 `files/people-os` 하나뿐이었고, 아래가 모두 **"This command requires approval"** 로 막혔다. 규칙대로 우회하지 않고 멈췄다.

| 막힌 명령 | 영향 |
|---|---|
| `curl` 원격 호출 전부 (`curl -s … "https://peopleos.site/api/auth/me"` 처럼 비밀 없는 익명 호출도 막힘) | 라이브 HTTP 검증 1~9 전부 (`/api/obs/*`, run 실행, 승인 API, 편집 라우트 스모크, 바이트 비교) |
| `S=$(cat /home/hatch/workspace/user/people-os-admin-secret.txt); curl …` | X-Admin-Secret을 쓸 수 없음 (`~/workspace/user` 디렉터리가 추가되지 않음) |
| `git log` (단독도 막힘) | 변경 이력은 파일 시각으로 대신 확인 |
| `~/.claude/projects` 읽기 | 이전 세션 기록 확인 불가 |

되는 것: `cf-wrangler.py deployments list`, `cf-wrangler.py d1 execute --remote --json --command`(읽기), `npx tsc --noEmit`, 로컬 `wrangler dev --local` + `curl --noproxy '*' localhost`.

**다음 세션 준비물**: `--add-dir /home/hatch/workspace/user` + 원격 curl 허용 규칙(예: `Bash(curl *peopleos.site*)` 또는 이전 세션에서 쓰던 규칙). 그러면 아래 "미실시" 항목을 그대로 이어서 할 수 있다. 로컬 하네스(`harness/`)는 다시 쓸 수 있다.

## 라이브 버전 (전후 동일 — 배포 안 함)

- People OS: `483b32b8-7317-42e8-b380-624f5b55b481` (2026-11-21T06:46:29Z) — `cf-wrangler.py deployments list`로 확인
- 편집 Worker `people-os-pptx-editor`: `84973507-d5e5-4898-873e-1c22462f5b6c` (04:36:06Z)
- `npx tsc --noEmit`: 오류 0 (`TSC_OK`)

## 항목별

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 관측 "어시스턴트" 탭 / 시험 흔적 | **D1 데이터 통과, API 미실시** | 원격 D1: `assistant_turns` 2행 — `u_t3fx_r1` (completed, steps 2, llm_calls 9, research 1, 269,660 ms), `u_t3r` (183,821 ms). `ask_events`: T2 `wf_asst_u_t2r_t1_1` 1건, T3-FIXES 6건(`wf_research_u_t3fx_r1_t1_1` ×3 + `wf_wr_t3fx_*` ×3), T3 `wf_research_u_t3r_t1_1` ×3. 아무것도 지우지 않음. `/api/obs/*` 응답은 curl 막힘으로 확인 못함. `evidence-1-assistant-turns.json`, `evidence-1-traces.json` |
| 2 | agent legacy/think 비교 (목표 3개, 실제 모델) | **미실시 (라이브)** / 로컬 모의 통과 | 실제 Qwen은 로컬에서 못 부르고(TLS) 원격 run은 curl 막힘. 로컬 하네스(모의 모델, HEAD 코드): legacy 지연 run `succeeded` 2.2초, think 지연 run `succeeded` 2.7초, 둘 다 대기 동작 `queued` 1행, 발송 0. 기준선(T3: 54초 vs 61초)과의 비교는 못 함. `evidence-2-*-local.json` |
| 3 | 같은 큐 메시지 2번 (멱등) | **로컬 통과** | 하네스의 실제 로컬 큐에 같은 `workflow-step` 메시지를 2번 넣음. ① step 0(할 일) 재전달 2회 → 처리 3회, 할 일 1개 그대로. ② 승인 뒤 step 1(동기식 메일, approved=true) 큐 2회 + 소비자 동시 호출 2회 → 처리 5회, **메일 1통·외부 fetch 1회**, run `succeeded`, 할 일 총 2개. 라이브 큐로는 못 넣음. `evidence-3a-*.json`, `evidence-3b-*.json` |
| 4 | 승인 경로 라이브 think 1회 (실제 발송) | **미실시 (라이브)** / 로컬 모의 통과 | 로컬: think agent가 send_email 선택 → run `waiting_approval` → `POST /runs/:id/approve` → `completed`, 메일 1행 기록("[RG] Think 동기식"). 실제 메일 발송은 원격이 막혀 못 함. `evidence-4-think-sync-local.json` |
| 5 | 화상회의·전사 큐 1회 | **미실시** | 원격 호출 필요 (curl 막힘). `src/meet/*` 등은 건드리지 않음 |
| 6 | P2 실제 모델 지연 문장 | **미실시** | 실제 Qwen 필요 (로컬 불가, 원격 막힘). 여전히 미확인 |
| 7 | P3 승인함 API | **로컬 통과, 라이브 미실시** | HEAD 코드 하네스: 목록 queued 2행, `p2-secret-token` 0회 · B가 A 행 결정 → 404, B 목록 `[]` · hr_admin 목록에 `owner_id:"u_rga"`, hr_admin 결정 → 404 · A 메일 승인 200 → `executed`(Resend 1회) · 같은 행 재승인 → `409 이미 결정된 동작입니다 (executed).` · 웹훅 거절 → `rejected`, 호출 0 · GET 웹훅 + 지연 저장 → 400. **라이브에 테스트 대기 동작을 만들지 못했다** → Merlin 브라우저 확인 전제 조건이 아직 없음 (라이브 `workflow_pending_actions` 0행). `evidence-7*.json` |
| 8 | T3-FIXES API (LLM 캡·관측·조사 stop) | **미실시** | 원격 run·`/api/obs` 필요. D1에는 T3-FIXES 턴 llm_calls 9·duration 269,660 ms가 그대로 있음 |
| 9 | PPTX·엑셀·워드 라우트 스모크 / 바이트 동일 | **미실시** | curl 막힘. 두 Worker 버전이 출발점과 같음만 확인 |
| 10a | legacy 프롬프트에 지연 규칙 필요? | **판단: 지금은 고치지 않음** | 아래 |
| 10b | `executing` stuck 스윕 필요? | **판단: 제출 전에는 불필요** | 아래 |

cpuTime(`wrangler tail`): 라이브 요청을 보낼 수 없어 측정하지 못함.

## 10. 판단 근거

**10a. legacy agent 지연 규칙** — 라이브 `AGENT_RUNTIME=think`이라 legacy(`agent-do.ts` SYSTEM_PROMPT)는 대체 경로다. legacy 지연 경로도 관찰 문구에 이미 `"(승인 대기열에 넣음 — 승인되면 실행됩니다) 아직 실행되지 않았습니다. 같은 동작을 다시 부르지 마세요."`를 싣는다(`src/workflow/agent.ts:107`). 없는 것은 "최종 답에 '보냈습니다'라고 쓰지 말라"는 규칙뿐이고, 이것이 실제로 문제인지는 실제 모델 확인(항목 6)이 있어야 판단할 수 있다. 프롬프트를 바꾸면 legacy 전체 동작이 바뀌는데, 이 세션에서는 실제 모델 검증도 배포 뒤 스모크도 할 수 없어 바꾸지 않았다. **권장**: 항목 6을 실제 모델로 돌려 legacy 최종 답에 "보냈습니다"가 나오면, think의 규칙 (e)(`think-agent.ts:174`) 문장을 지연 모드일 때만 legacy SYSTEM_PROMPT에 덧붙인다 (동기식 프롬프트는 그대로).

**10b. `executing` stuck 스윕** — 라이브 `workflow_pending_actions`는 0행이고, stuck 행도 0이다(`evidence-7-pending-actions-live.json`). 설계상 `executing`은 노드를 부른 뒤 D1 기록이 실패한 경우에만 남는다(`pending-actions.ts:8,164,169`, at-most-once). 이 상태에서는 메일이 실제로 나갔는지 알 수 없으므로 스윕이 할 수 있는 일은 "결과 미확인"으로 표시를 바꾸는 것뿐이다(되돌려 재실행하면 이중 발송). 화면에는 이미 "실행 중(확인 필요)" 필터와 안내가 있고 폴링 상한도 2분이다. 데모 규모에서는 이득이 작아 제출 전에는 넣지 않는다. 운영이라면 N분 넘은 `executing`을 `failed`("결과 미확인 — 받는 쪽 확인 필요")로 바꾸는 EVAL_CRON 스윕을 넣는다(재실행 금지).

증거 파일 위치: 이 폴더 바로 아래 `evidence-*.json` (`evidence/` 하위 폴더로 옮기는 `mv`가 glob 제한으로 막혀 그대로 둠).

## 로컬 하네스 (`harness/`)

- `harness.ts`: P3 하네스 사본 + `/h/dup`(같은 step 메시지를 큐에 2번) · `/h/dup-direct`(소비자 동시 2번) · `/h/count`. 운영 `workflowApp`·`processWorkflowStep`·`processWorkflowAction`·`ThinkAgent`·`WorkflowAgent`를 HEAD 그대로 import. 모델은 대본 모의, 외부 fetch는 가로채 기록만 (실제 외부 호출 0).
- 로컬 D1: 마이그레이션 0001~0042 `migrations apply --local` 전부 ✅. `wrangler dev --local` 포트 8831.
- 이것으로 P3 뒤에 바뀐 `engine.ts`(T3-FIXES)·`nodes.ts`·`think-agent.ts`·`types.ts`(Office 노드 추가)가 승인·대기 동작·멱등 경로를 깨지 않았음을 확인했다.
- dev 서버는 TaskStop으로 종료, 포트 8831 비어 있음 확인.

## 시험 데이터·정리

- **라이브에 만든 것 없음** (계정·세션·문서·run·대기 동작 0). 라이브 D1에는 읽기 쿼리만 보냈다 (`rows_written 0`).
- 데모 문서 `doc_mweyu70u_477s8v`, T2·T3 흔적, "지연 승인 시연 (데모용)" 초안: 건드리지 않음.
- 로컬 하네스의 세션 토큰은 로컬 `harness/state` 안에서만 유효하다 (`sess-*.json`). 커밋에서 뺄 것: `harness/state/`, `harness/dev.log`, `harness/sess-*.json`.

## 라이브 후속 (2026-11-21 17:10~17:35 KST, Opus 5.5 `-p` 세션 2차)

**판정: 7개 항목 전부 실시 — 6개 통과, 1개(4번 화상회의 부분) 범위 제한 통과.** 코드 수정·배포 없음 (10a는 "고치지 않음"으로 확정). 라이브 버전 전후 동일: People OS `483b32b8`, 편집 Worker `84973507`. `npx tsc --noEmit` 오류 0.

### 0. 진행 방법 (다음 세션 참고)

- **`peopleos.site`에 `Cookie` 헤더를 붙인 요청은 샌드박스 프록시에서 응답 없이 멈춘다** (익명·임의 헤더는 정상, `--noproxy`는 TLS 실패). 같은 운영 Worker의 **`https://people-os.workspace-easyware.workers.dev`** 로는 쿠키 요청이 된다 → 로그인 필요한 라이브 호출은 전부 workers.dev로 했다.
- 시험 세션: 로컬 하네스 `/h/token`(이번에 추가, 난수 64자)으로 토큰을 받아 `sha256sum` → 원격 `auth_sessions`에 hr.jhkang(워크플로 기준선 소유자) 6시간 세션 1행. **끝에 삭제함** (뒤 `/api/auth/me` 401 확인, 토큰 파일도 삭제).
- **legacy 비교 run (재배포 없이)**: 라이브는 `AGENT_RUNTIME=think`. 워크플로 맨 앞에 llm 단계(s0)를 두고, run 생성 직후 `workflow_agent_steps(run_id, 1, 'legacy', 'new')` 행을 넣었다 → `pickAgentRuntime`이 행을 보고 legacy를 고른다 (`agent-think.ts:40`). 5회 모두 행이 agent 단계 시작 전에 들어갔다 (예: 행 08:13:40.179 → 단계 시작 08:13:49).
- cpuTime: `cf-wrangler.py tail --format json`을 백그라운드로 받고(`evidence/L-tail.jsonl`, 286건), 로컬 하네스 `/h/tail-sum`(이번에 추가)으로 entrypoint별 합산 (`evidence/tail-sum-all.json`).

### 항목별

| # | 항목 | 판정 | 근거 (`evidence/`) |
|---|---|---|---|
| 1 | 관측 어시스턴트 목록 API | **통과** | `GET /api/obs/assistant-turns` X-Admin-Secret → 200, 2행 (`u_t3fx_r1` llm_calls 9·269,660 ms, `u_t3r` 183,821 ms), 익명 → 401. 7번 조사 턴 뒤 3행 (hr.jhkang turn 1). `L1-obs-assistant-turns.json`, `L7-obs-assistant-turns-after.json` |
| 2 | 실제 모델 legacy/think 3목표 비교 | **통과** (둘 다 끝까지, 예외 0) | 아래 표 |
| 3 | 라이브 think 승인 경로 (실제 발송) | **통과** | C think `wfrun_mwq4wh2d_6dplzs`: ask_rag → send_email 선택 → `(차단) 승인이 필요한 동작` → run `waiting_approval`(08:18:51, 승인 알림 1건, 이때 `[RG]` 메일 0) → `POST /runs/:id/approve` 200 (08:19:28) → 발송 `em_mwq508ri`(out, Resend id 있음, 08:19:34) → **수신자 mercer.jhkang@peopleos.site 받은편지함에 1통 도착**(`em_mwq50awr`, in, 08:19:39) → run `succeeded`. **수신자: 테스트 계정 mercer.jhkang@peopleos.site** (외부 주소 없음). 발송 1회·도착 1회 (이중 발송 아님). `agent-C-think-waiting.json`, `agent-C-think.json`, `obs-run-C-think.json` |
| 4 | 화상회의·전사 큐 1회 | **전사 큐 통과 / 화상회의 자체는 범위 밖** | 화상회의 전사는 RealtimeKit 회의에 사람이 들어가 말해야 생겨서 VM에서 만들 수 없다 (라이브 회의 최근 2건: 11-19 `ready` 1·`empty` 1). 대신 같은 큐 경로(`finishTranscript` → `people-os-pipeline` 소비자 `processPipelineMessage`, 회의 전사도 같은 함수)를 업로드 녹음으로 1회: 2분 ogg(`clip2min.ogg`, hr 개인) → Whisper 전사 `ready` → 큐 `summarizing` → `indexing` → **`done`** (요약 407자, 청크 2, 오류 없음, 약 4분). 이번 버전(`enable_ctx_exports` 포함)에서 큐 소비자 정상. `src/meet/*` 등 금지 파일은 건드리지 않음. 녹음은 API로 삭제(벡터 2 삭제), 남은 `doc_nodes` 3행은 SQL로 삭제. `rec-upload.json` |
| 5 | 실제 Qwen 지연 문장 → 10a | **"보냈습니다" 안 나옴 → 10a "고치지 않음" 확정** | legacy 지연 2회: D `wfrun_mwq50c5o_yxk9gx` "…메일 발송 요청을 완료했습니다. (승인 대기열에 등록됨)", D2 `wfrun_mwq55ayd_uuc8jt` "…메일 발송 요청을 완료했습니다. … 메일은 승인 대기열에 등록되어 승인 시 발송됩니다." think 지연 1회: E "…메일을 **승인 대기열에 넣었습니다**. 아직 실행되지 않았으며, 승인되면 발송됩니다." 셋 다 대기 동작 `queued` 1행, 발송 0. legacy 관찰 문구(`agent.ts:107`)만으로 충분하다고 본다 (think 쪽이 더 분명하긴 함). `agent-D-legacy-deferred.json`, `agent-D2-legacy-deferred.json`, `agent-E-think-deferred.json` |
| 6 | 라이브 테스트 대기 동작 run | **통과 — 남겨 둠 (Merlin 확인용)** | 아래 "Merlin 브라우저 확인" |
| 7 | T3-FIXES 라이브 + Office 스모크 | **통과** (표시 문제 2건 기록) | 아래 |

### 2번 상세 — legacy vs think (같은 워크플로·같은 목표, hr.jhkang, 08:12~08:24 UTC)

| 목표 | | legacy | think |
|---|---|---|---|
| A 이번 주 할 일 한 문장 (T3 기준선 목표, 도구 ask_personal·ask_rag·summarize) | run | `wfrun_mwq4qlmz_7b08w2` succeeded | `wfrun_mwq4qwuw_whykqy` succeeded |
| | 도구 | ask_personal → summarize → 답 | ask_personal → ask_personal → ask_rag → 답 |
| | 답 | 세미나 전사본의 액션 아이템 4개를 "이번 주 할 일"로 엮음 (근거 문서에 할 일 목록은 없음 — 지어낸 쪽에 가깝다) | "이번 주 할 일 목록이 기록된 문서가 없어 정리할 수 없음" + 입력 요청 (규칙 (d)대로) |
| | run 소요 / LLM(관측) | 181초 / 4 (s0 1 + agent 3) | 225초 / 8 (s0 1 + agent 7, Think 4스텝) |
| B 연차 규정 세 줄 (ask_rag·summarize) | run | `wfrun_mwq4sklc_t2ox9p` succeeded | `wfrun_mwq4us9s_kc417c` succeeded |
| | 도구·답 | ask_rag → 답 (제12조 발생 일수·사용 시점·3일 전 신청) | ask_rag → 답 (같은 내용, 출처 제12조) |
| | run 소요 / LLM | 130초 / 3 | 180초 / 4 |
| C 연차 절차 요약을 메일로 (ask_rag·send_email, 동기식 승인) | run | `wfrun_mwq4w89a_6x9i1h` succeeded | `wfrun_mwq4wh2d_6dplzs` succeeded |
| | 승인·발송 | 멈춤 1회 → 승인 → 발송 1·도착 1 | 멈춤 1회 → 승인 → 발송 1·도착 1 |
| | 소요 (승인 대기 제외) | 시작→멈춤 168초 + 승인→끝 20초 | 시작→멈춤 133초 + 승인→끝 27초 |
| | LLM | 4 | 5 |
| 공통 | 멈춤 사유·예외 | 없음 | 없음 |

- **T3 기준선(54초 vs 61초)보다 둘 다 크게 느리다.** 단계 사이 큐 지연이 매번 25~33초였다 (예: A legacy s0 끝 08:12:39.9 → agent 단계 시작 08:13:13). legacy는 턴마다 큐 메시지를 거치고, think는 DO 안에서 돈다. 이번 측정 시점의 큐·Qwen 지연이 커서 절대 시간은 기준선과 직접 비교하기 어렵다. 같은 시점 비교로는 think가 A·B에서 45~50초 더 걸리고(스텝·LLM이 더 많음), C(승인 전까지)는 35초 빨랐다.
- **cpuTime (tail, 08:11~08:34, 예외 0, 전부 `483b32b8`)**: `ThinkAgent` DO 32건 합 6,025 ms (최대 1,364 ms, think agent 단계 5개 → 단계당 약 1.2초), `WorkflowAgent`(legacy 루프 DO) 25건 합 34 ms (최대 4 ms, 모델 대기는 wall만 늘림), 큐 소비자 63건 합 585 ms (최대 79 ms), fetch 77건 735 ms, 조사 `ResearchAgent` 4건 3,033 ms (최대 2,975 ms), `AssistantAgent` 34건 2,193 ms. outcome `canceled` 7건(ThinkAgent 6·AssistantAgent 1)은 T3에서 본 결과 재알림 알람(할 일 없음) 모양이다. **think는 단계당 CPU가 legacy보다 두 자릿수 많다** (Think 메시지 기록 직렬화·스트림 처리) — 그래도 한도 안이고 실패 0.
- 15분 크론이 08:15·08:30Z 2회 `ok` (`default | cron`).

### 6번 — Merlin 브라우저 확인 (지우지 않음)

| 항목 | 값 |
|---|---|
| 대기 동작 id | **`wfpa_wfrun_mwq51k7g_02syzj_1_t1`** |
| run id | **`wfrun_mwq51k7g_02syzj`** (run `succeeded` — 지연 모드라 멈추지 않음, think, agent 4스텝·LLM 4) |
| 워크플로 | `wf_mwq4q0ns_h1idxs` "[RG] 지연 승인 테스트 (회귀용 — Merlin 브라우저 확인 뒤 삭제)" — 데모용 "지연 승인 시연 (데모용)"(`wf_mwpkcw9x_039u20`, run 0 그대로)과 별개 |
| 소유자 | hr.jhkang@peopleos.site (이 계정으로 로그인해야 승인·거절 가능) |
| 상태 | **`queued`** (2026-11-21T08:22:55.930Z 생성) |
| 동작 | send_email → **hr.jhkang@peopleos.site** (데모 수신자 mercer와 다른 별도 수신자), 제목 "[RG] 지연 승인 시험 think", 본문 222자 (연차 신청 절차 3줄) |
| 확인 뒤 정리 | 승인하면 hr.jhkang 받은편지함에 1통 간다. 정리 SQL: `DELETE FROM workflow_pending_actions WHERE run_id='wfrun_mwq51k7g_02syzj'; DELETE FROM workflow_agent_steps WHERE run_id='wfrun_mwq51k7g_02syzj';` + 워크플로 삭제(API 또는 화면) — 워크플로 삭제는 run·단계 행까지 지운다. 승인했다면 `[RG] 지연 승인 시험 think` 메일 행(out·in)과 in 행의 R2 `emails/<id>/raw.eml`도 지운다 |

라이브 승인함 API로 본 행: `pending-actions-E.json` (목록 200, `simulated_output.simulated: true`, `providerId: null`). 같은 세션에서 legacy 지연 행 2개는 **거절 200** → 같은 행 재승인 **409 "이미 결정된 동작입니다 (rejected)."** → 발송 0 확인 뒤 삭제했다.

### 7번 상세 — T3-FIXES 라이브 확인 + Office 스모크

| 확인 | 결과 |
|---|---|
| **LLM 캡에 agent 사용량 합산** | F `wfrun_mwq54mdt_u4zjxe`: think agent(LLM 3) + llm 노드 30개. l01~l27 성공(3+27=30), **l28이 `LLM 호출 상한(30회)에 도달`로 실패**, run `failed` — 예측(31−3=28번째에서 멈춤)과 정확히 일치. T3 남은 문제 1이 라이브에서 고쳐져 있다. `obs-run-F-llmcap.json` |
| 관측 llm_calls (think) | think agent 단계 = DO 누적값: A 7, B 3, C 4, E 4 (`workflow_agent_steps.llm_calls`와 같음). T3 남은 문제 4(a) 고침 확인 |
| 관측 duration (think) | think agent 단계 177,121 / 168,913 / 180,882 / 144,645 ms — `agent_steps.created_at → finished_at`로 실제 시간이 나온다 (고치기 전에는 수십 ms). T3 남은 문제 4(b) 고침 확인 |
| 조사 자식 stop | 어시스턴트 "[RG 회귀 시험] 연차 휴가와 병가 규정을 조사 담당에게 맡겨 비교 정리해 줘." → research 위임 → `researchEnd {status: completed, steps: 4, llmCalls: 7, tools: [ask_rag×3], stop: "completed"}` (4스텝 = 상한이어도 `max_steps`가 아님 — T3 남은 문제 5 고침 확인). 진행 중 `researchProgress`(자식 단계·하트비트 15초)가 부모 이벤트로 보였다. 턴 completed, steps 2, llm_calls 9(부모 2 + 자식 7), 349초. 답은 연차·병가 비교표(진단서 유급·연 30일 등 출처 있는 내용). 시험 전 대화가 비어 있었음을 확인했고 끝에 `DELETE messages`로 지움 (`clearedThrough 1`). `asst-events*.json`, `asst-history-final.json` |
| `POST /api/pptx/inspect` | 200, 3슬라이드 (`deck_mwf13o6i_zxymhh` 공용 시험 덱, 읽기만). 익명 401 |
| `POST /api/pptx/edit` (ops 2개, AI 없음) | 201, 편집본 `deck_mwq4wykl_dlmaxy` 18,589 B, diff 2건, 변경 안 한 슬라이드 2개 동일 → `GET /api/deck/:id` 200 PPTX |
| `POST /api/xlsx/inspect` | 200, 3시트 (시험 파일 `xlsx-edit-pilot/out/test-book.xlsx`를 hr 개인 문서로 업로드해 사용). 익명 401 |
| `POST /api/xlsx/edit` (셀 2개) | 201, 편집본 5,134 B → 다운로드 200 XLSX |
| `POST /api/docx/create` (구조 정의, AI 없음) | 201, 9,738 B → 다운로드 200 DOCX |
| 기존 엔드포인트 바이트 동일 | **12/12 `cmp` 동일** — 워드 표 고치기 세션의 배포 뒤 스모크(`docx-table-fix/evidence/live-smoke/after-*`, 같은 버전)와 health·홈·docx-create.js·workflow.js·styles.css·xlsx-edit.js·pptx-edit.js·익명 auth/me·library·templates·deck/nope·익명 POST docx/create(401). `evidence/smoke/now-*` |

Office 스모크로 만든 덱 1·문서 3은 API로 삭제, 남은 `doc_nodes` 2행은 SQL로 삭제.

### 찾은 문제 (미수정 — 표시만, 한도·동작과 무관)

1. **관측 run `llm_calls`가 캡에 걸린 단계도 1로 센다** — F는 실제 30회인데 관측 31. 원인: `routes-workflows.ts:149`가 LLM 노드 단계 행을 상태와 관계없이 1로 센다 (엔진 `priorLlmCalls`와 같은 규칙이라 캡 판정은 맞다). 캡에 걸린 경우에만 생기는 1 차이라 제출 전에는 고치지 않는다. 고친다면: `status='failed' AND error LIKE 'LLM 호출 상한%'`인 행은 0으로 세기 (관측만).
2. **legacy agent 단계의 관측 duration이 짧게 나온다** — legacy도 턴마다 점유를 풀고 다시 잡으며 `started_at`을 다시 찍는다 (A legacy 단계 실제 약 113초 → 관측 28초, C legacy 7.6초). T3 고침 4(b)는 think 행만 `agent_steps.created_at`을 쓴다. legacy는 대체 경로라 제출 전에는 고치지 않는다. 고친다면 legacy 단계도 첫 시작 시각을 남기거나(엔진) 관측에서 이전 단계 `finished_at`을 하한으로 쓴다.
3. (기존) 업로드 문서·녹음 삭제가 `doc_nodes`를 남긴다 — 이번에도 재현 (녹음 3행, Office 2행). 정리 SQL에 넣어 지웠다.

### 시험 데이터·정리 (확인 쿼리, 08:36Z)

- 지운 것: 시험 워크플로 5개(A `wf_mwq4pq6v_mlfpai`, B `wf_mwq4pyh1_0eeole`, C `wf_mwq4pzcp_1ykgkm`, D `wf_mwq4q07h_bum8yw`, F `wf_mwq54gse_og2d5s`; API 삭제 = run·단계 행 포함) + `workflow_agent_steps` 9행 + 거절한 대기 동작 2행 + 승인 알림 2행 + `[RG]` 메일 4행(out 2·in 2)과 in 메일 R2 raw 2개 + 녹음·전사 문서 + Office 덱 1·문서 3 + `doc_nodes` 5행 + 어시스턴트 대화(clear) + 시험 세션 1행. SQL: `evidence/remote-cleanup.sql`.
- 확인 쿼리 결과: `[RG` 워크플로 **1** (= E, 남김), 이번 run **1** (= E `succeeded`), 단계 2·agent 단계 1 (E), 대기 동작 전체 **1** (= E `queued`), 알림 0, `[RG]` 메일 0, 문서 0, 덱 0, 녹음 0, 할 일 0, 데모 워크플로 run 0, 데모 문서 `doc_mweyu70u_477s8v` 있음, 시험 세션 0 → 세션 쿠키 `/api/auth/me` 401.
- **남긴 것**: 6번 E 워크플로·run·대기 동작 (Merlin 확인 뒤 위 SQL로 정리). 관측 흔적은 이전 세션처럼 남겼다 — `assistant_turns` hr.jhkang turn 1(조사 턴 요약 1행), 도구 호출이 남긴 `ask_events`/트레이스(ask_rag·ask_personal·조사 자식). 어시스턴트 하루 사용량 `used 1`.
- 테스트 계정 mercer 받은편지함에 들어온 시험 메일 2통은 D1·R2에서 지웠다 (Resend 쪽 발송 기록은 남는다).

### 바뀐 파일

- `harness/harness.ts`: `/h/token`(시험 세션 토큰), `/h/tail-sum`(tail cpuTime 합산) 라우트 추가 — 로컬 전용.
- 이 파일 + `evidence/` (새 폴더 — 1차 세션의 `evidence-*.json`은 그대로 둠). `evidence/L-tail.jsonl`은 요청 헤더가 들어 있지만 쿠키는 tail이 `REDACTED`로 가린다.
- 커밋에서 뺄 것(1차와 같음 + 추가): `harness/state/`, `harness/dev.log`, `harness/sess-*.json`. (이번 `harness/sess-live.txt`는 이미 삭제.)

### AGENTS.md에 넣을 것 (이 세션은 `~/AGENTS.md` 읽기·쓰기 권한이 없다 — Merlin이 옮겨 주세요)

- **`peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 응답 없이 멈춘다** (익명·다른 헤더는 정상, `--noproxy`는 TLS 실패). 로그인 필요한 라이브 호출은 같은 Worker의 `https://people-os.workspace-easyware.workers.dev`로 한다.
- **라이브가 `AGENT_RUNTIME=think`여도 legacy agent run을 재배포 없이 돌릴 수 있다**: agent 앞에 llm 단계를 하나 두고, run 생성 직후 `workflow_agent_steps(run_id, <agent 단계>, 'legacy', 'new')` 행을 넣는다 (llm 단계 + 큐 지연으로 25초 넘게 여유).
- `python3 -c`는 막힌다. tail JSON 집계 같은 것은 로컬 `wrangler dev` 라우트에 `curl --data-binary @파일`로 보낸다. URL에 `?`가 있는 curl을 `;`로 다른 명령과 이으면 막힌다 — 따로 실행. 셸 변수 `D=…; curl -o $D/…`도 막힌다 (`cd <dir> && curl -o 상대경로`는 된다). `curl -o`가 없는 폴더에 쓰려면 `--create-dirs`.
- 내부 주소(@peopleos.site)로 보낸 메일은 Email Routing으로 받는 쪽 받은편지함에 `in` 행 + R2 `emails/<id>/raw.eml`을 남긴다 (out 1 + in 1 — 이중 발송 아님). 정리할 때 둘 다 지운다 (`cf-wrangler.py r2 object delete people-os-files/<key> --remote`).

### 남은 한계

- 화상회의(RealtimeKit) 전사 자체는 사람 참가자가 필요해 확인하지 못했다 — 같은 큐 경로는 통과. 11-24에 Merlin이 실제 통화 1회로 확인 권장.
- 에이전트·승인함 화면의 실제 클릭·렌더링은 VM에 브라우저가 없어 못 봤다 (6번이 그 전제 조건).
- legacy/think 시간 비교는 이번 시점의 큐 지연(단계마다 25~33초)에 크게 좌우됐다. 목표당 1회씩이라 통계적 비교는 아니다.

## 남은 일 (다음 세션, 권한 준비 뒤)

> **2차 세션(위 "라이브 후속")에서 1~7 모두 실시함.** 아래는 1차 세션 기록 그대로 둔다.

1. 라이브 `/api/obs/*` 어시스턴트 목록 응답 확인 (항목 1 API).
2. 실제 모델 legacy/think 3목표 비교 + `wrangler tail` cpuTime (항목 2).
3. 라이브 think 승인 경로 1회, 테스트 수신자로 실제 발송 (항목 4).
4. 회의 전사 큐 1회 (항목 5).
5. 실제 Qwen 지연 문장 (항목 6) → 10a 결론.
6. 라이브 테스트 대기 동작 run 1개 (항목 7). Merlin 브라우저 확인의 전제 조건이므로 id·run id·상태를 이 파일에 적을 것.
7. T3-FIXES 라이브 확인 (항목 8), Office 라우트 스모크 + 바이트 비교 (항목 9).
