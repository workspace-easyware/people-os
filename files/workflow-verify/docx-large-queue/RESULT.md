# 큰 덱·워크북·문서 Queue 처리 — 결과 (2026-11-22, Fable 5.2)

큰 파일의 구조화 문서 작업(ops·replace 편집, 정의로 만드는 Word 문서)을 Queue로 옮겼다. 요청을 받자마자 예상 CPU를 계산해 2초 미만이면 예전처럼 바로 201, 2초 이상이면 202 + 작업 id를 돌려주고 화면이 2초마다 상태를 묻는다. 라이브에서 큰 Word 문서 편집과 무거운 PPTX 편집이 202 → `done`으로 끝났고, 작은 편집은 그대로 201이다.

세션 3에서 남긴 직렬 실행 문제도 원인을 확인하고 고쳤다. Word AI 지시 작업은 이제 작업마다 Durable Object 알람에서 따로 돈다. 라이브에서 AI 작업 2개를 2초 간격으로 넣었더니 둘이 동시에 `running`이었고, 나중에 넣은 작업(33초)이 먼저 넣은 작업(90초)보다 먼저 끝났다.

- **라이브 버전: People OS `4a01a312-c085-42a5-a430-c8d5d74ce5e7`** (1차 `808ac976-2000-4409-bf89-f5473b6888e6`은 같은 날 대체됨). 문서 편집 Worker는 그대로 `1dd93ed7` (배포 안 함).
- **D1 마이그레이션: `0044_doc_jobs.sql`** — 원격에 `d1 execute --remote --file`로 적용하고 `d1_migrations`에 기록했다 (`migrations list --remote` → "No migrations to apply").
- **새 Cloudflare 자원**: Queue `people-os-doc-jobs`, Durable Object 클래스 `DocJobRunner` (wrangler 마이그레이션 태그 **v6**).
- 커밋·태그·푸시는 하지 않았다. `ARCHITECTURE.md`·`VERIFICATION.md`는 건드리지 않았다.
- `npx tsc --noEmit` 0건, `node --check` 통과 (`public/docx-create.js`·`docx-edit.js`·`pptx-edit.js`·`xlsx-edit.js`).

**Merlin이 알아야 할 것 두 가지**

1. **v6 배포 뒤에는 `wrangler rollback`으로 그 이전 버전에 돌아갈 수 없다** (v4·v5 때와 같다). 실행기를 끄려면 `src/index.ts` `queue()`의 `handOffDocxJob` 호출 한 줄을 빼고 재배포한다 (클래스·바인딩은 남겨 둔다).
2. **임계값 계산이 실제보다 약 2배 크게 나온다** (라이브 3건). 그래서 실제 CPU 1초짜리 작업도 Queue를 탔다. 안전한 쪽 오차이고 동작에는 문제가 없지만, 4장 1번에 숫자를 적었다.

## 1. 설계

### 흐름

1. `POST /api/pptx/edit`·`/api/xlsx/edit`·`/api/docx/edit` (ops 또는 replace), `POST /api/docx/create` (구조화 정의)
   → 입력 검사 + 원본 읽기(권한·형식) — 예전과 같은 4xx를 바로 돌려준다.
   → **예상 CPU 계산** (`src/doc-load.ts`). 2초 미만이면 예전 그대로 편집·저장하고 **201**.
   → 2초 이상이면 `doc_jobs` 행 + Queue `{type:"doc-job", jobId}` → **202** `{ok, queued:true, job:{id, kind, status:"queued", statusUrl, pollMs:2000, heavy:true, estMs}}`.
2. Queue 소비자(`queue()` → `processDocJob`)가 같은 실행 함수(`runPptxEdit` 등)를 불러 편집·저장하고 작업을 `done`으로 맺는다.
3. 화면은 `GET /api/doc-jobs/:id`를 2초마다 부른다. `done`이면 `result`(예전 201 응답과 같은 모양), `failed`면 `job.error`(한국어).

자연어 지시 경로는 이번 범위가 아니다. Word 지시는 세션 3 그대로 `docx_jobs`를 타고, PPTX·XLSX 지시는 예전처럼 요청 안에서 돈다.

