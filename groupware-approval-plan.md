# People OS 그룹웨어·결재·LMS 적용 계획

- 작성일: 2026-11-17 (Fable 5.2 자문, 읽기 전용 분석 — 코드 수정·배포·운영 리소스 쓰기 없음)
- 판: **종합판 (2단계)**. 1단계 초안에서 Workflows·Cloudflare OS를 요약문만으로 판단했던 부분(4장)을 원문 확인 결과로 교체했고, 8장 종합 결론을 새로 썼다.
- 근거: `Junhokang452/easy-ware`, `Junhokang452/easy-standards`, `workspace-easyware/{talent-navigator, easy-slides, flowdesk-cloud, ileet}`의 파일을 직접 읽은 내용과 로컬 `files/people-os/` 코드. 2단계에서 추가로 Cloudflare Workflows 공식 문서 6쪽, `cloudflare/workflows-starter`, `cloudflare/cloudflare-os` 저장소를 직접 읽었다 (목록은 4.1, 4.2).
- 참조 저장소 위치: `files/people-os/.ref/workflows-starter`, `files/people-os/.ref/cloudflare-os` (2026-11-17에 `--depth 1`로 받음, 66MB). 계획 근거용이며 배포에 들어가지 않는다 — `wrangler.toml`의 정적 자산 경로는 `./public`, `tsconfig.json`의 `include`는 `src`뿐이다. `.gitignore`에는 `.ref/`가 없으므로 저장소에 올릴 때는 추가가 필요하다.
- 표기: 원문에서 확인하지 못한 것은 **확인 안 됨**으로 적었다. 내가 계산하거나 해석한 값은 **추정**으로 표시했다.

## 핵심 결론

1. **결재는 ② D1 테이블 + API + UI 경량 방식**으로 만든다. 결재 상태의 진실원은 D1이고, 독촉은 기존 크론으로 한다. 원문을 읽은 뒤에도 이 추천은 그대로다. 다만 **근거가 바뀌었다** (아래 2번).
2. **1단계의 "Free 플랜은 대기 인스턴스가 3일 뒤 사라진다"는 전제는 원문으로 뒷받침되지 않는다.** 한도 문서의 해당 행 이름은 "Retention limit for **completed** Workflow instance state"이고, `waitForEvent` 타임아웃은 1초~365일로 지정할 수 있다. 실제 위험은 기본 타임아웃이 24시간이라는 점과, 타임아웃이 나면 인스턴스가 실패한다는 점이다. D1을 택하는 이유는 "3일 소멸"이 아니라 "문서함·검색·감사 로그가 어차피 D1에 있어야 하고, 회수·재상신이 행 갱신으로 끝난다"이다 (4.3~4.5).
3. **Cloudflare OS의 Gatekeeper는 떼어 쓸 수 없다.** 에이전트의 행동을 사용자 한 명이 승인하는 구조이고 사람 간 결재선이 없다. Dynamic Workers가 Workers Paid 전용이라 Free에서 돌릴 수도 없다. 대신 승인 큐의 설계 패턴을 People OS 결재에 반영한다 (4.2의 (6)).
4. **우선순위 1위 기능은 전자결재(결재함)** 이다. 다만 People OS에는 부서·부서장 데이터가 없어서 "조직(부서·부서장) 최소 모델"을 결재와 같은 단계에서 함께 넣어야 한다.
5. **LMS는 새로 설계한다.** Sites 저장소 4곳 어디에도 유튜브 코드가 없었다. 과정·수강 구조는 easy-ware의 `training_*` 테이블과 ileet의 교육 상태 전이를 참고하고, 영상은 유튜브 임베드를 기본으로, 사내 영상만 R2 Range 스트리밍으로 붙인다.

---

## 1. easy-ware 분석 요약

### 1.1 저장소 개요

- 멀티테넌트 그룹웨어 SaaS. 프런트 React 19 + TS + Mantine v9, 백엔드 Spring Boot 3 + JPA + Spring Security, DB는 Supabase(PostgreSQL) + RLS (`README.md`, `CLAUDE.md`).
- 모든 도메인 테이블에 `tenant_id` + `FORCE ROW LEVEL SECURITY`, PK는 UUID(신규는 UUIDv7), 인증은 httpOnly 쿠키 JWT + CSRF Double Submit (`README.md` 보안 원칙).

### 1.2 결재 프로세스 (기안 → 결재선 → 승인/반려 → 완료)

근거: `backend/.../service/approval/ApprovalService.java`, `ApprovalStateMachine.java`, `domain/approval/*.java`, `api/ApprovalController.java`.

| 단계 | 동작 | 근거 |
|---|---|---|
| 기안 | 양식(`approval_form`)을 고르고 제목·본문(HTML, 서버에서 sanitize)·결재선을 한 번에 저장. 상태는 `DRAFT` 또는 `TEMP_SAVED`(임시저장) | `createDraft` |
| 상신 | `SUBMIT` → 문서 `IN_PROGRESS`. 첫 번째 `APPROVER`를 `APPROVING`으로 바꾸고 **그 사람에게만 알림**을 보낸다. 합의자는 순차면 첫 사람만, 병렬이면 전원을 `CONSULT_PENDING`으로 만든다 | `advanceFirstApprover` |
| 결재 | 현재 `APPROVING`인 결재자만 `APPROVE` 가능. 뒤에 `PENDING` 결재자가 없으면 최종 단계로 보고 문서를 `COMPLETED`로 바꾸며 문서번호를 채번한다. 아니면 다음 결재자를 `APPROVING`으로 올린다 | `act`, `isFinalStepForApprover`, `advanceNextApprover` |
| 반려 | `REJECT` → 문서 `REJECTED`, 해당 결재선 행 `REJECTED` + 의견 저장 | `markCurrentRouteRejected` |
| 회수 | 기안자가 `RECALL`/`CANCEL_SUBMIT` → 문서 `RECALLED`, 결재선 전체를 `PENDING`으로 초기화 | `resetRoutes` |
| 후속 연동 | 문서가 `COMPLETED`/`REJECTED`/`RECALLED`가 되면 `ApprovalLifecycleEvent`를 발행한다. 휴가 도메인이 이를 받아 휴가 신청을 `APPROVED`/`REJECTED`로 바꾼다 | `act` 끝부분, `LeaveRequestService.onApprovalCompleted` 등 |

- "시행"에 해당하는 별도 단계는 **확인 안 됨**. 완료 시 문서번호 채번(`EW-연도-문서ID 앞 8자`)과 생명주기 이벤트 발행이 전부다. 코드 주석도 "단순 채번. 운영에서는 양식별/연도별/순번으로 분리"라고 적혀 있다.
- 모든 액션은 `approval_audit`에 전/후 상태, IP, User-Agent와 함께 기록된다 (`audit`).

### 1.3 결재선 지정 방식

- **기안자가 문서마다 직접 지정**한다. 구성원 검색 또는 부서 선택 두 가지 소스가 있다 (`frontend/src/pages/approval/ApprovalInfoModal.tsx`).
- 부서를 지정하면 백엔드가 `department.manager_user_id`(부서장)로 바꿔 넣는다. 부서장이 없으면 기안 자체를 거부한다 (`createDraft`, `20260524000400_org_departments.sql`).
- 역할(`RouteRole`): `DRAFTER`, `APPROVER`(결재), `CONSULTANT`(합의), `CONFIRMER`(확인), `AUDITOR`(감사), `CC_REF`(참조 — 진행 중에도 열람), `VIEWER`(열람 — 완료 후에만 열람, 완료 후 추가 가능).
- 합의 방식은 문서 단위로 `SEQUENTIAL`/`PARALLEL` 선택.
- "나의 결재선" 저장·불러오기가 있다. 결재선 구성을 JSON 문자열로 저장한다 (`ApprovalMyRoute`, `/api/approval/my-routes`).
- 양식별 **자동 결재선(직급·금액 조건 규칙)은 확인 안 됨**. 양식에는 전결·합의·확인·감사 허용 여부 플래그만 있다.
- 부재/위임 설정(기간 + 대결자)은 저장·조회·삭제 API가 있다. 그러나 `ApprovalService` 안에서 부재 설정을 읽어 결재선을 자동으로 바꾸는 코드는 없다. 대결은 현재 결재자가 `DELEGATE` 액션으로 직접 넘기는 방식만 확인했다.

### 1.4 상태 전이 규칙

문서 상태(`approval_document.status`): `DRAFT`, `TEMP_SAVED`, `IN_PROGRESS`, `RECEIVED_WAITING`, `COMPLETED`, `REJECTED`, `RECALLED`.

| 액션 (누가) | 허용 시작 상태 | 결과 상태 |
|---|---|---|
| `SUBMIT` (기안자) | DRAFT, TEMP_SAVED, RECALLED | IN_PROGRESS |
| `CANCEL_SUBMIT`, `RECALL` (기안자) | IN_PROGRESS (+ CANCEL_SUBMIT은 RECEIVED_WAITING) | RECALLED |
| `REQUEST_RE_APPROVAL` (기안자) | RECALLED | IN_PROGRESS |
| `APPROVE` (현재 결재자) | IN_PROGRESS, RECEIVED_WAITING | 최종 단계면 COMPLETED, 아니면 IN_PROGRESS |
| `REJECT`, `PREV_STAGE_REJECT` (현재 결재자) | IN_PROGRESS (+ REJECT는 RECEIVED_WAITING) | REJECTED |
| `FINAL_SHORTCUT` 전결 (현재 결재자) | IN_PROGRESS | COMPLETED (남은 결재자는 `SKIPPED`) |
| `CONSULT`, `CONSULT_OPPOSE` (합의자) | IN_PROGRESS | 문서 상태 변화 없음 (반대해도 문서는 계속 진행) |
| `DELEGATE` 대결, `PRE_APPROVE` 선결, `POST_APPROVE` 후결, `POST_REVIEW` 후열, `CONFIRM`, `AUDIT` | 액션별로 IN_PROGRESS / RECEIVED_WAITING / COMPLETED 조합 | 문서 상태 변화 없음 (결재선 행만 바뀜) |
| `FORCE_REJECT` (테넌트 OWNER/ADMIN) | COMPLETED | REJECTED |
| `DELETE_DOC` (테넌트 OWNER/ADMIN) | COMPLETED, REJECTED | 상태 유지 |

결재선 행 상태(`RouteStatus`): `PENDING`, `APPROVING`, `CONSULT_PENDING`, `APPROVED`, `CONSULTED`, `CONSULT_OPPOSED`, `REJECTED`, `PRE_APPROVED`, `POST_APPROVED`, `DELEGATED`, `POST_REVIEWED`, `CONFIRMED`, `AUDITED`, `SKIPPED`.

옮길 때 그대로 베끼면 안 되는 지점 (코드에서 확인한 빈틈):

- **알림은 첫 결재자에게만 간다.** `notificationService.send` 호출은 `advanceFirstApprover` 한 곳뿐이다. 다음 결재자, 완료·반려 시 기안자에게 가는 알림은 `ApprovalService`에 없다.
- `REQUEST_RE_APPROVAL`은 문서를 `IN_PROGRESS`로 되돌리지만 첫 결재자를 다시 `APPROVING`으로 올리는 처리가 없다 (`act`의 `default` 분기).
- `CANCEL_APPROVE`(결재 취소)와 `PREV_STAGE_REJECT`(전단계 반려)는 이름과 달리 결재선을 되돌리는 처리가 없다. 전단계 반려는 일반 반려와 똑같이 처리된다.
- `RECEIVED_WAITING` 상태로 들어가는 전이는 상태머신에 없다.
- 마이그레이션의 `approval_route` CHECK 제약에는 `CC_REF` 역할과 일부 상태(`CONSULT_OPPOSED`, `PRE_APPROVED` 등)가 없다. 이후 마이그레이션에서 넓혔는지는 **확인 안 됨**.

