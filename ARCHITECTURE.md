# 아키텍처 — 일잇 People OS (Workers 프로토타입)

> 파일: `architecture.svg`가 제출용 다이어그램 이미지. 아래 Mermaid는 같은 내용을 텍스트로 표현한 것.
> MVP(Phase 1–3)는 실선, 보강 예정(Phase 4·5)은 점선으로 구분했다.

## 다이어그램

![People OS 아키텍처](architecture.svg)

```mermaid
flowchart TB
    User["사용자<br/>HR 실무자 · 코치<br/>브라우저"] -->|HTTPS| Worker["Workers (Hono)<br/>src/index.ts<br/>API + 프론트 서빙"]

    Worker --> R2["R2<br/>음성·PDF·PPTX 원본<br/>덱 decks/*.pptx"]
    Worker --> D1["D1 (SQLite)<br/>문서·규정·세션<br/>리플렉션·캐시<br/>할 일·덱 메타"]
    Worker --> KV["KV<br/>질문 캐시"]
    Worker --> DO["Durable Objects<br/>AgentSession<br/>대화 기억"]
    Worker --> AI["Workers AI<br/>요약·답변·리플렉션"]
    Worker --> VEC["Vectorize<br/>규정·논문 RAG"]
    Worker -.-> Q["Queues + Workflows<br/>전사→요약→추출→임베딩"]
    Worker -.-> GW["AI Gateway<br/>모델 라우팅·폴백"]
    Worker -.-> HD["Hyperdrive<br/>기존 HR Postgres"]
    Worker -.-> CRON["Cron Triggers<br/>아침 HR 다이제스트"]
    Worker -.-> TS["Turnstile<br/>스팸 방지"]

    R2 --> Q
    Q --> AI
    AI --> VEC
    VEC --> D1
    AI --> D1
    DO --> D1
    KV --> Worker
```

## 요청 흐름 (데모 1개 흐름)

0. **음성 전사** — `POST /api/transcribe` (multipart `file`, 최대 25MB)
   R2 `recordings/<id>/<파일명>` 저장 + HEAD 크기 검증 → 행을 `processing`으로 만들고 전사는 백그라운드(`waitUntil`)로 진행 → ogg는 30분 단위로 나눠 구간별 Whisper 전사 → 전사본 있으면 D1 `documents` 행(kind='transcript') + `recordings` 행(status='ready') 생성. 전사 실패·빈 결과면 오디오만 저장하고 `transcript_status='pending'` (전사본을 지어내지 않음). `GET /api/recordings`, `POST /api/recordings/:id/retry`로 다시 전사. 진행 상황은 `recordings.progress`에 남는다.
1. **업로드** — `POST /api/documents` {title, content, kind}
   브라우저 → Workers → R2에 원본 저장 + D1에 메타 저장. 201 반환.
2. **요약** — `POST /api/documents/:id/summarize`
   Workers AI 요약 시도 → 로컬에선 `local-extractive`로 폴백. 3줄 요약 + 액션 2개 → D1 저장.
3. **질문 (RAG)** — `POST /api/ask` {question, sessionId}
   KV 캐시 확인 (`ask:{sessionId}:{question}`) → 없으면 Vectorize 검색 시도 → 로컬에선 D1 텍스트 검색 폴백 → 근거 문서(연차휴가 등) + 답변 생성 → Durable Objects 세션에 대화 저장 → KV에 캐시.
4. **코칭** — `POST /api/coaching/reflect` {transcript, sessionId}
   Workers AI 분석 시도 → 로컬에선 `local-rule`로 폴백. 핵심 질문·패턴·다음 질문 → D1 저장.
5. **할 일** — `POST /api/tasks` {title, source} / `PATCH /api/tasks/:id` / `DELETE /api/tasks/:id`
   요약 액션을 D1 `tasks`에 저장하고 체크·삭제. 홈 대시보드에 열린 할 일 미리보기.
6. **PPTX 초안** — `POST /api/deck` {title, summary, actions}
   pptxgenjs로 새 덱 생성(표지 + 요약 슬라이드 + 액션 슬라이드, people-insight 팔레트) → R2 `decks/<id>.pptx` 저장 + D1 `decks` 메타 저장 → `GET /api/deck/:id`로 다운로드.
7. **조회** — `GET /api/library`, `GET /api/seed`, `GET /api/home`
   문서·규정 7건·리플렉션 목록 반환. 홈은 현황 숫자(문서·요약·열린 할 일·리플렉션) + 최근 문서·할 일·리플렉션.

## Cloudflare 기능 매핑 (공모전 필수 조건)

