// 메일함 API (2026-11-17). index.ts에서 "/api/email"에 mount한다 (경로는 mount 기준 상대).
// 로그인 필수 (익명 401). 격리: 일반 사용자는 owner_id = 본인 메일만, hr_admin은 전체(공용·미지정 포함).
// 공용/미지정(owner_id NULL)은 hr_admin만 본다. 접근 불가 메일은 존재 여부를 숨기려고 404로 답한다.
//   GET  /inbox?folder=in|out|starred&scope=mine|all|unassigned&page=&limit=
//   GET  /search?q=&page=&limit=
//   POST /send                  {to, cc?, subject, text, html?, replyToId?}
//   POST /admin/ingest?from=&to= (hr_admin 또는 X-Admin-Secret) — 원문 .eml을 수신 경로로 주입 (Email Routing 활성 전 테스트용)
//   GET  /:id                   상세 + 첨부 목록 + 같은 스레드
//   GET  /:id/attachment/:attId 첨부 다운로드 (R2)
//   POST /:id/read {read?}      읽음 표시 (기본 true)
//   POST /:id/star              별표 토글
//   POST /:id/draft             (Phase 2) AI 답장 초안 생성 — 저장만, 발송은 사람이
//   POST /:id/index             (Phase 2) 개인 RAG에 색인
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest, type SessionUser } from "../auth";
import { ingestRawEmail, MAX_RAW_BYTES } from "./inbound";
import { extractAddresses, normalizeSubject } from "./mime";
import { DAILY_SEND_LIMIT, dailySendLimitReached, EMAIL_DOMAIN, localPartFor, ResendNotConfigured, sendEmail } from "./send";
import { uid } from "../lib";

export type EmailRouteEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
};

/** Phase 2 훅: index.ts가 주입한다 (indexDocument·LLM 호출은 index.ts/ask-pipeline 쪽에 있다). */
export type EmailHooks = {
  draftReply?: (env: EmailRouteEnv, email: EmailRow) => Promise<string>;
  indexToPersonalRag?: (env: EmailRouteEnv, email: EmailRow) => Promise<{ docId: string; chunks: number; indexError?: string }>;
  /** 완전 삭제 시 색인된 개인 RAG 문서를 지운다 (벡터·청크·doc_nodes·R2·documents 행). */
  purgeIndexedDoc?: (env: EmailRouteEnv, docId: string, errors: string[]) => Promise<void>;
};
let hooks: EmailHooks = {};
export function setEmailHooks(h: EmailHooks) { hooks = h; }

type C = Context<{ Bindings: EmailRouteEnv }>;
export const emailApp = new Hono<{ Bindings: EmailRouteEnv }>();

export type EmailRow = {
  id: string; owner_id: string | null; direction: string; from_addr: string; to_addr: string; cc: string | null;
  subject: string; body_text: string | null; body_html: string | null; received_at: string; message_id: string | null;
  thread_id: string | null; is_read: number; is_starred: number; labels: string | null; raw_r2_key: string | null;
  raw_size: number | null; parse_error: string | null; ai_draft: string | null; ai_draft_at: string | null;
  indexed_doc_id: string | null; deleted_at: string | null;
};

export const TRASH_DAYS = 7;

