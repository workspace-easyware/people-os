# 캘린더 기능 계획 — Fable 5.2 (설계만, 구현 금지)

## 너의 역할
너는 계획 세션이다. People OS에 **캘린더 기능 + 구글 캘린더 연동**을 넣기 위한 설계 문서를 만든다. 코드는 한 줄도 쓰지 마라. 배포·마이그레이션 금지. 결과물은 `files/people-os/calendar-plan.md` 한 파일이다.

## 읽을 것 (먼저 끝까지 읽어라)
- People OS 구조: `src/index.ts` (라우트 장착 방식, `requireViewer`·`requireAdmin` 패턴), `src/auth.ts` (세션), `src/approval/routes.ts` (부서·결재선 — 달력에 연동할 기한의 출처), `src/lms/routes.ts` (D1 테이블 + API 패턴).
- 기존 D1 마이그레이션: `migrations/0023_lms.sql`, `migrations/0024_approval.sql` (테이블 명명·인덱스 관례).
- 참고 조사 (사용자가 직접 검색으로 확인한 내용): Cloudflare에 공식 캘린더 제품·템플릿은 없다. 참고 프로젝트: Mailflare(Workers+D1 워크스페이스 대체재, 캘린더 내장), Punctual(캘린들리 대체재, 예약), Potion Calendar(구글 캘린더 클라이언트), timetracker(FullCalendar + Workers), notion-caldav-sync(CalDAV 동기화), slotmirror(캘린더 간 미러링). 이 프로젝트들에서 가져올 건 코드가 아니라 방식이다.

## 결정된 범위 (사용자 선택)
**개인 일정 + 팀 공유 일정 + 구글 캘린더 연동까지.** 즉 세 가지가 다 들어간다.
1. People OS 자체 캘린더: 개인 일정(본인만) + 팀 공유 일정(전원). 월/주 보기, 일정 추가·수정·삭제.
2. 구글 캘린더 연동: 구글 캘린더와 동기화. OAuth로 구글 계정을 연결한다.

## 설계 문서에 반드시 들어갈 것 (`files/people-os/calendar-plan.md`)
1. **일정 데이터 모델**: D1 테이블 설계 (`calendar_events` 등). 개인/공유 구분 (`owner_id` + `visibility`), 반복 일정 처리 여부, 시간대(Asia/Seoul 기준, UTC 저장) 방침, 결재 기한·할 일 기한·코칭 일정과의 연동 방식 (읽기 전용 미러 vs 별도 일정).
2. **구글 OAuth 흐름**: Google Cloud 콘솔에서 사용자가 만들어야 하는 것 (OAuth 클라이언트 ID·시크릿, 리디렉션 URI — People OS 도메인 기준), 필요한 스코프 (`calendar.events` 읽기/쓰기 범위, 최소 권한 원칙), 토큰 저장 위치와 암호화 방침 (D1 vs KV, 리프레시 토큰 보관), 토큰 갱신 (리프레시 토큰으로 액세스 토큰 재발급) 방식. **중요**: 구글 캘린더 연동은 사용자(구글 계정 소유자)가 Google Cloud에서 OAuth 앱을 만들고 동의를 해야 한다. 그 절차를 단계별로 적어라.
3. **동기화 설계**: 동기화 방향 (구글→People OS 읽기 / People OS→구글 쓰기 / 양방향), 충돌 해결 (양쪽에서 같은 일정을 고쳤을 때), 중복 방지 (구글 eventId ↔ People OS id 매핑), 동기화 트리거 (수동 새로고침 / Cron 주기 동기화 / 웹훅), 삭제 전파. 양방향이 복잡하면 1단계(구글 읽기 전용) → 2단계(쓰기) 로 나누는 안을 제시하라.
4. **알림**: 일정 시작 전 알림 (Cron + D1 notifications + Resend 메일 — 기존 알림 패턴 재사용), 반복 일정 알림 처리.
5. **UI 설계**: 월/주 보기 (FullCalendar 라이브러리 사용 여부 — 번들 크기·라이선스·People OS 디자인 시스템과의 조화), 일정 추가·수정 폼, 공유 일정 표시 (색상·배지), 구글 연동 상태 표시 (연결됨/끊김/다시 연결).
6. **보안·권한**: 개인 일정은 본인만, 공유 일정은 전원 읽기·hr_admin 쓰기 (또는 작성자만 수정), 구글 토큰은 본인만 접근, X-Admin-Secret으로는 구글 토큰에 접근 금지.
7. **구현 분할**: 단계별 작업 목록 (예: C1 D1+API 뼈대 → C2 화면 → C3 구글 OAuth → C4 동기화 → C5 알림), 각 단계의 모델 추천 (Sonnet/Opus), 의존 관계, `index.html` 메뉴 배선은 어느 단계에서 하는지. **주의**: 조직관리 메뉴 세션(Opus)과 강의실 설정 세션(Sonnet)이 지금 `index.html`을 만지고 있다. 캘린더 메뉴 배선은 그 세션들이 끝난 뒤에 하도록 단계에 명시하라.
8. **사실 기준표**: 확인 안 된 것은 "확인 안 됨"으로 적어라. 특히 구글 OAuth 앱 생성 절차·스코프 이름·토큰 수명은 Google 문서를 기준으로 하되, 실제 콘솔 화면과 다를 수 있음을 명시한다. People OS에 없는 기능(예: 구글 캘린더 웹훅 push notification)은 "쓴다"고 쓰지 마라.

## 제약
- 설계만 한다. `src/`·`public/`·`migrations/`에 코드를 쓰지 마라.
- 결과물은 `files/people-os/calendar-plan.md` 한 파일. 길이는 제한 없다. 결정 사항은 근거와 함께 적어라.
- 끝나면 최종 보고에 계획 문서 경로, 핵심 결정 5개, 사용자가 해야 할 구글 설정 단계, 구현 분할 요약을 적어라.
