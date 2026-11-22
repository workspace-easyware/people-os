# Word AI 지시 Queue 이동 — 결과 (2026-11-22, Fable 5.2)

Word 새로 만들기·기존 파일 편집의 자연어 지시 경로를 Queue로 옮겼다. 요청은 1~2초 안에 202 + 작업 id로 돌아오고, 화면이 2초마다 상태를 물어 끝나면 문서를 보여 준다. 라이브에서 168초 걸린 생성(계획 2회)도 오류 없이 `done`으로 끝났다. 구조화 입력은 예전처럼 바로 201이다.

- **라이브 버전: People OS `48544fec-b03f-4ced-9c6b-43908cd72c95`** (그 전 단계 `0f8b0589`는 같은 날 대체됨). 문서 편집 Worker는 그대로 `1dd93ed7` (배포 안 함).
- **D1 마이그레이션: `0043_docx_jobs.sql`** — 원격에 `d1 execute --remote --file`로 적용하고 `d1_migrations`에 기록했다 (`migrations list --remote` → "No migrations to apply").
- **새 Cloudflare 자원: Queue `people-os-docx-jobs`** (`cf-wrangler.py queues create`로 만듦).
- 커밋·태그·푸시는 하지 않았다. `ARCHITECTURE.md`·`VERIFICATION.md`는 건드리지 않았다.
- `npx tsc --noEmit` 0건, `node --check public/docx-create.js`·`public/docx-edit.js` 통과.

## 1. 설계

### 흐름

1. `POST /api/docx/create` (정의 없이 `instruction`만) 또는 `POST /api/docx/edit` (`ops`·`replace` 없이 `instruction`만)
   → AI를 부르지 않는 **사전 검사** (입력 모양·상한, 생성은 이미지 권한·형식·크기, 편집은 원본이 있는지·읽을 권한·.docx인지). 여기서 걸리면 예전과 같은 4xx를 바로 돌려준다.
   → `docx_jobs` 행 생성 + Queue에 `{type:"docx-job", jobId}` → **202** `{ok:true, queued:true, job:{id, kind, status:"queued", statusUrl, pollMs:2000}}`.
2. Queue 소비자(`queue()` → `processDocxJob`)가 Qwen 계획 호출 → 문서 생성/편집 → `documents` 새 행 + R2 저장 → 작업 `done`.
3. 화면은 `GET /api/docx/jobs/:id`를 2초마다 부른다. `done`이면 `result`(예전 201 응답과 같은 모양)를 받아 예전과 같은 결과 화면을 그리고 문서 목록을 갱신한다. `failed`면 `job.error`(한국어)를 보여 준다.

구조화 입력(정의·개요·ops·replace)은 Queue를 타지 않는다. 정의와 지시를 함께 준 요청은 예전처럼 400.

### Queue: 전용 큐 `people-os-docx-jobs` (바인딩 `DOCX_JOBS`)

처음에는 과제대로 기존 `people-os-pipeline`을 재사용해 배포했다 (`0f8b0589`). 라이브에서 **앞 작업이 도는 동안 뒤에 넣은 메시지 2개가 26초 대기**하는 것을 봤다 (소비자 동시 실행이 바로 늘지 않는다). 같은 큐를 쓰면 1~5분짜리 Word 작업이 전사 파이프라인·워크플로 단계를 그만큼 밀어낸다. 그래서 전용 큐로 나눴다 (`48544fec`).

- 소비자 설정: `max_batch_size = 1`, `max_batch_timeout = 1`, `max_retries = 3`, DLQ는 기존 `people-os-pipeline-dlq`를 같이 쓴다.
- 소비자는 같은 `queue()` 핸들러다 (메시지 `type`으로 가른다). `docx-job`은 먼저 시작만 해 두고 다른 메시지를 차례로 처리한 뒤 모아서 기다리게 해, 혹시 한 배치에 섞여도 다른 메시지를 막지 않는다.

