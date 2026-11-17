// 결재선 해석 (2026-11-17). 양식 default_route_json(["DEPT_MANAGER","HR_ADMIN"])이나 기안자가 준 routes 배열을
// 실제 사용자 id 목록으로 바꾼다.
//   DEPT_MANAGER → 기안자 부서의 부서장(departments.manager_user_id). 기안자 자신이 부서장이면 상위 부서장으로 올라간다.
//                  최상위까지 본인뿐이면 그 칸은 건너뛴다. 부서 미지정·부서장 미지정이면 기안을 거부한다 (easy-ware 규칙).
//   HR_ADMIN     → 활성 hr_admin 중 기안자가 아닌 사람(가입 순 첫 번째). 기안자 본인뿐이면 그 칸은 건너뛴다.
//   그 밖의 문자열 / {user_id} → 그 사용자 (활성 사용자만).
// 기안자 본인과 중복 결재자는 넣지 않는다. 코치는 결재자로 자동 지정하지 않는다 (코칭 관계는 결재선과 무관).
import { ApprovalError, ROUTE_TOKENS, type RouteSpec, type RouteToken } from "./types";

export const MAX_ROUTE_STEPS = 10;

type DeptRow = { id: string; manager_user_id: string | null; parent_id: string | null; is_active: number; name: string };

async function activeUser(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM users WHERE id = ? AND status = 'active'").bind(id).first();
  return !!r;
}

async function resolveDeptManager(db: D1Database, drafterId: string): Promise<RouteSpec | null> {
  const u = await db.prepare("SELECT department_id FROM users WHERE id = ?").bind(drafterId).first<{ department_id: string | null }>();
  if (!u?.department_id) throw new ApprovalError(400, "소속 부서가 지정되지 않아 부서장 결재선을 만들 수 없습니다. 인사팀에 부서 지정을 요청하세요.");
  let deptId: string | null = u.department_id;
  for (let depth = 0; deptId && depth < 10; depth++) {
    const d: DeptRow | null = await db.prepare("SELECT id, name, manager_user_id, parent_id, is_active FROM departments WHERE id = ?")
      .bind(deptId).first<DeptRow>();
    if (!d || !d.is_active) throw new ApprovalError(400, "소속 부서를 찾을 수 없습니다. 인사팀에 부서 지정을 요청하세요.");
    if (!d.manager_user_id) throw new ApprovalError(400, `'${d.name}' 부서장이 지정되지 않아 기안할 수 없습니다. 인사팀에 부서장 지정을 요청하세요.`);
    if (d.manager_user_id !== drafterId) {
      if (!(await activeUser(db, d.manager_user_id))) throw new ApprovalError(400, `'${d.name}' 부서장 계정이 비활성 상태라 기안할 수 없습니다.`);
      return { user_id: d.manager_user_id, source: "DEPT_MANAGER", dept_id: d.id };
    }
    deptId = d.parent_id; // 기안자 본인이 부서장 → 상위 부서장
  }
  return null; // 최상위 부서장 본인 → 이 칸 건너뜀
}

async function resolveHrAdmin(db: D1Database, drafterId: string): Promise<RouteSpec | null> {
  const r = await db.prepare(
    "SELECT id FROM users WHERE role = 'hr_admin' AND status = 'active' ORDER BY (id = ?), created_at, id LIMIT 1",
  ).bind(drafterId).first<{ id: string }>();
  if (!r) throw new ApprovalError(400, "활성 hr_admin 사용자가 없어 결재선을 만들 수 없습니다.");
  if (r.id === drafterId) return null;
  return { user_id: r.id, source: "HR_ADMIN", dept_id: null };
}

export function parseRouteTokens(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * items: 토큰("DEPT_MANAGER"/"HR_ADMIN"), 사용자 id 문자열, 또는 {user_id}/{token} 객체.
 * strict=true(기안자가 직접 준 결재선)면 본인 지정·중복을 오류로 알린다. false(양식 기본값)면 조용히 뺀다.
 */
export async function resolveRoute(db: D1Database, drafterId: string, items: unknown[], strict: boolean): Promise<RouteSpec[]> {
  if (items.length > MAX_ROUTE_STEPS) throw new ApprovalError(400, `결재자는 ${MAX_ROUTE_STEPS}명까지입니다.`);
  const out: RouteSpec[] = [];
  for (const raw of items) {
    let key = "";
    if (typeof raw === "string") key = raw.trim();
    else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      key = String(o.token ?? o.user_id ?? "").trim();
    }
    if (!key) throw new ApprovalError(400, "결재선 항목이 올바르지 않습니다.");
    let spec: RouteSpec | null;
    if ((ROUTE_TOKENS as readonly string[]).includes(key)) {
      spec = (key as RouteToken) === "DEPT_MANAGER" ? await resolveDeptManager(db, drafterId) : await resolveHrAdmin(db, drafterId);
    } else {
      if (key === drafterId) {
        if (strict) throw new ApprovalError(400, "본인을 결재자로 지정할 수 없습니다.");
        continue;
      }
      if (!(await activeUser(db, key))) throw new ApprovalError(400, "결재자로 지정한 사용자를 찾을 수 없거나 비활성 상태입니다.");
      spec = { user_id: key, source: "USER", dept_id: null };
    }
    if (!spec) continue;
    if (out.some((x) => x.user_id === spec!.user_id)) {
      if (strict && spec.source === "USER") throw new ApprovalError(400, "같은 사람을 결재선에 두 번 넣을 수 없습니다.");
      continue;
    }
    out.push(spec);
  }
  if (!out.length) throw new ApprovalError(400, "결재자가 없습니다. 결재선을 지정하세요.");
  return out;
}
