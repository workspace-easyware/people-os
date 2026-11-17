# 캘린더 C1 — D1 + API 뼈대 — Sonnet 5.5

## 너의 역할
너는 구현 세션이다. People OS 캘린더의 1단계(C1) 백엔드 뼈대를 만든다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `calendar-plan.md` 1장(데이터 모델)·1.6(API)·6장(보안·권한)·7.1(C1 행) — 이 문서의 지시를 그대로 따른다.
- 기존 패턴: `src/lms/routes.ts` (하위 앱 구조, `requireViewer`, 스키마 누락 503, `originOk`), `src/approval/routes.ts` (권한·404 원칙, 부분 색인), `migrations/0023_lms.sql`·`migrations/0024_approval.sql` (스키마 관례), `src/index.ts` (라우트 장착 위치, 캐치올 `app.all("*")` 앞).

## 구현할 것
1. **마이그레이션** (`migrations/00NN_calendar.sql`): 번호는 시작 전에 `ls migrations`와 원격 `d1 migrations list --remote`로 빈 번호를 확인해 쓴다. `0025`가 비어 있으면 `0025_calendar.sql`을 쓴다 (0025_agent_actions는 파일이 아직 없는 예약 번호 — 겹치지 않게 확인한다). 테이블 `calendar_events` + `calendar_reminder_log` (계획서 1.2·4.1 참조). `rrule`·`exdates` 컬럼은 만들되 C1에서는 항상 NULL (반복은 C7). 부분 색인 포함.
2. **`src/calendar/routes.ts`** (신규): 계획서 1.6의 API 전부.
   - `GET /events?from=&to=` (기간 최대 62일, 내 개인 + 팀 일정, `source:'local'`, `editable`, `owner_name`).
   - `POST /events`, `GET /events/:id`, `PATCH /events/:id` (`version` 불일치 409), `DELETE /events/:id` (소프트 삭제).
   - 전부 로그인 필수(익명 401). `X-Admin-Secret`만으로는 401 (세션만 본다 — `getSessionUser` 사용). 상태 변경은 `originOk`. 남의 개인 일정은 404.
   - 팀 일정 작성: **전원 작성 + 작성자 또는 hr_admin 세션만 수정·삭제** (계획서 6.1 권장안). hr_admin만 작성으로 바꾸는 것은 나중에 서버 검사 한 줄이다.
   - 검증: `end_at > start_at`, 한 일정 최대 31일, 시각 형식 `YYYY-MM-DDTHH:MM:SSZ` 엄격 검사, 본문 256KB 상한, `visibility`·`category` 목록 검사.
   - 스키마 누락 시 503 (LMS 방식 — 자기 테이블 누락만).
3. **`src/index.ts`**: `app.route("/api/calendar", calendarApp)` mount 2줄 (import + mount). 캐치올 앞. **편집 직전에 파일을 다시 읽어라.** 강의실 설정 세션(Sonnet)이 `src/lms/routes.ts`를 만지고 있지만 `src/index.ts`는 건드리지 않는다. 그래도 mount 위치를 확인하고, 이미 있는 mount 줄은 그대로 둔다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 curl 검증: 익명 401 · `X-Admin-Secret`만으로 401 · A의 개인 일정을 B가 조회/수정/삭제 → 404 · 팀 일정은 B가 조회 가능, 수정은 403, hr_admin 세션은 수정 가능 · `version` 불일치 409 · 기간 경계 (자정 KST에 걸친 일정, 종일 일정이 옆 날짜로 새지 않는가) · 마이그레이션 미적용 503 (테이블 없는 DB에서).
- 검증 산출물은 `files/calendar-c1-verify/`에 둔다. `/tmp` 금지.

## 제약
- C1 파일만 만든다/고친다: `migrations/00NN_calendar.sql`, `src/calendar/routes.ts`, `src/index.ts` (mount 2줄만). `public/`·`src/lms/`·`src/approval/`·`src/auth-routes.ts`는 건드리지 마라. 구글 OAuth·알림은 C3·C5의 일이다.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든/고친 파일 목록, 마이그레이션 번호, 로컬 검증 결과를 적어라.
