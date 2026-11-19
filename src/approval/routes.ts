// 전자결재 API (2026-11-17, groupware-approval-plan.md 4.6). index.ts에서 "/api/approval"에 mount한다 (경로는 mount 기준 상대).
// 로그인 필수 (익명 401). 조회 권한(canView): 기안자이거나 결재선에 있는 사람만. 볼 수 없는 문서는 존재를 숨기려고 404.
// 모든 상태 변경은 machine.ts를 통과한다 (액션 단일 진입점 POST /documents/:id/actions).
//   GET   /home                         문서함 건수 + 결재 대기 5건 + 최근 알림
//   GET   /box?type=PENDING|UPCOMING|DRAFTING|DRAFTS|DONE|APPROVED_BY_ME|MINE&page=&limit=
//   GET   /forms                        활성 양식 + 기본 결재선 (내 기준으로 해석한 결재자 미리보기, 해석 실패 시 route_error)
//   GET   /users?q=                     결재자 지정용 사용자 검색 (활성 사용자, 이름·이메일·부서)
//   POST  /documents                    기안 {form_id|form_code, title, body, routes?, is_urgent?, submit?}
//                                       routes 생략 시 양식 default_route_json을 자동 적용. 부서장이 없으면 거부.
//   GET   /documents/:id                상세 + 결재선 + 감사 이력 + 내가 할 수 있는 액션
//   PATCH /documents/:id                DRAFT/RECALLED에서만 {title?, body?, routes?, is_urgent?, version?}
//   POST  /documents/:id/actions        {action: SUBMIT|APPROVE|REJECT|RECALL|REQUEST_RE_APPROVAL|FORCE_REJECT, comment?}
//   GET   /notifications?unread=1       내 알림
//   POST  /notifications/read           {ids?: string[]} (생략 시 전부 읽음)
//   GET   /admin/departments            (hr_admin) 부서 목록 + 부서장 + 인원
//   POST  /admin/departments            (hr_admin) 부서 upsert {id?, code, name, manager_user_id?, parent_id?, sort_order?, is_active?}
//   PUT   /admin/users/:id/department   (hr_admin) {department_id: string|null}
// 스키마 누락(migration 0024 미적용)은 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest, type SessionUser } from "../auth";
import { uid } from "../lib";
import { runCompletionHook } from "./hooks";
import { availableActions, createDraft, editDraft, performAction, type RequestMeta } from "./machine";
import { deliverEmails } from "./notify";
import { parseRouteTokens, resolveRoute } from "./resolve";
import { ACTIONS, ApprovalError, type Action, type ApprovalEnv, type DocRow, type RouteRow } from "./types";

type C = Context<{ Bindings: ApprovalEnv }>;
export const approvalApp = new Hono<{ Bindings: ApprovalEnv }>();

const SCHEMA_MSG = "결재 스키마가 아직 적용되지 않았습니다 (migration 0024).";
const MAX_TITLE = 200;
const MAX_BODY = 50_000;

function fail(c: C, status: number, error: string) {
  return c.json({ ok: false, error }, status as 400);
}

/** 결재 관련 테이블·컬럼 누락만 503으로 본다. 다른 누락은 진짜 오류(500). */
function isSchemaMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(m) && /approval_|departments|notifications|department_id/i.test(m);
}

/** 공통 에러 처리: ApprovalError → 그 상태, 스키마 누락 → 503, 나머지는 다시 던진다. */
approvalApp.onError((e, c) => {
  if (e instanceof ApprovalError) return c.json({ ok: false, error: e.message }, e.status as 400);
  if (isSchemaMissing(e)) return c.json({ ok: false, error: SCHEMA_MSG }, 503);
  console.log("[approval] error:", e instanceof Error ? e.stack || e.message : String(e));
  return c.json({ ok: false, error: "결재 처리 중 오류가 발생했습니다." }, 500);
});

/** 상태 변경 요청은 같은 출처에서만 (Origin 헤더가 있으면 일치해야 한다). */
function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

async function requireUser(c: C): Promise<SessionUser> {
  const v = await getSessionUser(c.env, c.req.header("cookie"));
  if (!v) throw new ApprovalError(401, "로그인이 필요합니다.");
  return v;
}