### 1.5 스키마

`supabase/migrations/20260524000300_approval_domain.sql`의 9개 테이블:

| 테이블 | 역할 | 핵심 컬럼 |
|---|---|---|
| `approval_form_category` | 양식 분류 | code, sort_order |
| `approval_form` | 양식 | code, name, company_box, retention_years, allow_final_shortcut, allow_consultation, allow_confirm, allow_audit, is_active |
| `approval_form_favorite` | 사용자별 자주 쓰는 양식 | user_id, form_id |
| `approval_document` | 결재 문서 | form_id, drafter_id, title, body_html, body_text(검색용), status, is_urgent, is_public, retention_years, doc_box, doc_number, consensus_mode, submitted_at, completed_at, version(낙관적 잠금) |
| `approval_route` | 결재선 | document_id, step_no, role, actor_user_id, actor_dept_id, status, acted_at, comment, delegated_from |
| `approval_attachment` | 첨부 | file_name, mime_type, byte_size, storage_key |
| `approval_related_doc` | 관련 문서 링크 | document_id, related_doc_id |
| `approval_audit` | 액션 감사 로그 | action, before_status, after_status, comment, ip_addr, user_agent |
| `approval_view_log` | 열람 기록 | viewer_user_id, viewed_at |

- 엔티티로만 확인한 추가 테이블: 댓글(`ApprovalComment`), 사용자 설정(`ApprovalUserSettings` — 서명 이미지 URL 등), 부재(`ApprovalAbsence`), 나의 결재선(`ApprovalMyRoute`), 열람 이력(`ApprovalViewHistory`). 이 테이블들의 마이그레이션 파일 위치는 **확인 안 됨**.
- 기본 시드: 분류 8종(general, accounting, support, vacation, recruit, absence, education, attendance), 양식 6종(업무기안, 업무협조, 개인경비 사용내역서, 추가예산신청, 신규거래처등록신청, 사무용품신청).
- 조직: `department(code, name, manager_user_id, parent_id, sort_order, is_active)`.
- 알림: `notification(user_id, type, ref_id, ref_type, title, body, read_at)` + SSE 실시간 푸시 (`NotificationService`, `NotificationSseService`).

### 1.6 API와 화면

- API (`/api/approval`): `home`, `forms`, `box?type=`, `search`, `documents`(POST 기안 / GET 상세 / PATCH draft), `documents/{id}/actions`(모든 액션의 단일 진입점: `{action, comment, delegateeUserId}`), `documents/{id}/comments`, `documents/{id}/viewers`, `documents/{id}/view-history`, `documents/{id}/pdf`, `my-routes`, `settings`, `settings/absences`. 관리자용 `/api/approval/admin`은 분류·양식 CRUD.
- 문서함 종류(`boxDocuments`): 결재 대기(`PENDING_APPROVAL`), 기안 진행(`DRAFTING`), 임시저장(`TEMP_SAVED`), 내가 결재한 문서(`APPROVED_BY_ME`), 참조(`CC_REF`/`CC_ONLY`), 열람(`VIEWER_ONLY`), 수신(`RECEIVED`), 발신 완료(`SENT`).
- 화면 (`frontend/src/pages/approval/`): 결재 홈, 양식 선택 모달, 에디터, 결재선 패널(결재선 / 문서정보 / 변경이력 / 열람이력 탭), 결재선 지정 모달, 문서 상세, 결재선 타임라인, 대결 모달, 문서함, 검색, 환경설정, 양식 관리, 대기 문서 카드, 인쇄.

### 1.7 결재 외 그룹웨어 기능 목록

`README.md`, `frontend/src/layout/LeftNav.tsx`, `frontend/src/App.tsx` 라우트, `supabase/migrations/` 파일명으로 확인.

| 기능 | 내용 |
|---|---|
| 포털 홈 | 첫 화면 + 위젯 11종 (README는 mock이라고 표기) |
| 메일 | 수신자별 배달 모델(INBOX/SENT/DRAFT/TRASH), 임시저장, 휴지통, 태그, 외부 IMAP/SMTP 계정 |
| 캘린더 | 월/주/목록, 참석자·응답, 반복 일정(RRULE), 회의실·자원 예약과 충돌 검증 |
| 게시판 | 좋아요, 즐겨찾기, 말머리, 답글, 운영자, 첨부, 부서 게시판 |
| 휴가 | 신청·이력·팀/부서 현황·관리자, 휴가 종류, 잔여 관리, 연차 촉진. 결재 완료 이벤트와 연동 |
| 근태 | 출퇴근, 근무상태, 주간/월간 집계, 휴일대체, 보상휴가, 교대, 마감 |
| 경비 | 법인카드/개인경비/유류비 청구, 영수증 첨부, 예산 편성·집행 |
| 보고 | 정기/수시 보고서, 회차, 보고자별 제출, 양식 정의 |
| 전자계약 | 템플릿 5종, 서명 발송, 상태머신 (README 기준 Mock Provider) |
| 설문 | 설문 작성·목록·운영자 |
| 메신저 | 채팅, 파일, 리액션 |
| 주소록 | 전체/즐겨찾기/그룹/디렉터리 |
| Works | 업무 앱 빌더, 레코드, 작업·프로젝트(`/tasks`) |
| 기타 | 메모, 알림센터, 통합 검색, 휴지통 |
| 경영관리 포털 | 인사(인사카드·발령), 조직도·직위체계, 증명서, **직원교육(`training_course`/`training_session`/`training_enrollment`)**, 매출·매입·재무·세무, 급여 |
| 관리자 콘솔 | 브랜딩, 앱 메뉴, 메일 도메인, 용량, 업로드 정책, 백업, 관리자 역할, 보안 |

---

## 2. easy-standards 분석 요약

### 2.1 공통 코드 범위

저장소는 monorepo다. 공유 백엔드 lib(`easy-platform-core`, Java), 공통 표준 문서(`easy-standards/00-principles` 등), 프런트 공통 패키지로 구성된다.

| 영역 | 위치 | 상태 |
|---|---|---|
| 인증(JWT, refresh) | `easy-platform-core/.../platform/auth/` | 구현 (Spring) |
| SSO/Identity | `00-principles/12-sso-identity.md`, `V_IDENTITY_001__identity_schema.sql` | 문서 + SQL (Keycloak은 로드맵) |
| 권한(RBAC) | `common/Role.java`, `security/TenantAdminGuard.java`, 프런트 `auth-hooks/roles.ts` | 구현. `permission`/`role_permission` 테이블은 문서에만 있음 |
| 테넌시 | `tenant/`, `security/rls/` | 구현 (Neon DB-per-tenant, Postgres RLS 전용) |
| 감사 | `audit/` (`AuditEvent`, 해시체인), `V_AUDIT_001`, `auth_audit_log` | 구현 (기본 꺼짐) |
| 공통 값셋 | `common/` enum(`Status`, `ApprovalStatus`, `Gender`, `Role`), `15-common-data-model.md` | enum + 문서 |
| 공통코드(코드그룹/코드 테이블) | — | **확인 안 됨** (lib과 문서에서 못 찾음) |
| ID | `UuidV7.java`, `sequence/SequenceGenerator.java`, `V_SEQUENCE_001__document_number_sequence.sql` | 구현 |
| 에러 응답 | `error/` (`ApiError`, `ErrorCode`, `TraceIdFilter`) | 구현 |
| 결재/워크플로 | `ApprovalStatus` enum 하나 | **결재선·워크플로 엔진은 공통 lib에 없음** (easy-ware에만 있음) |
| 알림·파일저장 | 프런트 토스트 컴포넌트만 | 백엔드 공통 패키지 없음 |
| 프런트 공통 | `easy-platform-core/packages/` (tokens, http-client, auth-hooks, query-client, ui-components, i18n-common) | 구현 (React 19 + Mantine v9) |
| 루트 `packages/*` | ui, tokens, http-client, router-guards, i18n-common | 스캐폴드뿐 (`src` 없음) |
| CI 게이트 | `scripts/`, `easy-platform-core/scripts/*.mjs` | 구현 (Spring·Mantine 대상) |

### 2.2 People OS에 개념적으로 재사용할 수 있는 것

Java/Gradle·Postgres RLS·Mantine 코드는 Workers(TS) + D1 + 바닐라 JS에 직접 옮길 수 없다. 규칙·스키마 수준에서 가져올 것은 아래와 같다.

| 가져올 것 | 출처 | People OS 적용 |
|---|---|---|
| 역할 서열 비교(`atLeast`) | `common/Role.java` (OWNER > ADMIN > MANAGER > MEMBER > VIEWER) | 지금은 `hr_admin`/`user` 두 값뿐이다. 결재에 "부서장" 개념이 필요해지면 역할을 늘리지 말고 부서 테이블의 `manager_user_id`로 표현한다 (easy-ware 방식) |
| 격리 규칙: "ID로만 조회 금지, 항상 격리 키와 함께" | `01-identity-and-data.md` §3, `02-security-owasp.md` | 결재 조회는 "기안자이거나 결재선에 있는 사람"만 통과시키는 `canView`를 모든 조회·액션에 건다. 프런트에서 버튼을 숨기는 것으로 권한을 대신하지 않는다 |
| 감사 컬럼 표준 | `09-database.md` §4 (`created_at/by`, `updated_at/by`, `deleted_at/by`) | 새 테이블(결재·LMS·부서)에 같은 이름으로 넣는다. D1에서는 TEXT로 저장 |
| 상태 컬럼 규칙 | `09-database.md` (대문자 snake_case + CHECK) | 결재·수강 상태 컬럼에 CHECK 제약을 건다. 기존 People OS 테이블(소문자 값)과 표기가 달라지는 점은 열린 질문 7 |
| 감사 로그 스키마 | `V_AUDIT_001__audit_event.sql` (actor, action, resource_type, resource_id, ip, user_agent, metadata, prev_hash, hash) | 결재 액션 로그에 같은 컬럼 구성을 쓴다. 해시체인은 1단계에서 생략 가능 |
| 에러 응답 형식 | `error/ApiError.java` (`code, message, messageKey, details, traceId, path, timestamp`) | 새 API의 오류 응답을 `{code, message, traceId}`로 통일. 에러 코드 번호 체계는 lib 자체에 표준과 어긋난 값이 있어 그대로 베끼지 않는다 |
| 원자적 채번 | `V_SEQUENCE_001__document_number_sequence.sql` (`UNIQUE(tenant_id, scope_key)` + upsert) | 결재 문서번호를 `(scope_key)` 단위 upsert로 채번. SQLite도 `INSERT ... ON CONFLICT DO UPDATE`를 지원한다 |
| PK 규칙 | `01-identity-and-data.md` §1 (엔티티 PK는 UUIDv7, 토큰은 랜덤/해시) | 새 테이블 PK를 UUIDv7로 만들면 시간순 정렬이 된다. 기존 테이블은 건드리지 않는다 |
| 공통 값셋 | `ApprovalStatus`(DRAFT/SUBMITTED/APPROVED/REJECTED/CANCELLED) | 단순 승인 건(수강 신청 등)의 상태값으로 쓴다. 다단계 결재 문서는 easy-ware의 상태값을 쓴다 |
| 세션 규칙 | `02-security-owasp.md` §6-A (HttpOnly + Secure + SameSite 쿠키, 로컬스토리지 토큰 금지) | People OS 세션이 이 규칙을 지키는지는 이번 분석에서 **확인 안 됨** — 결재 작업 전에 점검 항목으로 둔다 |
| 디자인 토큰 값 | `packages/tokens/src/foundation.ts`, `semantic.ts` (brand blue `#2169ff`, 상태 톤 6종 등) | 자매 제품과 색을 맞추고 싶을 때만 CSS 변수로 옮긴다 (선택) |