### 상태 테이블 `docx_jobs` (migration 0043)

`id, kind(create|edit), status, owner_id, doc_id, source_doc_id, input_json, result_json, error, error_status, attempts, created_at, started_at, finished_at` + 인덱스 2개.

- 상태: `queued` → `running` → `done` | `failed`. 일시적인 AI 실패로 다시 시도할 때는 `queued`로 돌아간다 (`attempts`가 시도 횟수, 응답에 `retrying: true`).
- 조회 권한: 본인 작업만 (hr_admin·운영 비밀은 전부). 남의 작업·없는 작업은 같은 404, 익명은 401.
- `input_json`에 지시 글이 들어 있어 15분 크론이 **7일 지난 행을 지운다**.
- 한 사람이 동시에 돌릴 수 있는 작업은 3개 (넘으면 429 `too_many_jobs`).

### 멱등성 (작업 id 기준)

- **새 문서 id를 작업을 만들 때 미리 정한다** (`doc_id`). 같은 작업이 두 번 돌아도 같은 R2 키에 덮어쓰고 `documents`는 `INSERT OR IGNORE`라 문서는 1개다.
- 소비자는 조건부 UPDATE 1문으로 작업을 차지한다 (`status='queued'`이거나, `running`인 채 7분 넘은 것만). 이미 `done`/`failed`면 ack만 한다.
- 다시 차지했을 때 `doc_id` 문서 행이 이미 있으면 (앞 시도가 저장 뒤 상태를 못 남기고 죽은 경우) AI를 다시 부르지 않고 `done`으로 맺는다 (`result.recovered: true` — 이때는 개요·변경 목록 없이 문서 정보만 있다).

### 재시도 정책 (층을 나눠 겹치지 않게)

| 실패 종류 | 처리 |
|---|---|
| 계획이 틀림 (JSON·검증·자리표시자·편집 적용 실패) | 기존 그대로: 보정 2종 + 오류를 알려 주고 1회 재시도 (한 시도 안에서 AI 최대 2회). 그래도 안 되면 `failed`. **Queue 재시도 없음** |
| AI 호출 자체 실패 (3046 timeout·3040 capacity·시간 초과 = `code: "ai_call"`), D1·R2 예외 | 작업을 `queued`로 되돌리고 15초 뒤 재전달. **작업당 최대 3회 시도**, 만든 지 6분이 지났으면 더 하지 않고 `failed` |
| 소비자가 죽음 | Queue 재전달(`max_retries = 3`). `running`이 7분 넘었으면 다시 차지, 아니면 120초 뒤 다시 본다 |
| 끝내 안 끝남 (DLQ행 등) | 만든 지 **15분**이 지난 `queued`·`running`은 `failed`로 바꾼다 (상태 조회 때 + 15분 크론) |

AI 호출 1회에는 150초 상한을 뒀다 (`withAiTimeout` — Workers AI가 스스로 끊는 122초보다 조금 긴 안전망). 워크플로 노드도 같은 함수를 쓰므로 같이 적용된다.

### 워크플로 `docx_create`·`docx_edit` 노드: 바꾸지 않았다

노드는 이미 Queue 소비자 안에서 돈다 (HTTP 요청이 붙잡지 않는다). 소비자 제한 시간(15분) 안에 AI 2회(최대 약 5분)가 들어가고, 실패는 run에 기록된다. 작업 큐로 한 번 더 넘기려면 엔진에 "단계가 바깥 작업을 기다리는" 상태를 새로 만들어야 해서 이번 범위에서는 얻는 것보다 위험이 크다고 판단했다. 대신 남는 문제는 4장에 적었다 (지시 노드가 도는 동안 `people-os-pipeline`의 뒤 메시지가 밀린다 — 이번 변경 전부터 있던 동작).

노드가 부르는 `runDocxCreate`·`runDocxEdit`의 입출력은 그대로다 (선택 인자만 추가). 워크플로 run 자체는 이번에 다시 돌리지 않았다.