async function requireWriter(c: C): Promise<SessionUser> {
  if (!originOk(c)) throw new ApprovalError(403, "허용되지 않는 요청입니다.");
  return requireUser(c);
}

function metaOf(c: C): RequestMeta {
  return {
    ip: c.req.header("cf-connecting-ip") || null,
    userAgent: (c.req.header("user-agent") || "").slice(0, 300) || null,
  };
}

async function readJson(c: C): Promise<Record<string, unknown>> {
  try {
    const text = await c.req.text();
    if (text.length > 256 * 1024) throw new ApprovalError(413, "요청이 너무 큽니다.");
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    throw new ApprovalError(400, "JSON 본문이 올바르지 않습니다.");
  }
}

function paging(c: C): { limit: number; offset: number; page: number } {
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10) || 20));
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

async function loadDoc(db: D1Database, id: string): Promise<DocRow | null> {
  return db.prepare("SELECT * FROM approval_documents WHERE id = ?").bind(id).first<DocRow>();
}

async function loadRoutes(db: D1Database, docId: string): Promise<RouteRow[]> {
  const r = await db.prepare("SELECT * FROM approval_routes WHERE document_id = ? ORDER BY step_no, id").bind(docId).all<RouteRow>();
  return r.results || [];
}

/** 조회 권한: 기안자이거나 결재선(역할 무관)에 있는 사람만. hr_admin이라도 결재선 밖이면 볼 수 없다. */
export function canView(viewer: { id: string }, doc: DocRow, routes: RouteRow[]): boolean {
  return doc.drafter_id === viewer.id || routes.some((r) => r.actor_user_id === viewer.id);
}

/** 액션 뒤처리: 알림 메일·완료 후처리는 batch 커밋 뒤 waitUntil로 (응답을 막지 않고, 실패해도 결재 결과는 그대로). */
function afterCommit(c: C, notificationIds: string[], hookDocId: string | null) {
  const origin = new URL(c.req.url).origin;
  const work = (async () => {
    if (hookDocId) await runCompletionHook(c.env.DB, hookDocId).catch((e) => console.log("[approval:hook]", String(e)));
    await deliverEmails(c.env, notificationIds, origin).catch((e) => console.log("[approval:notify]", String(e)));
  })();
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    /* executionCtx 없음(테스트) — 그냥 흘려보낸다 */
  }
}

// ---------- 문서함 ----------

const LIST_COLS = `d.id, d.title, d.status, d.doc_number, d.is_urgent, d.submitted_at, d.completed_at, d.created_at, d.updated_at,
  f.name AS form_name, f.code AS form_code, du.name AS drafter_name,
  (SELECT cu.name FROM approval_routes cr JOIN users cu ON cu.id = cr.actor_user_id
     WHERE cr.document_id = d.id AND cr.status = 'APPROVING' LIMIT 1) AS current_approver_name`;
const LIST_FROM = `FROM approval_documents d
  LEFT JOIN approval_forms f ON f.id = d.form_id
  LEFT JOIN users du ON du.id = d.drafter_id`;

export const BOX_TYPES = ["PENDING", "UPCOMING", "DRAFTING", "DRAFTS", "DONE", "APPROVED_BY_ME", "MINE"] as const;
type BoxType = (typeof BOX_TYPES)[number];

/** 문서함별 WHERE (항상 본인 기준 — 다른 사람 문서는 결재선에 있을 때만 나온다). */
function boxWhere(type: BoxType, userId: string): { sql: string; binds: unknown[] } {
  const inRoute = (statuses: string, docStatus?: string) => ({
    sql: `EXISTS (SELECT 1 FROM approval_routes r WHERE r.document_id = d.id AND r.actor_user_id = ? AND r.role = 'APPROVER' AND r.status IN (${statuses}))`
      + (docStatus ? ` AND d.status = '${docStatus}'` : ""),
    binds: [userId],
  });
  switch (type) {
    case "PENDING": return inRoute("'APPROVING'", "IN_PROGRESS");          // 결재 대기 (내 차례)
    case "UPCOMING": return inRoute("'PENDING'", "IN_PROGRESS");           // 결재 예정 (앞 결재 진행 중)
    case "APPROVED_BY_ME": return inRoute("'APPROVED','REJECTED'");        // 내가 결재한 문서
    case "DRAFTING": return { sql: "d.drafter_id = ? AND d.status = 'IN_PROGRESS'", binds: [userId] };   // 기안 진행
    case "DRAFTS": return { sql: "d.drafter_id = ? AND d.status IN ('DRAFT','RECALLED')", binds: [userId] }; // 임시·회수
    case "DONE": return { sql: "d.drafter_id = ? AND d.status IN ('COMPLETED','REJECTED')", binds: [userId] }; // 완료·반려
    case "MINE": return { sql: "d.drafter_id = ?", binds: [userId] };     // 내 기안 전체
  }
}