옮기지 않는 것: Spring autoconfig, JPA 감사 엔티티, ThreadLocal 테넌트 컨텍스트, Postgres RLS, Neon 프로비저닝, Flyway 규칙, `@easy/*` React 패키지 코드, 급여·근태 산식 lib.

---

## 3. People OS에 적용할 그룹웨어 기능 후보 (우선순위 순)

People OS의 현재 상태(로컬 코드 확인): 사용자 테이블은 `users(id, email, name, role[hr_admin|user], status, coaching_role[coach|coachee])`. **부서·부서장·조직 테이블이 없다.** 할 일은 `tasks(owner_id)`, 메일은 Resend 발송, 크론은 하루 2회(`0 22 * * *`, `0 18 * * *`) 설정돼 있다.

| 순위 | 기능 | easy-ware의 무엇에서 왔나 | People OS에서의 모습 | 난이도 |
|---|---|---|---|---|
| 1 | **전자결재 (결재함)** | `approval_document`/`approval_route`/`approval_audit`, `ApprovalStateMachine`, `ApprovalService.act`, 문서함 분류 | 기안 → 순차 결재 → 승인/반려/회수. 액션은 6개(SUBMIT, APPROVE, REJECT, RECALL, 재상신, 관리자 강제반려)로 줄인다. 4장 참조 | 중 |
| 1-보조 | **조직 최소 모델 (부서·부서장)** | `department(manager_user_id, parent_id)`, 부서 지정 시 부서장 자동 결재 | `departments` 테이블 + `users.department_id`. 사용자 관리 화면에 부서 지정 추가. 결재선의 "부서장" 자동 해석에 필요 | 하 |
| 2 | **알림센터** | `notification` 테이블, `NotificationService` | D1 `notifications` + 사이드바 배지 + Resend 메일. easy-ware의 SSE 푸시는 생략하고 화면 진입 시 조회. 결재·LMS·할 일이 함께 쓴다 | 하 |
| 3 | **LMS (강의실)** | `training_course`/`training_session`/`training_enrollment` (경영관리 직원교육) | 과정 → 강의(유튜브/R2 영상) → 진도. 5장 참조 | 중 |
| 4 | **휴가 신청** | `LeaveRequestService` + `ApprovalLifecycleEvent` 연동 | 결재 양식 하나("휴가 신청")로 시작한다. 결재 완료 시 휴가 레코드를 확정하는 후처리 훅만 둔다. 잔여일수·연차 촉진은 뒤로 미룬다 | 중 |
| 5 | **캘린더 (일정)** | `calendar_event`, 참석자, RRULE, 자원 예약 | 코칭 세션·교육 일정·휴가를 한 달력에 보여주는 읽기 중심 화면부터. 반복 일정과 자원 예약은 제외 | 중 |
| 6 | **공지 게시판** | `board_post`(is_notice), 게시판 기능 | hr_admin이 쓰는 공지 한 종류. HR 규정 검색(RAG)에 공지를 색인하면 People OS 강점과 이어진다 | 하 |
| 7 | **설문** | `survey` 도메인 | 코칭 만족도·교육 평가 설문. LMS 수료 조건과 연결 가능 | 중 |
| 보류 | 근태, 경비, 급여, 전자계약, 메신저, Works 앱 빌더, 매출·매입·재무 | 각 도메인 | HR·코칭 인텔리전스라는 제품 성격과 거리가 멀고 규모가 크다. 가져오지 않는다 | — |

1위 이유: 사용자가 명시적으로 원한 기능이고, 휴가·교육 신청·코칭 보고 승인 등 뒤따르는 기능이 모두 "누군가의 승인"을 필요로 해서 결재가 공통 기반이 된다.

---

## 4. 결재 구현 방식 비교 (2단계: 원문 근거로 다시 씀)

### 4.1 Cloudflare Workflows — 원문 확인 결과

읽은 원문 (2026-11-17):

| 약칭 | 원문 |
|---|---|
| [개요] | https://developers.cloudflare.com/workflows/ |
| [예제] | https://developers.cloudflare.com/workflows/examples/wait-for-event/ |
| [이벤트] | https://developers.cloudflare.com/workflows/build/events-and-parameters/ |
| [API] | https://developers.cloudflare.com/workflows/build/workers-api/ |
| [요금] | https://developers.cloudflare.com/workflows/reference/pricing/ |
| [한도] | https://developers.cloudflare.com/workflows/reference/limits/ |
| [스타터] | `.ref/workflows-starter/src/index.ts`, `wrangler.jsonc`, `README.md` |

문서 쪽은 페이지를 요약 도구로 읽어 짧은 문장 단위로 인용을 받았다. 아래 따옴표 안은 그렇게 받은 원문 문장이다. 스타터 저장소는 파일을 직접 읽었다.

**(1) `waitForEvent`의 동작**

| 항목 | 원문 내용 | 출처 |
|---|---|---|
| 호출 형태 | `await step.waitForEvent('request-approval', { type: 'approval', timeout: '1 minute' })`. 받은 이벤트의 `payload`를 읽어 분기한다 | [스타터] `src/index.ts:42-45`, [예제] |
| 기본 타임아웃 | "The default timeout for a `waitForEvent` call is 24 hours." | [이벤트], [API] |
| 타임아웃 범위 | "You can specify a timeout between 1 second and up to 365 days." | [이벤트] |
| 타임아웃 시 | "When `waitForEvent` times out, the Workflow will throw an error and the instance will fail." 계속 진행하려면 `try...catch`로 감싼다 | [이벤트] |
| 이벤트 보내기 (Worker) | `let instance = await env.MY_WORKFLOW.get(instanceId); await instance.sendEvent({ type, payload })` | [이벤트] |
| 이벤트 보내기 (REST) | `POST /accounts/{account_id}/workflows/{workflow_name}/instances/{instance_id}/events/{eventName}` | [스타터] `src/index.ts:41` 주석 |
| 타입 일치 | `waitForEvent`와 `sendEvent`의 `type`이 같아야 한다. 영문·숫자·`-`·`_`만 허용하고 `.`이 들어가면 `workflow.invalid_event_type` 오류 | [이벤트] |
| 먼저 도착한 이벤트 | "The event will be buffered and delivered when the Workflow reaches the `waitForEvent` step with the matching `type`." 단, 인스턴스는 이미 만들어져 있어야 한다 | [이벤트] |
| `sendEvent` 실패 조건 | "throws an exception if the Workflow is not running or is an errored state" | [API] |
| 이벤트 payload 크기 | 1 MiB (Free·Paid 동일) | [한도] |
| 인스턴스 상태값 | queued, running, paused, errored, terminated, complete, waiting, waitingForPause, unknown | [API] |
| 인스턴스 제어 | pause, resume, terminate, restart("from the beginning, or from a specific step") | [API] |
| 인스턴스 ID | `create({ id, params })`로 직접 지정 가능. "Must be unique within the Workflow." | [API], [스타터] `src/index.ts:99-102` |

`waitForEvent` 자체의 재시도 설정은 원문에서 찾지 못했다 (**확인 안 됨**). 재시도 옵션(`retries: { limit, delay, backoff }`, `timeout`)은 `step.do`에 붙는다 ([스타터] `src/index.ts:54-64`). 승인 대기에서 "재시도"에 해당하는 것은 `try...catch`로 타임아웃을 잡고 반복문으로 다시 기다리는 방식이다.

**(2) 대기 중 인스턴스의 보관 기간 — 1단계 전제 정정**

- [한도] 표의 행 이름은 "Retention limit for **completed** Workflow instance state"이고 값은 Free 3일, Paid 기본 7일(최대 30일 설정)이다. 각주: "On the Workers Free plan, Workflow instance state and logs are retained for 3 days."
- [요금]: "By default, instance state is retained for 3 days on the Free plan and 7 days on the Paid plan." 보관 기간을 줄이는 옵션 설명에는 "errored or completed Workflows"라고 적혀 있다.
- `step.sleep` 최대 365일, `waitForEvent` 타임아웃 최대 365일 ([한도], [이벤트]). [개요]는 상태를 "minutes, hours, or weeks" 유지한다고 소개한다.
- 판단: 3일은 **끝난(완료·오류) 인스턴스의 상태와 로그를 보관하는 기간**으로 읽힌다. 대기 중인 인스턴스가 3일 뒤 사라진다는 문장은 원문 어디에도 없다. 반대로 "대기 중 인스턴스는 보관 기간과 무관하다"고 명시한 문장도 없다 (**확인 안 됨**). Free에서 3일 넘게 대기시킨 인스턴스가 살아남는지는 실측으로만 확정된다 (열린 질문 13).
- 결재에 실제로 걸리는 것 두 가지: ① 타임아웃을 지정하지 않으면 24시간 뒤 인스턴스가 실패한다. ② 완료된 결재의 인스턴스 상태는 Free에서 3일 뒤 지워지므로, 결재 이력을 Workflows에서 읽어올 수 없다. 이력은 처음부터 D1에 써야 한다.

**(3) 스텝·CPU 한도가 결재 흐름에 미치는 영향**

| 한도 | Free | Paid | 결재에 미치는 영향 |
|---|---|---|---|
| 스텝 수 | 하루 3,000 | 월 500,000 포함 | 재시도와 롤백 핸들러는 세지 않는다 ([요금]). `step.sleep`은 "최대 스텝 한도"에 세지 않는다 ([API]). **`waitForEvent`가 스텝으로 세어지는지는 확인 안 됨.** 1단계의 "하루 약 300건" 추정은 근거가 없어 철회한다. 하루 한도에 닿았을 때의 동작도 **확인 안 됨** |
| 스텝당 CPU | 10ms | 30초 (최대 5분) | D1 쓰기와 Resend 호출은 I/O 대기라 CPU에 들지 않는다. "API 응답 대기, `step.sleep`, 그 밖의 유휴 상태는 CPU 시간이 들지 않는다" ([요금]). 스텝 안에서 무거운 계산(HTML 변환, PDF)을 하면 10ms를 넘긴다 |
| 인스턴스당 스텝 | 1,024 | 10,000 | 다단계 결재 한 건은 문제없다 |
| 동시 인스턴스 | 계정당 100 | 50,000 | "Instances in the `waiting` or `paused` state do not count towards the concurrency limits." 단, 한도에 찬 상태에서 깨어나면 대기열에 들어간다 |
| 실행 횟수 | 하루 100,000 (Workers 요청과 합산) | 무제한 | 영향 없음 |
| 저장소 | 1 GB-월 | 1 GB-월 포함 | "running, errored, sleeping, and completed" 전부 합산. Free에서 한도를 넘으면 상태 저장 시 오류 |
| 인스턴스당 상태 | 100 MB | 1 GB | 스텝 결과에 첨부 파일을 담지 않으면 영향 없음 |
| Worker 서브리퀘스트 | 요청당 50 | 10,000 | 결재 한 스텝에서 알림 여러 건을 보낼 때만 주의 |

