# 검증 기록 — 일잇 People OS 로컬 MVP (Phase 0–3)

검증일: 2026-11-13 / Node v24.22.1 / npm 10.9.4 / wrangler 3.114.17 / TypeScript strict 통과
배포 없음: `wrangler login` / `wrangler deploy` / GitHub 푸시를 실행하지 않음. 전부 로컬.

## 실행한 명령

```bash
cd ~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os
npm install --no-audit --no-fund        # 62 packages, 13초, 성공
npx tsc --noEmit                          # TSC_OK (exit 0)
npx wrangler dev --local --port 8787      # http://localhost:8787
bash /tmp/people-os-test.sh               # curl 10개 케이스, 3회 반복 실행
```

## 결과 (최종 실행, 2026-11-13)

| # | 테스트 | 결과 |
|---|---|---|
| 1 | `GET /` 프론트 | 200, 7053 bytes, `<title>일잇 People OS — Workers 프로토타입</title>` |
| 2 | `GET /api/seed` | 규정 7건, 샘플 전사본 509자 |
| 3 | `POST /api/documents` | 201, `r2Stored: true` (Miniflare R2 로컬) |
| 4 | `POST /api/documents/:id/summarize` | 200, 요약 3줄 + 액션 2건, `engine: local-extractive` |
| 5 | `POST /api/ask` “연차 3일 쓸 수 있어?” | 200, 근거 1위 연차휴가, `engine: local-template`, `searchEngine: d1-text`, `sessionVia: durable-objects` |
| 6 | 동일 질문 반복 (동일 세션) | `cached: true` |
| 7 | 후속 질문 “그럼 신청은 며칠 전에 해야 해?” (동일 세션) | 200, 근거 1위 연차휴가, `cached: false` → 반복 시 `cached: true` |
| 8 | `POST /api/coaching/reflect` | 200, 핵심 질문 2개·패턴 2개·다음 질문 3개, `engine: local-rule` |
| 9 | `GET /api/library` | 문서 3건·규정 7건·리플렉션 3건 (3회 테스트 누적) |
| 10 | `POST /api/documents` 빈 content | 400 `{"ok":false,"error":"content is required"}` |

## 로컬 폴백으로 동작한 것 (확인됨)

- **Workers AI**: 로컬에서 `AI.run`이 실패해 요약·답변·리플렉션이 모두 로컬 로직으로 폴백했다.
  `engine`이 `local-extractive` / `local-template` / `local-rule`로 찍힌다.
  wrangler 경고: "Using Workers AI always accesses your Cloudflare account … will incur usage charges even in local development."
  로그인 없이 실행했으므로 실제 AI 호출·과금은 발생하지 않았다.
- **Vectorize**: 로컬 바인딩 미지원. wrangler 경고:
  "Vectorize local bindings are not supported yet."
  `env.VECTOR`가 로컬에서 falsy라 `searchEngine: d1-text`로 폴백했다.
- **KV / Durable Objects / R2 / D1**: Miniflare 로컬 에뮬레이션으로 정상 동작.
  DO 세션은 `sessionVia: durable-objects`로 확인, KV 캐시는 동일 세션에서 `cached: true`로 확인.
- **compatibility_date**: 처음 `2026-11-01`로 두었더니 wrangler 3.114.17이
  "latest compatibility date supported is 2025-07-18"라며 폴백했다.
  `wrangler.toml`을 `2025-07-18`로 수정해 경고를 제거했다.

## 테스트 중 발견해 수정한 버그 3건 (모두 재검증 완료)

1. **요약 액션 항목이 거대한 한 덩어리로 나옴** — 개행 없는 긴 텍스트를 통째로 액션으로 잡았다.
   → 문장 단위로 나누고 각 항목 160자 상한. 재검증: 액션 2건, 짧은 문장.
2. **코칭 핵심 질문이 거대한 한 덩어리로 나옴** — 같은 원인(개행 기준 추출).
   → 문장 단위 추출 + 140자 상한. 재검증: 핵심 질문 2개, 짧은 문장.
3. **후속 질문이 잘못된 규정을 답함 + 오래된 답이 재사용됨** — 원인 두 가지:
   (a) 후속 질문(“신청은 며칠 전에”)만으로는 연차 규정이 1위가 안 됨 → 직전 질문을 검색 쿼리에 보태고
   “며칠 전/신청” 가중치를 추가. (b) 더 근본적인 원인: 캐시 키가 `ask:{question}`이라
   세션과 무관하게 공유돼, 첫 실행의 잘못된 답이 모든 세션에 재사용됨.
   → 캐시 키를 `ask:{sessionId}:{question}`으로 변경. 재검증: 후속 질문 근거 1위 연차휴가,
   동일 세션 반복 시 `cached: true`로 같은 정답 반환.