### 임계값: 예상 CPU 2초 (`DOC_QUEUE_MS = 2000`)

**무엇을 재는가.** OOXML 파일은 ZIP이라 맨 끝 중앙 디렉터리에 부품마다 "압축을 푼 크기"가 적혀 있다. 압축을 풀지 않고 그 숫자만 읽는다 (CPU 거의 0, AI·편집 Worker 호출 없음). 파일 크기는 쓸 수 없다 — 문단 5,200개 문서가 37 KB, 10만 셀 워크북이 508 KB다.

| 종류 | 재는 값 | 식 (ms) | 2초가 되는 지점 |
|---|---|---|---|
| DOCX 편집 | `word/document.xml` + 머리글·바닥글·각주 XML | 150 + 2,400 × MiB | XML 약 0.77 MiB |
| XLSX 편집 | `xl/worksheets/*.xml` + `sharedStrings.xml` | 100 + 1,270 × MiB | XML 약 1.5 MiB (약 5만 셀) |
| PPTX 편집 | `ppt/` 아래 XML 전체, text op 수 | 350 + 1,600 × MiB + text op 수 × (200 + 800 × MiB) | 작은 덱(9장, 0.09 MiB)은 text op 6개부터, 40장(1.5 MiB) 덱은 op 1개도 |
| DOCX 생성 | 블록 수, 이미지 합계 | 100 + 0.15 × 블록 + 300 × 이미지 MiB | 이미지 약 6.3 MiB |

**계수 근거.**

- DOCX: 원격 실측 문단 5,200개(XML 1.78 MiB) 4,385 ms, 1,040개(0.36 MiB) 약 1,000 ms, 17개 133~189 ms.
- XLSX: 원격 실측 100,003셀(XML 3.06 MiB) 3,975 ms, 작은 워크북 79~175 ms.
- PPTX: 원격 값이 작은 덱뿐이라 로컬 workerd로 5장·40장 덱을 재고(아래 표) 원격/로컬 비 1.4배(XLSX에서 잰 값)를 곱했다. text op 계수는 라이브에서 다시 재서 300 → 200으로 낮췄다.
- DOCX 생성: 기존 파일럿 값 (1,910블록 281 ms, 이미지 10 MiB 0.6~3.2초).

로컬 실측 (편집 Worker RPC 1회, curl 시간):

| 파일 | XML | 로컬 시간 |
|---|---|---|
| DOCX 문단 20개 | 0.01 MiB | 0.27초 |
| DOCX 문단 1,040개 (파일럿) | 0.36 MiB | 0.58~0.65초 |
| DOCX 문단 2,000개 (새로 만듦) | 0.32 MiB | 0.46~0.48초 |
| DOCX 문단 4,000개 | 0.64 MiB | 0.75~0.94초 |
| DOCX 문단 4,000개, 긴 문장 | 1.49 MiB | 0.78~1.61초 |
| XLSX 10만 셀 | 3.06 MiB | 2.83~2.98초 |
| PPTX 5장 | 0.22 MiB | 복제 0.5초 · text 1개 0.6초 · text 3개 1.3초 |
| PPTX 40장 | 1.52 MiB | 복제 1.9~2.2초 · text 1개 2.6초 · text 3개 4.8초 |

문단 수가 2배여도 XML 크기가 같으면 시간이 같았다 (1,040개 0.36 MiB ≈ 2,000개 0.32 MiB). 그래서 문단 수가 아니라 XML 크기를 쓴다. 다만 긴 문장으로 XML만 키운 문서는 크기만큼 느려지지 않았다 — 4장 1번.

**덱 생성(`POST /api/deck`)은 넣지 않았다.** 슬라이드 12장·불릿 12개 상한이 있어 큰 덱이 만들어지지 않는다. 라이브에서 9장 덱 생성이 응답까지 1.85초였다 (네트워크·R2·D1 포함).

### Queue: 전용 큐 `people-os-doc-jobs` (바인딩 `DOC_JOBS`)

