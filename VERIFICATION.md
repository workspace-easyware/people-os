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
- FlowDesk 연결: 요약 결과 아래 "요약 복사" + "FlowDesk에서 열기" 버튼, 라이브러리 탭에도 FlowDesk 버튼. 링크 https://flowdesk-personal-c7a4.hr-jhkang.chatgpt.site/ 확인됨. FlowDesk는 별도 비공개 Site라 직접 임베드는 불가하고 링크+복사 흐름으로 연결.
- 리스타일 후 요약 엔진 workers-ai 유지, 에러 없음.