## 아직 검증하지 않은 것

- Workers AI / Vectorize 실동작 (클라우드 배포 후에만 가능 — 로그인·배포 승인 필요)
- 실제 음성 파일 업로드, Hyperdrive 실연결, Cron, Turnstile (Phase 4/5)
- 프론트 브라우저 클릭 테스트 (curl로 HTML 서빙까지만 확인, 브라우저 조작은 미수행)

## 라이브 검증 (2026-11-13, 배포 후, 사용자 Chrome 경유)

- 데모 URL: https://people-os.workspace-easyware.workers.dev (workers.dev 서브도메인: workspace-easyware.workers.dev)
- VM에서 curl로는 workers.dev에 빈 응답이 와서, 검증은 사용자 Chrome 브라우저로 수행함.
- 메인 페이지: 4개 탭(업로드·요약 / 질문 / 코칭 / 라이브러리) 정상 표시, 에러 없음.
- GET /api/health: ok:true, bindings d1/kv/r2/vectorize/ai/durable_objects 전부 true.
- 업로드: 샘플 전사본 업로드 시 "R2 저장: 예" 확인.
- 질문: "교육 지원은 어떻게 돼?" → 엔진 workers-ai, 검색 vectorize, 세션 durable-objects. 근거 문서 3건 표시.
- 요약: 엔진 workers-ai로 전환 확인 (초기에는 local-extractive 폴백이었음).
- 코칭: 엔진 workers-ai로 전환 확인 (초기에는 local-rule 폴백이었음).
- /api/seed-vectors: upserted 7, errors [].
- /api/debug-ai: embed ok (768차원), vectorize ok (매치 3건, 점수 ~0.76-0.80), llm 3개 모델 모두 ok.

