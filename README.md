# 일잇 People OS — Workers판 프로토타입

> **이것은 Workers 위에 새로 만드는 프로토타입입니다. 이미 정식 출시한 ChatGPT Sites(일잇, easy-slides 등)가 아닙니다.**
> Cloudflare Developer Day Seoul 2026 Use Case 공모전(마감 2026-11-27, 행사 2026-12-02 파르나스) 제출용입니다.
>
> **라이브 데모: https://people-os.workspace-easyware.workers.dev** — 배포됨, `/api/health` ok:true, 바인딩 6개(d1·kv·r2·vectorize·ai·durable_objects) 전부 true. 저장소: [workspace-easyware/people-os](https://github.com/workspace-easyware/people-os) (제출 전 공개 전환 예정).

HR 실무자·코치를 위한 AI 인텔리전스 플랫폼: 회의 전사본·규정·뉴스를 올리면 요약·RAG 답변·코칭 리플렉션을 한 흐름으로 내보냅니다.

## 데모 흐름 (3분 영상용)

1. 홈 대시보드 — 현황 숫자 + 최근 문서·할 일 확인
2. 음성 파일 업로드 → Whisper 전사 (최대 25MB, 전사본이 텍스트란에 채워짐) — 또는 샘플 전사본 붙여넣기
3. 요약하기 → 3줄 요약 + 액션 아이템
4. 액션 “할 일로 저장” + “PPTX 초안 다운로드” (표지+요약+액션, R2 저장)
5. “연차 3일 쓸 수 있어?” → 근거 문서(연차휴가 규정)와 함께 답변
6. 코칭 전사본 → 핵심 질문·패턴·다음 세션 질문 3개
7. 요약 복사 → "라이브러리에서 보기"로 라이브러리 탭에서 확인

## 로컬 개발

```bash
cd people-os
npm install
npx wrangler dev --local
# http://localhost:8787 로 접속
```