- `max_batch_size = 1`, `max_batch_timeout = 1`, `max_retries = 3`, DLQ는 기존 `people-os-pipeline-dlq`.
- `people-os-docx-jobs`와 또 나눈 이유: 몇 초면 끝나는 CPU 작업이 1~5분짜리 AI 작업 뒤에 줄 서지 않게 하려고. (지금은 AI 작업이 실행기 DO로 넘어가 큐를 바로 비우지만, 실행기를 끄면 다시 필요하다.)
- 큰 파일 작업은 이 큐의 소비자가 직접 돈다 (실행기 DO로 넘기지 않는다). 작업이 몇 초라 줄이 금방 줄고, 배치가 끝날 때마다 Queues가 소비자 수를 다시 본다.
- `DOC_JOBS` 바인딩이 없으면 판정을 하지 않고 예전처럼 요청 안에서 처리한다.

### 상태 테이블 `doc_jobs` (migration 0044) — `docx_jobs`와 나눴다

`id, kind(pptx_edit|xlsx_edit|docx_edit|docx_create), status, owner_id, result_id, source_ref, input_json, result_json, error, error_status, attempts, est_ms, created_at, started_at, finished_at` + 인덱스 2개.

나눈 이유: 결과가 문서일 수도 덱일 수도 있고(`result_id`), 원본 참조 모양(`deck:`·`doc:`)과 재시도 기준(AI 실패가 없다)이 다르다. `est_ms`는 요청 때 계산한 예상 CPU다 — 실제 값과 견줘 임계값을 손보는 데 쓴다.

- 조회 권한: 본인 작업만 (hr_admin·운영 비밀은 전부). 남의 작업·없는 작업은 같은 404, 익명은 401.
- 한 사람이 동시에 돌릴 수 있는 작업은 3개 (넘으면 429 `too_many_jobs`). `docx_jobs`의 3개와 따로 센다.
- 15분 크론이 15분 넘은 `queued`·`running`을 `failed`로 바꾸고, 7일 지난 행을 지운다 (`input_json`에 사용자가 쓴 글이 있다).
- 입력(JSON)이 40만 자를 넘으면 Queue로 보내지 않고 예전처럼 요청 안에서 처리한다 (D1 한 행 2 MB 한도).

### 멱등성 (작업 id 기준)

- **결과 id를 작업을 만들 때 미리 정한다** (`result_id` — 새 덱 id 또는 새 문서 id). 같은 작업이 두 번 돌아도 같은 R2 키에 덮어쓰고 행은 `INSERT OR IGNORE`다. 이를 위해 `runPptxEdit`·`runXlsxEdit`에 `newDeckId`·`newDocId` 선택 인자를 더했다 (DOCX는 세션 3에서 이미 있었다).
- 소비자는 조건부 UPDATE 1문으로 작업을 차지한다 (`queued`이거나 `running`인 채 3분 넘은 것만). 이미 `done`/`failed`면 ack만 한다.
- 다시 차지했을 때 결과 행이 이미 있으면 다시 편집하지 않고 `done`으로 맺는다 (`result.recovered: true` — 변경 목록 없이 파일 정보만).

### 재시도 정책

| 실패 종류 | 처리 |
|---|---|
| 요청이 틀림 (없는 셀·요소, 못 찾는 글자, 상한 초과, 원본이 지워짐) | 다시 해도 같으므로 바로 `failed`. Queue 재시도 없음 |
| 일시적인 실패 (D1·R2·편집 Worker RPC 예외, 편집 Worker 미연결 503) | `queued`로 되돌리고 10초 뒤 재전달. 작업당 최대 3회, 만든 지 6분까지 |
| 소비자가 죽음 | Queue 재전달(`max_retries = 3`). `running`이 3분 넘었으면 다시 차지, 아니면 60초 뒤 다시 본다 |
| 끝내 안 끝남 | 만든 지 15분이 지나면 `failed` (상태 조회 때 + 15분 크론) |

### 편집 Worker RPC: 구조를 바꾸지 않았다

Queue 소비자(People OS)가 `DOC_EDITOR` 서비스 바인딩으로 편집 Worker RPC를 그대로 부른다. 편집 Worker에는 Queue를 두지 않았고 배포도 하지 않았다. 편집 CPU는 편집 Worker 쪽 호출에서 쓰이므로 People OS 소비자의 CPU는 거의 늘지 않는다. 라이브에서 Queue 소비자 → RPC가 정상 동작했다 (tail: `applyDocumentOps` cpuTime 995 ms, `applyOps` 1,867 ms, outcome ok).

