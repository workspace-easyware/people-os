# 강의실 설정 기능 구현 — Sonnet 5.5 (HR Admin용, 강의실 화면 안)

## 너의 역할
너는 구현 세션이다. People OS 강의실(LMS) 화면 안에 HR Admin 전용 **설정** 기능을 넣는다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- 계획 문서 `lms-plan.md` 6장(UI 설계 — 6.2 강의실 탭 구조), 3장(R2 업로드·서빙 — 관리자 업로드 API는 제외, `wrangler r2 object put` 사용).
- 기존 백엔드: `src/lms/routes.ts` (전체 — 특히 `GET /courses`, `GET /courses/:id`, `POST /admin/courses`, `POST /admin/lessons`, `DELETE /admin/lessons/:id`). `GET /courses`는 hr_admin에게 DRAFT 포함 전 과정 + `status`를 준다.
- 기존 프런트: `public/lms.js`, `public/lms.css`, `public/lms-player.js` (플레이어 내부는 건드리지 마라), `public/index.html`의 강의실 메뉴 구조 (참고만 — `index.html`은 건드리지 마라).

## 구현할 것
1. **백엔드 (작은 추가 1건, `src/lms/routes.ts`만)**:
   - **`DELETE /admin/courses/:id`** (신규, hr_admin 또는 X-Admin-Secret): 과정 + 소속 강의 + 진도를 삭제한다. R2 객체는 남긴다 (DELETE /admin/lessons와 같은 방침). 과정이 없을 때 404, 권한 없을 때 401/403.
2. **프런트 (`public/lms.js`, `public/lms.css`만)**:
   - 강의실 화면에 HR Admin에게만 보이는 **설정** 탭/영역을 추가한다 (일반 사용자에게는 안 보인다).
   - **과정 관리**: 과정 목록 (DRAFT 포함, 상태 표시), 과정 추가·수정 (제목·설명·카테고리·순서·상태 PUBLISHED/DRAFT), 과정 삭제 (확인 후).
   - **강의 관리**: 과정별 강의 목록, 강의 추가·수정 (제목·출처 youtube/r2, 유튜브 ID, 시작/종료 초, R2 키, 순서), 강의 삭제 (확인 후).
   - **R2 영상 업로드 안내**: 관리자가 새 영상을 올리는 방법은 `wrangler r2 object put` (화면에서 업로드 API는 만들지 않는다 — 계획서 3장). R2 키 입력란에 이미 업로드된 키(`lms/sample.mp4` 형식)를 넣는다고 안내 문구를 둔다.
   - 유튜브 강의는 임베드만으로 재생되고, R2 강의는 Worker가 Range 스트리밍으로 서빙한다는 점을 설정 화면에 짧게 안내한다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 hr_admin 쿠키를 달고: 설정 탭이 hr_admin에게만 보이는지, 과정 추가·수정·삭제, 강의 추가·수정·삭제, DRAFT 과정이 일반 사용자에게 안 보이는지 확인. 일반 사용자 계정으로는 설정 탭이 안 보이는지 확인. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- 강의실 설정 파일만 만든다/고친다: `src/lms/routes.ts` (DELETE /admin/courses 1건만), `public/lms.js`, `public/lms.css`. `public/index.html`은 건드리지 마라 (조직관리 세션이 메뉴를 넣고 있다). `public/lms-player.js`와 `src/approval/**`, `src/auth-routes.ts`는 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든/고친 파일 목록, 백엔드 변경 내역, 로컬 검증 결과를 적어라.
