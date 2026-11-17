// 전자결재 공통 타입 (2026-11-17, groupware-approval-plan.md 4.6). 상태값은 대문자 (easy-ware와 동일).

export type DocStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "REJECTED" | "RECALLED";
export type RouteStatus = "PENDING" | "APPROVING" | "APPROVED" | "REJECTED" | "SKIPPED";
export type RouteRole = "APPROVER" | "CC_REF";
export type HookStatus = "NONE" | "PENDING" | "DONE" | "FAILED";

export const ACTIONS = ["SUBMIT", "APPROVE", "REJECT", "RECALL", "REQUEST_RE_APPROVAL", "FORCE_REJECT"] as const;
export type Action = (typeof ACTIONS)[number];

/** 결재선 토큰: 양식 default_route_json과 기안 요청 routes 배열에서 쓴다. */
export const ROUTE_TOKENS = ["DEPT_MANAGER", "HR_ADMIN"] as const;
export type RouteToken = (typeof ROUTE_TOKENS)[number];
export type RouteSource = RouteToken | "USER";

export type ApprovalEnv = {
  DB: D1Database;
  ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
};

export type DocRow = {
  id: string;
  form_id: string;
  drafter_id: string;
  title: string;
  body_html: string | null;
  body_text: string | null;
  status: DocStatus;
  doc_number: string | null;
  ref_type: string | null;
  ref_id: string | null;
  hook_status: HookStatus;
  hook_error: string | null;
  is_urgent: number;
  version: number;
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RouteRow = {
  id: string;
  document_id: string;
  step_no: number;
  role: RouteRole;
  actor_user_id: string;
  actor_dept_id: string | null;
  source: string | null;
  status: RouteStatus;
  acted_at: string | null;
  comment: string | null;
  reminded_at: string | null;
};

/** 결재선 한 칸 (해석 완료 — 실제 사용자 id). */
export type RouteSpec = { user_id: string; source: RouteSource; dept_id: string | null };

export class ApprovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
