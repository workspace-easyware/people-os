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

---

## 모델 교체 — 주 답변 Qwen3.8-27b (2026-11-18)

- 1차 시도 실패: 새 모델의 `choices[0].message.content` 형식을 `responseText`가 못 읽어 답이 raw JSON으로 나옴 → 롤백 (`5ee615c9`).
- 2차 성공: 라이브 `8458c9e9`. HR 질문 "연차는 며칠이야?" → 정상 텍스트 답, 제12조 인용, `grounded: true`.
- Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3는 건드리지 않음.

## Think 전면 도입 T0~T3 (2026-11-19~20)

- **T0** 통과 (커밋 `b496035`, 기준점 태그 `pre-think`): 관문 6항목 전부.
- **T1** (커밋 `bced0ee`, 태그 `think-t1`, 라이브 `7931eb4a`): ThinkAgent DO(마이그레이션 0040) + 도구 15종 변환 + 승인 차단 + 한도 훅(10스텝·LLM 20회·28분·같은 도구 3회). 런타임은 run 단위가 아니라 **agent 단계 단위**로 고정. `AGENT_RUNTIME=legacy`로 배포 (wrangler 4 첫 운영 배포).
- **T2** (커밋 `97f3f60`, 태그 `think-t2`, 라이브 `ad64158d`): AssistantAgent(사용자당 1개) + `/api/agents` 라우트 + ask-pipeline 도구 6종. 남의 어시스턴트 접근 404, 세션 쿠키 전용. 시험 흔적 트레이스 1건(`wf_asst_u_t2r_t1_1`)은 사용자 "그대로 둬" 결정 — 삭제 금지.
- **T3** (커밋 `8880010`, 태그 `think-t3`, 라이브 `a685a42f`): 선행 3건(일일 턴 상한 30회·대화 지우기·관측 어시스턴트 턴, 마이그레이션 0041) + 에이전트 화면 + ResearchAgent + `[observability.traces]` on + `AGENT_RUNTIME=think` 전환. 하네스 9/9. think vs legacy 기준선: 같은 워크플로 성공, 54초 vs 61초, 승인·발송 0건. 15분 크론 정상 (14:15·14:30 틱 ok).
- **프롬프트 v5** (2026-11-20 09:05, `pv_086c7a84faaa4d19`): 답 마지막에 근거 기반 사용 절차 덧붙이기. 골든셋 6/6, avgJudge 0.8667.
- **reasoning low 결정** (2026-11-20): 주 답변만 medium→low. 배포 `307cf8b6`, 골든셋 `run_df07177b374b43c4` 6/6 avgJudge 0.8167. 03:00 자동 평가(11/20) 6/6, 0.8167.
- **T3 마이너 6개 수정** (2026-11-21 08:10, 커밋 `09fd1fe`, 태그 `think-t3-fixes`, 라이브 `7fbe378c`): ① LLM 캡 agent 사용량 합산(llm 26 + agent 4 = 30 뒤 #27 막힘) ② 토큰 스트리밍(SSE delta + 2초 폴링 폴백, 실제 Qwen 47개 중 46개가 턴 종료 전) ③ 판단 근거 영어 **미완** — Qwen thinking이 언어 지시를 안 따름 → (A) `<details>` 접기 + "판단 근거 (모델 원문·영어)" 표시로 사용자 결정·적용 (배포 `778b62b4`) ④ 관측 llm_calls=Think llmCalls·duration=created_at→finished_at ⑤ 조사 자식 stop "completed" ⑥ 조사 진행 이벤트 + 15초 하트비트(252초 조사에 21개, 최대 공백 18.6초). 스모크 13개 엔드포인트 + 홈 동일, tail 예외 0, 15분 크론 ok.

## 비동기 승인 P1~P3 (2026-11-21 새벽)

- **P1** (커밋 `0df50d9`, 태그 `async-p1`, 라이브 `fc2ed076`): 마이그레이션 0042 `workflow_pending_actions`. 멱등성 결정적 id `wfpa_<runId>_<stepIndex>`(+agent용 `_t<turn>`). 노드 시뮬레이션(검증 먼저 → 대기 행 삽입 → `{simulated:true, pendingActionId}` 반환). 하네스 10/10.
- **P2** (커밋 `c53ac2e`, 태그 `async-p2`, 라이브 `720700f8`): 에이전트 경로 지연(legacy+Think) + 결정 API + 큐 소비자. `requiresApproval:true`+지연 agent는 저장 거부, hr_admin은 남의 동작 보기만 가능·결정은 본인 것만, 중복 승인 1회 실행. 하네스 10/10.
- **P3** (커밋 `3940ef5`, 태그 `async-p3`, 라이브 `81505638`): `public/workflow.js`·`workflow.css`만 변경. 대기 동작 섹션 + 일괄 승인/거절(50개씩) + 상태 필터 8종 + `executing`은 "실행 중(확인 필요)" 표시. 브라우저 렌더 확인 완료 (2026-11-21 02:03, VM 브라우저) — 단 실제 지연 run이 없어 배지·일괄 클릭은 미확인 (11-21 회귀에서 확인, 아래 참조).

## 문서 편집·생성 (2026-11-21)

- **PPTX 편집 파일럿** (11:33, 커밋 `85753e8`): 판정 **조건부 도입 가능** — `pptx-viewer-core 5.0.0` / `ooxml-core 2.x`. 텍스트·도형·표·차트·슬라이드 복제 전부 로컬 workerd + 원격 통과, 손대지 않은 슬라이드 바이트 동일. 조건: ① 별도 Worker 분리 ② 편집 1회 CPU 약 0.5~1초 (Workers Paid라 한도 여유).
- **PPTX 라이브 통합** (12:11, 커밋 `96d5007`, 태그 `pptx-edit-v1`): 편집 Worker `people-os-pptx-editor` 버전 `b0c17fb1`. People OS `778b62b4` → `a20936b2`. 라이브 E2E 통과(덱 생성→inspect→ops→새 버전→다시 읽기, 자연어 지시 실제 Qwen 11.0초, 워크플로 `pptx_edit` 승인 게이트 통과). CPU inspect 190ms·applyOps 682~1,566ms. **PowerPoint 열림 확인 완료 (사용자 12:59 "잘 보여")**.
- **엑셀 편집** (13:44, 커밋 `7755d3e`, 태그 `xlsx-edit-v1`): xlvane 1.3.4 파일럿 통과(조건 없음). 편집 Worker `b0c17fb1` → `84973507`, People OS `a20936b2` → `4a7af7af`. 라이브 편집 9 ops CPU 175ms. **Excel 열림 확인 완료 (사용자 15:29 "이상없어")** — 복구 대화상자 없음, 수식 재계산, 메모 시트 정상.
- **워드 새로 만들기** (14:40, 커밋 `e1b5df4`, 태그 `docx-create-v1`, People OS 라이브 `cd392c91`): docx 9.16.0, 본체 Worker 배치. 제목·Heading·굵게·기울임·글머리·번호·표·페이지 나누기 로컬+원격 15/15 통과. AI 지시 경로 약점: Qwen JSON 괄호 오류에 보정 2종 + 1회 재시도.
- **워드 표 고치기** (15:58, 커밋 `fee589e`, 태그 `docx-table-fix-v1`, People OS 라이브 `483b32b8`): 열 너비 5000% → 100% (docx PERCENTAGE는 숫자 size를 "퍼센트"로 받아 ×50), AI 자리표시자 금지+검증. **사용자 확인 완료 (16:48 "잘 수정되었다")**.

## 회귀 검증 (2026-11-21, 11-24분을 앞당김, 커밋 `4647464`, 태그 `regression-2026-11-21`)

1차는 로컬만 통과 (라이브 HTTP 검증이 권한 문제로 막힘 — 이후 `~/.claude/settings.json`에 `Bash(curl *peopleos.site*)`·`Bash(git log *)` 규칙 추가). 2차는 라이브 7개 항목 전부 실시 — **6개 통과 + 화상회의는 범위 제한 통과**. 코드 수정·배포 없음, 라이브 `483b32b8` 유지.

| # | 항목 | 결과 |
|---|---|---|
| ① | 관측 어시스턴트 목록 API | 통과 (X-Admin-Secret 200, 익명 401) |
| ② | 실제 모델 legacy/think 3목표 비교 | 통과 — 둘 다 성공·예외 0. A 목표(이번 주 할 일): legacy는 근거 없이 할 일을 지어내고 think는 "기록이 없어 정리할 수 없다"고 정확히 답함. think 단계당 CPU가 legacy보다 두 자릿수 많으나 한도 안 |
| ③ | 라이브 think 승인 경로 | 통과 — waiting_approval → approve 200 → 발송 → mercer.jhkang@peopleos.site 받은편지함 도착 1통 |
| ④ | 화상회의·전사 큐 | 전사 큐 통과 (2분 ogg → Whisper → 요약 → 색인 → done, 약 4분). 화상회의 자체는 사람 참가자 필요해 미확인 — 11-24에 실제 통화 1회 확인 권장 |
| ⑤ | 실제 Qwen 지연 문장 | 통과 — legacy 지연 2회·think 지연 1회 모두 "보냈습니다" 안 나옴 |
| ⑥ | 라이브 테스트 대기 동작 run | 통과 — 브라우저 확인용으로 남김 (아래 브라우저 수정에서 승인·정리) |
| ⑦ | T3-FIXES 라이브 + Office 스모크 | 통과 — LLM 캡 agent 합산 (l28에서 상한 도달로 실패 — 예측과 정확히 일치), 관측 llm_calls·duration 정상, 조사 stop "completed", PPTX/XLSX/DOCX 스모크 200/201, 기존 엔드포인트 12/12 바이트 동일 |

- **표시 문제 2건 (미수정 결정)**: 관측 run `llm_calls`가 캡 단계도 세어 1 많음 (실제 30, 표시 31), legacy agent 단계 관측 duration 짧음 (실제 약 113초 → 표시 28초).
- **기존 버그 재확인**: 문서·녹음 삭제 시 `doc_nodes` 잔재 (정리 SQL로 지움).
- **10b 판단**: `executing` stuck 스윕은 제출 전 불필요 (라이브 대기 동작 0행·stuck 0행, 재실행하면 이중 발송 위험).
- 결과: `files/workflow-verify/regression-2026-11-21/RESULT.md` + `evidence/`.

## 브라우저 화면 회귀 + 수정 + 재확인 (2026-11-21 17:39~18:13)

- **화면 회귀 확인** (17:39~17:45, VM 클라우드 브라우저, hr.jhkang 로그인, `browser-check-2026-11-21.md`): API 회귀는 전부 통과했지만 **화면에서 실패 3건** — ① 에이전트 대화 지우기 버튼 무반응 ② P3 일괄 승인 무반응 ③ Word 편집·엑셀 편집/생성 안 됨 (Word 편집은 구현된 적 없음, 엑셀은 .xlsx 문서 0건이라 미확인). 부분 실패: 진행 기록 2초 갱신 실패("답을 만드는 중…" 15초 그대로), 승인 대기 배지 → 결재함 링크 실패, 코칭 대상 드롭다운 비어 있음, 전사본 10회 중복, 트레이스 상세 스팬 없음. 원인 가설: 두 실패 버튼 모두 API 호출 전에 네이티브 `confirm()`을 부름 — 자동화 브라우저는 네이티브 confirm을 기본 자동 거절 → 조용히 무반응.
- **수정 세션** (Opus 14분 → 사용자 지시로 Fable 5.2가 이어서 마무리, 라이브 `474e11ab`): ① 일괄 승인·대화 지우기 — 네이티브 `confirm()`을 페이지 내 대화상자(`uiConfirm`) + 토스트로 교체 (원인은 코드 경로로 확정). ② 전사본 중복 — 라이브에 같은 제목 전사본이 실제로 10개 있어 1줄로 묶어 표시. "코칭 대상 비어 있음"은 **원인 미확정** (서버는 3명 돌려줌, 재현 안 됨) — 방어 수정만. ③ 트레이스 스팬 — 어시스턴트·워크플로 `ask_rag` 경로가 trace sink 없이 기록하던 것을 고침. 새 질문 `evt_mwq6qua0_tn0lde`는 스팬 9개와 원문이 남음 (옛 행은 되살릴 수 없음). ④ 진행 기록 — 설계대로라 고치지 않음 (이벤트는 도구·스텝 경계에서만 생김, `ask_rag` 한 번이 31초). ⑤ 승인 대기 링크 — 대기 동작은 워크플로우 화면에 두기로 판단, 에이전트 상세에 "대기 동작 N개" 배지 + 링크. ⑥ Word·엑셀 버튼 — PPTX·XLSX에만 "편집본 만들기", Word에는 "Word 편집 미지원 (새로 만들기는 됩니다)". ⑦ 지연 승인 알림 — 설계상 없음, 고치지 않음. ⑧ PPTX 편집본 덱 삭제. 결과: `browser-fix-RESULT.md`.
- **브라우저 재확인** (18:10~18:12, VM 클라우드 브라우저, 6개 항목 **전부 통과**): ⑤ 배지 + 링크 이동 확인 → ① 일괄 승인 (1) → 화면 안 대화상자 → "1개 승인" → 토스트 → 행 "실행됨" → 메일함 최상단에 "[RG] 지연 승인 시험 think" 도착 (18:11) → ② 대화 지우기 → 대화 비워짐 (사용 횟수 그대로 3/30회) → ③ 코칭 대상 김불꽃·이구름 표시, 전사본 "같은 내용 10개 (최신만 표시)" 1줄 → ④ 트레이스 `evt_mwq6qua0_tn0lde` 상세에 단계 타임라인·근거 후보·원문 표시 (스팬은 9개가 아니라 **10개** — `d1_merge` 하나 더 있음) → ⑥ test-docx 행에 "Word 편집 미지원" 안내만 표시. 네이티브 confirm()은 한 번도 안 뜸.
- **정리** (18:13): 테스트 대기 동작 run·워크플로우·메일 2행·R2 raw.eml 2개 삭제, D1 재확인 0건. 데모용 워크플로우("지연 승인 시연 (데모용)", run 0)는 건드리지 않음.
- **범위 밖으로 남은 네이티브 `confirm()`**: 스케줄·단계·워크플로 삭제, 녹음·파일 삭제, 비밀번호 초기화, 결재 회수·강제 반려, 달력, LMS 등 (위치는 `browser-fix-RESULT.md`에 있음). 자동화 브라우저로 누르면 똑같이 무반응입니다.

## 기타 라이브 확인 (2026-11-19~21)

- **Workers Paid** (2026-11-19): 사용자가 대시보드에서 직접 확인 — $5/월, "Dec 16, 2026에 갱신".
- **Turnstile** (2026-11-19, 배포 `6f6b45db`): HR 규정 검색(`/api/ask`)에만 게이트. 사이트 키(공개): `0x4AAAAAAGIO_oaHS7s1r41w`. VM 클라우드 브라우저에서는 반복 실패(600010) — 사용자 본인 브라우저에서만 풀림.
- **XAI 4종** (2026-11-19, 배포 `7d0739f3`, 마이그레이션 0037): 라이브 검증 5/5 통과.
- **Plaud 연동** (2026-11-19, 배포 `555295d1`, 마이그레이션 0033~0035): 녹음 목록 + 가져오기 + 전사 없는 녹음 Whisper 전사 (배포 `6690e643`, 오디오 상한 40MB).
- **이메일** (2026-11-17~21): 도메인 `peopleos.site`, 수신 Email Routing catch-all, 발송 Resend. 실제 수신·발송은 2026-11-21 회귀에서 확인.
- **캘린더 C1~C4** (2026-11-17): 배포 완료. 실제 브라우저 구글 동의→연결→일정 표시는 미확인. C4 events.list 호출 방식은 기억 기반 가정 — 첫 실호출 400/403 시 의심.
- **채팅·DO 레이트 리미터** (2026-11-18): DO 리미터 하네스 동시 30요청 → 정확히 20 허용/10 차단 (KV는 30건 전부 허용).
- **데모 결정 반영** (2026-11-21): 해피AI 영상 데모·제출물 노출 포함, A2 승인 큐 데모 포함, Muse 비서 계획서는 제출 저장소에서 제외. 지연 승인 시연 워크플로우 초안 생성 ("지연 승인 시연 (데모용)", 실행 안 함 — 녹화일 11-26에 1회 실행).

## 제출 전 수정 3건 — 편집 Worker 개명 + 로그아웃 새로고침 + doc_nodes 잔재 (2026-11-22, Opus 5.5 단일 세션)

- **배포** (직렬): 편집 Worker 새 이름 배포 → 본체 배포(바인딩 `env.DOC_EDITOR (people-os-doc-editor)` 확인) → 3분 대기 → 라이브 검증 → 옛 Worker 삭제. People OS `474e11ab` → **`40194b95`**, 편집 Worker `people-os-pptx-editor` `84973507` → **`people-os-doc-editor` `2828a924`** (옛 Worker 삭제 확인 — 조회 시 10007 "does not exist"). 폴더명 `pptx-editor/`는 그대로.
- **개명 검증**: 기존 덱 `deck_mwf14fsf_nmvrnq`로 PPTX inspect 200 (3장) · edit 201 (편집본 삭제), 시험 .xlsx 업로드로 XLSX inspect 200 (3시트) · edit 201 (편집본 삭제). 삭제 뒤 PPTX inspect 다시 200 — 숨은 의존 없음.
- **로그아웃 새로고침**: `doLogout()` 끝에 `location.reload()` 추가 (라이브 홈 HTML 1054행에서 확인). API 실패 시 서버 세션이 살아 있으면 다시 로그인 상태로 보이는 게 정직한 동작이라 그대로 둠. **브라우저 클릭 확인은 별도** (VM 클라우드 브라우저, hr.jhkang 로그인, 로그아웃 버튼 → 새로고침 → 로그인 화면).
- **doc_nodes 잔재 수정**: `purgeDocument()`에 `DELETE FROM doc_nodes WHERE doc_id = ?` 추가 (주석 단계 목록에도 반영). 삭제 경로는 이 함수 한 곳뿐 (`DELETE FROM documents` grep 확인), 덱 삭제는 doc_nodes와 무관. 라이브 고아 행은 시험 전부터 **0건** (전체 80행)이라 정리할 것이 없었고 시험 뒤에도 0건. 문서 삭제 검증: 트리 행 2개 → 0. 녹음 삭제 검증: 트리 행 2개 → 0 (문서·chunks·녹음 행도 0). 한계: 녹음 시험은 실제 오디오 업로드·Whisper 전사가 아니라 API로 만든 전사본 문서 + D1 직접 INSERT한 녹음 행이라, 오디오 R2 삭제는 없는 키로만 확인됨.
- **스모크**: `/api/health` 200 · 익명 `/api/auth/me` 401 · 익명 `/api/workflows/templates` 401 — 이전과 동일. 시험 데이터·임시 세션 정리 확인 0건.
- **남은 문제 (범위 밖, 재현 안 함)**: 트리 빌드 도중(LLM 호출 중)에 문서를 지우면 `saveTreeNodes`가 doc_nodes 행을 다시 넣을 수 있는 경쟁 조건 — 고아가 다시 생기면 이 경로를 먼저 볼 것.
- 결과: `files/workflow-verify/doc-fix-2026-11-22/RESULT.md`.

## Word 기존 .docx 편집 — 파일럿 + 라이브 통합 (2026-11-22, Fable 5.2 단일 세션)

- **파일럿 판정: 조건부 도입 가능** (ooxml-core 2.0.0의 docx 영역). 검사 44개(Word 모양 문서 26 + docx 라이브러리 문서 18)가 로컬 workerd와 원격 Workers에서 전부 통과. 조건 3개: ① 편집 Worker에 붙인다 (본체 단독 최소 경로 gzip 473 KiB라 본체에 넣으면 docx 생성의 4배) ② 문단 5,000개 상한 (5,200개 문서 편집 1회 CPU 약 4.7초) ③ Word에서 직접 열어 보는 확인은 못 함 (VM에 Word·LibreOffice 없음). docx Patcher는 자리표시자만 바꿔 맞지 않음, JSZip 수작업은 불필요. 시험 Worker `people-os-docx-edit-pilot`는 삭제.
- **통합·배포** (직렬): 편집 Worker 먼저, People OS 다음. People OS `40194b95` → **`ae40ce70`**, 편집 Worker `2828a924` → **`1dd93ed7`** (번들 gzip 2,463 → 2,868 KiB, +405 KiB). D1·DO 마이그레이션 없음. 롤백은 People OS를 `40194b95`로 되돌리면 됨.
- **라이브 검증**: 업로드 → inspect 200 (문단 17·표 1) → ops 8개 edit 201 (2.5초, 바뀐 부품은 document.xml·header1.xml뿐) → 편집본 다시 inspect (제목·김철수·650만 원·표 32·26·새 문단 확인) → 원본 다운로드가 업로드 파일과 `cmp` 동일. **자연어 지시** (Qwen 계획 ops 4개) 첫 시도에 201. 기존 엔드포인트 12건 바이트 동일 (`/api/health`·익명 `/api/auth/me`·PPTX/XLSX inspect 로그인·익명·`/api/library`·JS/CSS 4개). `/docx-edit.js` 신규 200 (12,931 B). CPU: applyDocumentOps 189~219ms, inspect 71~104ms. 임시 데이터 정리 확인 (users·sessions·documents·doc_nodes·chunks·decks 0건).
- **남은 확인 1건: `edited-live.docx`를 Word에서 직접 열어 복구 대화상자가 뜨지 않는지 사용자가 봐야 함** (2번째 문단 "김철수" 굵게, 메모·추적·하이퍼링크·머리글, 표 실적 셀 "26" 한 줄). 그 밖: 자연어 지시 편집 1건 실측 71초 (거의 전부 Qwen 시간, 1회만 잼), 재시도 경로는 라이브에서 안 일어남 (첫 시도 성공), 실제 Word 저장 회사 문서(각주·목차·콘텐츠 컨트롤·텍스트 상자·SmartArt)는 미확인, 중첩 표는 읽기 전용, 문단 직접 고치기는 첫 run 서식으로 합쳐짐.
- 결과: `files/workflow-verify/docx-edit-pilot/RESULT.md`, `files/workflow-verify/docx-edit/RESULT.md`. 커밋 `2a71347`, 태그 `docx-edit-v1`.

## Word 새로 만들기 확장 — 이미지·목차·머리말/바닥글 (2026-11-22, Fable 5.2 단일 세션)

- **파일럿 판정**: 이미지 조건부 도입 (PNG·JPEG·GIF·BMP만, 장당 5 MiB·합계 10 MiB·10장) · 목차 도입 가능 (TOC 필드 + 항목 5개 미리 채움, 쪽 번호만 Word 갱신) · 머리말·바닥글 도입 가능 (`PAGE`·`NUMPAGES`, 첫 쪽 다르게 옵션). 검사 47개 로컬·원격 전부 통과. 번들 본체 gzip +17 KiB라 본체에 둠. 이미지 10 MiB 넣으면 생성 CPU 약 1~3초.
- **통합·배포**: People OS `ae40ce70` → **`2e83ebca`** (편집 Worker 무접촉). `POST /api/docx/create`에 `images`·`toc`·`header`·`footer`·`differentFirstPage`, 자연어 지시도 세 기능 사용, UI 이미지 고르기·목차·머리말/바닥글 칸, `docx_create` 노드 입력 키 추가. D1·DO 마이그레이션 없음.
- **라이브 검증**: 구조화 4종(이미지·목차·머리말/바닥글·종합) + 자연어 지시 2종이 201로 만들어졌고 다시 읽어 요소를 확인 (그림 크기·정렬, 목차 항목 5개, 머리말 문구, 바닥글 `사내 한정 · PAGE / NUMPAGES`, XML 오류 0). 기존 구조화·지시 생성은 응답 모양 동일, 기존 엔드포인트 바이트 동일. CPU 7~302ms, tail 55건 예외 0. 임시 데이터 정리 확인 (users·sessions·documents·doc_nodes·chunks 0건).
- **주의할 점**: 자연어 지시 1차 시도가 Workers AI `3046 Request timeout`으로 502 (122초 뒤) — 같은 요청 재시도는 성공, 이번 변경이 원인이라는 근거 없음. 지시 생성 시간이 배포 전 13.9초에서 배포 후 62~72초로 느려짐 (프롬프트 약 500자 증가 + 1건은 JSON 깨져 재시도; 앞 세션 기록 "약 56초"와 같은 범위라 Workers AI 변동으로 봄, 프롬프트 길이 영향은 따로 안 잼). AI 지시를 Queue로 옮기는 다음 과제가 이 문제를 줄인다.
- **남은 확인**: `created-ext-live.docx`를 Word에서 직접 열어 복구 대화상자·목차 쪽 번호·BMP/JPEG 표시 확인 (사용자 몫). 화면 UI(이미지 목록·체크·너비 선택·개요 `![캡션](그림1)`)는 브라우저로 눌러 보지 못함. 실제 사진 JPEG·EXIF 회전·5 MiB 가까운 실제 이미지는 미시험. `docx_create` 노드 승인 게이트는 로컬에서만 확인 (라이브 미실행).
- 결과: `files/workflow-verify/docx-create-ext/RESULT.md`. 커밋 `53b6434`, 태그 `docx-create-ext-v1`.

## AI 지시 Queue 이동 — Word 생성·편집 (2026-11-22, Fable 5.2 단일 세션)

- **설계**: 지시 요청은 AI 없는 사전 검사(4xx는 바로) → `docx_jobs` 행 + 전용 Queue `people-os-docx-jobs` → 202 + 작업 id. 화면은 `GET /api/docx/jobs/:id`를 2초마다 폴링. 구조화 입력은 예전처럼 바로 201. 상태 `queued` → `running` → `done`/`failed`, 실패 사유 한국어, 동시 작업 3개 상한(429), 15분 상한(크론 정리). 멱등성: 작업 때 문서 id를 미리 정해 같은 작업이 두 번 돌아도 문서 1개. 재시도: 계획 틀림은 코드 내 1회 재시도만, AI 호출 실패는 15초 뒤 최대 3회, AI 호출 1회 150초 상한. D1 마이그레이션 0043 `docx_jobs`.
- **배포**: 1차 `0f8b0589` (기존 `people-os-pipeline` 재사용) → 앞 작업이 도는 동안 뒤 메시지 2개가 26초 대기하는 것을 보고 전용 큐로 나눔 → 2차 **`48544fec`** (현재 라이브). 편집 Worker 무접촉.
- **라이브 검증**: 구조화 생성 201 (1.9초) · 지시 생성 202 → done 168초(계획 2회, 예전이면 요청을 약 3분 붙잡았을 건) · 지시 편집 202 → done 206초(대기 166초 + 실행 39초). 타임아웃·502 없음. 기존 엔드포인트 바이트 동일. 임시 데이터 정리 확인 (users·sessions·documents·doc_nodes·chunks·docx_jobs 0건).
- **주의할 점**: **작업이 한 번에 하나씩 돈다** — 전용 큐로 나눈 뒤에도 뒤 작업이 앞 작업(166초)이 끝날 때까지 `queued`로 기다렸다 (원인 미확인). 여러 사람이 동시에 쓰면 15분 상한에 걸려 `failed`가 될 수 있다. 고치려면 기다리지 않는 구조(DO 알람 등)가 필요하다. 라이브에서 못 본 경로: AI 호출 실패 뒤 재시도, 소비자 죽은 뒤 재전달, 중복 전달 (로컬 가짜 AI로만 확인). 브라우저 화면("AI가 만들고 있어요" 표시·목록 갱신)은 직접 눌러 보지 못함. 워크플로 `docx_create`·`docx_edit` 노드는 바꾸지 않음 (이미 Queue 소비자 안에서 돔). 지시 경로는 이제 201이 아니라 202라 직접 쓰는 호출자는 폴링하도록 고쳐야 한다 (저장소 안에는 없음).
- 결과: `files/workflow-verify/docx-ai-queue/RESULT.md`. 커밋 `5f7bb56`, 태그 `docx-ai-queue-v1`.

## 큰 덱·워크북·문서 Queue 처리 + 직렬 실행 수정 (2026-11-22, Fable 5.2 단일 세션)

- **설계**: 구조화 문서 작업에 예상 CPU 판정(2초, `DOC_QUEUE_MS = 2000`). OOXML은 ZIP 중앙 디렉터리에서 풀린 XML 크기만 읽어 계산한다 (문단 수·파일 크기가 아니라 XML 크기 — 문단 5,200개 문서가 37 KB, 10만 셀 워크북이 508 KB). 2초 미만은 바로 201, 이상은 `doc_jobs` 행 + 전용 Queue `people-os-doc-jobs` → 202 + `GET /api/doc-jobs/:id` 2초 폴링. 대상: PPTX·XLSX·DOCX 편집 + DOCX 생성. D1 마이그레이션 0044 `doc_jobs`.
- **직렬 실행 원인·수정**: Cloudflare 문서에 그대로 있다 — Queues는 배치가 끝난 뒤에만 소비자 수를 늘릴지 본다. 배치 1개 = 작업 1개 = 1~5분이라 그동안 두 번째 소비자가 뜨지 않는다. 수정: Queue 소비자가 Word AI 작업을 실행기 DO `DocJobRunner`(작업당 인스턴스 1개, 알람에서 실행, 한도 15분)로 넘기고 바로 ack한다. **주의: v6 DO 마이그레이션 뒤에는 `wrangler rollback`으로 이전 버전으로 돌아갈 수 없다** (실행기를 끄려면 `queue()`의 `handOffDocxJob` 호출 한 줄을 빼고 재배포).
- **배포**: 1차 `808ac976` (큰 파일 Queue) → 2차 **`4a01a312`** (실행기 DO 추가, 현재 라이브). 편집 Worker 무접촉, RPC 구조 그대로.
- **라이브 검증**: 큰 Word 편집(문단 1,921개) 202 → done 3.4~5.2초 · 무거운 PPTX 편집(text 8개 + 복제) 202 → done 3.3~6.5초 · 작은 편집은 201 그대로. Word AI 지시 작업 2개를 2초 간격으로 넣으니 둘이 동시에 `running`, 나중 작업(33초)이 먼저 작업(90초)보다 먼저 끝났다 (세션 3에서는 뒤 작업이 166초 대기). 기존 엔드포인트 바이트 동일. 임시 데이터 정리 확인 (users·sessions·documents·decks·doc_nodes·chunks·doc_jobs·docx_jobs 0건).
- **주의할 점**: 임계값이 실제 CPU의 1.3~2.3배로 크게 나온다 (XML 크기만 재기 때문 — 실제 CPU 1초짜리도 Queue를 탐, 안전한 쪽 오차). XLSX 큰 워크북·이미지 많은 Word 생성은 라이브 미확인 (로컬만 — 라이브 업로드가 AI 변환·Vectorize 색인을 거침). PPTX 40장 덱 계수는 로컬 실측 × 1.4배 추정. 워크플로 run 재실행 안 함 (노드 코드·승인 게이트는 안 바꿨고 타입 검사만 통과 — 회귀 때 `pptx_edit`·`docx_edit` 노드를 한 번씩 돌려 볼 것). 큰 파일 작업끼리는 여전히 한 줄로 돈다 (몇 초라 그대로 둠). 실행기 DO의 재시도·도중 끊김 경로는 라이브에서 안 일어남. 작은 문구 오류 1건: 큰 Word 편집이 끊겼다 이어져 `recovered`로 끝나면 결과 줄에 "(AI 계획)"이 잘못 붙음.
- 결과: `files/workflow-verify/docx-large-queue/RESULT.md`. 커밋 `2a21d6d`, 태그 `docx-large-queue-v1`.

## 캘린더 C5(알림) + C6(구글 쓰기) (2026-11-22, Fable 5.2 단일 세션 — 런타임 재시작으로 중단, Merlin이 마무리)

- **C5 설계**: 새 크론을 더하지 않았다 (`*/15`는 WF-8 때 이미 있었고 분기도 있었다). 15분 틱에 `runCalendarTick` 한 줄을 얹어 다이제스트로 떨어질 길이 없다. 대상: `remind_minutes IS NOT NULL`, 삭제 아님, `CONFIRMED`, `시작 − remind_minutes분 <= 지금 < 시작` (종일 "당일 오전 9시"는 예외 처리). 개인 일정은 소유자에게 종 + 메일, 팀 일정은 활성 전원에게 종만, 구글 일정은 알리지 않음. 중복 방지: `calendar_reminder_log.run_id` INSERT OR IGNORE + 같은 batch에서 그 `run_id` 행에만 notifications 생성. D1 마이그레이션 0045 (`calendar_event_links` 포함).
- **C6 설계**: 개인 일정만 "구글 캘린더에도 저장"을 켜면 본인 구글 기본 캘린더에 쓴다. `events.insert`(미리 정한 id, 409 → patch) · `patch` + `If-Match`(412면 구글 값으로 덮고 알림) · 삭제 전파. 대조는 `updatedMin` 대신 연결 일정을 `events.get` + `If-None-Match`로 하나씩. 스코프 `calendar.events`, 원하는 사람만 `{write:true}`로 요청.
- **배포**: 1차 `40ce9197` → 2차 **`74bc26f6`** (현재 라이브). 편집 Worker 무접촉.
- **라이브 검증**: C5 실제 일정 2건이 15분 틱에 종 알림 + 메일 도착 (20:45Z A · 21:00Z B, 둘 다 `CALENDAR_REMINDER` + `in` 메일 행). `google_sync: true` (미연결)는 409, `/google/connect {write:true}`의 scope에 `calendar.events` 포함 확인, 읽기 전용 연결은 scope 그대로. 기존 엔드포인트 바이트 동일. 임시 데이터 정리 확인 (일정·알림·로그·메일·임시 사용자·세션 0건, `calendar_event_links` 0, `calendar_google_accounts` 0).
- **주의할 점**: **구글 문서를 열지 못해 스코프·`updatedMin`·etag·일정 id 규칙 전부 미확인 (기억 기반 가정)** — 첫 실호출에서 드러난다. C4 `events.list` 가정도 이번에 검증 못 함 (구글 연결 계정 0행 — 지금 구글을 연결한 사용자가 없다). C6 실제 구글 쓰기는 재동의 전이라 안 돌림 (로컬 가짜 구글로만 확인). 팀 일정 알림은 라이브에서 안 돌림 (실제 사용자 4명의 종에 시험 알림이 뜨므로 — 로컬에서만 확인). **C6 재동의 뒤 할 일**: (1) 콘솔에 `.../auth/calendar.events` 스코프 추가 (2) 캘린더 구글 칩 "읽기 + 구글에 저장 허용" → 구글 동의 (3) 개인 일정 저장 → 구글에 생기는지, 달력에 두 번 안 보이는지 (4) 양쪽 수정 반영 (5) 구글에서 고친 직후 People OS에서 수정 → 구글 값으로 맞춰지고 종 알림 (6) 양쪽 삭제·"저장 끄기" (7) 실패하면 `calendar_event_links` 조회.
- **세션 중단**: 런타임 재시작(05:50경)으로 세션 exec이 끊겼다. RESULT.md의 "21:00 틱"·"임시 데이터 정리" 절은 Merlin이 확인·정리 후 채워 넣었다. 배포 2건·RESULT.md·정리는 이미 끝나 있었다.
- 결과: `files/workflow-verify/calendar-c5c6/RESULT.md`. 커밋 `ff06314`, 태그 `calendar-c5c6-v1`.

## 네이티브 confirm() 나머지 17곳 교체 (2026-11-22, Fable 5.2 단일 세션)

- **범위**: approval(강제 반려·회수) · calendar(팀 저장·구글 해제·일정 삭제) · chat(`ask` 헬퍼 Promise화, 생성자 넘기기·나가기/제거) · lms(과정·강의 삭제) · meet(모두에게 종료) · plaud(연결 해제) · workflow(`wfConfirmLeave`·스케줄·단계·워크플로 삭제) · index(녹음·비밀번호 초기화·파일 삭제). `wfConfirmLeave`는 beforeunload가 아니라 화면 안 버튼 3곳에서만 불려 Promise로 교체했다. `meet.html`은 `ui-dialog.js`·`styles.css`를 안 불러 스크립트 태그 + 어두운 화면용 대화상자 스타일을 추가했다. `src/` 변경 없음.
- **배포**: People OS **`a2843af6`** (이전 `74bc26f6`). 편집 Worker 무접촉.
- **검증**: `node --check`·`tsc` 0건, 라이브 `/api/health` 200·익명 `/api/auth/me` 401 동일, 새 자산에서 `!confirm(` 0건. **브라우저 확인 (Merlin, VM 클라우드 브라우저, hr.jhkang 로그인, 읽기 전용)**: 워크플로우 "저장하지 않은 변경"("계속 편집" 시 그대로 남음) · 워크플로우 삭제 · 라이브러리 파일 삭제 다이얼로그가 페이지 안 alertdialog로 뜨고 취소 시 그대로 유지됨을 확인. **캘린더 모달 위 다이얼로그 + Esc (별도 확인, 시험 일정 1건 생성·삭제)**: "일정 삭제" 다이얼로그가 일정 모달 위에 완전히 표시되고, Esc를 누르자 다이얼로그만 닫히고 뒤의 일정 모달은 그대로 열려 있었음 (버그 없음). 빨간 "삭제"를 누르자 "일정을 삭제했습니다."가 뜨고 일정이 사라짐 (D1에서 `deleted_at` 소프트 삭제 확인). **미확인**: 채팅 그룹 멤버 제거/나가기 (그룹 채팅 없음), 결재 회수 (초안 없음), /meet "모두에게 통화 종료" (실시간 통화 필요). 테스트 데이터는 만들지 않았다 (캘린더 시험 일정 1건만 만들고 삭제함).
- **남은 것**: 관리자 "초기화"·설정 링크 발급은 네이티브 `prompt()` 그대로 (과제 밖). 손댄 함수 밖의 `alert()`도 그대로.
- 결과: `files/workflow-verify/confirm-replace/RESULT.md`. 커밋 `5629f4a`, 태그 `confirm-replace-v1`.

## 사용자 결정 3건 반영 (2026-11-22, Fable 5.2 단일 세션)

- **① 비밀번호 변경 → 아바타 메뉴**: 사이드바 하단 아바타 클릭 시 사용자 메뉴(비밀번호 변경·로그아웃) + "내 비밀번호 변경" 대화상자(현재/새/확인, 클라이언트 검사 2종). 관리자 탭 카드는 안내 + "비밀번호 변경 열기"로 교체 (중복 구현 없음). 호출 API는 기존 `/api/auth/change-password` 그대로. 임시 일반 사용자로 비밀번호 변경 1회 성공. **mercer 계정은 건드리지 않았다.**
- **② 암묵지 게시 → hr_admin 전용**: `POST /api/gaps/:id/publish` + `POST /api/documents`(kind tacit 직접 입력)에 401/403 검사(`tacitPublishDenied()`). 화면은 일반 사용자에게 게시 폼 대신 hr_admin 전용 안내 표시. 임시 일반 사용자의 게시·직접 입력 시도를 하네스로 준비했고, 라이브 익명 publish 401을 재확인했다 (일반 사용자의 403 응답 파일은 세션 중단으로 남지 않음).
- **③ qwen 단가 → `src/obs/pricing.ts`**: `@cf/qwen/qwen3.8-27b` 입력 $0.45/출력 $3.20/100만 토큰, checked "2026-11-22" (공식 가격 페이지 대조 + AI Gateway 실측 일치).
- **배포**: People OS **`94209460`** (이전 `a2843af6`). 편집 Worker 무접촉. `npx tsc --noEmit` 0건 (Merlin 직접 확인). 라이브 `/api/health` 200·익명 `/api/auth/me` 401·서빙 홈에 `userMenu`·`pwDlg` 확인.
- **세션 중단**: 런타임 재시작으로 세션이 끊겨 RESULT.md를 쓰지 못했고, Merlin이 버전·diff·D1·라이브 스모크를 대조해 마무리했다. 임시 사용자 2명·임시 gap 1건·세션·password_links 정리 0건 확인.
- **mercer 화면 확인 건너뜀 (사용자 결정 2026-11-22 08:05)**: Secure Vault에 mercer 로그인이 저장돼 있지 않아(peopleos.site 로그인은 hr 계정 1개뿐 — MEMORY.md의 "mercer 로그인 저장됨" 기록은 잘못된 것이었다) 브라우저 로그인이 실패했고, 사용자가 비밀번호 입력을 원하지 않아 건너뛰었다. 임시 일반 사용자로 같은 동작을 이미 확인했으므로 화면 렌더링만 미확인.
- 결과: `files/workflow-verify/decisions-2026-11-22/RESULT.md`. 커밋 `3f94083`, 태그 `decisions-2026-11-22-v1`.

## unslop UI 검토·수정 (2026-11-22, Fable 5.2 단일 세션)

- **방향 "잇는 선"**: 제품명 '일잇'에서 가져온 점·선 표현을 파이프라인 단계·소개 "하루" 흐름·결재선에 통일. 화면은 이미 Langfuse 기준으로 정리돼 있어 가벼운 slop → 다듬기 모드.
- **수정**: 색(히어로·덱 버튼 그라데이션·번짐 제거, 남색 한 면; a.btn 대비 5.3:1; 클래스 없는 a·`.muted` 규칙; 팔레트 밖 색 토큰화) · 아이콘(이모지→Lucide 선 아이콘·글자; 채팅 반응 이모지는 기능이라 유지) · 레이아웃(홈 12장 2열 격자, 브리핑·에이전트 활동 등은 전체 폭; 로그인 상자 로고) · 문구·서체·디테일(health OK→정상, 버튼 → 삭제, 굵기 700→600, 카드 제목 앞 남색 막대 삭제, 배지 알약→라벨, libcard hover 떠오름 제거).
- **배포**: People OS **`859de054`** (이전 `94209460`). `src/`·wrangler.toml·마이그레이션 무접촉. JS는 화면 문자열만 변경 (email.js 별표 aria-pressed 갱신 1줄 예외). `node --check`·`tsc` 0건. 라이브 `/api/health` 200·익명 `/api/auth/me` 401 배포 전과 바이트 동일, 바뀐 자산 200.
- **브라우저 확인 (Merlin, VM 클라우드 브라우저, hr.jhkang 로그인, 읽기 전용)**: 홈 2열 격자 정렬 양호 (반폭 카드 8개로 짝수라 홀수 빈 셀은 미확인), 파이프라인 점·선 정렬 양호 (라벨 2글자라 줄바꿈 케이스 미확인), 소개 "하루" 흐름 선·점 위치 정확 (선은 옅은 회색이라 잘 안 띔), 종 아이콘 양호, 로그인 로고 배치 양호. 별 아이콘은 메일함이 비어 있어 미확인, 덱 다운로드 아이콘은 덱 파일이 없어 미확인.
- **발견된 기존 표시 문제 (unslop 변경 아님, 별도 수정으로 넘김)**: 홈 '내 워크플로우' 카드에 "null" 문자열 노출 (원인: `workflow.js` `wfHomeCard`에서 `box.append(..., waiting.size ? ... : null)`), '이어서 듣기' 과정·강의 제목 동일 시 중복, '열린 할 일' 행에 내부 식별자(`workflow:...`) 노출, 히어로 배지에 기술용 서비스 목록 노출.
- **참고**: 스킬의 `references/signs.md`·`tokens.md`는 세션 권한으로 못 읽어 스킬 본문만 적용. 다음에는 `--add-dir /home/hatch/.claude/plugins/marketplaces/heydamir/skills/unslop`을 함께 준다.
- 결과: `files/workflow-verify/unslop-ui/RESULT.md`. 커밋 `717a7c8`, 태그 `unslop-ui-v1`.

## 홈 화면 표시 문제 5건 수정 (2026-11-22, Fable 5.2 단일 세션)

- **배경**: unslop 패스 뒤 브라우저 확인에서 발견된 기존 표시 문제. 11-26 데모 녹화 전에 수정.
- **수정**: ① '내 워크플로우' 카드 "null" 노출 — `workflow.js` `wfHomeCard`의 `append(null)` 수정 (승인 대기 배지는 있을 때만 붙임) ② '이어서 듣기' 제목 중복 — 과정 제목=강의 제목이면 한 번만 ③ '열린 할 일' 내부 식별자 노출 — `workflow:<id>`를 워크플로우 이름으로 표시(못 찾으면 숨김), `workflow:assistant`는 "AI 어시스턴트", 그 밖의 `종류:id` 꼴은 숨김 ④ 히어로 배지 기술용 문자열 — `정상`만 표시, 서비스 목록은 title 속성으로 ⑤ 소개 "하루" 흐름 세로 선 zinc-200 → zinc-400.
- **배포**: People OS **`83c2da21`** (이전 `859de054`). `public/` 4개 파일만, `src/`·wrangler.toml·마이그레이션 무접촉. `node --check`·`tsc` 0건. 라이브 `/api/health` 200·익명 `/api/auth/me` 401·`/api/home` 200 배포 전과 동일, 바뀐 자산 200.
- **브라우저 확인 (Merlin, VM 클라우드 브라우저, hr.jhkang 로그인, 읽기 전용)**: 5건 전부 양호 — "null" 없음(페이지 텍스트 검색 0건), 강의 제목 한 번만, 할 일 출처 "T1 테스트용 agent" 이름으로 표시(내부 id 검색 0건), 배지 "정상"만, 하루 선 중간 회색 실선으로 또렷. 홈 화면 전체 오류 없이 로드, 빈 카드·깨진 레이아웃 없음.
- 결과: `files/workflow-verify/home-glitch-fix/RESULT.md`. 커밋 `14459e9`, 태그 `home-glitch-fix-v1`.

## 표현 수정: '열린 할 일' → '해야 할 일', '리플렉션' → '성찰' (2026-11-22, Merlin 직접)

- **범위**: 표시 문구만 변경. API 경로·D1 테이블·식별자(`reflectionId` 등)·영문 키는 그대로.
- **해야 할 일**: 홈 카드·홈 통계·소개 탭 설명·빈 상태·다이제스트 카드·아침 다이제스트 문장 (`public/index.html`, `src/digest.ts`).
- **성찰**: 메뉴 '코칭 성찰', 홈 '최근 성찰', 라이브러리 탭·카드, 성찰 생성 버튼·제목, 워크플로우 노드 라벨(코치 성찰·코칭 대상 성찰), 발표자료 본문, 다이제스트 문장, LLM 시스템 프롬프트의 역할 이름 (`public/index.html`, `public/pitch-content.html`, `public/workflow.js`, `src/digest.ts`, `src/index.ts`, `src/workflow/nodes.ts`). 코드 주석 2곳(`src/lib.ts`, `src/ask-pipeline.ts`)만 '리플렉션'이 남음.
- **배포 경과**: '해야 할 일'만 먼저 라이브 `6a57ffb4`에 반영. '성찰' 포함 전체 배포는 Cloudflare 버전 업로드 API 500 (code 10002)으로 3회 실패 (2026-11-22 09:15~09:18 KST, Cloudflare 상태 Partially Degraded Service). 약 20분 뒤 재시도 1회 성공.
- **배포**: People OS **`f578ee4d`** (이전 `6a57ffb4`). `npx tsc --noEmit` 0건, `node --check` 통과.
- **라이브 확인 (배포 3분 뒤, curl)**: `/api/health` 200, 익명 `/api/auth/me` 401, `/` 200 — 서빙된 홈에 "코칭 성찰" 11건·"최근 성찰" 1건·"해야 할 일" 6건, "리플렉션"·"열린 할 일" 0건. `/pitch-content` 200 — "코칭 성찰" 2건·"성찰" 7건, "리플렉션" 0건.
- 커밋 `822a9fe`, 태그 `copy-terms-v1`.