### 워크플로 노드: 바꾸지 않았다

`pptx_edit`·`xlsx_edit`·`docx_edit`·`docx_create` 노드는 이미 Queue 소비자(`people-os-pipeline`) 안에서 돌고, `runPptxEdit` 등을 예전 인자 그대로 부른다. 승인 게이트는 엔진 쪽 코드라 손대지 않았다. 실행 함수는 "판정 함수를 받는 속 함수 + 예전 이름의 겉 함수"로 나눴는데, 노드가 부르는 겉 함수는 판정 없이 예전과 같은 길을 간다.

**워크플로 run은 이번에 다시 돌리지 않았다.** 근거는 타입 검사 통과와, 같은 속 함수를 쓰는 작은 편집 라우트가 로컬·라이브에서 201로 동작한 것이다.

### 직렬 실행 문제: 원인과 수정

**원인.** Cloudflare 문서(Queues → Consumer concurrency)에 그대로 적혀 있다: "Queues checks if it should autoscale consumers only after processing an entire batch of messages, so it will not autoscale while a batch is being processed." 배치 1개 = 작업 1개 = 1~5분이라, 그동안에는 두 번째 소비자가 뜨지 않는다. 설정으로 최소 동시 실행 수를 강제하는 방법은 문서에 없다 (`max_concurrency`는 상한뿐이다).

**수정.** Queue 소비자가 작업을 직접 돌리지 않고 실행기 DO `DocJobRunner`(작업당 인스턴스 1개, `src/docx/job-runner.ts`)에 넘긴 뒤 바로 ack한다. 실제 일(`processDocxJob` — Qwen 호출)은 그 DO의 알람에서 돈다 (알람 실행 한도 15분). 작업마다 DO가 따로라 서로 기다리지 않는다.

- 일시적인 AI 실패의 "15초 뒤 다시"와 "다른 실행이 하고 있으니 120초 뒤 다시 본다"는 Queue 지연 재전달 대신 알람을 다시 거는 것으로 바뀌었다. 횟수(3회)·시간(6분)·15분 상한은 그대로 `docx_jobs` 행이 맡는다.
- 알람이 예외로 끝나면 런타임이 다시 부른다 (지수 백오프, 최대 6회).
- 실행기 바인딩이 없거나 넘기지 못하면 소비자가 예전처럼 직접 돌린다.

### 바뀐 파일

| 파일 | 내용 |
|---|---|
| `migrations/0044_doc_jobs.sql` (새) | `doc_jobs` 테이블 |
| `src/doc-load.ts` (새) | ZIP 중앙 디렉터리 읽기, 종류별 예상 CPU, 임계값 |
| `src/doc-jobs.ts` (새) | 작업 만들기·Queue 넣기, 소비자(`processDocJob`), 상태 조회, 크론 정리 |
| `src/docx/job-runner.ts` (새) | 실행기 DO `DocJobRunner` + `handOffDocxJob` |
| `src/pptx/edit.ts`·`src/xlsx/edit.ts` | `tryPptxEdit`·`tryXlsxEdit`(판정 받는 길), `newDeckId`·`newDocId`(멱등) |
| `src/docx/edit.ts`·`src/docx/create.ts` | `tryDocxEdit`·`tryDocxCreate` |
| `src/docx/jobs.ts` | 주석만 (실행 위치 설명) |
| `src/index.ts` | 네 라우트의 판정 → 202, `GET /api/doc-jobs/:id`, `queue()`의 `doc-job` 처리와 실행기 넘기기, 크론에 `sweepDocJobs`, `Env.DOC_JOBS`·`DOC_JOB_RUNNER`, `DocJobRunner` export |
| `wrangler.toml` | `people-os-doc-jobs` producer·consumer, `DOC_JOB_RUNNER` 바인딩, 마이그레이션 v6 |
| `public/pptx-edit.js`·`xlsx-edit.js` | 202면 `docxJobWait`로 기다림, 복구된 결과(변경 목록 없음) 표시 |
| `public/docx-create.js`·`docx-edit.js` | 큰 파일 작업(`job.heavy`)일 때 문구 ("큰 문서라 뒤에서 고치고 있어요") |