필수: Workers + (KV·D1·Durable Objects·Hyperdrive·R2 중 1개) + 다른 Cloudflare 제품 1개.
이 프로젝트는 Workers + D1 + KV + R2 + Durable Objects + Workers AI + Vectorize를 쓴다.

| 기능 | MVP 상태 | 하는 일 | 폴백 (로컬) |
|---|---|---|---|
| Workers | 구현됨 | Hono API + 프론트 서빙 | — |
| D1 | 구현됨 | 문서·규정·세션·리플렉션·캐시 테이블 | Miniflare 로컬 D1 |
| R2 | 구현됨 | 원본 파일 저장 (`r2Stored: true` 확인) + 덱 `decks/<id>.pptx` | Miniflare 로컬 R2 |
| KV | 구현됨 | 질문 캐시, 세션별 키 | D1 cache 테이블 |
| Durable Objects | 구현됨 | AgentSession 대화 기억 | D1 sessions 테이블 |
| Workers AI | 코드 있음, 로컬 폴백 | 요약·답변·리플렉션 생성 | local-extractive / local-template / local-rule |
| Workers AI (Whisper) | 구현됨 | 음성 전사 (`@cf/openai/whisper`, 바인딩) | 전사 실패 시 pending 저장 (전사본 없음) |
| Vectorize | 코드 있음, 로컬 폴백 | 규정·논문 임베딩 검색 | D1 텍스트 검색 |
| Queues + Workflows | 설계·스텁 | 전사→요약→추출→임베딩 비동기 파이프라인 | 직접 호출 |
| AI Gateway | 설계만 | 모델 라우팅·폴백·로그 | — |
| Hyperdrive | 설계만 | 기존 HR Postgres 연결 | 모의 데이터 |
| Cron Triggers | 설계만 | 아침 HR 다이제스트 | 스케줄러 함수 자리만 |
| Turnstile | 설계만 | 가입·업로드 스팸 방지 | 폼 자리만 |
| Workers Static Assets | 구현됨 | `public/index.html` 서빙 | — |

## 데이터 모델 (migrations/0001_init.sql, 0002_workspace.sql, 0003_recordings.sql)

- `documents(id, title, kind, content, r2_key, created_at)`
- `policies(id, title, section, content)` — 시드 7건
- `cache(key, value, created_at)` — KV 폴백
- `sessions(id, data, updated_at)` — DO 폴백
- `reflections(id, session_id, transcript, result, created_at)`
- `tickets(id, title, body, status, created_at)` — 에이전트 티켓 초안용
- `tasks(id, title, source, done, created_at, done_at)` — Stage 1 작업 공간 (0002)
- `decks(id, title, r2_key, bytes, slides, created_at)` — Stage 1 PPTX 덱 메타 (0002)
- `recordings(id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, doc_id, progress, created_at)` — 음성 전사 입력 (0003, progress는 0004). `transcript_status`: 'ready' | 'pending' | 'processing'. Plaud `recordings` 형태를 따르되 provider는 'workers-ai', user_id 없음(프로토타입 단일 사용자).

## Stage 1 — 작업 공간 + PPTX 덱 (2026-11-13, 구현됨)

사용자 피드백("화면이 밋밋하고 검색창만 보인다")을 해소하는 작업 공간 + 파이프라인 마지막 단계 PPTX 초안.

