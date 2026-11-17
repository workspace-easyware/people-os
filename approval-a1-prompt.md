# 결재 구현 A1 — Opus 5.5 (백엔드: 마이그레이션·시드·상태머신·API·알림)

## 너의 역할
너는 구현 세션이다. 계획 문서 `groupware-approval-plan.md`의 7장 1단계 중 **백엔드**만 구현한다. 프런트(A2, Sonnet)와 배포는 하지 않는다. 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `groupware-approval-plan.md` 1장(easy-ware 분석 — 결재선·상태 전이·빈틈), 4.6(② 방식 설계 초안 — 스키마·상태 전이·API·구현 시 지킬 것), 8.3(D1 스키마 방향).
- 기존 패턴: `src/email/routes.ts`의 `isSchemaMissing` (503 가드), `src/auth.ts` (세션·권한), `src/index.ts`의 라우트 mount 방식과 `scheduled()` 크론, `migrations/0022_email.sql`, `seeds/ds_personal_v1.sql`.

## 결정된 사항 (사용자 결정, 그대로 쓴다)
- **결재선 지정 주체 (b)**: 양식별 고정 결재선을 자동 적용하고 기안자는 수정만 한다. 양식의 `default_route_json`에 `["DEPT_MANAGER","HR_ADMIN"]` 형태로 저장. 기안 시 자동 적용 후 기안자가 수정할 수 있게 한다.
- **조직 모델**: 리더 = 부서장, 같은 개념. `departments.manager_user_id`로 표현하고 별도 역할 필드를 늘리지 않는다 (easy-ware 방식). 구성원 = 그 부서에 속한 사용자 (`users.department_id`). 부서·부서장 데이터는 hr_admin이 사용자 관리 화면에서 입력한다 (A2 범위). 코치는 코칭 대상의 결재자로 보지 않는다.
- **양식 3종** (계획 제안 그대로, 시드 기본값): 일반 기안(`general_draft`), 휴가 신청(`leave`), 교육 수강 신청(`training_request`). 세 양식 모두 기본 결재선은 부서장 → hr_admin.
- **상태값**: 새 결재 테이블은 대문자(`IN_PROGRESS` 등, 계획 4.6 초안 그대로).
- **알림**: D1 `notifications` 기록 + Resend 메일 (제목·링크만, 본문 미포함).

## 구현할 것 (A1 범위)
1. **`migrations/0024_lms.sql`이 아니라 `migrations/0024_approval.sql`** (신규) — 4.6의 스키마 초안 그대로: `departments`, `users.department_id` (ALTER TABLE ADD COLUMN), `approval_forms`, `approval_documents`, `approval_routes`, `approval_audit`, `notifications` (easy-ware `notification(user_id, type, ref_id, ref_type, title, body, read_at)` 형태). 외래키는 달지 않는다 (0016·0022 방침). 부분 색인(`idx_appr_route_waiting`, `status = 'APPROVING'`) 포함. 마이그레이션 번호는 0024다 (LMS가 0023을 쓴다).
2. **`seeds/approval_seed_v1.sql`** (신규, 멱등 `INSERT OR IGNORE` + 고정 id) — 양식 3종 + 기본 부서 1개(예: `dept_hr` "인사팀", manager는 hr_admin 사용자 — 시드 실행 시점에 hr.jhkang@gmail.com의 id를 조회해서 넣는 방식이 아니라, 부서 manager를 NULL로 두고 hr_admin이 나중에 지정하게 한다. 부서장 없이 기안하면 거부되는 easy-ware 규칙은 유지하되, 시드 단계에서는 부서만 만들고 manager는 비워둔다).
3. **`src/approval/`** (신규 디렉터리) — 상태머신 함수, 액션 API, 문서함 조회, 조회 권한 검사(`canView`: 기안자이거나 결재선에 있는 사람만), 감사 로그, 알림(D1 + Resend). 액션은 SUBMIT, APPROVE, REJECT, RECALL, REQUEST_RE_APPROVAL(재상신), FORCE_REJECT(hr_admin) 6개. 액션 API는 하나(`/actions`)로 두고 모든 상태 변경이 상태머신을 통과하게 한다. 동시 승인 경합은 `UPDATE ... WHERE status = 'APPROVING'`의 변경 행 수로 판정하고, 문서·결재선·감사 로그 갱신은 D1 `batch()` 한 번으로 묶는다.
4. **`src/approval/routes.ts`** — `GET /api/approval/home`, `GET /api/approval/box?type=`, `GET /api/approval/forms`, `POST /api/approval/documents`, `GET /api/approval/documents/:id`, `PATCH /api/approval/documents/:id` (DRAFT/RECALLED에서만), `POST /api/approval/documents/:id/actions`. 스키마 미적용 시 503 가드 (메일함 방식). `POST /api/approval/documents`는 양식의 `default_route_json`을 읽어 결재선을 자동 생성한다 (DEPT_MANAGER → 기안자의 부서장, HR_ADMIN → hr_admin 역할 사용자. 부서장이 없으면 기안 거부). 기안자는 생성 시 결재선을 수정할 수 있다 (요청 본문에 routes 배열을 주면 그걸 쓴다).
5. **`src/index.ts`** — mount + import만. **편집 직전에 파일을 다시 읽어라.** LMS S1 세션이 같은 파일에 `/api/lms` mount를 넣고 있을 수 있다. 기존 mount 블록을 앵커로 삼아 `/api/approval` mount를 추가하고, LMS mount가 이미 있으면 그대로 두고, 없으면 건드리지 않는다. `scheduled()` 크론은 건드리지 마라 (독촉은 후속 단계).
6. **easy-ware의 빈틈을 옮기지 않는다**: 다음 결재자·완료·반려 알림을 모두 보내고, 재상신 시 첫 결재자를 다시 활성화한다. 상신 후에는 본문·결재선 수정 불가 (고치려면 회수). `hook_status` 컬럼을 두고 완료 후처리는 분리한다 (1단계는 후처리 함수 자리만 만들고 `NONE`으로 둔다 — 수강·휴가 연동은 2단계).

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler d1 execute people-os-db --local --file migrations/0024_approval.sql` 후 시드 실행 (`migrations apply --local`은 0004에서 실패하므로 쓰지 않는다).
- `npx wrangler dev --local` 로 로그인 쿠키를 달고 전체 시나리오: 기안(DRAFT) → 상신(IN_PROGRESS, 첫 결재자 APPROVING) → 승인(다음 결재자 APPROVING) → 최종 승인(COMPLETED + 채번) / 반려(REJECTED) / 회수(RECALLED + 결재선 PENDING 초기화) / 재상신(IN_PROGRESS + 첫 결재자 다시 APPROVING). 권한 밖 사용자(결재선에 없는 사람)의 조회·액션이 차단되는지 확인. 동시 승인(같은 문서를 두 결재자가 동시에 승인 시도) 시 한 건만 성공하는지 확인.
- 검증 스크립트나 하네스는 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- A1 파일만 만든다/고친다: `migrations/0024_approval.sql`, `seeds/approval_seed_v1.sql`, `src/approval/**`, `src/index.ts`(mount + import만). 프런트(`public/approval.js`, `public/approval.css`, `public/index.html`)는 건드리지 마라 (A2 범위).
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, tsc 결과, 로컬 검증 결과(시나리오별 상태 전이·권한 차단·동시 승인)를 적어라.
