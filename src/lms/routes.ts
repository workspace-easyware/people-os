// 강의실(LMS) API (2026-11-17). index.ts에서 "/api/lms"에 mount한다 (경로는 mount 기준 상대).
// 로그인 필수 (익명 401). 진도의 user_id는 항상 세션 사용자 id — 본문·쿼리로 받지 않는다.
//   GET    /courses                  과정 목록 (+lesson_count, completed_count)
//   GET    /courses/:id              과정 상세 + 강의 목록 (r2_key는 내보내지 않는다)
//   GET    /summary                  홈 카드용 요약 + 다음 강의
//   POST   /lessons/:id/progress     진도 저장 → progress.ts (O1)
//   GET    /lessons/:id/video        R2 영상 스트리밍 → stream.ts (O1)
//   POST   /admin/courses            과정 upsert (hr_admin 또는 X-Admin-Secret)
//   POST   /admin/lessons            강의 upsert
//   DELETE /admin/courses/:id        과정 + 소속 강의 + 진도 삭제 (R2 객체는 남긴다)
//   DELETE /admin/lessons/:id        강의 + 진도 삭제 (R2 객체는 남긴다)
// 스키마 누락(migration 0023 미적용)은 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest, type SessionUser } from "../auth";
import { uid } from "../lib";
import { handleVideo } from "./stream";
import { saveProgress } from "./progress";

export type LmsEnv = { DB: D1Database; FILES: R2Bucket; ADMIN_SECRET?: string };

type C = Context<{ Bindings: LmsEnv }>;
export const lmsApp = new Hono<{ Bindings: LmsEnv }>();

const SCHEMA_MSG = "강의실 스키마가 아직 적용되지 않았습니다 (migration 0023)";
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CATEGORIES = ["JOB", "LEGAL", "SAFETY", "COACHING"];
const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"];

function fail(c: C, status: number, error: string) {
  return c.json({ ok: false, error }, status as 400);
}

/** LMS 테이블 누락만 503으로 본다. 다른 테이블·컬럼 누락(예: users)은 진짜 오류로 500에 남긴다. */
function isSchemaMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(m) && /lms_/i.test(m);
}

/** 유튜브 URL(watch?v= / youtu.be/ / embed/ / shorts/) 또는 11자 id에서 id를 뽑는다. 실패하면 null. */
export function extractYoutubeId(input: string): string | null {
  const s = (input || "").trim();
  if (YT_ID_RE.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] || null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m) id = m[1];
    else if (u.pathname === "/watch") id = u.searchParams.get("v");
  }
  return id && YT_ID_RE.test(id) ? id : null;
}

function noStore(c: C) {
  c.header("cache-control", "no-store");
}

/** 로그인 확인. 없으면 401 응답을 돌려준다. */
async function requireViewer(c: C): Promise<{ v: SessionUser } | { res: Response }> {
  const v = await getSessionUser(c.env, c.req.header("cookie"));
  if (!v) return { res: fail(c, 401, "로그인이 필요합니다.") };
  return { v };
}

async function requireAdmin(c: C): Promise<Response | null> {
  const ok = await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret"));
  return ok ? null : fail(c, 403, "관리자 권한이 필요합니다.");
}

function thumbOf(row: { thumbnail_url: string | null; first_youtube_id?: string | null }): string | null {
  if (row.thumbnail_url) return row.thumbnail_url;
  return row.first_youtube_id ? `https://i.ytimg.com/vi/${row.first_youtube_id}/mqdefault.jpg` : null;
}

function intOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// 스키마 누락 → 503 (모든 라우트 공통).
lmsApp.onError((e, c) => {
  if (isSchemaMissing(e)) return c.json({ ok: false, error: SCHEMA_MSG }, 503);
  console.error("lms error", e);
  return c.json({ ok: false, error: "강의실 처리 중 오류가 발생했습니다." }, 500);
});

// ---- 조회 ----