### 바뀐 파일

| 파일 | 내용 |
|---|---|
| `migrations/0043_docx_jobs.sql` (새) | `docx_jobs` 테이블 |
| `src/docx/jobs.ts` (새) | 작업 만들기·Queue 넣기, 소비자(`processDocxJob`), 상태 조회, 크론 정리 |
| `src/docx/create.ts` | `precheckDocxCreate`, `docId` 선택 인자(멱등), AI 호출 150초 상한, AI 호출 실패에 `code: "ai_call"` |
| `src/docx/edit.ts` | `precheckDocxEdit`, `newDocId` 선택 인자(멱등), 같은 상한·코드 |
| `src/index.ts` | 두 라우트의 지시 경로 → 202, `GET /api/docx/jobs/:id`, `queue()`의 `docx-job` 처리, 15분 크론에 `sweepDocxJobs`, `Env.DOCX_JOBS` |
| `wrangler.toml` | `people-os-docx-jobs` producer·consumer |
| `public/docx-create.js` | `docxJobWait`(2초 폴링)·`docxJobText`, "AI가 만들고 있어요" 표시, 끝나면 목록 갱신 |
| `public/docx-edit.js` | 같은 폴링으로 "AI가 고치고 있어요" 표시 |

시험 하네스는 `files/workflow-verify/docx-ai-queue/harness/`에 있다 (배포하지 않는 로컬 전용).

## 2. 로컬 검증

로컬 `wrangler dev`는 Workers AI를 부를 수 없어, 본체 코드를 그대로 쓰되 `env.AI`만 가짜로 바꾼 진입점(`harness/stub-entry.ts`)으로 돌렸다. 편집 Worker는 실제 코드다 (`-c harness/wrangler.toml -c pptx-editor/wrangler.toml`). 따라서 **로컬은 Queue·상태·멱등성 흐름의 검증이고, 실제 Qwen 응답은 라이브에서만 봤다.**

| 시험 | 결과 |
|---|---|
| 구조화 생성 (회귀) | 201 바로 |
| 지시 생성 | **202** (0.12초) → 폴링 → `done` (1.2초), `result`에 문서·개요, 다운로드 200 (10,154 B, docx MIME) |
| 남의 작업 조회 / 익명 조회 | 404 / 401 |
| 못 만드는 지시 (자리표시자만 채운 계획) | `failed`, 422, 자리표시자 안내 문구. 문서 안 생김 |
| AI가 처음 1번만 실패 | `queued`(`retrying`) → 15초 뒤 다시 → `done`, `attempts: 2` (17초) |
| AI가 계속 실패 | 3회 시도 뒤 `failed`, 502, "AI가 응답하지 않아…" (33초) |
| 정의 + 지시 함께 / 없는 이미지 / 익명 | 400 / 404 `image_not_found` / 401 — 모두 Queue에 넣기 전에 |
| 지시 편집 | 202 → `done`, 2곳 바뀜 (`홍길동` → `김철수`), 부품 16개 그대로 |
| 남의 문서 지시 편집 | 404 (Queue에 넣기 전에) |
| ops 편집 (회귀) | 201 바로 |
| 동시 작업 4번째 | 429 `too_many_jobs` |
| 끝난 작업의 메시지를 한 번 더 전달 | ack만, AI 호출 0회, 문서 수 그대로 |
| `done` 작업을 `queued`로 되돌리고 다시 전달 (상태를 못 남기고 죽은 경우 흉내) | AI 호출 0회, `done` (`recovered: true`), 문서 수 그대로 (5개) |
| Queue 메시지가 사라진 작업 (dev 재시작으로 지연 메시지가 날아간 실제 사례) | 만든 지 15분 20초 뒤 조회에서 `failed`, 504, "15분 안에 끝나지 않아…" |
| 전용 큐로 바꾼 뒤 다시 | 202 → `done` (0.5초), 로그에 `QUEUE people-os-docx-jobs 1/1` |