### 라이브에서 고친 문제들
1. llama-3-8b-instruct 폐기 (2026-05-30, HTTP 410) → llama-4-scout-17b-16e-instruct으로 교체.
2. llama-3.1-8b-instruct도 Workers AI 바인딩에서는 폐기 (5028, infire-llama-3.1-8b-instruct) — REST API에서는 되지만 바인딩에서는 안 됨.
3. Vectorize 인덱스가 비어 있었고 검색 쿼리가 0벡터였음 → /api/seed-vectors로 규정 7건 임베딩·upsert, 질문 임베딩 후 검색으로 변경.
4. AI 응답 파싱: 바인딩은 {response: "..."}를 반환하고 JSON 답이 ``` 펜스로 감싸져 옴 → responseText/extractJson 헬퍼로 처리.

## Stage 1 — 작업 공간 + PPTX 덱 (2026-11-13)

검증일: 2026-11-13 / Node v24.22.1 / wrangler 3.114.17 / pptxgenjs 4.0.1 / TypeScript strict 통과 (`npx tsc --noEmit` → TSC_OK).
`npx wrangler dev --local --port 8787` + `bash /tmp/people-os-stage1-test.sh` (22개 케이스).

| # | 테스트 | 결과 |
|---|---|---|
| 1 | `GET /` 프론트 | 200, 홈·할 일 탭 존재, `tab-home`이 기본 활성 |
| 2 | `POST /api/health` | ok:true, 바인딩 d1/kv/r2/ai/durable_objects true (vectorize는 로컬 미지원으로 false — 기존과 동일) |
| 3 | `GET /api/home` (빈 DB) | counts 전부 0, 목록 빈 배열 |
| 4 | `POST /api/tasks` | 201, id `task_...`, source 저장됨 |
| 5 | `POST /api/tasks` 빈 title | 400 `title is required` |
| 6 | `GET /api/tasks` | 생성한 1건 반환 (done: 0) |
| 7–8 | `PATCH /api/tasks/:id` 토글 2회 | done true → false |
| 9 | `PATCH` 없는 id | 404 `task not found` |
| 10–11 | `DELETE` → 다시 `DELETE` | 200 → 404 |
| 12 | `POST /api/deck` (summary 2 + actions 2) | 201, `slides: 3`, `bytes: 63768`, `url: /api/deck/deck_...` |
| 13 | `GET /api/deck/:id` | 200, `Content-Type: application/vnd...presentationml.presentation`, `Content-Disposition: attachment`, 유효한 ZIP, 슬라이드 3장, 표지에 제목·"PEOPLE OS", 요약 슬라이드에 불릿, 액션 슬라이드에 액션 문구 확인 |
| 14 | `GET /api/deck/bad-id` | 404 `deck not found` |
| 15 | `POST /api/deck` 빈 body | 400 `summary, actions or bullets is required` |
| 16 | `POST /api/deck` bullets만 | 201, `slides: 2` (표지 + 내용) |
| 17 | 스모크: 업로드 + 요약 | 201 / 200, `engine: local-extractive` (로컬 폴백, 기존과 동일) |
| 18 | 스모크: ask “연차 3일 쓸 수 있어?” | 200, 근거 1위 연차휴가, `local-template` / `d1-text` / `durable-objects` (로컬 폴백) |
| 19 | 스모크: 코칭 리플렉션 | 200, 패턴 2개·다음 질문 3개, `engine: local-rule` (로컬 폴백) |
| 20 | `GET /api/library` | 문서 1건·규정 7건·리플렉션 1건 |
| 21 | `GET /api/home` (스모크 후) | counts 문서 1·요약 1·열린 할 일 0·리플렉션 1, 최근 문서·리플렉션 반환 |
| 22 | 요약 액션 → `POST /api/tasks` | 201, 목록에 "회의록 공유" (done: 0) — 프론트의 "할 일로 저장"과 같은 경로 |
| 23 | `POST /api/deck` outline (S3, 로컬) | 201, `slides: 3`, `outline: true` — 고친 표지 제목·슬라이드 제목·불릿 3개가 slide XML에 그대로 있음, 빈 불릿 빠짐, 불릿 없는 슬라이드 제외, 제목 없는 슬라이드 "내용"으로, slide XML 3장 파싱 OK |
| 24 | `POST /api/deck` outline 빈 slides (S3) | 400 `outline is empty: add at least one bullet` |
| 25 | `POST /api/deck` summary/actions (S3 회귀) | 201, `slides: 3`, `outline: false` — 기존 경로 그대로 동작, 기존 문구 전부 slide XML에 있음 |

S3 주의: PowerPoint에서 직접 열리는지는 로컬에서 확인할 수 없어 부모의 Chrome 확인에서 확인할 것.

### 테스트 중 발견해 수정한 버그 1건 (재검증 완료)

**한글 파일명으로 Content-Disposition을 만들면 브라우저에서 TypeError** — Miniflare 로그에 `Invalid header name or value ... must not contain any Unicode code points greater than 0xFF` ERROR가 찍혔다. Miniflare는 200을 반환했지만 실제 브라우저 Fetch 명세에서는 예외다. → `filename`은 ASCII 폴백(`11_.pptx`), 한글 제목은 RFC 5987 `filename*=UTF-8''...`로 변경. 재검증: 헤더 ASCII만 포함, 파일 63,768바이트·슬라이드 3장·유효한 ZIP 그대로 다운로드됨.

### 배포 (2026-11-13)

- `cf-wrangler.py deploy` → https://people-os.workspace-easyware.workers.dev, Version ID `7161dbd8-9aa4-4155-a88a-0a0beb9c480d`.
- 배포 직후 `d1 migrations list`에서 `0002_workspace.sql`이 미적용으로 보여 `d1 migrations apply people-os-db --remote`로 별도 적용 (✅, 3개 명령 실행). 참고: 배포가 마이그레이션을 자동 적용하지 않았고, 런타임 `ensureSchema()`가 테이블을 만들어주긴 하지만 마이그레이션 기록을 위해 명시 적용함.
- 라이브 확인은 이 VM에서 workers.dev에 닿지 않아 수행하지 않음 — 사용자 Chrome으로 확인할 것 (홈 대시보드, 할 일 체크, PPTX 다운로드, 요약/질문/코칭 엔진 유지).

### 아직 검증하지 않은 것 (Stage 1)

- 라이브 Workers AI/Vectorize 경로에서의 덱 생성 (로컬은 폴백이지만 덱 생성 자체는 AI와 무관 — pptxgenjs만으로 동작하므로 클라우드에서도 동일하게 동작할 것으로 예상, 배포 후 Chrome 확인 필요)
- 프론트 브라우저 클릭 테스트 (홈·할 일 체크박스·PPTX 버튼 — curl로 HTML·API까지만 확인, 브라우저 조작은 미수행, 배포 후 사용자 Chrome으로 확인 예정)
- PowerPoint 실파일 열기 확인 (ZIP 구조·슬라이드 XML 텍스트까지만 검증, PowerPoint 앱에서 여는 것은 미수행)

## 프론트 리스타일 + FlowDesk 연결 (2026-11-13)
- people-insight의 CSS 디자인 토큰(남색 #123863, 배경 #f5f8fc, 포인트 #2d7dde, 카드 radius 16px, Pretendard/Inter)을 public/index.html에 적용. Mantine 라이브러리가 아니라 Mantine처럼 보이게 짠 커스텀 CSS다.
- 상단 sticky topbar(남색 로고 + 탭 메뉴), 둥근 카드 + 그림자 확인됨 (사용자 Chrome 경유).
- FlowDesk 연결 (당시 기록, 이후 제거됨): 요약 결과 아래 "요약 복사" + "FlowDesk에서 열기" 버튼, 라이브러리 탭에도 FlowDesk 버튼이 있었다. **2026-11-13 C3로 제거 완료** — 화면·문서에서 ChatGPT Sites 링크 0건 확인 (Chrome 검증, 아래 "C1/C3" 참조). 결과 저장처는 앱 안 라이브러리 탭이다.
- 리스타일 후 요약 엔진 workers-ai 유지, 에러 없음.

## 음성 전사 입력 (2026-11-13)

Plaud Transcribe Studio의 전사 형태를 Cloudflare 네이티브(Workers AI Whisper)로 옮긴 파이프라인 맨 앞단.

### Whisper 사전 검증 (REST API, 2026-11-13)

- 무음 WAV 2초(16kHz mono, 64,044바이트) → HTTP 200, `success: true`, 텍스트는 "Thank you very much." 반복 환각. → 무음·잡음에 대한 반복 환각 가드(`isDegenerateTranscript`)를 넣은 근거.
- 실제 음성: Wikimedia Commons "Wikipedia - 2024 South Korean martial law.mp3" 앞 1MB 청크 → HTTP 200, `success: true`, 966자 중 coherent한 영어 전사 ("On December 3, 2024, at 1027 PM Korea's standard time, KST. South Korean president Yonseuk Yul declared martial law..."). → `@cf/openai/whisper`가 이 계정에서 실제 음성을 전사함을 REST로 확인.

### 로컬 검증 (`wrangler dev --local`, 포트 8787)

| # | 케이스 | 결과 |
|---|---|---|
| 1 | `POST /api/transcribe` 무음 WAV | 201, `transcriptStatus: 'pending'`, `transcript: null`, `reason`에 Whisper 실패 원문 포함. 지은 전사본 없음 |
| 2 | `GET /api/recordings` | pending 1건 반환 (`doc_id: null`, provider workers-ai, model `@cf/openai/whisper`, size 64044) |
| 3 | `POST /api/recordings/:id/retry` (pending) | 로컬 AI 불가로 pending 유지, reason 반환 (정직한 실패) |
| 4 | 텍스트 파일 업로드 | 400 |
| 5 | 빈 파일 업로드 | 400 |
| 6 | 26MB mp3 업로드 | 400 (25MB 상한) |
| 7 | 파일 없이 POST | 400 |
| 8 | 스모크: `POST /api/documents` | 201, 기존 경로 유지 |

### 바인딩 검증 (`wrangler dev`, 토큰 주입, 포트 8788 — 로컬 서버 + 클라우드 AI)

| # | 케이스 | 결과 |
|---|---|---|
| 9 | `POST /api/transcribe` 실제 음성 mp3 1MB | 201, `transcriptStatus: 'ready'`, 966자 실제 전사본, `docId` 생성, `recordingId` 생성 |
| 10 | `GET /api/recordings` | ready 1건 + pending(무음) 1건 반환 |
| 11 | `POST /api/recordings/:id/retry` (ready) | `already ready`, 전사본 반환, 행 건드리지 않음 |
| 12 | `POST /api/documents/:docId/summarize` (전사본 문서) | 200, `engine: workers-ai`, 한국어 1줄 요약 + 액션 3개 — 전사→요약 연결 확인 |
| 13 | 스모크: `/api/home`, `/api/tasks`, `/api/library` | 기존과 동일하게 응답 (문서 3·요약 2·할 일 1·리플렉션 1은 로컬 테스트 데이터) |

주의: 위 9–13번은 Miniflare 로컬 D1/R2에 쓴 테스트 데이터라 라이브 DB에는 남지 않는다. `wrangler dev --remote`는 KV `preview_id`가 없어 실행 불가(별도 preview 네임스페이스 필요)라 원격 D1/R2 경로는 로컬에서 검증하지 못했다 — 배포 후 사용자 Chrome에서 실제 음성 업로드로 확인할 것.

### 배포 (2026-11-13)

- `cf-wrangler.py deploy` → https://people-os.workspace-easyware.workers.dev, Version ID `46554999-0c63-450a-8fc2-a68c9ed63970`.
- 마이그레이션 `0003_recordings.sql`은 deploy가 자동 적용하지 않아 `d1 migrations apply people-os-db --remote`로 별도 적용 (✅, 2개 명령 실행). 원격 D1 확인: `recordings` 테이블 존재, 행 0건 (테스트 데이터는 로컬 Miniflare에만 있고 라이브 DB는 깨끗함).
- 라이브 확인은 이 VM에서 workers.dev에 닿지 않아 수행하지 않음 — 사용자 Chrome으로 확인할 것 (음성 업로드 → 전사본 채워짐 → 요약, 녹음 목록 불러오기/다시 전사).

### 검증 완료 (음성 전사, 2026-11-13)

- 배포된 Worker에서의 실제 음성 전사: Chrome 확인 완료 (C2 참조).
- 긴 오디오: 97분 ogg 전사 완료 (아래 "97분 ogg 전사" 참조). 25MB 상한까지의 긴 파일 전사 확인됨.
- 프론트 브라우저 클릭 테스트: Chrome 확인 완료 (C2 + 97분 ogg 참조).

## C1 탭 유지 + C3 Sites 링크 제거 (2026-11-13, Chrome 확인)

- 구현: Sonnet 5.5, 로컬 커밋 `239c0bc` (public/index.html 10줄 변경). 탭 선택을 URL 해시(`#home`·`#upload`·`#ask`·`#coaching`·`#tasks`·`#library`)에 반영, 로드 시 복원, `hashchange` 리스너로 뒤로 가기 지원. "FlowDesk에서 열기" 버튼 2곳 제거 → 결과 카드는 "라이브러리에서 보기"로 교체, `FLOWDESK_URL` 상수 및 관련 문구 제거.
- 로컬 검증: `npx tsc --noEmit` 통과, `wrangler dev --local`에서 `/` 200·`/api/health` 200 (ok:true).
- 배포: `cf-wrangler.py deploy` → https://people-os.workspace-easyware.workers.dev, Version ID `e3c1d75e-9daf-4b51-882f-d8fd71be8fe6`.
- Chrome 확인 (사용자 Chrome): 해시 없이 열면 홈 탭·해시 없음. 질문 탭 클릭 → URL `#ask`, 새로고침해도 질문 탭 유지, 뒤로 가기 → 홈 탭. 결과 카드 버튼은 "할 일로 저장"·"PPTX 초안 다운로드"·"요약 복사"·"라이브러리에서 보기" 4개, "FlowDesk에서 열기" 없음. 업로드 화면·라이브러리 탭에서 "FlowDesk" 텍스트 검색 0건. "라이브러리에서 보기" 클릭 → `#library` 이동. 에러 없음, 상단 상태 "health OK · d1, kv, r2, vectorize, ai, durable_objects".
- 확인 중 샘플 문서 1건이 라이브러리에 저장됨 (id `doc_mweizjym_vjkiuj`) — 데모 데이터, 11/25 정리 예정.
- GitHub 스냅샷: 원격 md5가 로컬 base 커밋 `8cbb196`과 일치 확인 후 push → 원격 커밋 `fba89291c27901e7231d2a6544957b713b04e220`, 재검증 md5 일치, `FlowDesk`/`chatgpt` 0건. sync record에 6번째 엔트리 추가.