function shapeListRow(r: Record<string, unknown>) {
  return { ...r, is_urgent: !!r.is_urgent };
}

approvalApp.get("/box", async (c) => {
  const v = await requireUser(c);
  const type = (c.req.query("type") || "PENDING").toUpperCase() as BoxType;
  if (!BOX_TYPES.includes(type)) return fail(c, 400, `type은 ${BOX_TYPES.join(", ")} 중 하나입니다.`);
  const { limit, offset, page } = paging(c);
  const w = boxWhere(type, v.id);
  const rows = await c.env.DB.prepare(
    `SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${w.sql} ORDER BY d.is_urgent DESC, d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`,
  ).bind(...w.binds, limit + 1, offset).all<Record<string, unknown>>();
  const list = rows.results || [];
  return c.json({ ok: true, type, page, limit, hasMore: list.length > limit, documents: list.slice(0, limit).map(shapeListRow) });
});

approvalApp.get("/home", async (c) => {
  const v = await requireUser(c);
  const db = c.env.DB;
  const counts = BOX_TYPES.map((t) => {
    const w = boxWhere(t, v.id);
    return db.prepare(`SELECT COUNT(*) AS n FROM approval_documents d WHERE ${w.sql}`).bind(...w.binds);
  });
  const pw = boxWhere("PENDING", v.id);
  const res = await db.batch<Record<string, unknown>>([
    ...counts,
    db.prepare(`SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${pw.sql} ORDER BY d.is_urgent DESC, d.submitted_at ASC LIMIT 5`).bind(...pw.binds),
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(v.id),
    db.prepare("SELECT id, type, ref_type, ref_id, title, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5").bind(v.id),
  ]);
  const boxCounts: Record<string, number> = {};
  BOX_TYPES.forEach((t, i) => { boxCounts[t] = Number((res[i].results?.[0] as { n?: number } | undefined)?.n ?? 0); });
  const k = BOX_TYPES.length;
  return c.json({
    ok: true,
    counts: boxCounts,
    pending: (res[k].results || []).map(shapeListRow),
    unreadNotifications: Number((res[k + 1].results?.[0] as { n?: number } | undefined)?.n ?? 0),
    notifications: res[k + 2].results || [],
  });
});

// ---------- 양식·사용자 ----------

approvalApp.get("/forms", async (c) => {
  const v = await requireUser(c);
  const rows = await c.env.DB.prepare(
    "SELECT id, code, name, category, description, body_template, default_route_json FROM approval_forms WHERE is_active = 1 ORDER BY sort_order, name",
  ).all<{ id: string; code: string; name: string; category: string; description: string | null; body_template: string | null; default_route_json: string | null }>();
  const forms = [];
  for (const f of rows.results || []) {
    const tokens = parseRouteTokens(f.default_route_json);
    let preview: { user_id: string; name: string; source: string }[] = [];
    let route_error: string | null = null;
    try {
      const specs = await resolveRoute(c.env.DB, v.id, tokens, false);
      const names = await namesOf(c.env.DB, specs.map((s) => s.user_id));
      preview = specs.map((s) => ({ user_id: s.user_id, name: names[s.user_id] || "", source: s.source }));
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      route_error = e.message;
    }
    const { default_route_json: _j, ...rest } = f;
    forms.push({ ...rest, default_route: tokens, route_preview: preview, route_error });
  }
  return c.json({ ok: true, forms });
});

