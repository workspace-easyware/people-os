-- 0024_approval.sql — 전자결재 1단계 (2026-11-17, groupware-approval-plan.md 4.6 / 8.3).
-- easy-ware 결재 도메인(9개 테이블)을 축소: 조직(departments) + 결재 4개 + 알림 1개. tenant_id 없음.
-- 외래키는 달지 않는다 (0016·0022 방침). 참조 관계는 주석으로만 남긴다.
-- 상태값은 대문자 (easy-ware와 동일). 상태 전이는 src/approval/machine.ts 한 곳에서만 일어난다.
-- 로컬 검증: npx wrangler d1 execute people-os-db --local --file migrations/0024_approval.sql
--   (ensureSchema로 만든 로컬 DB는 migrations apply --local이 0004에서 실패한다 — AGENTS.md)

-- 조직 (easy-ware department). 리더 = 부서장 = manager_user_id (별도 역할 필드 없음).
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  manager_user_id TEXT,                  -- users.id (NULL = 부서장 미지정 → 이 부서원은 DEPT_MANAGER 결재선 기안 불가)
  parent_id TEXT,                        -- departments.id (상위 부서)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_departments_manager ON departments(manager_user_id);

-- 구성원 = 그 부서에 속한 사용자.
ALTER TABLE users ADD COLUMN department_id TEXT;   -- departments.id
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);

-- 양식 (easy-ware approval_form, 분류는 컬럼 하나로).
CREATE TABLE IF NOT EXISTS approval_forms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- 'general_draft', 'leave', 'training_request'
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT,
  body_template TEXT,                    -- 기본 본문 (일반 텍스트)
  default_route_json TEXT,               -- 기본 결재선 (예: ["DEPT_MANAGER","HR_ADMIN"]) — 기안 시 자동 적용, 기안자가 수정 가능
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 문서 (easy-ware approval_document).
CREATE TABLE IF NOT EXISTS approval_documents (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,                 -- approval_forms.id
  drafter_id TEXT NOT NULL,              -- users.id
  title TEXT NOT NULL,
  body_html TEXT,                        -- 서버가 body_text를 이스케이프해 만든 HTML (1단계: 텍스트 + 줄바꿈만)
  body_text TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','COMPLETED','REJECTED','RECALLED')),
  doc_number TEXT,                       -- 완료 시 채번 (AP-YYYY-00001)
  ref_type TEXT,                         -- 연동 대상 (2단계: 'lms_enrollment', 'leave')
  ref_id TEXT,
  hook_status TEXT NOT NULL DEFAULT 'NONE'  -- 완료 후처리 상태 (결재 완료 batch와 분리)
    CHECK (hook_status IN ('NONE','PENDING','DONE','FAILED')),
  hook_error TEXT,
  is_urgent INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,    -- 낙관적 잠금 (모든 상태 변경이 +1)
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appr_doc_drafter ON approval_documents(drafter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_appr_doc_status ON approval_documents(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appr_doc_number ON approval_documents(doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appr_doc_hook ON approval_documents(hook_status) WHERE hook_status IN ('PENDING','FAILED');

-- 결재선 (easy-ware approval_route).
CREATE TABLE IF NOT EXISTS approval_routes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,             -- approval_documents.id
  step_no INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'APPROVER' CHECK (role IN ('APPROVER','CC_REF')),
  actor_user_id TEXT NOT NULL,           -- users.id
  actor_dept_id TEXT,                    -- 부서장 자동 해석(DEPT_MANAGER)으로 들어온 경우 그 부서
  source TEXT,                           -- 'DEPT_MANAGER' | 'HR_ADMIN' | 'USER' (어떻게 정해졌는지)
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVING','APPROVED','REJECTED','SKIPPED')),
  acted_at TEXT,
  comment TEXT,
  reminded_at TEXT,                      -- 크론 독촉 중복 방지 (후속 단계)
  UNIQUE (document_id, step_no, role, actor_user_id)
);
CREATE INDEX IF NOT EXISTS idx_appr_route_doc ON approval_routes(document_id, step_no);
CREATE INDEX IF NOT EXISTS idx_appr_route_actor ON approval_routes(actor_user_id, status);
-- 결재 대기함 전용 부분 색인 (대기 건만 담는 희소 색인).
CREATE INDEX IF NOT EXISTS idx_appr_route_waiting ON approval_routes(actor_user_id) WHERE status = 'APPROVING';

-- 감사 로그 (easy-ware approval_audit). 모든 액션이 상태 변경과 같은 batch로 남는다.
CREATE TABLE IF NOT EXISTS approval_audit (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_status TEXT,
  after_status TEXT,
  comment TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appr_audit_doc ON approval_audit(document_id, created_at);

-- 알림 (easy-ware notification). D1 기록 + Resend 메일(제목·링크만, 본문 미포함).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                 -- 받는 사람 users.id
  type TEXT NOT NULL,                    -- 'APPROVAL_REQUEST' | 'APPROVAL_COMPLETED' | 'APPROVAL_REJECTED' | 'APPROVAL_RECALLED' ...
  ref_type TEXT,                         -- 'approval_document'
  ref_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                             -- 앱 내 경로 (예: /#approval/<docId>)
  read_at TEXT,
  emailed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