- **홈 대시보드** (`GET /api/home`, 첫 탭): 현황 숫자 4개(문서·요약 완료·열린 할 일·리플렉션) + 최근 문서 5건 + 열린 할 일 5건 + 최근 리플렉션 3건.
- **할 일** (`/api/tasks` CRUD, D1 `tasks`): 요약 액션을 "할 일로 저장" 버튼으로 옮기고 체크·삭제. FlowDesk의 노트·작업 모델을 참고하되, 별도 Site가 아니라 D1에 직접 저장한다.
- **라이브러리 카드화**: JSON 덤프 대신 문서·규정·리플렉션 카드 목록(제목·요약 발췌·날짜·종류).
- **PPTX 초안** (`POST /api/deck` → `GET /api/deck/:id`): easy-slides 방식 — pptxgenjs로 새 덱을 처음부터 생성. 표지(남색 #123863) + 요약 슬라이드 + 액션 슬라이드, Malgun Gothic, 16:9. R2 `decks/<id>.pptx`에 저장하고 D1 `decks`에 메타 저장. 다운로드 시 `Content-Disposition`은 한글 제목을 RFC 5987 `filename*`로 싣고 `filename`은 ASCII 폴백 (브라우저 Fetch 명세상 한글 filename은 TypeError).
- 참고한 코드: easy-slides `site/` (pptxgenjs 신규 생성, 템플릿·workspace API, drizzle 스키마), FlowDesk Cloud `src/core/slides-export.mjs` (pptxgenjs 호출 패턴, `officeText` XML 금지 문자 제거, Malgun Gothic/`ko-KR`), `cloud/storage.mjs` (R2 저장·다운로드 패턴).

## 음성 전사 입력 (2026-11-13, 구현됨)

파이프라인 맨 앞단. Plaud Transcribe Studio의 전사 형태를 Cloudflare 네이티브로 옮겼다.

- **입력** — `POST /api/transcribe` (multipart `file`, 최대 25MB, audio/*). Plaud `app/api/transcribe/route.ts`와 같은 상한·같은 필드명. R2 `recordings/<id>/<파일명>`에 저장하고 **HEAD 크기 검증**을 put 직후에 한다 (Plaud `docs/DOT_PLAUD_SYNC.md` 패턴: 크기 불일치는 실패, 덮어쓰지 않음).
- **전사** — Workers AI Whisper 바인딩 (언어 자동 감지). 처음에는 `@cf/openai/whisper` + `{ audio: number[] }`를 썼으나 Ogg Opus 입력에서 호출이 끝나지 않고 조용히 멈췄다 (2분짜리 489KB 클립도 5분 넘게 무응답 — 2026-11-13 확인). Cloudflare 공식 대용량 오디오 청킹 튜토리얼이 쓰는 `@cf/openai/whisper-large-v3-turbo` + Base64 문자열 입력으로 바꿨다. mp3는 두 방식 모두 1분 안에 전사됨을 확인했다 (REST: 1MB mp3 → 966자 정상 전사; 바인딩: 동일 파일로 `wrangler dev`에서 ready + documents 행 생성 + workers-ai 요약까지 연결 확인).
- **긴 오디오 구간별 전사 (2026-11-13 추가)** — 97분 ogg(24.9MB)를 한 번에 부르면 27분 동안 응답이 안 돌아오고 녹음 행 자체가 안 남았다. 그래서 전사를 비동기로 바꿨다: `POST /api/transcribe`는 R2 저장 후 행을 `processing`으로 만들고 바로 201을 돌려주고, `waitUntil` 백그라운드에서 전사한다. ogg(Opus)는 `src/ogg.ts`의 Ogg 페이지 분할기로 구간 단위로 나눈다 (ffmpeg 없이 순수 JS: 페이지 경계에서만 자르고, OpusHead·OpusTags·Plaud 벤더 페이지 포함 헤더 페이지를 모든 구간 앞에 붙이고, 패킷이 이어지는 페이지에서는 자르지 않는다 — ffprobe로 4개 구간 전부 디코딩 확인). **구간 길이는 30분에서 15분으로 줄였다**: 30분 구간(7.7MB)은 첫 구간 Whisper 호출이 44분 동안 안 끝나고 백그라운드 작업이 에러도 없이 조용히 죽어 행이 `1/4 구간 전사 중`에 멈췄다. 15분 구간도 안 되면 더 줄이는 것이 다음 단계다. `processing`이 30분 넘게 멈춰 있으면 `POST /api/recordings/:id/retry`로 다시 시작할 수 있다. 구간별 Whisper 결과를 이어 붙이고, 일부 구간만 성공해도 성공한 구간은 저장한다. 진행 상황(`1/7 구간 전사 중` 등)은 `recordings.progress`에 남고 프론트가 5초마다 폴링한다.
- **실패 처리 (지은 전사본 없음)** — Whisper 실패·빈 텍스트·반복 환각(무음 wav에서 "Thank you very much." 반복 확인)일 때는 오디오만 저장하고 `transcript_status='pending'`으로 남긴다. Plaud의 `plaud-audio-pending-transcript` 마커와 같은 원칙이다. `POST /api/recordings/:id/retry`로 R2 오디오를 다시 전사하며(역시 백그라운드), ready 행은 건드리지 않고 processing 중인 행은 중복 실행하지 않으며 R2 키/크기는 유지한다 (Plaud pending enrichment 패턴).
- **연결** — 전사 성공 시 `documents` 행(kind='transcript')을 만들어 기존 요약 엔드포인트가 그대로 동작한다. 프론트 업로드 탭의 "0. 음성 파일 전사"에서 파일을 올리면 전사본이 제목·본문에 채워지고 "요약하기"가 활성화된다. 최근 녹음 목록에서 불러오기/다시 전사가 된다.
- **참고한 코드**: `workspace-easyware/plaud-transcribe-studio` — `app/api/transcribe/route.ts` (25MB 상한·R2 put·recordings 행), `app/api/summarize/route.ts` (저장된 전사본에서 요약), `docs/DOT_PLAUD_SYNC.md` (R2 HEAD 검증·pending 마커·재시도 시 덮어쓰기 금지).

### Plaud Dot 동기화 (나중에 할 일, 미구현)

Plaud Dot 기기와의 자동 동기화(페어링·스코프 토큰·별도 Dot 동기화 클라이언트·Plaud 계정 연동)는 이 프로토타입에 옮길 수 없어 구현하지 않았다. `docs/DOT_PLAUD_SYNC.md`의 페어링 흐름(32바이트 verifier·SHA-256 challenge·10분 만료 일회용 코드·`pts_` 토큰)은 Plaud 계정과 Sites 비밀 설정이 필요하고, 지금은 파일 업로드 전사로 대체한다. 나중에 할 때는 Dot 동기화 클라이언트를 별도 서비스로 두고 이 Worker의 `/api/transcribe`·`recordings` 모델을 그대로 재사용하는 것이 맞다.

## Stage 2 — 덱 편집기 (계획만, 미구현)

Stage 1은 "새 덱 생성"까지만 한다. 다음 단계는 FlowDesk 방식의 **기존 덱 제자리 편집**이다.

- 생성된 덱을 브라우저에서 열어 텍스트·위치를 고치고 다시 저장: jszip으로 .pptx 패키지를 왕복하며 원본 서식을 유지하는 FlowDesk `pptx-package.mjs` / `pptx-parts.mjs` / `pptx-preview.mjs` 패턴을 Worker + 프론트에 이식.
- R2 버전 관리: FlowDesk Cloud `cloud/storage.mjs`처럼 현본 + 직전본을 유지하고, 저장 충돌 시 거부(동시 편집 보호).
- 범위 주의: FlowDesk 편집기는 클라이언트 중심의 큰 코드베이스라 통째로 가져오지 않고, 텍스트·도형 수정에 필요한 최소 부분만 이식한다. 공모전 마감(11/27) 안에 Stage 2를 못 끝내면 Stage 1 생성 + 다운로드만으로 제출한다.

## 로컬 vs 클라우드 차이 (솔직한 기록)

- 로컬(`wrangler dev --local`)에서는 Workers AI·Vectorize가 안 돈다. `VERIFICATION.md`에 경고 문구 원문과 폴백 엔진을 기록했다. Whisper도 로컬에서는 인증 문제로 실패해 전사가 pending으로 남는다 (지은 전사본 없음). 단, 토큰을 주입한 `wrangler dev`(로컬 서버 + 클라우드 AI)에서는 바인딩 Whisper가 실제 음성을 전사함을 2026-11-13에 확인했다.
- `compatibility_date`는 wrangler 3.114.17이 지원하는 최신 `2025-07-18`로 맞췄다.
- 배포 후 같은 코드가 바인딩을 그대로 써서 Workers AI·Vectorize를 타는 것이 라이브 Chrome 확인으로 검증됐다 (2026-11-13, VERIFICATION.md 참조).

## 원본 자산과의 관계

- `people-insight`의 FastAPI+Turso+n8n+Vercel → Workers+D1+Queues/Workflows+Static Assets
- `oss-agent-lab`의 Qdrant RAG + LangGraph 라우터 → Vectorize + Durable Objects 세션
- `enterprise-ops-agent`의 ADK ReAct → `/api/ask` 라우터·근거 표시
- ChatGPT Sites(Plaud Transcribe Studio, Paperdoc, easy-slides, People Signal 등) → 입력·출력 모듈의 화면·흐름 참고. 단, 이 제출물은 Sites 자체가 아니라 Workers 위에 새로 만든 프로토타입이다.
- FlowDesk Cloud → 요약·액션·리플렉션 결과의 저장처는 앱 안 라이브러리 탭이다. 기존 ChatGPT Sites는 연습작이라 연동·링크하지 않는다 (2026-11-13 결정, C3로 화면·문서에서 링크 제거 완료). FlowDesk의 제자리 편집 방식은 Stage 2 덱 편집기의 참고만 한다.
- 코드 참고 (Stage 1): `workspace-easyware/flowdesk-cloud` (PPTX 내보내기·R2 저장 패턴, `workspace-easyware/easy-slides` (pptxgenjs 신규 덱 생성·템플릿·workspace API). 두 접근법 중 Stage 1은 easy-slides식 생성, Stage 2는 FlowDesk식 제자리 편집으로 나눴다 — 위 Stage 1/2 참조.
- 화면 스타일: `people-insight`의 CSS 디자인 토큰(남색 #123863, 배경 #f5f8fc, 포인트 #2d7dde, 카드 radius 16px, Pretendard/Inter)을 `public/index.html`에 그대로 적용했다. Mantine 라이브러리가 아니라 Mantine처럼 보이게 짠 커스텀 CSS다.