## C2 실음성 전사 Chrome 확인 (2026-11-13)

- 파일: 사용자가 첨부한 Plaud 녹음 `original.mp3` (1.9MB, MP3 40kbps 16kHz mono).
- 흐름: 업로드·요약 화면 "0. 음성 파일 전사" 카드 → 파일 선택 → "전사하기" → 약 30초 뒤 "전사 완료 · 문서 id doc_mwej585g_axv0p5 — 전사본이 아래에 채워졌습니다".
- 전사본이 제목("original") + 본문 칸에 채워짐. 본문은 영어 전사본 ("How to use Plod Let's walk through how to use Plod from recording and marking highlights..."). 참고: Whisper가 "Plaud"를 "Plod"로 전사함.
- 전사 전 비활성화였던 "요약하기" 버튼 활성화 → 요약 실행, 엔진 표시 `workers-ai`, 요약 3항목 + 액션 3개.
- 녹음 목록: "original.mp3" 표시, 배지 "전사 완료", "2026-11-13 · 1818KB", "불러오기" 버튼. (계획서 C2의 "ready" 문구와 달리 실제 UI 배지 문구는 "전사 완료" — 같은 상태의 화면 표시.)
- 에러 없음.
- 미확인: 없음 — 24.9MB ogg 긴 오디오는 아래 "97분 ogg 전사"에서 완료 확인됨.