시험 하네스는 `files/workflow-verify/docx-large-queue/harness/`에 있다 (배포하지 않는 로컬 전용, 설정의 `name`은 `people-os-doc-large-local`).

## 2. 로컬 검증

본체 코드를 그대로 쓰고 시험 파일을 만드는 `/__lab/*` 라우트만 더한 진입점으로 돌렸다. 편집 Worker는 실제 코드다 (`-c harness/wrangler.toml -c pptx-editor/wrangler.toml`). 근거 파일은 `evidence/local/`.

| 시험 | 결과 |
|---|---|
| DOCX 작은 문서 ops 편집 | **201** 바로 (0.39초) |
| DOCX 큰 문서(문단 4,000개, XML 1.49 MiB, 예상 3,720 ms) ops 편집 | **202** (0.10초) → `done` (1.6초). 편집본 다운로드 200, 다시 읽어 문단 4,001개·3번 문단 바뀜·"김철수" 치환 확인 |
| XLSX 작은 워크북 / 10만 셀(예상 3,984 ms) | 201 (0.20초) / **202** → `done` (3.2초), 508,044 B, 시트 2장 |
| PPTX 5장 text 1개 / 40장 text 2개 + 복제(예상 5,808 ms) | 201 / **202** → `done` (5.2초), 41장, 다시 읽어 제목 바뀜 확인 |
| DOCX 생성 이미지 1 MiB / 이미지 4 MiB 2장(예상 2,501 ms) | 201 (0.62초) / **202** → `done` (0.9초), 그림 2장 |
| 못 만드는 ops: DOCX 없는 문단 / PPTX 없는 요소 | 202 → **`failed`**, 422, "99999번 문단이 없습니다 (문단 4001개)" / "1번 슬라이드에 요소 no-such-element가 없습니다" |
| Queue에 넣기 전 거절: 남의 문서 / 익명 / 없는 이미지 | 404 / 401 / 404 `image_not_found` |
| 남의 작업 조회 / 익명 조회 | 404 / 401 |
| 끝난 작업의 메시지를 한 번 더 전달 | ack만, 시도 횟수 그대로(1), 편집본 수 그대로 |
| `done` 작업을 `queued`로 되돌리고 다시 전달 | 다시 편집하지 않고 `done` (`recovered: true`, 67 ms) |
| 편집 Worker가 계속 예외 | 3회 시도 뒤 `failed`, 500, "파일을 처리하는 중 오류가 나서…" (20초) |
| 편집 Worker가 처음에만 예외 | `queued`(`retrying`) → 10초 뒤 다시 → `done`, `attempts: 2` (14초) |
| 동시 작업 4번째 | 429 `too_many_jobs`. 그동안 작은 편집은 그대로 201 |
| **실행기 DO**: 12초짜리 AI 작업 2개를 연달아 제출 (가짜 AI) | 둘 다 0.4초 안에 `running`, **12.6초에 둘 다 `done`** (직렬이면 24초) |
| 실행기 DO: AI가 처음 1번 실패 | 15초 뒤 알람이 다시 불러 `done`, `attempts: 2` |

로컬에서 못 본 것: 15분 상한 (코드는 세션 3과 같은 모양이고 이번에는 기다려 보지 않았다).

## 3. 라이브 검증

배포 3분 뒤, 임시 사용자 세션으로 `https://people-os.workspace-easyware.workers.dev`에 호출했다. 근거 파일은 `evidence/live/` (tail 원본 `tail-peopleos.jsonl`·`tail-editor.jsonl` 포함). 타임아웃·502는 한 번도 없었고 폴링 응답은 모두 200이었다.

**1차 — `808ac976` (큰 파일 Queue)**

