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
| POST | `/api/documents` | `{title, content, kind}` 업로드 → R2 + D1 |
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
    → Queues/Workflows, Hyperdrive, AI Gateway, Cron, Turnstile: 설계·스텁 (Phase 4/5, README 하단 참조)
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
| Queues + Workflows | 전사→요약→추출→임베딩 파이프라인 | 직접 호출 + 큐 스텁 (정식 파이프라인은 공모전 이후) |
| AI Gateway | 모델 라우팅·폴백 | 설계만 |
| Cron Triggers | 아침 HR 다이제스트 | 공모전 중 구현 예정 |
| Turnstile | 업로드 스팸 방지 | 공모전 중 구현 예정 |

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
