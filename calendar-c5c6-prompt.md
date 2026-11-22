# 캘린더 C5(알림) + C6(구글 쓰기) (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `4a01a312`, 문서 편집 Worker `1dd93ed7`. 커밋 HEAD은 세션 4 커밋(`docx-large-queue-v1` 태그) 이후다.
- 모델: Fable 5.2 (이 세션은 Fable 5.2 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 기존 상태 (C1~C4 완료)

- 설계 원본: **`calendar-plan.md`** — C5는 §4, C6은 §3(2단계)를 먼저 읽는다. C1·C2(자체 캘린더)·C3(구글 OAuth 연결)·C4(구글 실시간 읽기)가 라이브에 있다. 코드: `src/calendar/{routes,google-oauth,google-events,crypto}.ts`, 화면 `public/calendar.js`·`calendar.css`.
- Google 앱: External, 개인 계정 hr.jhkang@gmail.com, 프로젝트 "People OS" (people-os-515001), 스코프 `openid`·`userinfo.email`·`calendar.events.readonly`, 시크릿 3개 저장됨. **주의: C4의 `events.list` 호출 방식은 기억 기반 가정이다 — 첫 실호출에서 400/403이 나면 이 가정을 먼저 의심한다.**
- **C6은 사용자 브라우저 구글 재동의(새 쓰기 스코프)가 필요하다** — 이번 세션은 코드까지만 만들고, 재동의는 사용자 몫이다. 동의 없이 라이브에서 쓰기를 돌릴 수 없음을 RESULT에 명시한다.
- 반복 일정은 C1~C5 범위가 아니다 (`calendar-plan.md` §1.4 — 컬럼만 미리 둠, 반복은 C7).

## 과제

### C5 — 일정 알림 (§4)

- 방식: 기존 알림 패턴 재사용 — `Cron(15분) → D1 notifications 기록 → Resend 메일`, 결재 알림과 같은 표·같은 종 아이콘 (`src/approval/notify.ts` 참조, 결재 모듈은 고치지 않고 `src/calendar/notify.ts`를 새로 만든다).
- **크론 분기 주의**: `wrangler.toml`에 `*/15 * * * *`를 더할 때 `scheduled()`에 분기를 **맨 먼저** 추가해야 한다. 지금 코드는 평가 cron이 아니면 전부 다이제스트를 생성한다 — 분기 없이 cron만 더하면 다이제스트가 15분마다 돈다. Free 플랜 Cron Trigger는 계정당 5개 — 이 Worker가 2개를 쓰고 있으니 C5가 대시보드/`wrangler`로 다른 Worker 사용량을 확인한다.
- 정밀도 15분 단위: 알림 시점 선택지는 15분/30분/1시간/1일 전으로 제한한다 ("약 10분 전" 같은 어긋나는 문구 금지).
- 대상: `remind_minutes IS NOT NULL`, 삭제·취소 아님, `start_at - remind_minutes분 <= 지금 < start_at`.
- 받는 사람: 개인 일정은 소유자에게 종 알림 + 메일. 팀 일정은 활성 사용자 전원에게 종 알림만 (메일 없음 — Resend 한도·소음). **구글 일정은 People OS가 알리지 않는다** (내용을 저장하지 않고 구글이 이미 알림 — 중복 방지).
- 중복 방지: `calendar_reminder_log(event_id, occurrence_start, user_id)` PK에 `INSERT OR IGNORE`, 같은 batch 안에서 방금 들어간 행일 때만 `notifications`에 넣는다 (결재의 `notificationStmt` 패턴).
- 알림 행: `type = 'CALENDAR_REMINDER'`, `ref_type = 'calendar_event'`, `title = "[일정] <제목> · 11/20(금) 14:00"`, `link = "/#calendar/<일정 id>"`. 메일: 제목·시각·링크만 (본문 미포함), 발신 `"People OS 일정" <calendar@peopleos.site>`. `RESEND_API_KEY`가 없으면 메일은 건너뛰고 D1 기록만 남긴다.

### C6 — 구글 쓰기 (§3 2단계)

- 방향: People OS → 구글 쓰기. **일정마다 "구글에도 저장"을 켠 개인 일정만** 구글에 쓴다 (팀 일정·구글에서 온 일정은 쓰지 않는다).
- 스코프: `calendar.events`로 넓힌다. 단, 더 좁은 쓰기 스코프(`calendar.events.owned`, `calendar.app.created`)가 있는지 먼저 문서를 확인해, 쓸 수 있으면 그쪽을 쓴다. 처음부터 쓰기 스코프를 받지 않은 이유(토큰 유출 시 피해, 동의 화면 문구)는 계획서에 있다.
- 연결된 일정의 변경·삭제 전파: `calendar_event_links` 테이블을 추가한다 (계획서 §1.1 — 2단계에서 추가하기로 돼 있다). 충돌은 etag로 처리한다.
- 변경 감지: `syncToken` 대신 `updatedMin`을 쓴다 (계획서 §3.2 말미 — `updatedMin`의 정확한 제약은 확인 안 됐으니 C6이 문서를 확인하고, 맞지 않으면 "연결된 일정을 `events.get`으로 하나씩"으로 단순화한다 — 연결 일정이 사용자당 수십 건 이하일 때만 유효).
- **재동의**: 새 스코프는 기존 연결로는 쓸 수 없다. 사용자가 브라우저에서 구글 재동의를 해야 한다. 세션은 재동의 안내(화면에 뜨는 문구·연결 상태 표시)까지 만들고, 동의 자체는 사용자가 하는 것으로 RESULT에 남긴다.

### 검증

- 로컬: C5 알림 크론 분기(다이제스트가 15분마다 안 도는지)·알림 생성·중복 방지(같은 일정에 2회 크론 → 알림 1개)·팀 일정 종 알림만·구글 일정 알림 없음. C6 쓰기 경로(연결·생성·수정·삭제 전파·etag 충돌)는 구글을 못 부르면 로컬 가짜 응답으로 흐름까지만 확인하고, 라이브에서 가능한 범위까지 확인한다.
- 라이브: C5는 실제 일정 1건으로 알림이 D1에 남는지(메일 발송까지는 Resend 로그로) 확인한다. C6은 **재동의 전에는 라이브 쓰기 시험을 하지 않는다** — 코드·마이그레이션·화면까지만 검증하고, 재동의 뒤 할 일을 RESULT에 적는다.
- 기존 엔드포인트 스모크 (`/api/health`·익명 `/api/auth/me` 401·캘린더 조회 1건)가 이전과 동일한지 확인한다.
- 임시 시험 계정·일정·알림은 전부 정리하고 0건임을 재확인한다.

## 공통 규칙

- 배포는 직렬로. GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/calendar-c5c6/RESULT.md`에 쓴다)

- 설계 (C5 알림 흐름·C6 쓰기 흐름·스코프 결정·테이블) + 바뀐 파일, 배포한 버전 ID, D1 마이그레이션 번호.
- 라이브 검증 결과 (엔드포인트·상태·확인한 값), 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다 (특히: C4 `events.list` 가정 검증 여부, C6 재동의 뒤 할 일, 크론 사용량 확인 결과).