## 97분 ogg 전사 (2026-11-13)

파일: 사용자가 첨부한 Plaud 녹음 `original_0_krwd.ogg` (24.9MB, Ogg Opus 16kHz mono, 97분 = 5,844초).

### 시행착오와 원인 가르기

- 한 번에 전사 시도 → 27분 무응답, 행 자체가 생성 안 됨. 동기 Whisper 호출이 응답 시간 안에 안 끝남.
- 구간별 비동기 전사 구축 (`src/ogg.ts` 순수 JS Ogg 페이지 분할기, 페이지 경계에서만 절단, 패킷이 이어지는 페이지에서는 자르지 않음, granule == 0인 선행 페이지들이 헤더): 30분 구간(7.7MB) → 첫 구간에서 44분 멈춤, 15분 구간(3.8MB) → 첫 구간에서 46분 멈춤, 둘 다 에러 없음.
- 원인 가르기 실험: 짧은 mp3(1.9MB, 6분)는 새 비동기 경로로 60초 이내 전사 완료, 2분 ogg 클립(489KB)은 5분 넘게 멈춤. → 비동기 경로·크기가 아니라 ogg(Opus) 입력 + 구 Whisper 모델(`@cf/openai/whisper` + `{audio: number[]}`) 조합이 hang.
- 모델 교체: Cloudflare 공식 대용량 오디오 청킹 튜토리얼이 쓰는 `@cf/openai/whisper-large-v3-turbo` + Base64 문자열 입력으로 변경. 2분 ogg 클립이 1분 안에 전사 완료 (문서 `doc_mweobwdg_91d31i`).
- 그래도 97분 원본은 15분 구간에서 27분 멈춤. 패턴: 1회 호출당 1.9MB/6분까지는 되고 3.8MB/15분부터 hang. → 구간을 1MB(약 4분) 단위로 변경 (공식 튜토리얼 기준). 로컬 검증: 24개 구간, 각 1025KB·약 246초, ffprobe 디코딩 확인.
- 1MB 구간으로 올리니 12분 만에 17/24까지 진행, 18구간(70분 지점)에서 11분 멈춤. 단독 테스트: 4구간(seg4, 12~16분)은 2분 안에 전사 완료 → 구간 내용 문제가 아님. 공통점: 성공한 전사는 전부 업로드 후 ~2분 안에 끝났고, 그 뒤는 어떤 호출도 안 끝남 → **waitUntil 백그라운드 작업이 약 2분 뒤에 조용히 죽는 것이 원인**.
- 추가 버그: 분할기가 granule 절대값으로 구간 길이를 재서, 잘라낸 파일(seg4/seg11)은 시간 상한이 첫 페이지에서 바로 걸림 (seg11이 1KB+1025KB로 쪼개짐). 기준 granule을 첫 오디오 페이지로 수정 — 로컬 검증: seg4/seg11이 각각 1구간 246초로 정상 분할, 원본은 여전히 24구간.