- 요금 적용: "Billing for Workflows steps and storage will apply starting August 10th, 2026." Free·Paid 모두에서 Workflows를 쓸 수 있다 ([개요], [요금]).

**(4) People OS에 붙이는 방법**

People OS의 Worker는 `src/index.ts` 하나이고 `export default { fetch, scheduled, queue }`와 `export { AgentSession }`(Durable Object)를 내보낸다 (`src/index.ts:36`, `:1875-1893`). Workflows는 별도 Worker 없이 여기에 붙는다.

1. 클래스: `export class ApprovalWorkflow extends WorkflowEntrypoint<Env, Params>`를 같은 파일(또는 `src/approval/workflow.ts`에서 재수출)에 둔다. `this.env`로 기존 바인딩(`DB`, `PIPELINE` 등)을 그대로 쓴다 ([스타터] `src/index.ts:16-19`).
2. 바인딩: 스타터의 `wrangler.jsonc:14-23`에 대응하는 설정을 `wrangler.toml`에 추가한다 — `[[workflows]]`에 `name`, `binding`, `class_name` 세 값. TOML 표기 자체는 스타터에 없으므로(스타터는 jsonc) 적용할 때 Wrangler 문서로 확인한다.
3. 호출 경로: 상신 API가 `env.APPROVAL_WF.create({ id: <문서 ID>, params })`를 부르고, 승인·반려 API가 `env.APPROVAL_WF.get(<문서 ID>)` → `sendEvent({ type: 'decision', payload })`를 부른다. 인스턴스 ID를 문서 ID로 쓰면 D1에 인스턴스 ID 컬럼을 따로 둘 필요가 없다.
4. 회수·재상신: 실행 중인 인스턴스의 결재선을 바꾸는 API는 없다. `terminate()` 후 새 인스턴스를 만들어야 한다. 인스턴스 ID가 Workflow 안에서 유일해야 하므로 재상신 때는 `문서ID-회차` 같은 ID가 필요하다. 종료된 인스턴스의 ID를 다시 쓸 수 있는지는 **확인 안 됨**.
5. 로컬 개발(`wrangler dev --local`)에서 Workflows가 동작하는지는 이번에 읽은 원문 범위에서 **확인 안 됨**.

### 4.2 Cloudflare OS — 저장소 확인 결과

읽은 파일 (모두 `.ref/cloudflare-os/` 아래): `README.md`, `AGENTS.md`, `packages/workshop-backend/AGENTS.md`, `packages/workshop-backend/wrangler.jsonc`, `packages/workshop-backend/src/auto-approval.ts`(전체), `packages/workshop-backend/src/overseer.ts`(5425-5444행과 메서드 위치), `packages/workshop-backend/src/storage-schema/overseer-storage.ts`(액션 관련 행), `packages/workshop-shared/src/api.ts`(3168-3255, 3560-3645행), `packages/workshop-shared/src/gatekeeper.ts`(1504-1549행), `packages/gatekeeper-kit/README.md`(전체), `packages/gatekeeper-kit/AGENTS.md`, `packages/gatekeeper-kit/USAGE.md`(554-639행), `packages/gatekeeper-kit/src/actions.ts`(160-264행), `packages/gatekeeper-kit/src/action-journal.ts`(37-147행), `docs/notifications.md`(200-233행). `overseer.ts`는 14,925행이라 승인 관련 부분만 읽었다.

**(1) 정체**

- "an 'operating system' for AI productivity originally developed for use inside Cloudflare". 에이전트 채팅, 샌드박스 앱("gadget"), 보안 틀("Gatekeepers") 세 가지를 제공한다 (`README.md:3-16`).
- 성숙도: "As of the August 2026 release, Cloudflare OS v2 is very capable, but still has many rough edges... consider this an 'early access' release." (`README.md:48`). 외부 기여는 받지 않는다 (`README.md:234`).
- Gatekeeper는 외부 서비스마다 하나씩 있는 별도 Worker다. "each Gatekeeper is implemented as a separate Worker" (`README.md:79`). 저장소에 GitHub, Google, Slack, Notion 등 20여 종이 들어 있다 (`packages/gatekeeper-*`).

**(2) deferred approval(승인 대기 큐)의 동작**

| 단계 | 동작 | 근거 |
|---|---|---|
| 취지 | 기존 human-in-the-loop는 에이전트가 승인을 기다리며 멈춘다. Gatekeeper는 결과를 **시뮬레이션**해서 에이전트를 계속 진행시키고, 사용자는 나중에 한꺼번에 또는 하나씩 승인·거부한다 | `README.md:75-77` |
| 제출 | Gatekeeper가 `ApprovalQueue.submitAction(action, description)`을 부른다. 즉시 반환하고 실제 실행은 나중이다. "the user might not approve actions until hours or days later, but this shouldn't cause any problems" | `workshop-shared/src/gatekeeper.ts:1510-1533` |
| 대기 방식 | 액션 종류마다 `delivery: "continue-with-simulation" \| "await-decision"`을 선언한다. 앞의 것은 대기 중인 효과를 이후 읽기에 투영하고, 뒤의 것은 에이전트가 결정을 기다린다 | `gatekeeper-kit/src/actions.ts:178-179`, `USAGE.md:637-639` |
| 큐 저장 | 워크스페이스마다 하나인 Durable Object(`OverseerDurableObject`, SQLite 기반)의 `actions` 컬렉션. 상태는 `"pending" \| "approved" \| "rejected"` | `workshop-backend/wrangler.jsonc:54-61`, `overseer-storage.ts:490-521, 1588`, `api.ts:3174` |
| 큐 레코드 | `id`(워크스페이스 안 순번), `gatekeeperId`, `chatId`, `resourceTitle`, `resourceUrl`, `createdAt`, `appliedAt`, `state`, `description`, `resolvedBy`(누가 결정했나), `autoApproved` | `api.ts:3180-3226` |
| 색인 | `byLastChanged`(마지막 상태 변경 시각 — 재접속 시 이어받기용), `pendingByGatekeeper`(대기 건만 담는 희소 색인), `byHistoryFilter`(목록 필터별) | `overseer-storage.ts:1595-1611` |
| 조회 | `listActions({ beforeId, filter })` — 최신순 페이지, `filter: "pending"`은 대기 건만. 변경은 `subscribeToActions()`로 구독 | `api.ts:3560-3571` |
| 결정 | `approveAction(id)` — "The action will be performed on approval." `rejectAction(id)` — Gatekeeper에 "앞으로 승인되지 않는다"고 알린다 | `api.ts:3573-3584` |
| 중복 결정 방지 | `claimDecision(id)`가 상태가 `pending`이 아니거나 이미 결정 중이면 `Action is not pending` 오류를 던진다. 승인으로 넘어가는 경로는 한 곳(`applyPendingAction`)뿐이고 `resolvedBy`·`autoApproved`를 필수 인자로 받는다 | `overseer.ts:5429-5444` |
| 자동 승인 | 사용자가 "이 Gatekeeper의 이 종류 액션은 자동 승인" 규칙을 켠다. 액션 작성자가 `autoApprovable: true`로 표시한 것만 해당한다. 순번대로 적용하다가 수동 승인이 필요한 건을 만나면 **멈춘다**(건너뛰지 않음). 자동 승인 건은 규칙을 켠 사용자 이름으로 기록된다. 자동 **거부**는 없다 | `auto-approval.ts:30-38, 87-131`, `api.ts:3214-3218, 3619-3630` |
| 승인 문구 | "The approver vouches for the text they read". 워크스페이스에서 온 내용은 전부 필드에 담아 글자 그대로 보여주고 Markdown으로 렌더링하지 않는다. 96 KiB를 넘겨 일부가 잘리면 승인자에게 "일부가 표시되지 않았다"고 알린다 | `USAGE.md:593-605` |
| 적용 실패 | 세 갈래: 일반 오류(다시 pending — 재시도 안전할 때만), `ActionApplyError`(효과 없음이 확실한 종료), `ActionOutcomeUnknownError`(결과 불명 — 재실행하지 않고, 사용자가 거부할 때까지 자리를 차지한다) | `USAGE.md:569-576` |
| 권한 변경 차단 | "fence": 승인 당시와 다른 계정 권한으로 바뀌었으면 적용을 거부한다. 기본값 없이 반드시 선택하게 했다 | `actions.ts:231-254` |
| Gatekeeper 쪽 저널 | 상태 `staged → pending → claimed → applied / failed`. 미결 한도 기본 50건(`maxPending`) | `action-journal.ts:40, 99, 123` |
| 로그 성격 | "action log is append-only" | `overseer-storage.ts:530` 부근 주석 |

**(3) 승인자 알림과 만료**

- 알림: 사용자 Durable Object → 중앙 알림 서비스 → APNs / Web Push. 열려 있는 탭에 먼저 알리고 3초 안에 확인이 없으면 모든 등록 기기에 푸시한다. 푸시에는 이벤트 ID, 채팅 제목, 딥링크 경로만 실리고 "Permission details, chat content, gatekeeper grants, and provider credentials do not" (`docs/notifications.md:204-212`). 사람이 시작하지 않은 실행(예약 작업, 하위 에이전트)은 "notify only when they need the user's permission" (`docs/notifications.md:223-225`). 메일 알림은 읽은 범위에서 **확인 안 됨**.
- 만료: 대기 중인 액션이 시간이 지나 자동으로 만료·거부되는 코드는 읽은 범위에서 찾지 못했다 (**확인 안 됨**). 확인한 것은 반대 방향의 규칙이다 — 미결 한도 50건, 결과 불명 액션은 "holds a slot until the user rejects it", 자동 거부 없음. 적용 완료 기록의 보관·폐기는 Gatekeeper가 정한다 (`USAGE.md:564-567`). 알림 자체에는 수명이 있어 "Expired alerts are logged and discarded" (`docs/notifications.md:221`).

**(4) Dynamic Worker 요구사항**