| 호출 | 결과 |
|---|---|
| 구조화 생성 (1,920블록, 본문 862 KB) — 큰 원본 만들기 | **201**, 2.18초 (예상 388 ms라 바로 처리) |
| 큰 문서 ops 편집 (문단 1,921개, XML 0.92 MiB, 예상 2,363 ms) | **202**, 1.47초 → `done`, 만든 뒤 5.2초 (대기 3.2초 + 실행 2.1초). 다운로드 200 (31,427 B, docx MIME). 내려받아 다시 읽어 문단 1,921개·3번 문단 바뀜 확인 |
| 못 만드는 ops (문서에 없는 글자 찾아 바꾸기) | 202 → **`failed`**, 422, "글자를 찾지 못했습니다: …" (1.9초) |
| 덱 만들기 9장 → inspect | 201 (1.85초) → 200 |
| PPTX 작은 편집 (text 1개) | **201**, 3.26초 |
| PPTX 무거운 편집 (text 8개 + 복제, 예상 3,493 ms) | **202**, 1.29초 → `done`, 3.3초 (대기 0.7초 + 실행 2.6초). 다운로드 200 (36,739 B). 다시 읽어 10장·제목 8곳 바뀜 확인 |

**2차 — `4a01a312` (실행기 DO 추가, 현재 라이브)**

| 호출 | 결과 |
|---|---|
| 큰 문서 ops 편집 (다시) | 202 → `done`, 3.4초 (대기 1.2초 + 실행 2.2초) |
| PPTX 무거운 편집 (다시, 예상 2,693 ms — 계수 조정 뒤) | 202 → `done`, 6.5초 (대기 3.8초 + 실행 2.8초). 대기는 바로 앞 Word 작업이 끝나길 기다린 시간이다 |
| PPTX 작은 편집 (다시) | 201, 3.34초 |
| **Word AI 지시 작업 2개를 2초 간격으로** | 1번: 20:20:19.9 제출 → 21.8 시작 → 21:49.7 끝 (**89.8초**, 계획 2회). 2번: 20:20:21.8 제출 → **26.9 시작** → 20:54.4 끝 (**32.6초**). 2번이 1번 도중에 시작해 먼저 끝났다 |

tail로 본 실행기 동작: Queue 소비자 호출은 wallTime 649 ms·cpuTime 1 ms에 끝났고 (작업을 넘기고 ack), `DocJobRunner`의 `/start`는 76 ms였다. 세션 3에서는 같은 상황에서 뒤 작업이 166초를 기다렸다.

**예상 CPU와 실제 CPU** (편집 Worker tail의 cpuTime)

| 작업 | 예상 | 실제 | 비 |
|---|---|---|---|
| DOCX 큰 문서 편집 (2회) | 2,363 ms | 995 / 1,026 ms | 2.3배 |
| PPTX text 8개 + 복제 (1차, 조정 전 계수) | 3,493 ms | 1,867 ms | 1.9배 |
| PPTX text 8개 + 복제 (2차, 조정 뒤 계수) | 2,693 ms | 1,254 또는 2,000 ms | 1.3~2.1배 |
| PPTX text 1개 (바로 처리, 식으로 다시 계산) | 약 770 ms | 647 ms | 1.2배 |

2차 PPTX는 무거운 편집과 작은 편집이 같은 때 돌아서, tail의 `applyOps` 두 줄(1,254·2,000 ms) 중 어느 것이 어느 요청인지 가르지 못했다.

**기존 엔드포인트** (배포 전 `48544fec` vs 최종 `4a01a312`)

| 엔드포인트 | 판정 |
|---|---|
| `GET /api/health` | 바이트 동일 (1차·최종 모두) |
| `GET /api/auth/me` 익명 401 | 바이트 동일 (1차·최종 모두) |
| `GET /api/library` 익명 | 정리 뒤 바이트 동일 |
| `/pptx-edit.js`·`/xlsx-edit.js`·`/docx-create.js`·`/docx-edit.js` | 로컬 파일과 바이트 동일 (의도한 변화) |
| 기존 작은 편집 (PPTX text 1개) | 201, 응답 모양 그대로 |
| `GET /api/doc-jobs/x` 익명 | 401 (새 라우트) |

**임시 데이터 정리**