lmsApp.get("/courses", async (c) => {
  const g = await requireViewer(c);
  if ("res" in g) return g.res;
  const admin = g.v.role === "hr_admin";
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.description, c.category, c.thumbnail_url, c.ord, c.status,
       (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id) AS lesson_count,
       (SELECT COUNT(*) FROM lms_lessons l JOIN lms_progress p ON p.lesson_id = l.id AND p.user_id = ?1
          WHERE l.course_id = c.id AND p.completed_at IS NOT NULL) AS completed_count,
       (SELECT l.youtube_id FROM lms_lessons l WHERE l.course_id = c.id AND l.source = 'youtube'
          ORDER BY l.ord LIMIT 1) AS first_youtube_id
     FROM lms_courses c
     ${admin ? "" : "WHERE c.status = 'PUBLISHED'"}
     ORDER BY c.ord, c.created_at`,
  ).bind(g.v.id).all<{
    id: string; title: string; description: string | null; category: string; thumbnail_url: string | null;
    ord: number; status: string; lesson_count: number; completed_count: number; first_youtube_id: string | null;
  }>();
  noStore(c);
  return c.json({
    ok: true,
    courses: (rows.results || []).map((r) => ({
      id: r.id, title: r.title, description: r.description, category: r.category,
      thumbnail: thumbOf(r), lesson_count: r.lesson_count, completed_count: r.completed_count,
      ...(admin ? { status: r.status } : {}),
    })),
  });
});

lmsApp.get("/courses/:id", async (c) => {
  const g = await requireViewer(c);
  if ("res" in g) return g.res;
  const admin = g.v.role === "hr_admin";
  const course = await c.env.DB.prepare(
    "SELECT id, title, description, category, thumbnail_url, ord, status FROM lms_courses WHERE id = ?",
  ).bind(c.req.param("id")).first<{
    id: string; title: string; description: string | null; category: string; thumbnail_url: string | null; ord: number; status: string;
  }>();
  if (!course || (course.status !== "PUBLISHED" && !admin)) return fail(c, 404, "과정을 찾을 수 없습니다.");
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.ord, l.title, l.source, l.youtube_id, l.start_sec, l.end_sec, l.duration_sec, l.curator_note,
            p.completed_at, p.position_sec
     FROM lms_lessons l LEFT JOIN lms_progress p ON p.lesson_id = l.id AND p.user_id = ?1
     WHERE l.course_id = ?2 ORDER BY l.ord`,
  ).bind(g.v.id, course.id).all<{
    id: string; ord: number; title: string; source: string; youtube_id: string | null; start_sec: number | null;
    end_sec: number | null; duration_sec: number | null; curator_note: string | null;
    completed_at: string | null; position_sec: number | null;
  }>();
  const lessons = (rows.results || []).map((l) => ({
    id: l.id, ord: l.ord, title: l.title, source: l.source, youtube_id: l.youtube_id,
    start_sec: l.start_sec, end_sec: l.end_sec, duration_sec: l.duration_sec, curator_note: l.curator_note,
    completed: !!l.completed_at, completed_at: l.completed_at, position_sec: l.position_sec ?? 0,
  }));
  const firstYt = lessons.find((l) => l.source === "youtube")?.youtube_id ?? null;
  noStore(c);
  return c.json({
    ok: true,
    course: {
      id: course.id, title: course.title, description: course.description, category: course.category,
      thumbnail: thumbOf({ thumbnail_url: course.thumbnail_url, first_youtube_id: firstYt }),
      ...(admin ? { status: course.status } : {}),
      lesson_count: lessons.length, completed_count: lessons.filter((l) => l.completed).length,
    },
    lessons,
  });
});

lmsApp.get("/summary", async (c) => {
  const g = await requireViewer(c);
  if ("res" in g) return g.res;
  const tot = await c.env.DB.prepare(
    `SELECT COUNT(*) AS lesson_count,
            COUNT(p.completed_at) AS completed_count
     FROM lms_lessons l
     JOIN lms_courses c ON c.id = l.course_id AND c.status = 'PUBLISHED'
     LEFT JOIN lms_progress p ON p.lesson_id = l.id AND p.user_id = ?1`,
  ).bind(g.v.id).first<{ lesson_count: number; completed_count: number }>();
  const next = await c.env.DB.prepare(
    `SELECT c.id AS course_id, c.title AS course_title, l.id AS lesson_id, l.title AS lesson_title
     FROM lms_lessons l
     JOIN lms_courses c ON c.id = l.course_id AND c.status = 'PUBLISHED'
     LEFT JOIN lms_progress p ON p.lesson_id = l.id AND p.user_id = ?1
     WHERE p.completed_at IS NULL
     ORDER BY c.ord, c.created_at, l.ord LIMIT 1`,
  ).bind(g.v.id).first<{ course_id: string; course_title: string; lesson_id: string; lesson_title: string }>();
  noStore(c);
  return c.json({
    ok: true,
    lesson_count: tot?.lesson_count ?? 0,
    completed_count: tot?.completed_count ?? 0,
    next: next ?? null,
  });
});

