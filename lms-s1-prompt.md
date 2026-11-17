# LMS 구현 S1 — Sonnet 5.5 (마이그레이션·시드·API 뼈대)

## 너의 역할
너는 구현 세션이다. 계획 문서 `lms-plan.md`의 7장 분할표에서 **S1**만 구현한다. S1 범위를 벗어나지 마라. O1(Opus)과 S2(Sonnet)의 파일은 건드리지 마라. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `lms-plan.md` 2장(D1 스키마·시드), 5장(API 설계), 7장(분할표·세션 간 계약), 8.1(로컬 검증).
- `lms-seed-content.md` (시드 콘텐츠 실제 값).
- 기존 패턴: `src/email/routes.ts`의 `isSchemaMissing` (503 가드), `migrations/0022_email.sql`, `seeds/ds_personal_v1.sql`, `src/index.ts`의 라우트 mount 방식.

## 구현할 것 (S1 범위)
1. **`migrations/0023_lms.sql`** (신규) — 2.2의 SQL을 그대로 옮긴다 (`lms_courses`, `lms_lessons`, `lms_progress` + 인덱스). 외래키 없음. 테이블명 `lms_` 접두사.
2. **`seeds/lms_seed_v1.sql`** (신규) — 2.4의 SQL을 기본으로 하되, 아래 해결된 값을 반영한다 (멱등 `INSERT OR IGNORE` + 고정 id).
3. **`src/lms/routes.ts`** (신규) — API 뼈대: courses 목록·상세, summary, admin upsert·삭제, 유튜브 id 추출·검증, 503 가드(`no such table` → 503 "강의실 스키마가 아직 적용되지 않았습니다 (migration 0023)"). `/lessons/:id/video`와 `/lessons/:id/progress` 라우트는 등록만 하고 아래 4번의 함수를 부른다 (구현은 O1이 채운다).
4. **`src/lms/stream.ts`, `src/lms/progress.ts`** (신규) — 자리 표시만: 7장의 계약 서명 그대로 `handleVideo()`와 `saveProgress()`를 만들고 501을 돌려준다. O1이 채울 파일의 함수 서명만 고정한다.
5. **`src/index.ts`** (2줄) — 5장의 위치에 mount + import.

## 해결된 값 (계획의 열린 질문 중 확정된 것 — 그대로 쓴다)
- **R2 영상은 이미 업로드돼 있다. 다시 올리지 마라.** 버킷 `people-os-files`, 키 `lms/sample.mp4`, `video/mp4`, 32,942,962 bytes, 270초. 시드에는 이 키를 그대로 쓴다 (계획의 `lms/videos/<lessonId>/` 키 형식은 제안일 뿐, 실제 업로드된 키가 우선이다 — 시드에 주석으로 남긴다).
- **R2 과정**: id `course_storytelling`, 제목 "스토리텔링: 내 이야기 바꾸면, 사람이 움직인다", 설명에 챕터 3개 포함 ("1. 인류의 가장 오래된 소통 / 2. 나를 정의하는 이야기 / 3. 세상과 연결되는 법"), category `JOB`, ord 1, `PUBLISHED`.
- **R2 강의**: 1개만 만든다 (챕터별 타임스탬프가 없어서 분할 불가). id `les_storytelling_01`, course `course_storytelling`, ord 1, 제목 "스토리텔링: 내 이야기 바꾸면, 사람이 움직인다", source `r2`, r2_key `lms/sample.mp4`, content_type `video/mp4`, size_bytes 32942962, duration_sec 270.
- **유튜브 과정**: 2.4의 값 그대로. 과정 `course_claude_allinone` (ord 2) + 강의 14개 (les_claude_01~14, start_sec/end_sec 포함, 영상 ID `ZN37IV4sbQg`).
- **유튜브 링크 추가는 없다.** 14챕터 분할 시드로 간다.

## 검증 (로컬, 8.1 중 S1 범위)
- `npx tsc --noEmit` 통과.
- `npx wrangler d1 execute people-os-db --local --file migrations/0023_lms.sql` 후 시드 파일 실행 (`migrations apply --local`은 0004에서 실패하므로 쓰지 않는다 — AGENTS.md).
- `npx wrangler dev --local` 로 로그인 쿠키를 달고: L1(미로그인 401), L2(마이그레이션 전 503 — 적용 전후 둘 다 확인), L3(A로 courses 조회 시 과정 2개, lesson_count 14와 1, completed_count 0).
- Range 관련 확인(L4~L10)은 O1 범위라 하지 않는다 (지금은 501이 정상).
- 검증 스크립트나 하네스는 `files/lms-verify/` 아래가 아니라 이 작업 디렉터리(`files/people-os/` 안)에 두되, 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- S1 파일만 만든다/고친다: `migrations/0023_lms.sql`, `seeds/lms_seed_v1.sql`, `src/lms/routes.ts`, `src/lms/stream.ts`, `src/lms/progress.ts`, `src/index.ts`(2줄). O1·S2 파일(`public/lms-player.js`, `public/lms.js`, `public/lms.css`, `public/index.html`)은 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, tsc 결과, 로컬 검증 결과(L1~L3)를 적어라.