## 3. 라이브 검증

배포 3분 뒤, 임시 사용자 세션으로 `https://people-os.workspace-easyware.workers.dev`에 호출했다. 근거 파일은 `evidence/live/`.

**1차 — `0f8b0589` (기존 파이프라인 큐)**

| 호출 | 결과 |
|---|---|
| 구조화 생성 | 201, 1.95초, `planned: false` |
| 지시 생성 | **202**, 1.39초 → `done`, 만든 뒤 33.7초 (대기 6.5초 + 실행 27초), 계획 1회. 섹션 4개(개요·첫 주 일정 표 5행·준비물 5·질문 4), 11,425 B. 다운로드 200, 다시 읽어 문단 36·표 1 확인 |
| 지시 편집 | 202, 1.98초 → `done`, 30.4초 (**대기 26.7초** + 실행 3.7초). 2곳 바뀜, 부품 16개 그대로 |
| 편집할 수 없는 지시 ("오늘 서울 날씨…") | 202 → **`failed`**, 422, "AI가 지시를 편집으로 바꾸지 못했습니다: 날씨 질문은 문서 편집 지시가 아닙니다." |

**2차 — `48544fec` (전용 큐, 현재 라이브)**

| 호출 | 결과 |
|---|---|
| 구조화 생성 | 201, 1.90초 |
| 지시 생성 | 202, 1.44초 → `done`, **168초** (대기 2.1초 + 실행 166초, **계획 2회**), 11,930 B. 예전이면 요청을 약 3분 붙잡았을 건인데 오류 없이 끝났다 |
| 지시 편집 | 202, 1.96초 → `done`, 206초 (**대기 166초** + 실행 39초). tail: queue `people-os-docx-jobs`, outcome ok, wallTime 39.6초, cpuTime 9 ms |

타임아웃·502는 한 번도 없었다. 폴링 응답은 모두 200이었다.

**기존 엔드포인트** (배포 전 `2e83ebca` vs 배포 후)

| 엔드포인트 | 판정 |
|---|---|
| `GET /api/health` | 바이트 동일 (1차·2차 모두) |
| `GET /api/auth/me` 익명 401 | 바이트 동일 (1차·2차 모두) |
| `GET /api/library` 익명 | 정리 뒤 바이트 동일 |
| `/docx-create.js`·`/docx-edit.js` | 로컬 파일과 바이트 동일 (의도한 변화) |
| 기존 구조화 생성 | 201, 응답 모양 그대로 |

**임시 데이터 정리**

- 문서 6건(원본 2·생성 2·편집본 2)을 `DELETE /api/documents/:id`로 지웠다 (모두 200, errors 없음).
- 임시 사용자 `u_dxq_tmp`·세션 1개·작업 행 5개를 D1에서 지웠다.
- 확인 쿼리: **users 0 / auth_sessions 0 / documents 0 / doc_nodes 0 / chunks 0 / docx_jobs 0**. R2 `docs/created/doc_mwqtexk3_pe2vro.docx`는 "The specified key does not exist".
- 로컬 dev 서버와 tail을 멈췄다 (포트 8791 비어 있음).
- 남은 흔적: AI Gateway 로그(`docx-create-plan`·`docx-edit-plan` 몇 건)와 Workers Logs 이벤트. Queue `people-os-docx-jobs`는 운영 자원으로 남는다.

## 4. 남은 문제·미확인 항목