// ---- 진도·영상 (구현은 progress.ts / stream.ts) ----

lmsApp.post("/lessons/:id/progress", async (c) => {
  // 세션 필수: X-Admin-Secret만으로는 401 (getSessionUser는 쿠키만 본다).
  const g = await requireViewer(c);
  if ("res" in g) return g.res;
  let body: { completed?: unknown; position_sec?: unknown } = {};
  try {
    body = (await c.req.json()) || {};
  } catch {
    return fail(c, 400, "JSON 본문이 필요합니다.");
  }
  const input: { completed?: boolean; position_sec?: number } = {};
  if (body.completed !== undefined) {
    if (typeof body.completed !== "boolean") return fail(c, 400, "completed는 true/false여야 합니다.");
    input.completed = body.completed;
  }
  if (body.position_sec !== undefined) {
    const n = Number(body.position_sec);
    if (!Number.isFinite(n) || n < 0) return fail(c, 400, "position_sec는 0 이상의 숫자여야 합니다.");
    input.position_sec = Math.floor(n);
  }
  // user_id는 body에서 받지 않는다 — 세션 사용자만.
  const r = await saveProgress(c.env, g.v.id, c.req.param("id"), input);
  noStore(c);
  if (!r.ok) return fail(c, r.status, r.error);
  const { ok: _ok, ...rest } = r;
  return c.json({ ok: true, ...rest });
});

lmsApp.get("/lessons/:id/video", (c) => handleVideo(c));

// ---- 관리자 ----

lmsApp.post("/admin/courses", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let b: Record<string, unknown>;
  try {
    b = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return fail(c, 400, "JSON 본문이 필요합니다.");
  }
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return fail(c, 400, "title이 필요합니다.");
  const category = b.category === undefined ? undefined : String(b.category);
  if (category !== undefined && !CATEGORIES.includes(category)) return fail(c, 400, `category는 ${CATEGORIES.join("|")} 중 하나여야 합니다.`);
  const status = b.status === undefined ? undefined : String(b.status);
  if (status !== undefined && !STATUSES.includes(status)) return fail(c, 400, `status는 ${STATUSES.join("|")} 중 하나여야 합니다.`);
  const ord = b.ord === undefined ? undefined : Number(b.ord);
  if (ord !== undefined && !Number.isInteger(ord)) return fail(c, 400, "ord는 정수여야 합니다.");
  const description = typeof b.description === "string" ? b.description : null;
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : uid("course");
  const admin = await getSessionUser(c.env, c.req.header("cookie"));
  await c.env.DB.prepare(
    `INSERT INTO lms_courses (id, title, description, category, ord, status, created_by)
     VALUES (?1, ?2, ?3, COALESCE(?4, 'JOB'), COALESCE(?5, 0), COALESCE(?6, 'PUBLISHED'), ?7)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = COALESCE(?3, lms_courses.description),
       category = COALESCE(?4, lms_courses.category),
       ord = COALESCE(?5, lms_courses.ord),
       status = COALESCE(?6, lms_courses.status),
       updated_at = datetime('now')`,
  ).bind(id, title, description, category ?? null, ord ?? null, status ?? null, admin?.id ?? null).run();
  return c.json({ ok: true, id });
});