- 덱 5건(원본 1·편집본 4)을 `DELETE /api/decks/:id`, 문서 5건(원본 1·편집본 2·AI 생성 2)을 `DELETE /api/documents/:id`로 지웠다 (모두 200, errors 없음, `vectorsDeleted: 0`).
- 임시 사용자 `u_dlq_tmp`·세션 1개·`doc_jobs` 5행·`docx_jobs` 2행을 D1에서 지웠다.
- 확인 쿼리: **users 0 / auth_sessions 0 / documents 0 / decks 0 / doc_nodes 0 / chunks 0 / doc_jobs 0 / docx_jobs 0**. R2 `docs/created/doc_mwqufww5_0adnyt.docx`는 "The specified key does not exist".
- 로컬 dev 서버와 tail 2개를 멈췄다 (포트 8793 비어 있음).
- 남은 흔적: AI Gateway 로그(`docx-create-plan` 3건)와 Workers Logs 이벤트. Queue `people-os-doc-jobs`와 DO 클래스 `DocJobRunner`(끝난 작업의 인스턴스는 저장소를 비웠다)는 운영 자원으로 남는다.
- 저장소에 남은 시험 파일: `harness/state`(25 MB)·`harness/gen`(7 MB)·`out/dryrun`(29 MB)은 커밋할 필요가 없다.

## 4. 남은 문제·미확인 항목

1. **임계값이 실제 CPU보다 크게 나온다.** 라이브 3건에서 예상이 실제의 1.3~2.3배였다. 그래서 실제 CPU 1초짜리 Word 편집이 Queue를 탔다 (바로 처리했으면 약 1.5초, Queue로는 3.4~5.2초). 원인은 XML 크기만 재기 때문이다: 계수를 맞춘 파일럿 문서는 태그가 촘촘하고(문단당 359 B), 라이브 시험 문서는 문장이 길어 같은 크기에 태그가 적다. 반대 방향(실제가 예상보다 큼)은 이번에 보지 못했다. 그 경우에도 예전처럼 요청 안에서 처리될 뿐이다. 더 정확히 하려면 본문 XML을 풀어 태그 수를 세면 된다 (요청마다 CPU 수십 ms가 든다 — 하지 않았다).
2. **XLSX 큰 워크북과 이미지 많은 Word 생성은 라이브에서 돌리지 않았다** (로컬만). 라이브에 큰 파일을 올리면 업로드 경로가 AI 변환과 Vectorize 색인을 거치기 때문이다. 라이브에서 본 것은 Word 편집과 PPTX 편집 두 종류다. XLSX 계수는 세션 2의 원격 실측 1건(10만 셀 3,975 ms)에 맞춘 값이다.
3. **PPTX 큰 덱 계수는 로컬 실측에 1.4배를 곱한 추정이다.** 40장 덱을 라이브에서 편집해 보지 않았다. 라이브 PPTX는 9장 덱 + text op 8개(op 수로 무거운 경우)였다.
4. **워크플로 run은 다시 돌리지 않았다.** 노드 코드와 승인 게이트는 바꾸지 않았고 타입 검사는 통과했다. 노드가 부르는 실행 함수는 내부 구조를 바꿨으니 (겉 함수 → 속 함수), 워크플로 회귀 때 `pptx_edit`·`docx_edit` 노드를 한 번씩 돌려 보는 것이 좋다.
5. **브라우저 화면은 직접 눌러 보지 않았다.** 화면 JS는 문법 검사, 배포본 바이트 대조, 화면이 쓰는 API 응답 모양까지만 확인했다. "큰 덱이라 뒤에서 고치고 있어요" 표시는 실제 브라우저에서 봐야 한다.
6. **API 동작이 바뀌었다.** 큰 파일의 구조화 편집·생성은 이제 201이 아니라 202다. 그리고 큰 파일에서는 파일을 읽어야 아는 오류(없는 요소, 못 찾는 글자)가 요청의 422가 아니라 작업의 `failed`로 온다. 화면은 고쳤고, 저장소 안의 다른 호출자(워크플로 노드)는 함수를 직접 불러 영향이 없다.
7. **큰 파일 작업끼리는 여전히 한 줄로 돈다** (`people-os-doc-jobs` 소비자가 직접 돌린다). 라이브에서 앞 작업 2.2초 뒤에 온 작업이 3.8초 기다렸다. 작업이 몇 초라 그대로 뒀다. 동시에 많이 몰리면 같은 실행기 DO로 넘기면 된다 (메시지 `type`만 가르면 된다 — 하지 않았다).
8. **실행기 DO에서 라이브로 못 본 경로**: AI 실패 뒤 알람 재시도, 알람 도중 배포·재시작으로 끊긴 뒤 이어 받기, 중복 전달. 로컬 가짜 AI로는 재시도(15초 뒤 `done`)만 확인했다. 끊긴 작업은 `running`이 7분 넘어야 다시 차지하므로 그동안 화면은 "만들고 있어요"로 보인다. 알람이 6번 연속 예외로 끝나면 더 불리지 않고, 그 작업은 15분 상한에서 `failed`가 된다.
9. **PPTX·XLSX의 자연어 지시는 여전히 요청 안에서 Qwen을 기다린다** (이번 범위 밖). Word 지시만 Queue다. 같은 타임아웃 위험이 남아 있다.
10. **워크플로 지시 노드**는 여전히 `people-os-pipeline` 소비자 안에서 Qwen을 기다린다. 직렬 실행의 원인이 같으므로, 그동안 같은 큐의 전사·워크플로 메시지가 밀린다 (이번 변경 전부터 있던 동작).
11. **예상 CPU는 파일이 적어 둔 크기를 믿는다.** ZIP 중앙 디렉터리를 속인 파일은 "바로 처리" 쪽으로 갈 수 있다. 그 길은 편집 Worker의 기존 상한(입력 20 MiB, 풀린 크기 200 MiB, 문단·셀·슬라이드 수)이 그대로 막는다.
12. **작은 문구 오류 1건 (고치지 않았다).** 큰 Word 편집 작업이 중간에 끊겼다 이어져 `recovered`로 끝나면, `public/docx-edit.js`가 결과 줄 끝에 "(AI 계획)"을 붙인다 (AI를 쓰지 않은 작업인데도). 드문 경로이고 다운로드는 정상이다. `r.planned === false`일 때 빼면 된다.
13. 15분 상한과 DLQ행은 이번에 로컬에서도 기다려 보지 않았다 (코드는 세션 3과 같은 모양).
14. `wrangler deploy` 출력의 `env.DB` id가 미리보기 id로 찍히는 것은 기존에 알려진 표시 문제다. 마이그레이션은 운영 DB의 `d1_migrations`로 확인했다.