/** 완전 삭제: 첨부 R2·행 → 원문 R2 → 색인된 개인 RAG 문서 → emails 행. 없는 객체는 무시(멱등). 단계 실패는 errors에 모으고 계속한다. */
export async function purgeEmail(env: EmailRouteEnv, row: { id: string; raw_r2_key: string | null; indexed_doc_id: string | null }): Promise<string[]> {
  const errors: string[] = [];
  const atts = await env.DB.prepare("SELECT r2_key FROM email_attachments WHERE email_id = ?").bind(row.id).all<{ r2_key: string }>();
  for (const a of atts.results || []) {
    try { await env.FILES.delete(a.r2_key); } catch (e) { errors.push(`att: ${e instanceof Error ? e.message : String(e)}`); }
  }
  await env.DB.prepare("DELETE FROM email_attachments WHERE email_id = ?").bind(row.id).run();
  if (row.raw_r2_key) {
    try { await env.FILES.delete(row.raw_r2_key); } catch (e) { errors.push(`raw: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (row.indexed_doc_id && hooks.purgeIndexedDoc) {
    try { await hooks.purgeIndexedDoc(env, row.indexed_doc_id, errors); } catch (e) { errors.push(`doc: ${e instanceof Error ? e.message : String(e)}`); }
  }
  await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(row.id).run();
  return errors;
}

/** 7일 지난 휴지통 메일 자동 완전 삭제 (15분 틱). 한 번에 최대 50통. */
export async function sweepEmailTrash(env: EmailRouteEnv): Promise<number> {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, raw_r2_key, indexed_doc_id FROM emails WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50",
  ).bind(cutoff).all<{ id: string; raw_r2_key: string | null; indexed_doc_id: string | null }>();
  let n = 0;
  for (const r of rows.results || []) { await purgeEmail(env, r); n++; }
  return n;
}

function fail(c: C, status: number, error: string) {
  return c.json({ ok: false, error }, status as 400);
}

function isSchemaMissing(e: unknown): boolean {
  return /no such table|no such column/i.test(e instanceof Error ? e.message : String(e));
}

async function viewerOf(c: C): Promise<SessionUser | null> {
  return getSessionUser(c.env, c.req.header("cookie"));
}

function canSee(v: SessionUser, ownerId: string | null): boolean {
  return v.role === "hr_admin" || (ownerId !== null && ownerId === v.id);
}

/** 목록 WHERE 조각 (격리). */
function scopeClause(v: SessionUser, scope: string | undefined): { sql: string; binds: unknown[] } {
  if (v.role !== "hr_admin") return { sql: "e.owner_id = ?", binds: [v.id] };
  if (scope === "mine") return { sql: "e.owner_id = ?", binds: [v.id] };
  if (scope === "unassigned") return { sql: "e.owner_id IS NULL", binds: [] };
  return { sql: "1=1", binds: [] };
}

function paging(c: C): { limit: number; offset: number; page: number } {
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "25", 10) || 25));
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

const LIST_COLS = `e.id, e.owner_id, e.direction, e.from_addr, e.to_addr, e.subject, substr(COALESCE(e.body_text, ''), 1, 160) AS snippet,
  e.received_at, e.deleted_at, e.is_read, e.is_starred, e.thread_id, e.parse_error IS NOT NULL AS has_parse_error,
  (SELECT COUNT(*) FROM email_attachments a WHERE a.email_id = e.id) AS attachments,
  u.name AS owner_name, u.email AS owner_email`;

function shapeList(v: SessionUser, rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    ...r,
    owner_id: undefined, owner_email: undefined, owner_name: undefined,
    owner: v.role === "hr_admin" ? (r.owner_id ? (r.owner_name || r.owner_email) : null) : undefined,
    is_read: !!r.is_read, is_starred: !!r.is_starred, has_parse_error: !!r.has_parse_error,
  }));
}

async function listQuery(c: C, v: SessionUser, extraSql: string, extraBinds: unknown[]) {
  const { limit, offset, page } = paging(c);
  const sc = scopeClause(v, c.req.query("scope"));
  const where = `${sc.sql}${extraSql ? " AND " + extraSql : ""}`;
  const trash = extraSql.includes("e.deleted_at IS NOT NULL");
  const rows = await c.env.DB.prepare(
    `SELECT ${LIST_COLS} FROM emails e LEFT JOIN users u ON u.id = e.owner_id WHERE ${where}
     ORDER BY ${trash ? "e.deleted_at" : "e.received_at"} DESC, e.id DESC LIMIT ? OFFSET ?`,
  ).bind(...sc.binds, ...extraBinds, limit + 1, offset).all<Record<string, unknown>>();
  const list = rows.results || [];
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails e WHERE ${sc.sql} AND e.direction = 'in' AND e.is_read = 0 AND e.deleted_at IS NULL`,
  ).bind(...sc.binds).first<{ n: number }>();
  return {
    ok: true, page, limit, hasMore: list.length > limit,
    emails: shapeList(v, list.slice(0, limit)),
    unread: unread?.n ?? 0,
    address: `${localPartFor(v.email)}@${EMAIL_DOMAIN}`,
  };
}

emailApp.get("/inbox", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const folder = c.req.query("folder") || "in";
  const extra = folder === "trash" ? "e.deleted_at IS NOT NULL"
    : "e.deleted_at IS NULL AND " + (folder === "out" ? "e.direction = 'out'" : folder === "starred" ? "e.is_starred = 1" : "e.direction = 'in'");
  try {
    return c.json(await listQuery(c, v, extra, []));
  } catch (e) {
    if (isSchemaMissing(e)) return fail(c, 503, "메일함 스키마가 아직 적용되지 않았습니다 (migration 0022).");
    throw e;
  }
});

emailApp.get("/search", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  if (!q) return fail(c, 400, "검색어를 입력하세요.");
  const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  try {
    const out = await listQuery(c, v,
      "e.deleted_at IS NULL AND (e.subject LIKE ? ESCAPE '\\' OR e.body_text LIKE ? ESCAPE '\\' OR e.from_addr LIKE ? ESCAPE '\\' OR e.to_addr LIKE ? ESCAPE '\\')",
      [like, like, like, like]);
    return c.json({ ...out, q });
  } catch (e) {
    if (isSchemaMissing(e)) return fail(c, 503, "메일함 스키마가 아직 적용되지 않았습니다 (migration 0022).");
    throw e;
  }
});

