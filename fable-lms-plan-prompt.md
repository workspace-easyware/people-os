# Fable 5.2 자문 — People OS 간단 LMS 구현 계획 (공모전용)

## 너의 역할
너는 아키텍처 자문이다. 아래 자료를 읽고 **구현 계획**을 세우는 것이 임무다. 코드를 수정하거나 배포하지 마라. 결과물은 계획 문서 1개다. 이 계획은 뒤에 이어질 구현 세션들(Sonnet 5.5 쉬운 코딩, Opus 5.5 어려운 코딩)의 지침서가 된다.

## 배경
- **People OS**는 Cloudflare Workers 위의 HR·코칭 인텔리전스 플랫폼이다. 스택: Workers + D1 + R2 + KV + Vectorize + Workers AI(Qwen3, Clef, bge-m3, Whisper) + Durable Objects + Queues. **Free 플랜 — 유료 기능 사용 금지.** 도메인 peopleos.site. 로그인(PBKDF2+페퍼, hr_admin/user 역할), 개인 RAG 격리(owner_id), 메일함(Resend 발송)이 있다. 메뉴: 홈, 메일함, 할 일, 녹음전사.문서저장, 코칭 리플렉션, 개인 업무 검색, HR 규정 검색, 라이브러리, 관측·평가, 사용자 관리, 소개.
- 로컬 People OS 코드: 이 작업 디렉터리의 `files/people-os/` (src/index.ts Hono Worker, src/auth.ts, migrations/ 번호순, public/index.html·styles.css·각종 .js, wrangler.toml 바인딩: DB people-os-db, FILES R2 people-os-files, CACHE KV, VECTOR, AI).
- **공모전 일정**: 기능 동결 11-25, 데모 영상 11-26, 제출 11-27. LMS는 제출 전에 들어가야 한다.

## 만들 것 — 간단한 LMS (공모전 범위, Free 내)
- D1 테이블: courses(과정), lessons(강의 — youtube_id 또는 r2_key 중 하나), progress(사용자별 수강 완료).
- 콘텐츠: **R2 영상 1개 + 유튜브 링크 몇 개.** (실제 영상 파일과 유튜브 URL은 사용자가 나중에 제공한다. 계획에는 플레이스홀더 + 시드 방법을 넣어라.)
- 기능: 과정 목록, 강의 재생(유튜브 iframe / R2 영상 `<video>`), 사용자별 진도(본 강의 표시), 기존 로그인·owner_id 격리 재사용.
- UI: 새 메뉴 "강의실" 추가 (메뉴 순서와 홈 카드 배치까지 제안).

## 관련 자료 (직접 읽어라)
### 1. R2 영상 스트리밍 패턴 (핵심)
- Worker가 `env.FILES.get(key, { range: { offset, length } })`로 R2에서 구간만 읽어 **206 Partial Content**로 반환하면 브라우저 `<video>` 태그가 탐색(seek)까지 지원한다. 인코딩·적응형 비트레이트는 없다 (MP4/WebM 직접 재생, ffmpeg로 미리 변환).
- R2 가격: 저장 $0.015/GB-월 (10GB 무료), **전송(egress) $0**, Class B 읽기 $0.36/100만 (월 1,000만 무료). 소규모면 거의 무료.
- 참고 프로젝트 (WebFetch으로 읽어라): "Build a Course Platform on Cloudflare for $0" (simpleappshipper.com — R2 스트리밍 + 인증 + 페이월 구조), file-spooder (R2 파일 매니저, Range 요청 영상 탐색), JustRec (Hono Worker + R2 + D1 영상 공유).

### 2. 유튜브 큐레이션 패턴 (우리 코드에서 찾기)
- GitHub CLI로 workspace-easyware 저장소를 읽는다 (기본 계정, 플래그 없음):
  `/opt/hatch/bin/github call-read-tool --name get_file_contents --arguments-json '{"owner": "workspace-easyware", "repo": "<repo>", "path": "<path>"}'`
