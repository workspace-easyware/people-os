# 조직관리 메뉴 구현 — Opus 5.5 (백엔드 보강 + 프런트)

## 너의 역할
너는 구현 세션이다. People OS에 HR Admin 전용 **조직관리** 메뉴를 새로 만든다. 사용자는 hr.jhkang@peopleos.site (HR Admin)이다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 배경 (데이터는 이미 라이브에 반영됨)
- 부서 1개: 인사팀 (`dept_hr`). 부서장: 이구름 (coach.jhkang@peopleos.site, id `0b9abdd9-7b28-46a5-a46d-a49c700a6396`).
- 구성원: 이구름·김불꽃 (mercer.jhkang@peopleos.site, id `a06b2c76-bb16-49ae-ba9f-3fa3f7539881`)이 인사팀 소속 (`department_id='dept_hr'`).
- 강준호 (hr.jhkang@peopleos.site, hr_admin)는 부서 미지정이다. 조직관리 메뉴에서 부서를 지정할 수 있어야 한다.
- 결재선: 부서장 → hr_admin. 부서원이 기안하면 부서장이 결재하고, 부서장이 기안하면 부서장 칸을 건너뛰고 hr_admin이 결재한다.

## 읽을 것 (먼저 끝까지 읽어라)
- 기존 백엔드: `src/auth-routes.ts` (`GET/POST /admin/users`, `PATCH /admin/users/:id` — hr_admin 계정 관리), `src/approval/routes.ts` (`GET/POST /admin/departments`, `PUT /admin/users/:id/department` — 부서 관리).
- 기존 프런트: `public/index.html` (메뉴·`TABS`·`COACHEE_TABS`·`switchTab`·`applyRole` 구조), 사용자 관리 화면 (참고용 — "사용자 관리" 메뉴는 그대로 둔다).

## 백엔드 보강 (작은 변경 2건, `src/auth-routes.ts`만)
1. **`GET /admin/users`**: 반환에 `department_id`와 `department_name`을 추가한다 (`users`와 `departments` LEFT JOIN). 기존 필드는 그대로.
2. **`PATCH /admin/users/:id`**: `name` 변경을 받는다 (1~100자, 공백 제거). 자기 계정의 이름은 바꿀 수 있게 한다 (역할·상태·코칭 역할만 자기 계정 변경 금지 — 이름은 허용). `role`·`status`·`coaching_role` 동작은 그대로.

## 프런트 구현
1. **`public/org.js`, `public/org.css`** (신규) — 조직관리 화면:
   - **부서 탭**: 부서 목록 (이름·코드·부서장·인원·상위 부서·사용 여부), 부서 추가·수정 (이름·코드·부서장 선택·상위 부서·정렬·사용 여부), 부서장 지정.
   - **구성원 탭**: 사용자 목록 (이름·이메일·역할·코칭 역할·부서·상태), 이름 수정 (인라인 또는 편집 폼), 부서 지정 (드롭다운 — `PUT /admin/users/:id/department` 사용), 역할·코칭 역할 표시 (변경은 사용자 관리 메뉴에서).
   - 부서장이 없는 부서의 부서원은 기안할 수 없다는 안내를 부서 화면에 보여준다 (결재선 규칙).
2. **`public/index.html`** — 사이드바에 **조직관리** 메뉴 추가 (사용자 관리 다음, HR Admin 전용 — `applyRole`에서 일반 사용자에게 숨긴다). `TABS`에는 넣고 `COACHEE_TABS`에는 넣지 않는다 (HR Admin 전용). `switchTab` 연결, 스크립트·CSS 링크. **편집 직전에 파일을 다시 읽어라.** LMS 설정 세션이 같은 파일에 강의실 설정 메뉴를 넣고 있을 수 있다. 기존 메뉴·탭 구조를 앵커로 삼아 조직관리 항목만 추가하고, 이미 있는 항목은 그대로 둔다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 hr_admin 쿠키를 달고: 조직관리 메뉴가 뜨는지, 부서 목록·구성원 목록이 보이는지, 부서 추가·부서장 지정·구성원 부서 지정·이름 수정이 동작하는지 확인. 일반 사용자 계정으로는 조직관리 메뉴가 안 보이는지 확인. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- 조직관리 파일만 만든다/고친다: `src/auth-routes.ts` (GET/PATCH users 2곳만), `public/org.js`, `public/org.css`, `public/index.html` (조직관리 메뉴·탭만). `src/approval/routes.ts`와 `src/lms/**`, `public/lms.js`는 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든/고친 파일 목록, 백엔드 변경 내역, 로컬 검증 결과를 적어라.