## 5. 다음 세션에 알릴 운용 교훈

- **Queues는 배치가 끝난 뒤에만 소비자 수를 늘릴지 본다** (공식 문서). 메시지 1개가 분 단위로 걸리면 직렬이 된다. 긴 일은 소비자에서 기다리지 말고 DO 알람으로 넘긴다 (알람 실행 한도 15분, 예외 시 최대 6회 재시도, 같은 DO의 알람은 동시에 돌지 않는다).
- **OOXML 파일 크기는 무게를 말해 주지 않는다** (문단 5,200개 = 37 KB). ZIP 중앙 디렉터리의 "풀린 크기"를 읽으면 압축을 풀지 않고 XML 크기를 안다.
- **로컬 `wrangler dev`에서 DO가 쓰는 env는 진입점의 Proxy를 거치지 않는다.** DO 안에서 가짜 AI를 쓰려면 하네스에서 같은 이름의 하위 클래스를 export해 생성자에서 env를 바꾼다 (`export *`보다 직접 export가 우선한다).
- **`sleep N; <명령>`은 N이 25초 안팎을 넘으면 막힌다** (20·22초는 됐고 28초는 막혔다). 길게 기다릴 때는 `sleep`만 백그라운드로 돌린다.
- **`printf … > 파일`을 `&&`로 여러 개 이으면 승인 대기다.** 요청 본문 파일은 Write 도구로 만든다.
- **`cd <dir> && curl …` 뒤에는 cwd가 바뀐 채 남는다** (이번에도 두 번 겪었다). 루트에서 상대 경로로만 쓴다.
- **로컬 workerd는 한 번에 한 가지 CPU 작업만 빨리 한다.** 큰 편집이 도는 동안 다른 요청 시간이 몇 배로 늘어난다 (작은 PPTX 편집 0.6초 → 4.4초). 시간을 잴 때는 하나씩 돌린다.