- 저장소: "Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet, and Gatekeepers also install facets into each workspace" (`README.md:116`). 백엔드 설정에 `worker_loaders` 바인딩(`LOADER`), 브라우저 렌더링 바인딩, KV 2개, R2 1개, SQLite Durable Object 6종이 있다 (`workshop-backend/wrangler.jsonc`).
- 요금제: 저장소 안에는 Free/Paid 요구를 적은 문장이 없다 (전체 검색에서 못 찾음). Cloudflare 문서에는 "Dynamic Workers are currently only available on the Workers Paid plan."이라고 적혀 있다 (https://developers.cloudflare.com/dynamic-workers/pricing/). 월 1,000개까지 포함, 초과분은 Dynamic Worker 하나당 하루 $0.002.
- 결론: Cloudflare OS 전체는 Free 플랜인 People OS에 올릴 수 없다. Workers Paid의 정확한 월 요금은 이번에 읽은 원문에 없다 (1단계의 "$5/월"은 의뢰서 요약에서 온 값).

**(5) 결재만 떼어 쓸 수 있는 최소 단위**

- 가장 작은 조각은 `packages/gatekeeper-kit`의 `./actions`와 `./action-description`이다. "independent leaf modules exposed through package subpaths. Import them à la carte" (`gatekeeper-kit/README.md:13-14`).
- 그대로 가져다 쓸 수 없는 이유 네 가지:
  1. 키트가 맡는 것은 Gatekeeper 쪽 절반(제출·저널·적용)뿐이다. 승인 큐 본체(목록, 승인, 거부, 알림)는 14,925행짜리 커널 `overseer.ts` 안에 있고, 저장소는 이 커널을 가장 엄격하게 관리하는 부분으로 다룬다.
  2. 저장소가 D1이 아니라 Durable Object의 KV 저장소(`ctx.storage.kv`)이고, 호출은 Cap'n Web RPC 스텁(`RpcStub<ApprovalQueue>`)을 전제한다 (`actions.ts:26`).
  3. 패키지 이름이 `@gadgets/gatekeeper-kit`인 워크스페이스 내부 패키지다. npm 배포 여부는 **확인 안 됨**.
  4. 모델이 다르다. 여기서 승인은 "에이전트가 하려는 행동 1건을 워크스페이스 사용자 1명이 승인"하는 것이다. 결재선(여러 사람이 순서대로), 합의, 회수, 재상신에 해당하는 개념이 없다. `resolvedBy`는 한 명이다.
- 판단: 코드를 떼어 쓰지 않고 **설계만 참고**한다.

**(6) People OS에 반영할 패턴**

| 가져올 패턴 | Cloudflare OS 근거 | People OS 결재에 적용 |
|---|---|---|
| 대기 건만 담는 희소 색인 | `pendingByGatekeeper` | 결재 대기함 조회용 부분 색인: `CREATE INDEX ... ON approval_routes(actor_user_id) WHERE status = 'APPROVING'` |
| 마지막 변경 시각 색인 | `byLastChanged` | `approval_documents.updated_at` 색인으로 "지난 접속 이후 바뀐 문서"와 배지 갱신을 싸게 조회 |
| 승인 전환 경로를 한 곳으로 | `applyPendingAction`이 유일한 관문, 결정자 인자 필수 | 상태 변경은 `/actions` 하나, 감사 로그 기록 없이 상태가 바뀌는 경로를 만들지 않는다 (1단계 원칙과 같음 — 독립된 근거가 하나 더 생김) |
| 승인자가 본 것과 실행되는 것이 같아야 한다 | `buildDescription`, `descriptionIsComplete` | 상신 후에는 본문을 수정할 수 없게 한다(수정하려면 회수). 사용자 입력은 HTML로 렌더링하지 않고 글자 그대로 보여준다. 첨부가 있으면 파일명·크기·해시를 결재 화면에 표시 |
| 적용 실패 세 갈래 | `ActionApplyError`, `ActionOutcomeUnknownError` | 결재 완료와 완료 후처리(수강 승인, 휴가 확정)를 분리한다. 문서에 `hook_status`(`NONE`/`PENDING`/`DONE`/`FAILED`)를 두고, 후처리 실패가 결재 완료를 되돌리지 않게 한다. 후처리는 문서 ID를 멱등 키로 쓴다 |
| 권한 변경 차단(fence) | `FencePolicy` | 결재선의 결재자는 상신 시점에 사용자 ID로 확정해 저장한다(부서장이 바뀌어도 진행 중 문서는 그대로). 결재자가 비활성화된 경우의 처리는 열린 질문 15 |
| 자동 승인은 규칙을 켠 사람 이름으로 | `AutoApproveTagRecord.enabledBy`, `autoApproved` | 3단계의 전결·위임을 만들 때 "누구의 권한으로 자동 처리됐는지"를 결재선 행에 남긴다 |
| 자동 거부 없음 | "there is no automatic rejection" | 장기 미결 문서를 자동 반려하지 않는 것을 기본값으로 제안한다 (열린 질문 9) |
| 알림에 내용을 싣지 않는다 | `docs/notifications.md:204-210` | 결재 요청 메일에는 제목과 링크만 넣고 본문은 넣지 않는다 (열린 질문 8) |

Cloudflare OS의 본래 용도인 "AI 에이전트의 행동을 사람이 나중에 승인"은 People OS의 다른 기능에 맞는다. People OS의 에이전트(`AgentSession`)가 메일 발송이나 할 일 생성 같은 행동을 하게 될 때, 그 행동을 결재함의 별도 탭("에이전트 승인")으로 올리는 구조다. 3단계 후보로 둔다.

### 4.3 세 가지 방식 (원문 근거로 재평가)

| | ① Workflows `waitForEvent` | ② D1 테이블 + API + UI | ③ Cloudflare OS Gatekeeper |
|---|---|---|---|
| 방식 | 문서 1건 = 워크플로 인스턴스 1개. 결재자마다 `step.waitForEvent()`로 멈추고, 승인 API가 이벤트를 보내 깨운다 | 문서·결재선·감사 로그를 D1에 두고, 액션 API가 상태머신을 검증한 뒤 행을 갱신한다 (easy-ware와 같은 구조) | 에이전트의 부작용 있는 행동을 큐에 쌓아 나중에 승인하는 "deferred approval" |
| 상태의 진실원 | 워크플로 인스턴스 (문서함 조회용으로 D1에도 써야 함 → 이중 관리) | D1 한 곳 | 워크스페이스 Durable Object의 `actions` 컬렉션 |
| 장점 | 공식 Human-in-the-Loop 패턴([개요]가 용도로 명시). 타임아웃을 365일까지 줄 수 있고, 대기 중에는 CPU 시간이 들지 않으며 동시 실행 한도에도 세지 않는다. 문서별 기한·독촉·에스컬레이션을 코드 흐름으로 쓸 수 있다. 같은 Worker에 클래스와 바인딩만 추가하면 된다 | 기존 스택(D1 + Hono 라우트)만으로 된다. 대기 기간 제한이 없다. 회수·재상신·전결 같은 "되돌리기"가 행 갱신으로 끝난다. 문서함·검색·통계가 SQL 한 번이다. easy-ware 설계를 거의 그대로 옮길 수 있다 | 승인 큐 설계가 실전에서 다듬어져 있다(중복 결정 방지, 실패 세 갈래, 승인 문구 규칙, 자동 승인 귀속) |
| 단점 | 완료된 인스턴스 상태는 Free에서 3일 뒤 지워져 이력 조회에 쓸 수 없다 → 문서함·감사 로그용 D1 테이블이 어차피 필요하고 상태가 두 군데가 된다. 실행 중인 인스턴스의 결재선을 바꿀 수 없어 회수·재상신마다 종료 후 새 인스턴스가 필요하다. `sendEvent`는 인스턴스가 실행 중이 아니면 예외를 던지므로 D1과 어긋난 경우의 복구 코드가 필요하다. 타임아웃을 빠뜨리면 24시간 뒤 실패한다 | 독촉·기한 초과 처리를 직접 만들어야 한다(크론, 하루 2회 단위). 동시 승인 경합을 직접 막아야 한다 | Dynamic Workers가 Workers Paid 전용이라 Free에서 못 돌린다. 사람 간 결재선(다단계·합의·회수) 모델이 아니다. 승인 큐 본체가 커널(14,925행) 안에 있어 떼어낼 수 없다. v2는 "early access" |
| 비용 (Free 한도) | 하루 3,000스텝, 스텝당 CPU 10ms, 저장소 1 GB-월. 결재 1건이 몇 스텝인지는 `waitForEvent`의 스텝 계산 여부가 **확인 안 됨**이라 산정하지 않는다 | D1·Workers 기존 한도 안. 결재 1건당 D1 쓰기 몇 행 수준 | Workers Paid 필요 |
| 장기 대기 리스크 | 대기 중 인스턴스가 Free의 3일 보관 기간에 영향받는지 문서에 명시가 없다 (**확인 안 됨**, 4.1의 (2)). 명시된 위험은 기본 24시간 타임아웃 | 해당 없음 | 대기 액션의 자동 만료 코드는 읽은 범위에서 못 찾음. 미결 한도 50건 |

### 4.4 Workflows를 쓸 경우의 형태 (참고)

원문 기준으로 ①을 안전하게 쓰는 형태는 한 가지다. **D1이 진실원이고 Workflow는 "문서별 타이머"만 맡는다.**

```ts
// 결재자 한 명분의 대기. 승인·반려 판정은 하지 않는다 (판정은 D1 액션 API가 이미 끝냈다).
for (let round = 0; round < MAX_REMINDERS; round++) {
  try {
    await step.waitForEvent(`wait-${stepNo}-${round}`, { type: 'decision', timeout: '3 days' });
    break;                                   // 결정이 났다 → 다음 결재자 또는 종료
  } catch {
    await step.do(`remind-${stepNo}-${round}`, async () => { /* D1에서 아직 APPROVING인지 확인 후 독촉 메일 */ });
  }
}
```

- 승인 API는 D1을 먼저 갱신하고, 그다음 `sendEvent`를 보낸다. `sendEvent`가 예외를 던져도 결재는 유효하다(인스턴스가 없으면 독촉이 안 갈 뿐이다).
- 인스턴스가 사라지거나 실패해도 결재 데이터는 영향이 없다. 이 성질 때문에 "대기 인스턴스가 3일 넘게 사는가"가 확인되지 않은 상태에서도 도입할 수 있다.
- 이 형태에서 Workflow가 주는 것은 "문서마다 다른 기한과 독촉 간격"이다. 하루 2회 크론으로 충분하면 필요 없다.

### 4.5 최종 추천안

**② D1 테이블 + API + UI (독촉은 기존 크론).** 하나만 고른다면 이것이다.

근거 (원문 확인 후):

1. **문서함·검색·감사 로그는 D1에 있어야 한다.** Workflows는 완료 인스턴스의 상태를 Free 3일, Paid 최대 30일만 보관한다 ([한도]). 결재 이력의 저장소가 될 수 없으므로 ①을 택해도 ②의 테이블을 전부 만들어야 한다.
2. **회수·재상신·결재선 수정이 ②에서는 행 갱신이고 ①에서는 인스턴스 종료 후 재생성이다.** easy-ware의 상태 전이표(1.4)에서 문서를 되돌리는 액션이 4개(RECALL, CANCEL_SUBMIT, REQUEST_RE_APPROVAL, FORCE_REJECT)다.
3. **Cloudflare OS도 승인 큐를 실행 엔진이 아니라 저장된 레코드로 만들었다.** 대기 액션은 Durable Object의 `actions` 컬렉션에 `pending` 상태로 저장되고 승인 API가 상태를 바꾼다 (4.2의 (2)). Workflows를 쓰지 않았다. Cloudflare의 Workers 팀이 만든 승인 대기 큐가 ②와 같은 구조라는 점이 독립된 근거다.
4. **확인 안 된 항목이 ①에 몰려 있다.** 대기 인스턴스의 보관 기간, `waitForEvent`의 스텝 계산, 하루 스텝 한도 도달 시 동작, 종료된 인스턴스 ID 재사용, 로컬 개발 지원. ②는 이미 쓰고 있는 D1·크론·Resend만 쓴다.

조건부로 달라지는 경우:

| 조건 | 달라지는 것 |
|---|---|
| 독촉 주기가 하루 2회보다 촘촘해야 하거나, 양식마다 기한·에스컬레이션 단계가 달라야 한다 | 4.4 형태로 Workflows를 **추가**한다 (②를 대체하지 않음). 그 전에 열린 질문 13의 실측을 한다 |
| 실측에서 Free의 대기 인스턴스가 3일 뒤 사라지는 것으로 확인된다 | Workflows를 쓰더라도 타임아웃을 2일 이하로 끊고 크론이 인스턴스를 다시 띄운다. 이 경우 크론만 쓰는 것과 차이가 거의 없으므로 도입하지 않는다 |
| People OS의 AI 에이전트가 외부 행동(메일 발송 등)을 하게 된다 | 4.2의 (6)에 적은 Cloudflare OS 패턴으로 "에이전트 승인" 큐를 D1에 추가한다. Cloudflare OS 코드는 쓰지 않는다 |
| Workers Paid로 올린다 | 추천은 그대로 ②다. Paid는 Workflows의 스텝·CPU 한도를 풀어줄 뿐 위 1~3번 근거를 바꾸지 않는다 |

1단계와 달라진 점: 추천안은 같고, "3일 소멸" 근거를 뺐다. Workflows는 1단계에서 "48시간 타임아웃으로 짧게 끊어 쓴다"였으나 원문상 긴 타임아웃(최대 365일)이 허용되므로 4.4처럼 "3일 대기 + 독촉 반복" 형태로 고쳤다. ③은 "Paid가 필요하고 크다"에서 "모델이 다르고 떼어낼 수 없다, 설계 패턴만 가져온다"로 구체화했다.

### 4.6 ② 방식 설계 초안

D1 스키마 초안 (easy-ware 9개 테이블을 5개로 축소, `tenant_id` 제외):

```sql
-- 조직 (easy-ware department)
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  manager_user_id TEXT REFERENCES users(id),
  parent_id TEXT REFERENCES departments(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- users에 department_id TEXT 컬럼 추가

-- 양식 (easy-ware approval_form, 분류는 컬럼 하나로)
CREATE TABLE approval_forms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,            -- 'general_draft', 'leave', 'training_request'
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  body_template TEXT,                    -- 기본 본문
  default_route_json TEXT,               -- 기본 결재선 (예: ["DEPT_MANAGER","HR_ADMIN"])
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 문서 (easy-ware approval_document)
CREATE TABLE approval_documents (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES approval_forms(id),
  drafter_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','COMPLETED','REJECTED','RECALLED')),
  doc_number TEXT,
  ref_type TEXT,                         -- 연동 대상 (예: 'lms_enrollment', 'leave')
  ref_id TEXT,
  hook_status TEXT NOT NULL DEFAULT 'NONE'  -- 완료 후처리 상태 (4.2 (6): 결재 완료와 후처리 분리)
    CHECK (hook_status IN ('NONE','PENDING','DONE','FAILED')),
  is_urgent INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,    -- 낙관적 잠금
  submitted_at TEXT, completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_appr_doc_drafter ON approval_documents(drafter_id, created_at);
CREATE INDEX idx_appr_doc_status ON approval_documents(status, created_at);

-- 결재선 (easy-ware approval_route)
CREATE TABLE approval_routes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES approval_documents(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('APPROVER','CC_REF')),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_dept_id TEXT,                    -- 부서장 자동 해석으로 들어온 경우
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVING','APPROVED','REJECTED','SKIPPED')),
  acted_at TEXT,
  comment TEXT,
  reminded_at TEXT,                      -- 크론 독촉 중복 방지
  UNIQUE (document_id, step_no, role, actor_user_id)
);
CREATE INDEX idx_appr_route_actor ON approval_routes(actor_user_id, status);
-- 결재 대기함 전용 부분 색인 (4.2 (6): 대기 건만 담는 희소 색인)
CREATE INDEX idx_appr_route_waiting ON approval_routes(actor_user_id) WHERE status = 'APPROVING';

-- 감사 로그 (easy-ware approval_audit + easy-standards audit_event 컬럼)
CREATE TABLE approval_audit (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_status TEXT, after_status TEXT,
  comment TEXT, ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

상태 전이 (easy-ware `ALLOWED_FROM`의 부분집합):

| 액션 | 누가 | 시작 상태 | 결과 |
|---|---|---|---|
| SUBMIT | 기안자 | DRAFT, RECALLED | IN_PROGRESS + 첫 결재자 `APPROVING` + 알림 |
| APPROVE | 현재 `APPROVING` 결재자 | IN_PROGRESS | 다음 결재자 `APPROVING` + 알림, 마지막이면 COMPLETED + 채번 + 기안자 알림 |
| REJECT | 현재 `APPROVING` 결재자 | IN_PROGRESS | REJECTED + 기안자 알림 (의견 필수) |
| RECALL | 기안자 | IN_PROGRESS | RECALLED + 결재선 전체 `PENDING`으로 초기화 |
| FORCE_REJECT | hr_admin | COMPLETED | REJECTED |

API (easy-ware 경로를 축소): `GET /api/approval/home`, `GET /api/approval/box?type=`, `GET /api/approval/forms`, `POST /api/approval/documents`, `GET /api/approval/documents/:id`, `PATCH /api/approval/documents/:id`, `POST /api/approval/documents/:id/actions`. hr_admin용 `GET/POST/PUT /api/approval/admin/forms`.

구현 시 지킬 것:

- **액션 API는 하나**(`/actions`)로 두고, 모든 상태 변경이 상태머신 함수를 통과하게 한다 (easy-ware 원칙).
- 동시 승인 경합은 `UPDATE ... WHERE id = ? AND status = 'APPROVING'`의 변경 행 수로 판정한다. 문서 갱신·결재선 갱신·감사 로그는 D1 `batch()` 한 번으로 묶는다.
- easy-ware의 빈틈을 옮기지 않는다: 다음 결재자·완료·반려 알림을 모두 보내고, 재상신 시 첫 결재자를 다시 활성화한다.
- 완료 후처리는 `ref_type`/`ref_id`로 분기하는 함수 하나로 둔다 (easy-ware `ApprovalLifecycleEvent`에 대응). 수강 신청 승인·휴가 확정이 여기에 붙는다.
- 본문 HTML은 서버에서 sanitize한다 (easy-ware `HtmlSanitizer`에 대응). 1단계는 일반 텍스트 + 줄바꿈만 허용해도 된다.
- 상신 후에는 본문·결재선을 수정할 수 없다. 고치려면 회수한다. `PATCH`는 `DRAFT`/`RECALLED`에서만 허용한다 (4.2 (6): 승인자가 본 내용과 확정되는 내용이 같아야 한다).
- 완료 후처리는 결재 완료 `batch()`와 분리해 실행하고 결과를 `hook_status`에 남긴다. 실패해도 문서는 `COMPLETED`로 두고, 크론이 `FAILED`/`PENDING`을 다시 시도한다. 후처리 함수는 같은 문서 ID로 두 번 불려도 결과가 같아야 한다.

1단계에서 뺀 것: 합의(순차/병렬), 확인, 감사, 선결/후결, 대결/후열, 전결, 첨부, 관련 문서, 나의 결재선, 부재 설정, PDF. 필요해지면 `role`·`status` CHECK 값을 늘려 붙인다.

---

## 5. LMS (유튜브 큐레이션 + R2 영상) 적용안

### 5.1 Sites 저장소에서 찾은 패턴

| 저장소 | 정체 | 유튜브 코드 |
|---|---|---|
| talent-navigator | 경력개발 입력·집계 Worker (D1 + R2) | 없음 |
| easy-slides | 슬라이드 템플릿 편집·발표 | 없음. `iframe`은 HTML 슬라이드 샌드박스 렌더링용 (`site/public/app.js`) |
| flowdesk-cloud | 문서·노트·AI 대화·슬라이드 작업 공간 | 없음. 오히려 sanitize에서 `iframe`/`embed`를 금지 (`src/core/documents.ts`) |
| ileet | 소규모 기업 업무·스킬·교육 관리 | 없음 |

**네 저장소 모두 유튜브 임베드·영상 목록·큐레이션·썸네일·진도 추적 코드가 없다.** 일부 디렉터리(각 저장소의 tests, scripts, ileet의 `lib/import-data/company-02~24.json` 등)는 읽지 않았으므로, 사용자가 기억하는 유튜브 큐레이션 코드가 다른 저장소나 브랜치에 있을 가능성은 남는다 (열린 질문 5).

참고할 수 있는 인접 패턴:

- **ileet의 교육 레코드**: 범용 `records(kind='training', owner_id, data JSON, status, version)` 테이블에 저장하고, 상태 전이를 `실습 중 → 실습 완료 → 확인 요청 → 취소`로 제한한다 (`db/schema.ts`, `app/api/workspace/route.ts`). 화면에는 "내 교육" 필터와 상태 변경 select가 있다 (`app/workspace.tsx`). 진도율·시청 위치 추적은 없다.
- **easy-ware의 직원교육**: `training_course`(분류 JOB/LEGAL/SAFETY, 시간, 의무 여부) → `training_session`(회차, 기간, 정원) → `training_enrollment`(REQUESTED/APPROVED/REJECTED/COMPLETED/CANCELLED, 점수, 수료증 번호). 집합교육 신청·승인·수료 모델이고 영상 필드는 없다.
- **보안 패턴**: easy-slides의 `sandbox` iframe, flowdesk-cloud의 DOMPurify 금지 태그. 유튜브 iframe은 사용자 입력 HTML에 섞지 말고 전용 플레이어 컴포넌트에서만 만든다.

### 5.2 적용안

- **과정 구조**는 easy-ware `training_course`를 따르되 회차(`training_session`)는 뺀다. 온라인 영상은 상시 수강이라 회차가 필요 없다.
- **수강 상태**는 easy-ware `training_enrollment`의 상태값을 쓴다. 의무 과정이나 승인이 필요한 과정은 4장의 결재(`ref_type='lms_enrollment'`)와 연결한다.
- **유튜브 큐레이션**: hr_admin이 유튜브 URL을 붙여 넣으면 서버가 영상 ID를 추출해 저장한다. 재생은 유튜브 임베드 iframe, 진도는 IFrame Player API의 재생 위치를 주기적으로 서버에 보낸다. 썸네일은 영상 ID로 만든 유튜브 썸네일 주소를 쓴다. 이 부분은 참고 코드가 없어 새로 만든다.
- **사내 영상**: R2(`people-os-files`)에 올리고 Worker가 Range 요청을 처리해 `<video>`로 재생한다. People OS에는 현재 Range 처리 코드가 없다 (`src/index.ts`에서 확인).
- **People OS만의 연결점**: 녹음 전사·RAG가 이미 있으므로, 사내 영상의 음성을 Whisper로 전사해 "강의 내용 검색"과 "강의 요약"을 붙일 수 있다. 3단계 후보.

### 5.3 D1 스키마 초안

```sql
-- 과정 (easy-ware training_course)
CREATE TABLE lms_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'JOB',     -- JOB | LEGAL | SAFETY | COACHING
  description TEXT,
  thumbnail_url TEXT,
  is_required INTEGER NOT NULL DEFAULT 0,   -- 의무교육
  needs_approval INTEGER NOT NULL DEFAULT 0,-- 수강 신청에 결재 필요
  audience TEXT NOT NULL DEFAULT 'all',     -- all | coach | coachee
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 강의 (과정 안의 영상 1개)
CREATE TABLE lms_lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube','r2')),
  youtube_id TEXT,                          -- source='youtube'
  r2_key TEXT,                              -- source='r2'
  duration_sec INTEGER,
  curator_note TEXT,                        -- 큐레이션 코멘트 ("왜 이 영상인가")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, ord)
);