### 최종 구조 (재개 가능 구간 전사)

- `recordings`에 `partial`(완료 구간 전사본)·`done_chunks`(완료 구간 수)·`lock_until`(동시 실행 방지 잠금, 180초 TTL) 추가 (마이그레이션 0005).
- 업로드 직후 waitUntil은 처음 2구간(60초 예산)까지만 돌리고, 프론트 폴링이 `POST /api/recordings/:id/advance`로 한 번에 1구간씩 직접 전사한다 (60분 상한, 페이지를 열어두는 동안 이어감).
- 구간별 Whisper 호출 90초 타임아웃 (fetch 핸들러 수명 ~2분보다 짧아야 실패 처리가 됨). 실패 구간은 `[구간 N 전사 실패]` 자리 표시자만 남기고 건너뛴다 — 전사본을 지어내지 않는다.
- 폴링 루프는 /advance 호출이 실패해도 끝나지 않고 5초 뒤 재시도한다. /advance는 내부 에러가 나도 행을 돌려주고 500을 내지 않는다.
- `POST /api/recordings/:id/retry`: 멈춘 processing 행은 완료분을 유지한 채 이어가고, pending 행은 처음부터 다시 한다.

### 최종 확인 (Chrome, 클라우드 브라우저, 2026-11-13 18:26~18:31)