- `wrangler dev`는 로컬(Miniflare)에서 D1/KV/R2/Durable Objects를 에뮬레이션합니다.
- 라이브 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`로 합니다 (저장된 API 토큰 주입). D1 마이그레이션은 deploy가 자동 적용하지 않으므로 새 마이그레이션이 있으면 `d1 migrations apply people-os-db --remote`를 따로 실행합니다.
- Node v24.22.1에서 확인했습니다.

## API

| 메소드 | 경로 | 설명 |
|---|---|---|
| POST/GET | `/api/health` | 상태 + 바인딩 확인 (규정 시드도 여기서 초기화) |
| GET | `/api/home` | 홈 대시보드: 현황 숫자 + 최근 문서·할 일·리플렉션 |
| GET/POST/PATCH/DELETE | `/api/tasks`, `/api/tasks/:id` | 할 일 체크리스트 (생성·토글·삭제) |
| POST | `/api/deck` | `{title, summary, actions}` 또는 `{title, outline: {title, slides: [{heading, bullets}]}}` → pptxgenjs 덱 생성, R2 저장, `{url}` 반환. 개요가 오면 고친 문구를 그대로 쓰고 빈 불릿·빈 슬라이드는 제외 (S3) |
| GET | `/api/deck/:id` | 생성된 .pptx 다운로드 |
| POST | `/api/transcribe` | multipart `file`(최대 25MB) → R2 저장 + 백그라운드 전사 → `{recordingId, transcriptStatus: 'processing'}` (폴링으로 완료 확인, 긴 ogg는 1MB 단위 구간별 전사, 재개 가능) |
| GET | `/api/recordings` | 최근 음성 녹음 목록 (메타데이터 + 상태 ready/pending/processing + 진행 상황) |
| GET | `/api/recordings/:id` | 녹음 1건 + 전사본 |
| POST | `/api/recordings/:id/advance` | 다음 1구간을 직접 전사하고 행 반환 (프론트 폴링이 부름) |
| POST | `/api/recordings/:id/retry` | pending 녹음을 R2 오디오로 다시 전사 (백그라운드, 멈춘 processing 행은 이어가기) |
| POST | `/api/documents` | `{title, content, kind}` 업로드 → R2 + D1. multipart `file`(최대 10MB)도 받는다 — 매직 바이트로 형식을 판별해 PDF·DOCX·XLSX·이미지는 Workers AI `toMarkdown()`으로, HWPX는 Worker 안에서 직접 텍스트를 뽑아 색인한다 (C5 Phase 3). HWP 5.0은 안내만 하고 변환하지 않는다 |
| POST | `/api/documents/:id/summarize` | Workers AI 요약, 실패 시 로컬 추출식 요약 |
| POST | `/api/ask` | `{question, sessionId?}` RAG 답변 + 근거 + 세션 기억 |
| POST | `/api/coaching/reflect` | `{transcript, sessionId?}` 코칭 리플렉션 |
| GET | `/api/library` | 문서·규정·리플렉션 목록 |
| GET | `/api/seed` | 샘플 전사본·코칭 전사본·규정 7건 |

시드 규정 7건: 연차휴가, 근무시간, 출장, 정보보안, 평가·승진, 교육, 근태·지각 — `seed/seed-data.json` 참조.

## 아키텍처

```
브라우저 (public/index.html, 탭 6개: 홈·업로드·질문·코칭·할 일·라이브러리)
  → Workers (Hono, src/index.ts)
    → D1 (문서·규정·세션·리플렉션·캐시·할 일·덱 메타·녹음)
    → R2 (원본 파일 + 녹음 recordings/* + 덱 decks/*.pptx)
    → KV (질문 캐시, 실패 시 D1 cache 테이블)
    → Vectorize (RAG — 로컬에서 쿼리 실패 시 D1 텍스트 검색 폴백)
    → Workers AI (요약·답변·리플렉션 + Whisper 전사 — 로컬에서 실패 시 로컬 템플릿/규칙 폴백, 전사는 pending 저장)
    → Durable Objects AgentSession (대화 기억 — 실패 시 D1 sessions 폴백)
    → Queues/Workflows, Hyperdrive, Cron, Turnstile: 설계·스텁 (Phase 4/5, README 하단 참조)
```

## Cloudflare 기능 매핑

| 기능 | MVP에서 하는 일 | 상태 |
|---|---|---|
| Workers | API + 프론트 서빙 | 구현됨 |
| Workers AI | 요약·답변·리플렉션 생성 | 라이브 확인됨 (로컬에서는 실패 시 폴백) |
| Workers AI (Whisper) | 음성 전사 (`@cf/openai/whisper`) | 라이브 확인됨 — 실제 Plaud 녹음 전사, 전사 실패 시 pending 저장 (전사본 없음) |
| Vectorize | RAG 임베딩 검색 | 라이브 확인됨 (로컬에서는 D1 텍스트 검색 폴백) |
| D1 | 문서·규정·세션·리플렉션·캐시·할 일·덱 메타·녹음 | 구현됨 (마이그레이션 `migrations/0001_init.sql`, `0002_workspace.sql`, `0003_recordings.sql`) |
| KV | `/api/ask` 캐시 | 시도 후 D1 폴백 |
| Durable Objects | 에이전트 세션 기억 | 시도 후 D1 폴백 |
| R2 | 업로드 원본 저장 + 덱 `decks/*.pptx` | 라이브 확인됨 |
| Hyperdrive | 기존 HR Postgres 연결 | 스텁/설계만 (모의 데이터) |
| Queues + Workflows | 전사→요약→추출→임베딩 파이프라인 | 구현됨 (S1): 전사→요약→색인 Queues 파이프라인 + DLQ, 라이브 확인됨 |
| AI Gateway | 모든 Workers AI 호출 경유 (게이트웨이 `people-os`, 채팅 캐시·태그별 로그) | 구현됨 (로컬 검증; 라이브 확인 전 — 대시보드에서 게이트웨이 생성 필요, 아래 S2 참조) |
| Cron Triggers | 아침 HR 다이제스트 | 구현됨 (C9): 매일 07:00 KST, 첫 실행 2026-11-14 |
| Turnstile | 업로드 스팸 방지 | 구현됨 (C7): fail-open, 키 설정 시 검증 |

## S2 — AI Gateway (2026-11-13, 로컬 구현)

- 방식: Workers AI 바인딩 + AI Gateway 공식 방식 — `env.AI.run()`의 세 번째 인자로 `{ gateway: { id: "people-os", skipCache, tags } }`를 넘긴다. `wrangler.toml`의 `[ai]` 바인딩은 그대로 (변경 없음).
- 헬퍼: `src/ai-gateway.ts`의 `aiGatewayOptions()` — 11개 AI 호출처 전부 경유 (채팅 llama-4-scout 5곳: 요약·질문·코칭·다이제스트·debug-ai / 임베딩 bge-m3 5곳: 시딩·문서 색인·암묵지 검증·질문 검색·debug-ai / 전사 whisper-large-v3-turbo 1곳).
- 캐시 정책: 채팅은 게이트웨이 캐시 사용 (프롬프트에 근거 문맥이 포함돼 근거가 바뀌면 캐시 키도 바뀐다). 다시 생성(`force`)과 운영 진단(`/api/debug-ai`)은 `skipCache: true`. 임베딩·전사는 항상 `skipCache: true` (재색인 검증이 흐려지고, 전사는 오디오마다 달라 캐시할 이유가 없음).
- 태그: 호출마다 `ask` / `summary` / `embed` / `whisper` / `coaching` / `digest` / `debug` 태그를 붙여 게이트웨이 대시보드에서 기능별로 구분한다.
- **게이트웨이 생성 (배포 전 필수)**: wrangler CLI에는 `ai-gateway` 명령이 없어 CLI 생성이 안 된다. 대시보드 → AI Gateway → Create Gateway, 이름 `people-os`로 만든다. 이름 있는 게이트웨이는 자동 생성되지 않는다 (`"default"`만 첫 요청 때 자동 생성). 게이트웨이가 없으면 AI 호출이 실패하고 기존 로컬 폴백으로 떨어진다 (앱은 안 죽는다).
- 레이트 리밋 (대시보드에서 설정, 권장): 분당 100회. 질문 1건이 AI 호출 2회(임베딩+채팅)라 기존 세션당 분당 20회 제한과 전사·요약을 합쳐도 여유가 있다. 캐시는 게이트웨이 기본값 사용.
- 되돌리기: 호출처에서 `aiGatewayOptions()` 인자만 빼면 된다 (`wrangler.toml` 변경이 없어 되돌림이 한 줄씩이다).

## C5 Phase 3 — 업로드 문서 파서 라우팅 (2026-11-13, 로컬 구현)

- 형식 판별은 확장자가 아니라 앞부분 바이트로 한다 (`src/parse.ts`): `%PDF` → PDF, `PK` + `mimetype=application/hwp+zip` → HWPX, `PK` + `[Content_Types].xml` → Office Open XML, `D0CF11E0` → HWP 5.0/구형 Office, 이미지 매직 바이트 → 이미지, UTF-8 디코딩되면 텍스트, `<?xml`/`<svg`/`<html` → toMarkdown.
- HWPX는 Worker 안에서 직접 추출한다 (fflate로 zip을 풀어 `Contents/section*.xml`의 `<hp:t>` 텍스트를 모은다 — toMarkdown은 HWPX를 지원하지 않는다). 표 셀 텍스트도 순서대로 뽑히고, `제N조` 마커는 평문이라 조문 단위 청킹이 그대로 된다.
- PDF·DOCX·XLSX·이미지·XML/HTML은 Workers AI `toMarkdown()`으로 변환한다 (`env.AI.toMarkdown({name, blob}, {gateway: {id: "people-os", skipCache: true}})` — 파일명에서 변환기를 고르므로 원본 파일명을 그대로 넘긴다).
- 저장: 원본 `docs/<id>/source.<ext>` + 추출본 `docs/<id>/extracted.md` (R2), D1 `content`에는 추출본, `extract_status`/`extract_error`/`source_r2_key`는 마이그레이션 0012. 추출본은 기존 `indexDocument` 경로로 색인한다 (Vectorize 메타데이터 kind는 문서 실제 종류).
- 실패 처리 (내용을 지어내지 않는다): HWP 5.0은 "HWPX 또는 PDF로 저장해 올려 주세요" 안내, 판별 불가 형식은 지원 형식 안내, 추출 실패(toMarkdown 에러·빈 결과·텍스트 없음)는 문서 행을 `extract_status='failed'`로 만들고 사유를 보여준다. 원본은 실패해도 R2에 남는다. 실패한 문서는 색인하지 않는다.
- 상한: 문서 파일 10MB (우리 쪽 상한 — toMarkdown 공식 문서에 파일 크기 상한이 명시돼 있지 않다).
- 로컬 검증: 단위 테스트 25개 통과 (판별 15개·HWPX 추출 9개·BOM 1개), `wrangler dev --local` e2e — HWPX 업로드 → `format: hwpx, extractStatus: ready`, D1 chunk 2개(제1조 목적·제2조 적용 범위), 질문 시 HWPX 문서가 근거로 나옴. 연차 질문은 여전히 연차휴가 규정이 1위. 로컬 AI가 안 돼 임베딩 upsert와 toMarkdown은 실패로 떨어지는 기존 한계가 있다 (D1 chunk는 남고, 에러가 그대로 보고됨). 라이브 확인 필요: DOCX/PDF 실제 변환, HWPX 근거 1위 여부.
- 되돌리기: 파일 업로드 분기를 빼면 JSON 경로만 남는다 (마이그레이션 0012 컬럼은 남겨둬도 무해하다).

## 로컬 폴백 (중요)

`wrangler dev --local`에서는 Workers AI와 Vectorize가 클라우드와 동일하게 동작하지 않습니다.
그래서 코드는 **먼저 클라우드 바인딩을 시도하고, 실패하면 로컬 로직으로 답**합니다:

- 요약: Workers AI (`@cf/meta/llama-4-scout-17b-16e-instruct`) → 실패 시 추출식 요약 (`src/lib.ts localSummarize`)
- RAG 검색: Vectorize 쿼리 → 실패 시 D1 텍스트 검색 + 키워드 순위 (`localSearch`)
- 답변: Workers AI → 실패 시 근거 기반 템플릿 답변 (`local-template`)
- 코칭: Workers AI → 실패 시 규칙 기반 리플렉션 (`localReflect`)
- 전사: Workers AI Whisper → 실패·빈 결과·반복 환각 시 오디오만 저장하고 `transcript_status='pending'` (전사본을 지어내지 않음, `POST /api/recordings/:id/retry`로 다시 시도)
- KV/DO: 실패 시 D1 테이블(`cache` / `sessions`)로 폴백

응답 JSON의 `engine` / `searchEngine` / `sessionVia` 필드로 어떤 경로로 답했는지 확인할 수 있습니다.
라이브에서는 Workers AI / Vectorize를 실제로 사용함이 Chrome으로 확인됐습니다. 로컬 개발 시에만 폴백이 돕니다.

## 구조

```
people-os/
  wrangler.toml        바인딩: D1, KV, R2, Vectorize, AI, Durable Objects, Assets
  src/index.ts         Hono API + 폴백 로직 + 작업 공간·덱·전사 API (pptxgenjs, Whisper)
  src/lib.ts           로컬 요약·검색·리플렉션 + 시드 로더
  src/agent-session.ts Durable Object (세션 기억)
  migrations/0001_init.sql, 0002_workspace.sql, 0003_recordings.sql
  seed/seed-data.json  샘플 전사본 + 규정 7건 + 코칭 전사본
  public/index.html    탭 6개 SPA (홈·업로드·질문·코칭·할 일·라이브러리)
```

## 제출물

- 아키텍처 다이어그램: [ARCHITECTURE.md](ARCHITECTURE.md) · [architecture.svg](architecture.svg)
- 3분 데모 대본: [DEMO-SCRIPT.md](DEMO-SCRIPT.md) (2분 50초, 라이브 데모 URL 화면 녹화용)
- 검증 기록: [VERIFICATION.md](VERIFICATION.md)
- 데모 URL: https://people-os.workspace-easyware.workers.dev (라이브)

## 아직 없는 것 (공모전 이후)

- Plaud Dot 기기 자동 동기화 (페어링·스코프 토큰 필요 — ARCHITECTURE.md 참조), Hyperdrive 실연결, Cron 다이제스트, Turnstile 실연동
- 덱 편집기 (Stage 2): 생성된 PPTX를 브라우저에서 고쳐 저장하는 FlowDesk식 제자리 편집 + R2 버전 관리 — ARCHITECTURE.md 참조
- 3분 데모 영상 녹화본, 공모전 Google Form 제출, 행사 참가 등록