lmsApp.post("/admin/lessons", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  let b: Record<string, unknown>;
  try {
    b = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return fail(c, 400, "JSON 본문이 필요합니다.");
  }
  const courseId = typeof b.course_id === "string" ? b.course_id.trim() : "";
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const ord = Number(b.ord);
  if (!courseId || !title || !Number.isInteger(ord) || ord < 0) return fail(c, 400, "course_id, title, ord(정수)가 필요합니다.");
  const course = await c.env.DB.prepare("SELECT id FROM lms_courses WHERE id = ?").bind(courseId).first();
  if (!course) return fail(c, 400, "course_id에 해당하는 과정이 없습니다.");

  // 소스: youtube_url | youtube_id | r2_key 중 하나.
  let source: "youtube" | "r2";
  let youtubeId: string | null = null;
  let r2Key: string | null = null;
  let contentType: string | null = null;
  let sizeBytes: number | null = null;
  if (typeof b.r2_key === "string" && b.r2_key.trim()) {
    if (b.youtube_url || b.youtube_id) return fail(c, 400, "youtube와 r2_key를 함께 줄 수 없습니다.");
    source = "r2";
    r2Key = b.r2_key.trim();
    const head = await c.env.FILES.head(r2Key);
    if (!head) return fail(c, 400, "R2에 해당 객체가 없습니다.");
    sizeBytes = head.size;
    contentType = head.httpMetadata?.contentType || "video/mp4";
  } else {
    const raw = typeof b.youtube_url === "string" ? b.youtube_url : typeof b.youtube_id === "string" ? b.youtube_id : "";
    if (!raw) return fail(c, 400, "youtube_url, youtube_id, r2_key 중 하나가 필요합니다.");
    youtubeId = extractYoutubeId(raw);
    if (!youtubeId) return fail(c, 400, "유튜브 영상 id(11자)를 확인할 수 없습니다.");
    source = "youtube";
  }
  const startSec = intOrNull(b.start_sec);
  const endSec = intOrNull(b.end_sec);
  const durSec = intOrNull(b.duration_sec);
  if (startSec === undefined && b.start_sec !== undefined) return fail(c, 400, "start_sec는 0 이상의 정수여야 합니다.");
  if (endSec === undefined && b.end_sec !== undefined) return fail(c, 400, "end_sec는 0 이상의 정수여야 합니다.");
  if (durSec === undefined && b.duration_sec !== undefined) return fail(c, 400, "duration_sec는 0 이상의 정수여야 합니다.");
  if (startSec != null && endSec != null && endSec <= startSec) return fail(c, 400, "end_sec는 start_sec보다 커야 합니다.");
  const note = typeof b.curator_note === "string" ? b.curator_note : null;
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : uid("les");

  try {
    await c.env.DB.prepare(
      `INSERT INTO lms_lessons (id, course_id, ord, title, source, youtube_id, r2_key, start_sec, end_sec, duration_sec, content_type, size_bytes, curator_note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(id) DO UPDATE SET
         course_id = excluded.course_id, ord = excluded.ord, title = excluded.title, source = excluded.source,
         youtube_id = excluded.youtube_id, r2_key = excluded.r2_key, start_sec = excluded.start_sec, end_sec = excluded.end_sec,
         duration_sec = excluded.duration_sec, content_type = excluded.content_type, size_bytes = excluded.size_bytes,
         curator_note = excluded.curator_note`,
    ).bind(id, courseId, ord, title, source, youtubeId, r2Key, startSec ?? null, endSec ?? null, durSec ?? null, contentType, sizeBytes, note).run();
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) {
      return fail(c, 409, "같은 과정에 같은 순서(ord)의 강의가 이미 있습니다.");
    }
    throw e;
  }
  return c.json({ ok: true, id });
});

lmsApp.delete("/admin/courses/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT id FROM lms_courses WHERE id = ?").bind(id).first();
  if (!exists) return fail(c, 404, "과정을 찾을 수 없습니다.");
  // 진도 → 강의 → 과정 순으로 한 batch에서 지운다 (외래키 없음). R2 객체는 지우지 않는다.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM lms_progress WHERE lesson_id IN (SELECT id FROM lms_lessons WHERE course_id = ?1)").bind(id),
    c.env.DB.prepare("DELETE FROM lms_lessons WHERE course_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM lms_courses WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true, id });
});

lmsApp.delete("/admin/lessons/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT id FROM lms_lessons WHERE id = ?").bind(id).first();
  if (!exists) return fail(c, 404, "강의를 찾을 수 없습니다.");
  // 외래키가 없으므로 진도 행을 같은 batch에서 함께 지운다. R2 객체는 지우지 않는다.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM lms_progress WHERE lesson_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM lms_lessons WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true, id });
});