- 대상: talent-navigator, easy-slides, flowdesk-cloud, ileet. `search_code`는 비공개 저장소에서 0건을 반환하니 **반드시 get_file_contents로 디렉터리를 훑고 파일을 직접 읽어라.**
- 찾을 것: 유튜브 임베드(`youtube.com/embed`, `youtu.be`, iframe), 영상 목록·큐레이션 UI, 썸네일 처리. 어떤 저장소에 패턴이 있고 People OS에 어떻게 가져올지.

### 3. People OS 기존 패턴 (로컬 코드에서 확인)
- D1 마이그레이션 작성·적용 방식 (migrations/ 디렉터리, 번호 규칙), API 라우트 추가 방식 (src/index.ts), 권한 체크 (hr_admin vs user, owner_id), 프론트 탭·메뉴 추가 방식 (public/index.html의 TABS 배열과 탭 UI 패턴).
- R2 사용 현황: 기존에 R2 `people-os-files`에 무엇을 어떻게 저장하는지 (recordings/, docs/, emails/ 등 키 규칙), Range 요청을 이미 쓰는 곳이 있는지.

### 4. 쓰지 않을 것
- **Cloudflare Stream은 쓰지 않는다** (관리형이지만 무료 티어 없음 — 저장 $5/1,000분/월, 전송 $1/1,000분). 공모전 범위는 Free만.

## 산출물
**`files/people-os/lms-plan.md`** (한국어) — 아래 목차로 작성한다:
1. 아키텍처 개요 (한 장 그림 — 텍스트로: D1·R2·Worker·브라우저 흐름)
2. D1 스키마 (courses/lessons/progress — 컬럼, 인덱스, 마이그레이션 번호 제안, 시드 데이터 형태 — R2 영상 1개 + 유튜브 링크 몇 개를 넣는 방법: 관리자 시드 API vs SQL 시드)
3. R2 영상 업로드·서빙 설계 (업로드 경로 — wrangler r2 object put vs 관리자 업로드 API, Range 요청 처리 의사코드, Content-Type·Content-Range·Accept-Ranges 헤더, 1개 영상 기준 Free 한도 계산)
4. 유튜브 재생 설계 (iframe 임베드, 썸네일, 개인정보 보호 — youtube-nocookie 여부)
5. API 설계 (라우트 목록 — 메서드·경로·권한·입출력, 기존 라우트 스타일과 일치)
6. UI 설계 (메뉴 "강의실" 위치, 과정 목록·강의 상세·진도 표시, 홈 카드 추가 여부)
7. **구현 작업 분할 — 쉬운 것(Sonnet 5.5) vs 어려운 것(Opus 5.5)** (각 작업마다 담당 모델을 명시하고, 경계가 깨끗하도록 파일을 나눈다. 예: 마이그레이션+시드+API 뼈대+UI 목록 = Sonnet, Range 스트리밍+진도 동시성 = Opus. 판단 근거를 한 줄씩 적는다.)
8. 검증 체크리스트 (로컬 workerd 테스트, 라이브 확인 항목 — R2 영상 재생·seek, 유튜브 재생, 진도 저장·조회, 비로그인 401, 타인 진도 격리)
9. 열린 질문 (사용자 결정 필요 — R2 영상 파일, 유튜브 URL 목록, 과정·강의 이름, 수강 대상 범위)

## 제약
- 코드는 읽되 수정하지 마라. 배포하지 마라. D1/R2 등 운영 리소스에 쓰지 마라.
- 추측하지 마라. 자료에서 확인한 것만 근거로 쓴다. 못 찾은 것은 "확인 안 됨"으로 명시한다.
- 계획 문서가 완성되면 최종 보고에 핵심 결론(아키텍처 한 줄, Sonnet/Opus 분할 요약)을 적어라.