async function namesOf(db: D1Database, ids: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return {};
  const r = await db.prepare(`SELECT id, name FROM users WHERE id IN (${uniq.map(() => "?").join(",")})`).bind(...uniq).all<{ id: string; name: string }>();
  return Object.fromEntries((r.results || []).map((x) => [x.id, x.name]));
}

approvalApp.get("/users", async (c) => {
  await requireUser(c);
  const q = (c.req.query("q") || "").trim().slice(0, 50);
  const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.coaching_role, u.department_id, dp.name AS department_name
     FROM users u LEFT JOIN departments dp ON dp.id = u.department_id
     WHERE u.status = 'active' ${q ? "AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')" : ""}
     ORDER BY u.name LIMIT 30`,
  ).bind(...(q ? [like, like] : [])).all();
  return c.json({ ok: true, users: rows.results || [] });
});

// ---------- 문서 ----------

function parseTitle(v: unknown, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  const t = typeof v === "string" ? v.trim().replace(/[\r\n]+/g, " ") : "";
  if (!t) throw new ApprovalError(400, "제목을 입력하세요.");
  if (t.length > MAX_TITLE) throw new ApprovalError(400, `제목은 ${MAX_TITLE}자까지입니다.`);
  return t;
}

function parseBody(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ApprovalError(400, "본문은 텍스트여야 합니다.");
  if (v.length > MAX_BODY) throw new ApprovalError(400, `본문은 ${MAX_BODY}자까지입니다.`);
  return v;
}

approvalApp.post("/documents", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  const formKey = typeof b.form_id === "string" ? b.form_id : typeof b.form_code === "string" ? b.form_code : "";
  if (!formKey) return fail(c, 400, "양식을 선택하세요 (form_id 또는 form_code).");
  const form = await c.env.DB.prepare(
    "SELECT id, body_template, default_route_json FROM approval_forms WHERE (id = ? OR code = ?) AND is_active = 1",
  ).bind(formKey, formKey).first<{ id: string; body_template: string | null; default_route_json: string | null }>();
  if (!form) return fail(c, 404, "양식을 찾을 수 없습니다.");
  const title = parseTitle(b.title, true)!;
  const bodyText = parseBody(b.body) ?? form.body_template ?? "";
  // 결재선 (b): 양식 기본 결재선 자동 적용, 기안자가 routes를 주면 그걸 쓴다.
  const routes = Array.isArray(b.routes)
    ? await resolveRoute(c.env.DB, v.id, b.routes, true)
    : await resolveRoute(c.env.DB, v.id, parseRouteTokens(form.default_route_json), false);
  const id = await createDraft(c.env.DB, v, { formId: form.id, title, bodyText, isUrgent: b.is_urgent === true, routes }, metaOf(c));
  if (b.submit === true) {
    const doc = (await loadDoc(c.env.DB, id))!;
    const r = await performAction(c.env.DB, doc, await loadRoutes(c.env.DB, id), v, "SUBMIT", null, metaOf(c), c.env);
    afterCommit(c, r.notifications.map((n) => n.id), null);
  }
  return c.json({ ok: true, id, document: await detail(c.env.DB, v, id) }, 201);
});

/** 상세 응답 (호출 전에 권한 확인을 끝낸 상태여야 한다). */
async function detail(db: D1Database, v: SessionUser, id: string) {
  const doc = await loadDoc(db, id);
  if (!doc) return null;
  const routes = await loadRoutes(db, id);
  const [form, drafter, audit] = await Promise.all([
    db.prepare("SELECT id, code, name, category FROM approval_forms WHERE id = ?").bind(doc.form_id).first(),
    db.prepare(
      "SELECT u.id, u.name, u.email, dp.name AS department_name FROM users u LEFT JOIN departments dp ON dp.id = u.department_id WHERE u.id = ?",
    ).bind(doc.drafter_id).first(),
    db.prepare(
      `SELECT a.id, a.action, a.before_status, a.after_status, a.comment, a.created_at, a.actor_user_id, u.name AS actor_name
       FROM approval_audit a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.document_id = ? ORDER BY a.created_at, a.id`,
    ).bind(id).all(),
  ]);
  const names = await namesOf(db, routes.map((r) => r.actor_user_id));
  const deptIds = [...new Set(routes.map((r) => r.actor_dept_id).filter((x): x is string => !!x))];
  const depts = deptIds.length
    ? Object.fromEntries(((await db.prepare(`SELECT id, name FROM departments WHERE id IN (${deptIds.map(() => "?").join(",")})`)
      .bind(...deptIds).all<{ id: string; name: string }>()).results || []).map((d) => [d.id, d.name]))
    : {};
  return {
    ...doc,
    is_urgent: !!doc.is_urgent,
    form,
    drafter,
    routes: routes.map((r) => ({
      id: r.id, step_no: r.step_no, role: r.role, actor_user_id: r.actor_user_id, actor_name: names[r.actor_user_id] || "",
      actor_dept_id: r.actor_dept_id, actor_dept_name: r.actor_dept_id ? depts[r.actor_dept_id] || null : null,
      source: r.source, status: r.status, acted_at: r.acted_at, comment: r.comment,
    })),
    audit: audit.results || [],
    actions: availableActions(doc, routes, v),
    editable: doc.drafter_id === v.id && (doc.status === "DRAFT" || doc.status === "RECALLED"),
  };
}

approvalApp.get("/documents/:id", async (c) => {
  const v = await requireUser(c);
  const id = c.req.param("id");
  const doc = await loadDoc(c.env.DB, id);
  if (!doc || !canView(v, doc, await loadRoutes(c.env.DB, id))) return fail(c, 404, "문서를 찾을 수 없습니다.");
  return c.json({ ok: true, document: await detail(c.env.DB, v, id) });
});

approvalApp.patch("/documents/:id", async (c) => {
  const v = await requireWriter(c);
  const id = c.req.param("id");
  const doc = await loadDoc(c.env.DB, id);
  if (!doc || !canView(v, doc, await loadRoutes(c.env.DB, id))) return fail(c, 404, "문서를 찾을 수 없습니다.");
  const b = await readJson(c);
  if (typeof b.version === "number" && b.version !== doc.version) {
    return fail(c, 409, "문서가 그 사이에 바뀌었습니다. 새로고침 후 다시 시도하세요.");
  }
  if (doc.drafter_id !== v.id) return fail(c, 403, "기안자만 수정할 수 있습니다.");
  if (doc.status !== "DRAFT" && doc.status !== "RECALLED") {
    return fail(c, 409, "상신한 문서는 수정할 수 없습니다. 고치려면 먼저 회수하세요.");
  }
  const routes = Array.isArray(b.routes) ? await resolveRoute(c.env.DB, v.id, b.routes, true) : undefined;
  await editDraft(c.env.DB, doc, v, {
    title: parseTitle(b.title, false),
    bodyText: parseBody(b.body),
    isUrgent: typeof b.is_urgent === "boolean" ? b.is_urgent : undefined,
    routes,
  }, metaOf(c));
  return c.json({ ok: true, document: await detail(c.env.DB, v, id) });
});

approvalApp.post("/documents/:id/actions", async (c) => {
  const v = await requireWriter(c);
  const id = c.req.param("id");
  const b = await readJson(c);
  const action = (typeof b.action === "string" ? b.action.toUpperCase() : "") as Action;
  if (!ACTIONS.includes(action)) return fail(c, 400, `action은 ${ACTIONS.join(", ")} 중 하나입니다.`);
  const doc = await loadDoc(c.env.DB, id);
  const routes = doc ? await loadRoutes(c.env.DB, id) : [];
  // 결재선 밖 사용자는 문서 존재도 모른다 (404). 예외: hr_admin의 강제 반려.
  const visible = !!doc && (canView(v, doc, routes) || (action === "FORCE_REJECT" && v.role === "hr_admin"));
  if (!doc || !visible) return fail(c, 404, "문서를 찾을 수 없습니다.");
  if (typeof b.version === "number" && b.version !== doc.version) {
    return fail(c, 409, "문서가 그 사이에 바뀌었습니다. 새로고침 후 다시 시도하세요.");
  }
  const r = await performAction(c.env.DB, doc, routes, v, action, b.comment, metaOf(c), c.env);
  afterCommit(c, r.notifications.map((n) => n.id), r.runHook ? id : null);
  return c.json({
    ok: true, action: r.action, before: r.before, after: r.after,
    document: canView(v, doc, routes) ? await detail(c.env.DB, v, id) : null,
  });
});

// ---------- 알림 ----------

approvalApp.get("/notifications", async (c) => {
  const v = await requireUser(c);
  const { limit, offset, page } = paging(c);
  const unreadOnly = c.req.query("unread") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT id, type, ref_type, ref_id, title, link, read_at, created_at FROM notifications
     WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).bind(v.id, limit + 1, offset).all();
  const list = rows.results || [];
  return c.json({ ok: true, page, limit, hasMore: list.length > limit, notifications: list.slice(0, limit) });
});

approvalApp.post("/notifications/read", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  const now = new Date().toISOString();
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 98) : null; // D1 바인드 상한 100 = now + user_id + id 98개
  if (ids && !ids.length) return c.json({ ok: true, updated: 0 });
  const r = ids
    ? await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(now, v.id, ...ids).run()
    : await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now, v.id).run();
  return c.json({ ok: true, updated: r.meta.changes ?? 0 });
});

// ---------- 관리 (hr_admin): 부서·부서장·소속 ----------

async function requireAdmin(c: C): Promise<void> {
  if (!originOk(c)) throw new ApprovalError(403, "허용되지 않는 요청입니다.");
  if (!(await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret")))) {
    throw new ApprovalError(403, "hr_admin만 사용할 수 있습니다.");
  }
}

approvalApp.get("/admin/departments", async (c) => {
  await requireAdmin(c);
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.code, d.name, d.manager_user_id, m.name AS manager_name, d.parent_id, d.sort_order, d.is_active,
       (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status = 'active') AS member_count
     FROM departments d LEFT JOIN users m ON m.id = d.manager_user_id ORDER BY d.sort_order, d.name`,
  ).all();
  return c.json({ ok: true, departments: rows.results || [] });
});

