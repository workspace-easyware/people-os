# 결재 구현 A2 — Sonnet 5.5 (프런트: 결재함·기안·상세·홈 카드·부서 관리)

## 너의 역할
너는 구현 세션이다. 계획 문서 `groupware-approval-plan.md`의 7장 1단계 중 **프런트**만 구현한다. A1(Opus) 백엔드는 끝났다 (마이그레이션 0024·시드·`src/approval/`·로컬 검증 완료). 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `groupware-approval-plan.md` 6장(UI 변경안 — 메뉴 순서·결재함 탭·문서 상세·홈 카드·사용자 관리 부서 탭).
- A1이 만든 백엔드: `src/approval/routes.ts` (엔드포인트·요청/응답 형식), `migrations/0024_approval.sql`.
- 기존 패턴: `public/email.js`/`email.css` (메일함 렌더링 선례), `public/index.html`의 메뉴·`TABS`·`COACHEE_TABS`·`switchTab`·`applyRole`·홈 카드 구조.

## A1이 넘긴 계약 (그대로 쓴다 — A1 최종 보고 기준)
- **알림 링크**: `/#approval/<docId>` 해시 경로. 이 형식을 그대로 쓴다.
- **문서함 종류** (`GET /api/approval/box?type=`): `PENDING`(결재 대기), `UPCOMING`(결재 예정), `DRAFTING`(기안 진행), `DRAFTS`(임시·회수), `DONE`(완료·반려), `APPROVED_BY_ME`(내가 결재), `MINE`(내 기안 전체). 탭은 6장의 구성(대기/기안/완료/임시저장/참조)을 이 종류에 맞게 매핑한다.
- **추가 엔드포인트**: `GET /api/approval/users?q=` (결재자 지정용 검색), `GET /notifications` + `POST /notifications/read` (알림 목록·읽음), hr_admin 전용 `GET`·`POST /admin/departments`, `PUT /admin/users/:id/department`.
- **기안**: `POST /api/approval/documents`에 `submit:true`를 주면 기안과 상신을 한 번에 한다. 결재선 수정은 `routes` 배열로 받는다 (토큰, 사용자 id, `{user_id}` 형태). 기본 결재선은 양식의 `default_route_json`(부서장 → hr_admin) 자동 적용.
- **조회 권한**: 기안자와 결재선에 있는 사람만 볼 수 있다. hr_admin도 결재선 밖 문서는 조회하지 못하고 강제 반려만 할 수 있다. 프런트는 이 권한을 그대로 반영한다 (버튼을 숨기는 것으로 권한을 대신하지 않는다 — 서버가 막는 것이 본질이다).
- **메일 발송은 미검증**: 로컬에 `RESEND_API_KEY`가 없어서 실제 발송은 확인 안 됐다. 알림은 D1에만 기록됐다. 프런트는 알림 목록(`GET /notifications`)을 보여주는 데 집중한다.

## 구현할 것 (A2 범위)
1. **`public/approval.js`, `public/approval.css`** (신규) — 결재함 화면: 탭(대기/기안/완료/임시저장/참조), 문서 목록, 새 기안(양식 선택 → 에디터 → 결재선 확인·수정 → 상신), 문서 상세(본문 + 우측 결재선 타임라인(사람·상태·시각·의견) + 하단 승인/반려 버튼(의견 입력)). 상신 후에는 본문·결재선 수정 불가 (회수만). `email.js`와 같은 패턴의 렌더링.
2. **`public/index.html`** — 메뉴에 **결재함** 추가 (메일함 다음, 업무 묶음). 결재 대기 건수 배지. `TABS`/`COACHEE_TABS`/`switchTab`/`applyRole`에 연결. 홈 카드 "결재 대기 N건"(누르면 결재함 대기 탭), "내 기안 진행 중 N건". 사용자 관리에 "부서" 탭 추가(부서 CRUD, 부서장 지정), 사용자 행에 부서 선택 추가. **편집 직전에 파일을 다시 읽어라.** LMS S2 세션이 같은 파일에 강의실 메뉴를 넣고 있을 수 있다. 기존 메뉴·탭 구조를 앵커로 삼아 추가하고, 이미 있는 항목은 그대로 둔다.
3. **알림 UI**: 상단 종 아이콘 + 드롭다운 (6장). `GET /notifications` 목록과 `POST /notifications/read` 읽음 처리. 결재 요청 메일의 링크(`/#approval/<docId>`)가 결재 문서 상세를 바로 연다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 로그인 쿠키를 달고: 결재함 메뉴·탭이 뜨는지, 새 기안 → 상신 → 대기 탭에 보이는지, 문서 상세 타임라인·승인/반려 버튼 동작, 홈 카드 숫자, 사용자 관리 부서 탭. 권한 밖 문서(결재선 밖)는 목록에 안 뜨고 직접 열면 404인지 확인.
- 검증 스크립트나 하네스는 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- A2 파일만 만든다/고친다: `public/approval.js`, `public/approval.css`, `public/index.html`(메뉴·탭·홈 카드·사용자 관리 부서 탭만). 백엔드(`src/approval/**`, `migrations/`)는 건드리지 마라. LMS 파일(`public/lms.js`, `public/lms.css`, `src/lms/**`)은 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, tsc 결과, 로컬 검증 결과를 적어라.
- 참고: `files/approval-a1-verify/hash.mjs`는 A1이 남긴 불필요한 파일이다. 지워도 된다.