- 멈춘 행(`rec_mweqo8bw_rgli6q`, 18/24)에서 '진행 확인'을 눌러 이어가기 — 다시 올리지 않음. 약 5분 뒤 '전사 완료'로 전환, 문서 id `doc_mweryu3r_d54l0b`.
- D1 직접 확인: 행 `ready`, `done_chunks` 24/24, 전사본 42,967자. 실패 자리 표시자 0건 — 24개 구간 전부 성공.
- 제목 칸 'original_0_krwd', 본문 칸에 긴 전사본 채워짐 (영어 Gemini Enterprise 부분 + 한국어 김일호 발표·삼성 메디슨 등).
- '요약하기' 활성화 → 요약 실행, 엔진 표시 `workers-ai`, 요약 3항목 + 액션 3개. 전사→요약 파이프라인이 97분 파일에서도 끝까지 동작함을 확인.
- 참고: 목록에는 이전 시도들의 멈춘 항목(3/24, 1/7, 1/4 구간 등)이 그대로 남아 있음 — 11/25 데모 데이터 정리 때 처리 예정. Whisper가 "Plaud"를 "Plod"로 전사하는 문제는 mp3에서 확인된 것과 동일 (C2 참조).

## C6 운영 경로 잠금 (2026-11-13, 로컬 검증)

- `/api/debug-ai`, `/api/seed-vectors`를 `X-Admin-Secret` 헤더 + `ADMIN_SECRET` 환경값 뒤로 잠금 (fail-closed: 시크릿 미설정 시 항상 거부). 시크릿은 코드에 없고 `wrangler secret` / 대시보드에서만 설정.
- 로컬 검증 (`wrangler dev --local`): 헤더 없음 → 401, 잘못된 헤더 → 401, `/api/health` 200 (ok:true), `/api/home` 200. `npx tsc --noEmit` 통과.
- 비밀 스캔: 추적 파일 + git 이력 전체에서 토큰·키 패턴(`sk-`·`ghp_`·`AKIA`·개인키·Bearer 등) 0건. `.dev.vars` 없음(있으면 gitignore). `wrangler.toml` 리소스 ID는 비밀이 아니므로 유지.
- 라이브 Chrome 확인 (401 여부)은 사용자 복귀 후 진행 예정.
- 배포: `cf-wrangler.py deploy` → Version ID `08a99d43-593e-4e4c-b65f-37fea934e9a8` (2026-11-13, 로컬 커밋 `d9719c5`). GitHub 스냅샷 푸시는 Chrome 확인 후 진행.

## S2 AI Gateway (2026-11-13, 로컬 구현 — 라이브 확인 전)

- 공식 방식 확인: Cloudflare 문서 "Set up Workers AI with AI Gateway" — `env.AI.run()`의 세 번째 인자로 `{ gateway: { id, skipCache } }`를 넘긴다. `wrangler.toml`의 `[ai]` 바인딩 변경은 필요 없다. `@cloudflare/workers-types` (설치본 4.20241112.0)의 `AiOptions`·`GatewayOptions` 타입이 이 옵션을 이미 지원한다.
- 게이트웨이 생성: wrangler 4.161.0에 `ai-gateway` 명령이 없다 (`wrangler ai`는 models/finetune만). CLI 생성이 안 돼 대시보드에서 `people-os` 게이트웨이를 만들어야 한다 (배포 전 필수). 이름 있는 게이트웨이는 자동 생성되지 않는다 (`"default"`만 첫 인증 요청 때 자동 생성). 우회 API 호출은 하지 않았다.
- 구현: 신규 `src/ai-gateway.ts` (`AI_GATEWAY_ID = "people-os"`, `aiGatewayOptions()` 헬퍼). 11개 AI 호출처 전부 경유 — 채팅 5곳 (요약·질문·코칭·다이제스트·debug-ai), 임베딩 5곳 (시딩·문서 색인·암묵지 검증·질문 검색·debug-ai), 전사 1곳. 태그 `ask/summary/embed/whisper/coaching/digest/debug`로 대시보드에서 기능별 구분.
- 캐시 정책: 채팅은 게이트웨이 캐시 사용 (프롬프트에 근거 문맥 포함 → 근거가 바뀌면 키도 바뀜, C5-b 게시 후 재질문은 새 답). 다시 생성(`force`)·debug-ai는 `skipCache: true`. 임베딩·전사는 항상 `skipCache: true`.
- 로컬 검증: `npx tsc --noEmit` 통과. `wrangler dev --local` 부팅 확인 — `/api/health` 200 (ok:true, 바인딩 전부 true), `/api/seed-status` 200. 로컬 AI 바인딩은 실패하는 기존 한계라 (`lastError: "Not logged in"`) 게이트웨이 경유 자체는 로컬에서 검증 불가 — 라이브 확인 필요.
- 게이트웨이 미생성 시 동작: AI 호출이 실패하고 호출처의 try/catch가 기존 로컬 폴백(추출식 요약·템플릿 답·전사 pending)으로 떨어진다. 앱이 죽지 않는다.
- 되돌리기: 호출처에서 `aiGatewayOptions()` 인자만 빼면 된다 (`wrangler.toml` 변경 없음).
- 부모가 이어서 할 일: ① 대시보드에서 `people-os` 게이트웨이 생성 + 레이트 리밋 설정 (권장 분당 100회, 캐시 기본값) ② 배포 ③ Chrome 확인 — 질문·요약·전사 정상 동작 + AI Gateway 대시보드(Logs)에서 `people-os` 게이트웨이에 태그별 로그·캐시 표시 확인.