1. **작업이 한 번에 하나씩 돈다.** 전용 큐로 나눈 뒤에도, 앞 작업(166초)이 끝날 때까지 뒤 작업이 `queued`로 기다렸다. Queue 소비자 동시 실행이 이 정도 양에서는 늘지 않는 것으로 보인다 (원인을 따로 확인하지는 않았다). 여러 사람이 동시에 쓰면 뒤 사람은 앞 작업 시간만큼 더 기다리고, 줄이 길면 15분 상한에 걸려 `failed`가 될 수 있다. 화면에는 "차례를 기다리는 중"으로 보인다. 고치려면 소비자에서 기다리지 않는 구조(예: Durable Object 알람)가 필요하다.
2. **Qwen 호출 시간 상한.** 호출 1회 150초(실제로는 Workers AI의 122초 timeout이 먼저 온다), 한 시도 최대 약 5분(AI 2회), 작업 전체 15분. 15분 상한이 실제 Queue 환경에서 걸리는 것은 라이브에서 보지 않았다 (로컬에서만 확인).
3. **라이브에서 못 본 경로:** AI 호출 실패 뒤 재시도(3046·3040), 소비자가 죽은 뒤 재전달, 중복 전달. 이번 라이브 5건에서는 일어나지 않았고 로컬 가짜 AI로만 확인했다.
4. **실패 문구.** 계획 실패는 기존 문구 그대로다. 그중 "AI가 만든 문서 구조가 올바르지 않습니다: sections[0].table.rows[1] 칸 수…"처럼 내부 필드 이름이 섞인 것은 사용자에게 어렵다 (이번에 손대지 않았다). 새로 만든 문구는 셋이다: "AI가 응답하지 않아 문서를 만들지 못했습니다 (여러 번 다시 시도했습니다)…" — 편집 작업에도 "문서를 만들지"로 나온다 / "AI 작업이 15분 안에 끝나지 않아 멈췄습니다…" / "작업을 대기열에 넣지 못했습니다…".
5. **브라우저 화면은 직접 눌러 보지 않았다.** 화면 JS는 문법 검사와 배포본 바이트 대조, 그리고 화면이 쓰는 API 응답 모양까지만 확인했다. "AI가 만들고 있어요" 표시와 끝난 뒤 목록 갱신은 실제 브라우저에서 한 번 봐야 한다.
6. **API 동작이 바뀌었다.** 지시 경로는 이제 201이 아니라 202다. 화면 말고 이 응답을 직접 쓰는 호출자가 있으면 폴링하도록 고쳐야 한다 (저장소 안에는 없다 — 워크플로 노드는 함수를 직접 부른다).
7. **워크플로 지시 노드**는 여전히 `people-os-pipeline` 소비자 안에서 Qwen을 기다린다. 그동안 같은 큐의 뒤 메시지가 밀리는 것은 이번 변경 전부터 있던 동작이고 그대로다.
8. **실패·대기 작업이 동시 작업 3개 한도를 차지한다.** Queue 메시지가 사라진 작업은 15분 상한까지 한 자리를 차지한다 (로컬에서 실제로 429를 봤다).
9. `wrangler deploy` 출력의 `env.DB` id가 미리보기 id로 찍히는 것은 기존에 알려진 표시 문제다. 마이그레이션은 운영 DB의 `d1_migrations`로 확인했다.

## 5. 다음 세션에 알릴 운용 교훈

- 로컬 `wrangler dev`는 소스·설정이 바뀌어 다시 뜰 때 **지연 재전달 중인 Queue 메시지를 잃는다**. 재시도 시험 중에는 파일을 고치지 말 것.
- Workers AI를 못 부르는 로컬에서는 `import worker from src/index` + `export * from src/index` + `env.AI`만 Proxy로 바꾼 진입점으로 지시 경로를 끝까지 돌릴 수 있다 (설정 사본의 `name`을 꼭 바꿔 실수로 운영에 배포되지 않게 한다).
- `curl -o <없는 폴더>/…`는 201을 받고도 종료 코드 23으로 본문을 잃는다. 처음부터 `--create-dirs`.
- `kill <pid>`는 `-p` 세션에서 승인 대기다. 백그라운드로 띄운 dev·tail은 TaskStop으로 멈춘다.
- `r2 object get --file`은 키가 없어도 0바이트 파일을 남긴다. 삭제 확인은 출력의 "The specified key does not exist"로 한다.
