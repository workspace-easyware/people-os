-- 결재 기본 시드 v1 (2026-11-17). 멱등 (INSERT OR IGNORE + 고정 id). 마이그레이션이 아님 — 0024 적용 후 d1 execute --file로 적용.
-- 양식 3종: 기본 결재선은 모두 부서장 → hr_admin. 기안 시 자동 적용되고 기안자가 수정할 수 있다.
-- 기본 부서 1개: 인사팀. 부서장(manager_user_id)은 비워 둔다 — hr_admin이 사용자 관리 화면에서 지정한다.
-- 부서장 없는 부서원이 DEPT_MANAGER 결재선 양식으로 기안하면 거부된다 (easy-ware 규칙 유지).
INSERT OR IGNORE INTO departments (id, code, name, manager_user_id, parent_id, sort_order, is_active) VALUES
 ('dept_hr', 'HR', '인사팀', NULL, NULL, 10, 1);

INSERT OR IGNORE INTO approval_forms (id, code, name, category, description, body_template, default_route_json, sort_order, is_active) VALUES
 ('form_general_draft', 'general_draft', '일반 기안', 'general',
  '업무 보고·요청 등 정해진 양식이 없는 결재',
  '1. 목적:' || char(10) || char(10) || '2. 내용:' || char(10) || char(10) || '3. 기대 효과:' || char(10),
  '["DEPT_MANAGER","HR_ADMIN"]', 10, 1),
 ('form_leave', 'leave', '휴가 신청', 'leave',
  '연차·반차·경조 휴가 신청 (2단계에서 휴가 확정과 연동)',
  '휴가 종류: 연차' || char(10) || '기간: YYYY-MM-DD ~ YYYY-MM-DD (N일)' || char(10) || '사유:' || char(10) || '업무 인수인계:' || char(10),
  '["DEPT_MANAGER","HR_ADMIN"]', 20, 1),
 ('form_training_request', 'training_request', '교육 수강 신청', 'education',
  '사내·외부 교육 수강 신청 (2단계에서 강의실 수강 승인과 연동)',
  '과정명:' || char(10) || '교육 기관/링크:' || char(10) || '기간:' || char(10) || '비용:' || char(10) || '신청 사유·기대 효과:' || char(10),
  '["DEPT_MANAGER","HR_ADMIN"]', 30, 1);