async function readJson(c: C): Promise<Record<string, unknown>> {
  try {
    const text = await c.req.text();
    if (text.length > 512 * 1024) return {};
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function addrList(v: unknown): string[] {
  const s = Array.isArray(v) ? v.map(String).join(",") : typeof v === "string" ? v : "";
  return extractAddresses(s);
}

/** 답장 스레딩 헤더 (Agentic Inbox buildReferencesChain/buildThreadingHeaders 대응).
 *  저장소는 원본의 References + 원본 Message-ID로 체인을 만든다. 우리는 수신 References를 따로 저장하지 않으므로
 *  같은 스레드(같은 owner)의 Message-ID들을 시간순으로 모아 체인을 만들고, 답장 대상의 ID를 맨 끝에 둔다.
 *  보낸 메일(Resend가 Message-ID를 정함 → message_id NULL)에 답장하면 스레드의 마지막 수신 ID로 대신한다. */
async function threadingHeaders(
  db: D1Database,
  orig: { owner_id: string | null; message_id: string | null; thread_id: string | null },
): Promise<Record<string, string>> {
  let ids: string[] = [];
  if (orig.thread_id) {
    const rows = await db.prepare(
      "SELECT message_id FROM emails WHERE thread_id = ? AND owner_id IS ? AND message_id IS NOT NULL ORDER BY received_at",
    ).bind(orig.thread_id, orig.owner_id).all<{ message_id: string }>();
    ids = (rows.results || []).map((r) => r.message_id);
  }
  const parent = orig.message_id || ids[ids.length - 1];
  if (!parent) return {};
  const chain = [...new Set([...ids.filter((x) => x !== parent), parent])];
  // 첫 메시지(스레드 루트)는 항상 유지하고, 헤더가 너무 길어지지 않게 뒤쪽 9개만 붙인다 (RFC 5322 3.6.4 권고와 같은 방식).
  const refs = chain.length > 10 ? [chain[0], ...chain.slice(-9)] : chain;
  return { "In-Reply-To": parent, References: refs.join(" ") };
}

emailApp.post("/send", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  if (!c.env.RESEND_API_KEY) return fail(c, 503, "Resend 미설정: 메일 발송이 아직 준비되지 않았습니다 (RESEND_API_KEY).");
  const b = await readJson(c);
  const to = addrList(b.to);
  const cc = addrList(b.cc);
  // 보안점검(2026-11-22): 제목의 줄바꿈을 지운다 (헤더 주입 방어 — 워크플로우 send_email과 같은 처리).
  const subject = typeof b.subject === "string" ? b.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
  const text = typeof b.text === "string" ? b.text.slice(0, 100_000) : "";
  const html = typeof b.html === "string" && b.html.trim() ? b.html.slice(0, 200_000) : undefined;
  if (!to.length) return fail(c, 400, "받는 사람 주소가 올바르지 않습니다.");
  if (to.length + cc.length > 20) return fail(c, 400, "받는 사람은 20명까지입니다.");
  if (!subject) return fail(c, 400, "제목을 입력하세요.");
  if (!text.trim() && !html) return fail(c, 400, "본문을 입력하세요.");
  // 보안점검(2026-11-22) Medium: 하루 발송 상한 (src/email/send.ts DAILY_SEND_LIMIT).
  if (await dailySendLimitReached(c.env.DB, v.id)) return fail(c, 429, `하루에 보낼 수 있는 메일 수(${DAILY_SEND_LIMIT}통)를 넘었습니다. 내일 다시 시도해 주세요.`);

  let threadId: string | null = null;
  const headers: Record<string, string> = {};
  if (typeof b.replyToId === "string" && b.replyToId) {
    const orig = await c.env.DB.prepare("SELECT owner_id, message_id, thread_id FROM emails WHERE id = ?")
      .bind(b.replyToId).first<{ owner_id: string | null; message_id: string | null; thread_id: string | null }>();
    if (!orig || !canSee(v, orig.owner_id)) return fail(c, 404, "답장할 메일을 찾을 수 없습니다.");
    threadId = orig.thread_id;
    Object.assign(headers, await threadingHeaders(c.env.DB, orig));
  }

  const displayName = (v.name || "").replace(/["<>\r\n]/g, "").trim();
  const fromAddr = `${localPartFor(v.email)}@${EMAIL_DOMAIN}`;
  const from = displayName ? `"${displayName}" <${fromAddr}>` : fromAddr;
  let providerId: string;
  try {
    providerId = (await sendEmail(c.env, { from, to, cc, subject, text, html, headers })).id;
  } catch (e) {
    if (e instanceof ResendNotConfigured) return fail(c, 503, e.message);
    return fail(c, 502, e instanceof Error ? e.message : String(e));
  }
  // 보낸 메일 기록 (direction='out'). 기록 실패는 발송 성공을 뒤집지 않는다.
  const id = uid("em");
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO emails (id, owner_id, direction, from_addr, to_addr, cc, subject, body_text, body_html, received_at,
         message_id, thread_id, subject_norm, provider_id, is_read, created_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
    ).bind(id, v.id, from, to.join(", "), cc.length ? cc.join(", ") : null, subject, text, html ?? null, now,
      threadId ?? id, normalizeSubject(subject), providerId, now).run();
  } catch (e) {
    console.log("[email] sent but record failed:", e instanceof Error ? e.message : String(e));
  }
  return c.json({ ok: true, id, providerId, from: fromAddr });
});

// 관리자 테스트 주입: Email Routing 활성 전에도 수신 경로(파싱·저장·owner·스레드)를 검증한다.
emailApp.post("/admin/ingest", async (c) => {
  if (!(await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret")))) return fail(c, 401, "관리자만 사용할 수 있습니다.");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.byteLength) return fail(c, 400, "원문(.eml)을 본문으로 보내세요.");
  if (buf.byteLength > MAX_RAW_BYTES) return fail(c, 413, "25MB를 넘습니다.");
  const to = c.req.query("to") || `unassigned@${EMAIL_DOMAIN}`;
  const from = c.req.query("from") || "test@example.com";
  try {
    return c.json({ ok: true, ...(await ingestRawEmail(c.env, buf, { from, to })) });
  } catch (e) {
    if (isSchemaMissing(e)) return fail(c, 503, "메일함 스키마가 아직 적용되지 않았습니다 (migration 0022).");
    throw e;
  }
});

async function loadVisible(c: C, v: SessionUser, id: string): Promise<EmailRow | null> {
  const row = await c.env.DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first<EmailRow>();
  if (!row || !canSee(v, row.owner_id)) return null;
  return row;
}

emailApp.get("/:id", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  try {
    const row = await loadVisible(c, v, c.req.param("id"));
    if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
    const atts = await c.env.DB.prepare("SELECT id, filename, content_type, size FROM email_attachments WHERE email_id = ? ORDER BY created_at, id")
      .bind(row.id).all();
    const thread = row.thread_id
      ? await c.env.DB.prepare(
        "SELECT id, direction, from_addr, subject, received_at, is_read FROM emails WHERE thread_id = ? AND owner_id IS ? ORDER BY received_at",
      ).bind(row.thread_id, row.owner_id).all()
      : { results: [] };
    let owner: string | null | undefined;
    if (v.role === "hr_admin") {
      const u = row.owner_id ? await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?").bind(row.owner_id).first<{ name: string; email: string }>() : null;
      owner = u ? (u.name || u.email) : null;
    }
    const { raw_r2_key: _rk, owner_id: _o, ...rest } = row;
    return c.json({
      ok: true,
      email: { ...rest, is_read: !!row.is_read, is_starred: !!row.is_starred, owner, has_owner: !!_o, has_raw: !!_rk },
      attachments: atts.results || [],
      thread: thread.results || [],
    });
  } catch (e) {
    if (isSchemaMissing(e)) return fail(c, 503, "메일함 스키마가 아직 적용되지 않았습니다 (migration 0022).");
    throw e;
  }
});

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

emailApp.get("/:id/attachment/:attId", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await c.env.DB.prepare(
    "SELECT a.filename, a.content_type, a.r2_key, e.owner_id FROM email_attachments a JOIN emails e ON e.id = a.email_id WHERE a.id = ? AND a.email_id = ?",
  ).bind(c.req.param("attId"), c.req.param("id")).first<{ filename: string; content_type: string | null; r2_key: string; owner_id: string | null }>();
  if (!row || !canSee(v, row.owner_id)) return fail(c, 404, "첨부를 찾을 수 없습니다.");
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return fail(c, 404, "첨부 원본이 저장소에 없습니다.");
  // 활성 콘텐츠(HTML·SVG·XML)는 같은 출처에서 렌더링되지 않게 octet-stream으로 내려준다.
  const ct = (row.content_type || "application/octet-stream").toLowerCase();
  const safeCt = /html|svg|xml|javascript/.test(ct) ? "application/octet-stream" : ct;
  return new Response(obj.body, {
    headers: {
      "content-type": safeCt,
      "content-disposition": contentDisposition(row.filename || "attachment"),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});

emailApp.post("/:id/read", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  const b = await readJson(c);
  const read = b.read === false ? 0 : 1;
  await c.env.DB.prepare("UPDATE emails SET is_read = ? WHERE id = ?").bind(read, row.id).run();
  return c.json({ ok: true, is_read: !!read });
});

emailApp.post("/:id/star", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  const next = row.is_starred ? 0 : 1;
  await c.env.DB.prepare("UPDATE emails SET is_starred = ? WHERE id = ?").bind(next, row.id).run();
  return c.json({ ok: true, is_starred: !!next });
});

// ---- Phase 2: AI 답장 초안 (저장만 — 발송은 사람이 작성 화면에서 확인 후) ----
emailApp.post("/:id/draft", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  if (!hooks.draftReply) return fail(c, 503, "AI 답장 초안이 준비되지 않았습니다.");
  try {
    const draft = (await hooks.draftReply(c.env, row)).trim();
    if (!draft) return fail(c, 502, "AI가 빈 초안을 돌려줬습니다. 다시 시도하세요.");
    const at = new Date().toISOString();
    await c.env.DB.prepare("UPDATE emails SET ai_draft = ?, ai_draft_at = ? WHERE id = ?").bind(draft, at, row.id).run();
    return c.json({ ok: true, draft, at });
  } catch (e) {
    return fail(c, 502, `AI 초안 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// ---- Phase 2: 개인 RAG 색인 (메일 소유자의 개인 공간 문서로) ----
emailApp.post("/:id/index", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  if (!row.owner_id) return fail(c, 400, "공용/미지정 메일은 개인 공간이 없어 색인할 수 없습니다.");
  if (row.indexed_doc_id) return c.json({ ok: true, docId: row.indexed_doc_id, already: true });
  if (!hooks.indexToPersonalRag) return fail(c, 503, "개인 RAG 색인이 준비되지 않았습니다.");
  const r = await hooks.indexToPersonalRag(c.env, row);
  await c.env.DB.prepare("UPDATE emails SET indexed_doc_id = ? WHERE id = ?").bind(r.docId, row.id).run();
  return c.json({ ok: true, ...r });
});

// ---- 휴지통 (2026-11-26, migration 0047): 소프트 삭제 → 복원 / 완전 삭제 / 비우기. 7일 뒤 자동 완전 삭제는 15분 크론 틱 (index.ts). ----
emailApp.post("/trash/empty", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const sc = scopeClause(v, c.req.query("scope"));
  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.raw_r2_key, e.indexed_doc_id FROM emails e WHERE ${sc.sql} AND e.deleted_at IS NOT NULL LIMIT 200`,
  ).bind(...sc.binds).all<{ id: string; raw_r2_key: string | null; indexed_doc_id: string | null }>();
  const errors: string[] = [];
  let purged = 0;
  for (const r of rows.results || []) { errors.push(...(await purgeEmail(c.env, r))); purged++; }
  return c.json({ ok: true, purged, errors });
});

emailApp.post("/:id/delete", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  if (!row.deleted_at) await c.env.DB.prepare("UPDATE emails SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  return c.json({ ok: true });
});

emailApp.post("/:id/restore", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  if (!row.deleted_at) return fail(c, 400, "휴지통에 있는 메일이 아닙니다.");
  await c.env.DB.prepare("UPDATE emails SET deleted_at = NULL WHERE id = ?").bind(row.id).run();
  return c.json({ ok: true, folder: row.direction === "out" ? "out" : "in" });
});

emailApp.post("/:id/purge", async (c) => {
  const v = await viewerOf(c);
  if (!v) return fail(c, 401, "로그인이 필요합니다.");
  const row = await loadVisible(c, v, c.req.param("id"));
  if (!row) return fail(c, 404, "메일을 찾을 수 없습니다.");
  if (!row.deleted_at) return fail(c, 400, "휴지통에 있는 메일만 완전 삭제할 수 있습니다.");
  return c.json({ ok: true, errors: await purgeEmail(c.env, row) });
});