-- 수강 (easy-ware training_enrollment)
CREATE TABLE lms_enrollments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'APPROVED'
    CHECK (status IN ('REQUESTED','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  approval_doc_id TEXT,                     -- 결재 연동 시
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (course_id, user_id)
);
CREATE INDEX idx_lms_enroll_user ON lms_enrollments(user_id, status);

-- 진도 (강의별)
CREATE TABLE lms_progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  lesson_id TEXT NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  position_sec INTEGER NOT NULL DEFAULT 0,  -- 마지막 시청 위치 (이어보기)
  watched_sec INTEGER NOT NULL DEFAULT 0,   -- 누적 시청 시간
  completed_at TEXT,                        -- 완료 기준 충족 시각
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
```

- 진도 저장은 15~30초 간격 + 일시정지·종료 시점에만 보낸다. D1 쓰기 한도를 아끼기 위해서다.
- 강의 완료 기준(예: 누적 시청 90%)과 과정 수료 기준(전 강의 완료)은 열린 질문 6.

### 5.4 R2 Range 스트리밍 vs Stream

R2 Range 스트리밍은 추가 상품 없이 지금 버킷으로 되지만 원본 파일 그대로 내려보내므로 화질 자동 조절과 인코딩이 없다. Cloudflare Stream은 인코딩·적응형 재생·플레이어를 제공하는 별도 유료 상품이다 (요금은 이 문서에서 확인하지 않음). 사내 영상이 적고 짧은 동안은 R2 Range로 충분하다.

---

## 6. People OS UI 변경안

### 6.1 메뉴 순서

현재(11개): 홈, 메일함, 할 일, 녹음전사.문서저장, 코칭 리플렉션, 개인 업무 검색, HR 규정 검색, 라이브러리, 관측·평가, 사용자 관리, 소개.

변경안(13개, 묶음 구분선 추가):

| 묶음 | 메뉴 | 비고 |
|---|---|---|
| 업무 | 홈 | 카드 추가 (6.2) |
| | 메일함 | 그대로 |
| | **결재함** (신규) | 결재 대기 건수 배지. easy-ware도 홈·메일 다음이 결재다 (`LeftNav.tsx`) |
| | 할 일 | 그대로 |
| 성장 | 녹음전사.문서저장 | 그대로 |
| | 코칭 리플렉션 | 그대로 |
| | **강의실** (신규) | 코칭 다음에 둬 "코칭 → 학습" 흐름을 만든다 |
| 지식 | 개인 업무 검색 | 그대로 |
| | HR 규정 검색 | 그대로 |
| | 라이브러리 | 그대로 |
| 관리 | 관측·평가 | hr_admin 전용 (현행) |
| | 사용자 관리 | hr_admin 전용. 부서 관리 탭 추가 |
| | 소개 | 그대로 |

알림은 메뉴가 아니라 상단의 종 아이콘 + 드롭다운으로 둔다.

### 6.2 새 탭과 카드

- **홈 카드**: "결재 대기 N건"(누르면 결재함 대기 탭), "내 기안 진행 중 N건", "이어서 듣기"(마지막 시청 강의), hr_admin에게는 "의무교육 미수료 N명".
- **결재함 탭 구성** (easy-ware 문서함을 축소): 대기(내가 결재할 문서) / 기안(내가 올린 진행 중) / 완료(내가 올렸거나 결재한 문서) / 임시저장 / 참조. 우측 상단 "새 기안" 버튼 → 양식 선택 → 에디터. hr_admin에게만 "양식 관리" 탭.
- **결재 문서 상세**: 본문 + 우측 결재선 타임라인(사람·상태·시각·의견) + 하단 승인/반려 버튼(의견 입력). easy-ware `ApprovalRouteTimeline`, `ApprovalLinePanel` 구성을 따른다.
- **강의실 탭 구성**: 내 학습(수강 중·의무·수료) / 전체 과정(카드 목록, 분류 필터) / 과정 상세(강의 목록 + 플레이어 + 진도 막대). hr_admin에게만 "과정 관리"(유튜브 URL 붙여넣기, 영상 업로드, 순서 변경)와 "수강 현황".
- **사용자 관리**: "부서" 탭 추가(부서 CRUD, 부서장 지정), 사용자 행에 부서 선택 추가.
- **메일함 연동**: 결재 요청 메일의 링크가 결재 문서 상세를 바로 연다.

구현 메모: 프런트는 `public/index.html` 단일 파일(1,543줄)이다. 메일함처럼 `approval.js`/`approval.css`, `lms.js`/`lms.css`로 분리한다 (`public/email.js` 선례).

---

## 7. 단계별 실행 계획

전제: 11-25 기능 동결, 11-27 공모전 제출. **결재·LMS 작업은 제출 이후에 시작한다.** 제출 전에는 이 문서 검토와 9장 질문에 대한 결정만 한다.

### 1단계 — 결재 최소 기능 (제출 직후, 약 1~2주)

1. 마이그레이션: `departments`, `users.department_id`, `approval_forms`, `approval_documents`, `approval_routes`, `approval_audit`, `notifications`. 기본 양식 2~3종 시드.
2. 백엔드 `src/approval/`: 상태머신 함수, 액션 API, 문서함 조회, 조회 권한 검사, 감사 로그, 알림(D1 + Resend).
3. 프런트: 결재함 메뉴·탭, 새 기안, 문서 상세·타임라인, 홈 카드, 사용자 관리의 부서 탭.
4. 크론 독촉: 기존 크론에 "N일 넘은 `APPROVING` 결재선" 메일 발송과 `hook_status`가 `PENDING`/`FAILED`인 후처리 재시도 추가.
5. 검증: `npx tsc --noEmit`, 로컬에서 기안 → 승인 → 반려 → 회수 → 재상신 시나리오, 권한 밖 사용자의 조회·액션 차단 확인 후 배포.

완료 기준: 사용자 2~3명이 실제로 기안·승인·반려를 끝까지 할 수 있고, 모든 액션이 감사 로그에 남는다.

### 2단계 — LMS 최소 기능 + 결재 연동 (약 2~3주)

1. 마이그레이션: `lms_courses`, `lms_lessons`, `lms_enrollments`, `lms_progress`.
2. 유튜브 큐레이션: URL → 영상 ID 추출, 과정 관리 화면, 임베드 플레이어, 진도 저장, 이어보기.
3. 강의실 메뉴·내 학습·홈 "이어서 듣기" 카드.
4. 결재 연동: 승인 필요 과정의 수강 신청 → 결재 문서 생성 → 완료 후처리에서 수강 `APPROVED`.
5. 결재 보강: 참조(`CC_REF`), 첨부(R2), 휴가 신청 양식 + 후처리.

완료 기준: hr_admin이 유튜브 영상으로 과정을 만들고, 사용자가 수강해 진도·수료가 기록된다.

### 3단계 — 확장 (이후, 필요에 따라)

- 사내 영상: R2 업로드 + Range 스트리밍, Whisper 전사 → 강의 내용 검색·요약.
- 결재 고급 기능: 합의(순차/병렬), 대결·부재 위임, 전결, 나의 결재선, PDF 출력.
- Workflows 도입 검토: 4.5의 조건(하루 2회보다 촘촘한 독촉, 양식별 기한)이 생겼을 때만. 먼저 열린 질문 13의 실측을 하고, 4.4 형태(D1이 진실원, Workflow는 문서별 타이머)로 붙인다.
- 에이전트 승인 큐: People OS 에이전트가 외부 행동을 하게 되면 결재함에 "에이전트 승인" 탭 추가 (4.2 (6)).
- 그룹웨어 후속: 캘린더, 공지 게시판, 설문.
- easy-standards 정렬: 에러 응답 형식 통일, 감사 로그 해시체인, 멀티테넌시(`tenant_id`) 도입 여부 결정.

---

## 8. 종합 결론

### 8.1 다섯 가지 출처에서 가져오는 것

| 출처 | 가져오는 것 | 가져오지 않는 것 |
|---|---|---|
| easy-ware (결재) | 문서 + 결재선 + 상태머신 + 감사 로그의 구조, 액션 단일 진입점, 문서함 분류, 부서장 자동 해석, 완료 이벤트로 다른 도메인(휴가·교육)을 확정하는 방식 | Java/Spring 코드, 1단계에서 쓰는 5개 액션(4.6) 밖의 액션(합의·전결·대결 등은 3단계), 코드에서 확인한 빈틈 5가지(1.4) |
| easy-standards (공통 코드) | 감사 컬럼 이름, 상태 컬럼 CHECK 규칙, 감사 로그 컬럼 구성, 에러 응답 형식, 원자적 채번, UUIDv7, "ID만으로 조회 금지" 규칙 | Spring autoconfig, Postgres RLS, Mantine 패키지, 멀티테넌시(열린 질문 12에서 결정) |
| Cloudflare Workflows | 1·2단계에서는 쓰지 않는다. 3단계에서 조건이 맞으면 "문서별 타이머"로만 추가 (4.4) | 결재 상태의 저장소 역할 |
| Cloudflare OS | 승인 큐 설계 패턴: 대기 건 희소 색인, 승인 전환 단일 관문, 승인자가 본 내용의 고정, 후처리 실패 분리, 결재자 확정 저장, 자동 처리의 귀속 기록, 자동 반려 없음, 알림에 본문 미포함 (4.2 (6)) | 코드 전체. Dynamic Workers(Paid 전용), Durable Object 저장 구조, Cap'n Web RPC |
| 유튜브 LMS | 참고 코드가 없어 새로 설계. 과정·수강 상태는 easy-ware `training_*`, 상태 전이 제한은 ileet 방식 | 회차(`training_session`) 모델 |

### 8.2 아키텍처 개요

기존 Worker 하나에 모듈 세 개(결재, 알림, LMS)를 더한다. 새 Cloudflare 상품은 1·2단계에서 추가하지 않는다.

```
브라우저 (public/index.html + approval.js / lms.js)
   │  fetch /api/approval/*  /api/lms/*  /api/notifications/*
   ▼
Worker people-os (src/index.ts, Hono)
   ├─ src/approval/   상태머신 · 액션 API · 문서함 · canView · 감사 로그 · 후처리 훅
   ├─ src/notify/     D1 notifications 기록 + Resend 메일 (제목·링크만)
   ├─ src/lms/        과정 · 강의 · 수강 · 진도
   ├─ scheduled()     기존 크론 2회 → 결재 독촉 · 후처리 재시도 · 의무교육 미수료 알림
   └─ queue()         기존 파이프라인 (3단계: 사내 영상 전사 → 색인)
   │
   ├─ D1 people-os-db     결재 4개 + 알림 1개 + 부서 1개 + LMS 4개 테이블  ← 유일한 진실원
   ├─ R2 people-os-files  결재 첨부(2단계) · 사내 영상(3단계)
   ├─ Vectorize / Workers AI  (3단계) 강의 전사 검색 · 요약
   └─ [3단계, 조건부] Workflows 바인딩 — 문서별 독촉 타이머 (4.4)
```

흐름 하나로 보면: 사용자가 승인 필요 과정에 수강 신청 → `lms_enrollments`가 `REQUESTED`로 생기고 결재 문서가 `ref_type='lms_enrollment'`로 만들어짐 → 부서장에게 알림 → 부서장 승인 → 문서 `COMPLETED`, `hook_status='PENDING'` → 후처리 훅이 수강을 `APPROVED`로 바꾸고 `hook_status='DONE'` → 신청자에게 알림 → 강의실에서 수강 시작.

### 8.3 D1 스키마 방향

- 테이블 10개를 세 번의 마이그레이션으로 나눈다: ① `departments` + `users.department_id` + `notifications`, ② 결재 4개(`approval_forms`, `approval_documents`, `approval_routes`, `approval_audit` — 4.6), ③ LMS 4개(5.3). `notifications` 테이블의 컬럼은 아직 초안이 없다 — easy-ware `notification(user_id, type, ref_id, ref_type, title, body, read_at)`을 따른다 (1.5).
- 공통 규칙 (easy-standards에서): PK는 TEXT(UUIDv7), 상태 컬럼은 CHECK 제약, 시각은 TEXT(`datetime('now')`), 새 테이블에 `created_at`/`updated_at`. 상태값 대소문자는 열린 질문 7.
- 결재와 다른 도메인의 연결은 `approval_documents.ref_type`/`ref_id` 한 쌍과 상대 테이블의 `approval_doc_id` 한 컬럼으로만 한다. 결재 테이블이 LMS·휴가 테이블을 직접 참조하지 않는다.
- 색인은 조회 화면 기준으로 둔다: 결재 대기함(부분 색인), 내 기안(`drafter_id, created_at`), 내 수강(`user_id, status`).
- 로컬 마이그레이션 주의: `ensureSchema()`로 만든 로컬 DB에는 `migrations apply --local`이 0004에서 실패한다(기존 문제). 새 마이그레이션은 `d1 execute --local --file`로 개별 검증한다. 원격은 `migrations list --remote`로 추적 상태를 먼저 확인한다.

### 8.4 UI 배치

6장 그대로다. 요약하면 사이드바에 **결재함**(메일함 다음)과 **강의실**(코칭 리플렉션 다음) 두 메뉴를 추가하고, 알림은 상단 종 아이콘으로 둔다. 홈에 카드 3~4개(결재 대기, 내 기안, 이어서 듣기, hr_admin용 의무교육 미수료), 사용자 관리에 부서 탭을 더한다. 2단계에서 원문을 읽고 추가한 것:

- 결재 문서 상세에서 사용자 입력 본문은 텍스트로만 표시한다 (HTML 렌더링 금지).
- 상신된 문서에는 "수정" 버튼이 없고 "회수"만 있다.
- hr_admin 화면에 "후처리 실패" 목록(`hook_status='FAILED'`)과 재시도 버튼을 둔다.
- 메뉴 구성은 1단계 분석 시점의 `public/index.html` 기준이다. 이후 메뉴가 바뀌었으면 착수 시점에 다시 맞춘다.

### 8.5 단계별 실행 계획

상세 작업 목록은 7장. 일정으로 옮기면 다음과 같다 (2026-11-27은 금요일).

| 시기 | 할 일 | 산출물 |
|---|---|---|
| ~11-25 (기능 동결 전) | 결재·LMS 코드 작업 없음. 9장 질문 중 1·2·3·7·8번 결정 | 결정 사항 메모 |
| 11-25 ~ 11-27 | 공모전 제출 작업만 | — |
| 11-30 주 ~ 12월 2주 (1단계) | 부서·알림·결재 마이그레이션, 결재 백엔드, 결재함 UI, 크론 독촉 | 기안 → 승인/반려 → 회수 → 재상신이 실사용자 2~3명으로 끝까지 동작 |
| 12월 3주 ~ 1월 1주 (2단계) | LMS 마이그레이션, 유튜브 과정 관리·플레이어·진도, 수강 신청 결재 연동, 참조·첨부, 휴가 양식 | hr_admin이 만든 과정을 사용자가 수강하고 수료가 기록됨 |
| 1월 이후 (3단계, 필요에 따라) | 사내 영상(R2 Range) + 전사 검색, 결재 고급 기능, Workflows 타이머(조건부), 에이전트 승인 큐, 캘린더·공지·설문 | 항목별로 따로 결정 |

1단계 착수 전에 할 일 한 가지: People OS 세션 쿠키가 HttpOnly + Secure + SameSite인지 점검한다 (2.2에서 확인 안 됨으로 남긴 항목). 결재는 "누가 승인했는가"가 핵심이라 세션이 약하면 감사 로그의 의미가 없다.

### 8.6 한 문단 요약

People OS의 결재는 easy-ware의 구조를 부서 포함 5개 D1 테이블로 줄여 옮기고, easy-standards의 컬럼·감사·에러 규칙을 입히고, Cloudflare OS 승인 큐의 설계 패턴으로 다듬는다. 결재 상태는 D1 한 곳에만 있고 독촉은 기존 크론이 한다. Workflows는 문서별 타이머가 필요해질 때 덧붙이는 선택지로 남긴다. LMS는 같은 D1 위에 새로 만들고, 승인이 필요한 수강 신청은 결재를 통과한다. 모든 작업은 11-27 제출 이후에 시작한다.

---

## 9. 열린 질문 (사용자 결정 필요)

1. **결재 대상 문서 종류**: 1단계 양식을 무엇으로 할까? 제안은 "일반 기안", "휴가 신청", "교육 수강 신청" 3종. 코칭 관련(코칭 계획 승인, 코칭 결과 보고)을 넣을지도 결정이 필요하다.
2. **결재선 지정 주체** — **결정됨 (2026-11-17, 사용자 선택)**: **(b) 양식별 고정 결재선(부서장 → hr_admin)을 자동 적용하고 기안자는 수정만.** 양식의 `default_route_json`에 `["DEPT_MANAGER","HR_ADMIN"]` 형태로 저장하고, 기안 시 자동 적용 후 기안자가 수정할 수 있게 한다. (a) 기안자 직접 지정(easy-ware 방식)과 (c) 둘 다는 선택하지 않음.
3. **조직 데이터** — **결정됨 (2026-11-17, 사용자 확인)**: 리더 = 부서장, 같은 개념이다. `departments.manager_user_id`로 표현하고 별도 역할 필드를 늘리지 않는다 (easy-ware 방식). 구성원 = 그 부서에 속한 사용자 (`users.department_id`). 부서·부서장 데이터는 hr_admin이 사용자 관리 화면에서 입력한다. 코치는 코칭 대상의 결재자로 보지 않는다 (코칭 관계와 결재선은 별개).
4. **LMS 수강 대상**: 전 직원인가, 코치·코치이 구분이 있는가? 의무교육(법정교육) 추적이 필요한가, 자율 학습 위주인가?
5. **유튜브 큐레이션 원본 위치**: 지정된 4개 저장소에서는 유튜브 코드를 찾지 못했다. 참고하려던 코드가 다른 저장소나 브랜치에 있는지 확인이 필요하다.
6. **수료 기준**: 강의 완료를 시청 몇 %로 볼 것인가? 유튜브는 건너뛰기를 막을 수 없는데, 시청 시간 누적으로 충분한가, 퀴즈·설문이 필요한가?
7. **상태값 표기**: 새 테이블은 easy-standards 규칙대로 대문자(`IN_PROGRESS`)로 갈까, People OS 기존 테이블처럼 소문자(`active`)로 맞출까?
8. **알림 채널**: 결재 요청을 앱 내 알림만으로 할까, 메일(Resend)도 보낼까? 외부 메일 주소로 결재 제목이 나가도 되는가?
9. **독촉·기한 정책**: 며칠 지나면 독촉하고, 몇 번 독촉 후 누구에게 올리나? 장기 미결 문서를 자동 반려할 것인가?
10. **플랜**: Free를 유지하는가? 원문 확인 결과 결재 추천안(② D1)은 플랜과 무관하다. Paid로 올리면 달라지는 것은 Workflows 한도(스텝당 CPU 10ms → 30초, 하루 3,000스텝 → 월 500,000스텝, 완료 인스턴스 보관 3일 → 최대 30일)와 Dynamic Workers 사용 가능 여부뿐이다.
11. **자매 제품 연동**: People OS 결재를 easy-ware 결재와 독립으로 둘 것인가, 나중에 문서를 주고받을 것인가? 연동 계획이 있으면 상태값과 역할 이름을 easy-ware와 똑같이 유지해야 한다.
12. **멀티테넌시**: easy-ware·easy-standards는 전부 `tenant_id` 전제다. People OS를 여러 회사에 제공할 계획이 있으면 새 테이블에 처음부터 `tenant_id`를 넣는 편이 싸다.

2단계에서 원문을 읽고 새로 생긴 질문:

13. **Workflows 대기 인스턴스 실측 (Workflows를 쓰려 할 때만)**: Free 플랜에서 `waitForEvent`로 3일 넘게 대기한 인스턴스가 살아 있는지 문서에 명시가 없다. 도입 전에 별도의 시험용 Worker로 4일 대기 시험을 할 것인가? 함께 확인할 것: `waitForEvent`가 하루 3,000스텝에 세어지는지, 종료된 인스턴스의 ID를 다시 쓸 수 있는지, `wrangler dev --local`에서 동작하는지. 운영 계정에 시험용 Worker를 만드는 일이라 사용자 승인이 필요하다.
14. **독촉 주기**: 하루 2회 크론(07:00, 03:00 KST)에 얹은 독촉으로 충분한가? 충분하면 Workflows는 도입하지 않는다. 양식별로 다른 기한이나 시간 단위 독촉이 필요하면 4.4 형태를 검토한다.
15. **결재자 변경 시 처리**: 진행 중인 문서의 결재자가 퇴사·비활성화되거나 부서장이 바뀌면 어떻게 하나? 제안은 "상신 시점의 결재자를 유지하고, 결재자가 비활성 상태면 hr_admin에게 알려 수동으로 결재선을 바꾸게 한다". 자동으로 새 부서장에게 넘기는 방식도 가능하다.
16. **상신 후 수정 금지**: 상신된 문서는 회수해야만 고칠 수 있게 하는 것(4.6)에 동의하는가? 오탈자 수정까지 회수를 요구하게 된다. 대안은 "수정하면 이미 승인한 결재자의 승인을 무효로 하고 처음부터 다시"다.
17. **후처리 실패 시 책임자**: 결재는 완료됐는데 후처리(수강 승인, 휴가 확정)가 실패하면 누가 보고 재시도하나? 제안은 크론 자동 재시도 + hr_admin 화면의 실패 목록.
18. **에이전트 승인 큐**: People OS의 AI 에이전트가 메일 발송·할 일 생성 같은 행동을 직접 하게 할 계획이 있는가? 있으면 Cloudflare OS 방식(행동을 큐에 쌓고 사람이 나중에 승인)을 결재함의 한 탭으로 넣는 것을 3단계에 올린다.
19. **참조 저장소 보관**: `files/people-os/.ref/`(66MB)를 계획 확정 후에도 둘 것인가? 두려면 `.gitignore`에 `.ref/`를 추가해야 한다 (이번 세션은 코드·설정을 수정하지 않아 추가하지 않았다).