approvalApp.post("/admin/departments", async (c) => {
  await requireAdmin(c);
  const b = await readJson(c);
  const code = typeof b.code === "string" ? b.code.trim().slice(0, 50) : "";
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
  if (!code || !name) return fail(c, 400, "부서 코드와 이름을 입력하세요.");
  const id = typeof b.id === "string" && b.id ? b.id : uid("dept");
  const manager = typeof b.manager_user_id === "string" && b.manager_user_id ? b.manager_user_id : null;
  const parent = typeof b.parent_id === "string" && b.parent_id ? b.parent_id : null;
  if (manager && !(await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND status = 'active'").bind(manager).first())) {
    return fail(c, 400, "부서장으로 지정한 사용자를 찾을 수 없거나 비활성 상태입니다.");
  }
  if (parent && (parent === id || !(await c.env.DB.prepare("SELECT 1 AS x FROM departments WHERE id = ?").bind(parent).first()))) {
    return fail(c, 400, "상위 부서가 올바르지 않습니다.");
  }
  const sort = typeof b.sort_order === "number" ? Math.trunc(b.sort_order) : 0;
  const active = b.is_active === false ? 0 : 1;
  try {
    await c.env.DB.prepare(
      `INSERT INTO departments (id, code, name, manager_user_id, parent_id, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, manager_user_id = excluded.manager_user_id,
         parent_id = excluded.parent_id, sort_order = excluded.sort_order, is_active = excluded.is_active, updated_at = datetime('now')`,
    ).bind(id, code, name, manager, parent, sort, active).run();
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) return fail(c, 409, "같은 부서 코드가 이미 있습니다.");
    throw e;
  }
  return c.json({ ok: true, id });
});

approvalApp.put("/admin/users/:id/department", async (c) => {
  await requireAdmin(c);
  const b = await readJson(c);
  const dept = typeof b.department_id === "string" && b.department_id ? b.department_id : null;
  if (dept && !(await c.env.DB.prepare("SELECT 1 AS x FROM departments WHERE id = ?").bind(dept).first())) {
    return fail(c, 400, "부서를 찾을 수 없습니다.");
  }
  const r = await c.env.DB.prepare("UPDATE users SET department_id = ? WHERE id = ?").bind(dept, c.req.param("id")).run();
  if (!r.meta.changes) return fail(c, 404, "사용자를 찾을 수 없습니다.");
  return c.json({ ok: true, department_id: dept });
});