## C5 Phase 3 — 업로드 문서 파서 라우팅 (2026-11-13, 로컬 구현 — 라이브 확인 전)

- 구현: 신규 `src/parse.ts` (매직 바이트 판별 + HWPX 추출 + XML 엔티티 디코딩), `POST /api/documents`에 multipart 파일 경로 추가 (기존 JSON 경로 그대로), 마이그레이션 0012 (`extract_status`/`extract_error`/`source_r2_key`), 프론트 업로드 탭에 파일 입력 + "파일로 업로드" 버튼, 라이브러리 카드에 변환 실패 사유 표시. 의존성 fflate 추가 (HWPX zip 해제용, Workers 호환 순수 JS).
- 판별 (확장자 무시, 앞부분 바이트만): `%PDF` → PDF, `PK`+`mimetype=application/hwp+zip` → HWPX, `PK`+`[Content_Types].xml` → OOXML, `D0CF11E0` → HWP 5.0/구형 Office, 이미지 매직 바이트 → 이미지, UTF-8 → 텍스트, `<?xml`/`<svg`/`<html` → toMarkdown. 공식 문서 확인: toMarkdown 지원 형식은 PDF·이미지·HTML·XML·Office·ODF·CSV·Apple Numbers — HWPX는 없어 Worker 내 직접 추출이 맞다. toMarkdown 파일 크기 상한은 공식 문서에 명시 없음 → 우리 쪽 10MB 상한.
- 로컬 검증 (단위 테스트 25개 전부 통과): 판별 15개 (PDF·OLE·PNG·JPEG·GIF·WEBP·BMP·HWPX 2종·mimetype 없음 포함·OOXML·손상 zip·텍스트·XML·SVG·이진 쓰레기·빈 파일), HWPX 추출 9개 (제1/2/3조 마커 보존, 본문, 표 셀, `&amp;` 디코딩, 문단 분리, 태그 잔재 없음), BOM 제거 1개.
- 로컬 검증 (`wrangler dev --local`, 마이그레이션 0012 로컬 적용): HWPX 업로드 → `format: hwpx, extractStatus: ready`, D1 chunk 2개 (제1조 목적·제2조 적용 범위), R2 저장 예. 텍스트 업로드 → `format: text, ready`, chunk 1개. 가짜 HWP5(OLE) → `format: ole, failed` + "HWPX 또는 PDF로 저장해 올려 주세요" 안내. 쓰레기 바이너리 → `format: unknown, failed` + 지원 형식 안내. DOCX → `format: ooxml, failed` (로컬 AI "Not logged in" — toMarkdown 자체가 로컬에서 안 도는 기존 한계, 실패가 우아하게 처리됨). 11MB 파일 → 400 "파일은 10MB 이하만 올릴 수 있습니다". JSON 경로 회귀 → 정상. 질문 "이 규정은 누구에게 적용되나요?" → HWPX 문서 chunk 2개가 근거로 나옴 (D1 폴백 경로). "연차휴가는 입사 몇 년이 지나면 생기나요?" → 여전히 연차휴가 규정(제12조)이 1위. `/api/library`에 `extract_status`/`extract_error` 포함 확인. 로컬 임베딩 upsert 실패(`indexError: Not logged in`)는 기존 한계 — D1 chunk는 남는다.
- 부모가 이어서 할 일: ① 마이그레이션 0012 원격 적용 ② 배포 (S2 게이트웨이 생성 전제 — toMarkdown도 `people-os` 게이트웨이 경유) ③ Chrome 확인 — HWPX 업로드 → 질문 시 근거로 나오는지, 연차 질문 1위 유지되는지, DOCX/PDF 실제 변환되는지, HWP5 안내 문구·라이브러리 실패 표시 확인.
