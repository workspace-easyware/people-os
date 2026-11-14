// S4 M3 — Datasets API (S4 설계서 §8). M6이 `app.route("/api/obs", datasetsApp)`로 마운트한다
// (경로는 마운트 지점 기준 상대: `/datasets`, `/datasets/:id`, ...).
// 읽기는 공개(PII 마스킹), 쓰기(생성·수정·시드·승격)는 전부 관리자 게이트.
import { Hono } from "hono";
import type { Context } from "hono";
import type { EvalItem, ExpectedSource, ExpectedVerdict, ObsEnv } from "./types";
import { obsSchemaNotReadyBody, obsSchemaReady, intToBool, newId, parseJson } from "./db";
import { PromoteError, promoteTraceToItem, seedGoldenDataset } from "./seed-golden";
// 관리자 검사(X-Admin-Secret ↔ ADMIN_SECRET, 상수 시간, 미설정이면 거부)는 index.ts의 것을 쓴다 (M6-β).
import { adminAllowed } from "../index";

// PII 마스킹 (계획서 B.1 — 주민번호·휴대전화·이메일·계좌). M2의 mask.ts가 확정되면 그쪽으로 교체.
function maskPii(s: string | null): string | null {
  if (s == null) return s;
  return s
    .replace(/\d{6}-[1-4]\d{6}/g, "[주민번호]")
    .replace(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g, "[전화번호]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[이메일]")
    .replace(/\b\d{3,6}-\d{2,6}-\d{4,8}\b/g, "[계좌]");
}

type ItemRow = {
  id: string; dataset_id: string; question: string; expected_answer: string | null; expected_sources: string;
  expected_verdict: string; tags: string; source: string; origin_ref: string | null; prereq: string | null;
  active: number; created_at: string; updated_at: string;
};

function rowToItem(r: ItemRow): EvalItem {
  return {
    id: r.id,
    datasetId: r.dataset_id,
    question: maskPii(r.question) ?? "",
    expectedAnswer: maskPii(r.expected_answer),
    expectedSources: parseJson<ExpectedSource[]>(r.expected_sources, []),
    expectedVerdict: (r.expected_verdict === "ungrounded" ? "ungrounded" : "grounded") as ExpectedVerdict,
    tags: parseJson<string[]>(r.tags, []),
    source: r.source as EvalItem["source"],
    originRef: r.origin_ref,
    prereq: r.prereq,
    active: intToBool(r.active) ?? false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ITEM_COLS =
  "id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref, prereq, active, created_at, updated_at";

const SOURCES = new Set(["seed", "gap", "trace", "manual"]);
const MAX_Q = 1000;
const MAX_TEXT = 4000;

// ---- 입력 검증 ---------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseSources(v: unknown): Parsed<ExpectedSource[]> {
  if (!Array.isArray(v) || v.length > 20) return { ok: false, error: "expectedSources must be an array (max 20)" };
  const out: ExpectedSource[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") return { ok: false, error: "expectedSources entries must be objects" };
    const o = s as Record<string, unknown>;
    const e: ExpectedSource = {};
    for (const k of ["doc_id", "title_like", "article_like"] as const) {
      if (o[k] == null) continue;
      if (typeof o[k] !== "string" || (o[k] as string).length > 200) return { ok: false, error: `expectedSources.${k} must be a string` };
      e[k] = o[k] as string;
    }
    out.push(e);
  }
  return { ok: true, value: out };
}

function parseTags(v: unknown): Parsed<string[]> {
  if (!Array.isArray(v) || v.length > 30 || v.some((t) => typeof t !== "string" || t.length > 40)) {
    return { ok: false, error: "tags must be an array of short strings" };
  }
  return { ok: true, value: v as string[] };
}

function parseActive(v: unknown): Parsed<boolean> {
  if (v === true || v === 1) return { ok: true, value: true };
  if (v === false || v === 0) return { ok: true, value: false };
  return { ok: false, error: "active must be boolean" };
}

function optText(v: unknown, name: string): Parsed<string | null> {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== "string" || v.length > MAX_TEXT) return { ok: false, error: `${name} must be a string (max ${MAX_TEXT})` };
  const t = v.trim();
  return { ok: true, value: t === "" ? null : t };
}

type ItemPatch = {
  question?: string; expectedAnswer?: string | null; expectedSources?: ExpectedSource[];
  expectedVerdict?: ExpectedVerdict; tags?: string[]; prereq?: string | null; active?: boolean;
};

/** body → 부분 항목. create는 question 필수. */
function parseItemBody(body: unknown, requireQuestion: boolean): Parsed<ItemPatch & { source?: EvalItem["source"] }> {
  if (!body || typeof body !== "object") return { ok: false, error: "JSON body required" };
  const b = body as Record<string, unknown>;
  const out: ItemPatch & { source?: EvalItem["source"] } = {};
  if (b.question !== undefined || requireQuestion) {
    if (typeof b.question !== "string" || b.question.trim() === "" || b.question.length > MAX_Q) {
      return { ok: false, error: `question is required (max ${MAX_Q} chars)` };
    }
    out.question = b.question.trim();
  }
  if (b.expectedAnswer !== undefined) {
    const r = optText(b.expectedAnswer, "expectedAnswer");
    if (!r.ok) return r;
    out.expectedAnswer = r.value;
  }
  if (b.prereq !== undefined) {
    const r = optText(b.prereq, "prereq");
    if (!r.ok) return r;
    out.prereq = r.value;
  }
  if (b.expectedSources !== undefined) {
    const r = parseSources(b.expectedSources);
    if (!r.ok) return r;
    out.expectedSources = r.value;
  }
  if (b.tags !== undefined) {
    const r = parseTags(b.tags);
    if (!r.ok) return r;
    out.tags = r.value;
  }
  if (b.expectedVerdict !== undefined) {
    if (b.expectedVerdict !== "grounded" && b.expectedVerdict !== "ungrounded") {
      return { ok: false, error: "expectedVerdict must be grounded|ungrounded" };
    }
    out.expectedVerdict = b.expectedVerdict;
  }
  if (b.active !== undefined) {
    const r = parseActive(b.active);
    if (!r.ok) return r;
    out.active = r.value;
  }
  if (b.source !== undefined) {
    if (typeof b.source !== "string" || !SOURCES.has(b.source)) return { ok: false, error: "source must be seed|gap|trace|manual" };
    out.source = b.source as EvalItem["source"];
  }
  return { ok: true, value: out };
}

// ---- 라우터 --------------------------------------------------------------------------

export const datasetsApp = new Hono<{ Bindings: ObsEnv }>();

// 마이그레이션 미적용이면 503 — 앱 전체를 죽이지 않는다.
datasetsApp.use("*", async (c, next) => {
  if (!(await obsSchemaReady(c.env.DB))) return c.json(obsSchemaNotReadyBody(), 503);
  await next();
});

function requireAdmin(c: Context<{ Bindings: ObsEnv }>): Response | null {
  if (!adminAllowed(c.env, c.req.header("x-admin-secret"))) return c.json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

async function readJson(c: Context<{ Bindings: ObsEnv }>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

type DatasetRow = { id: string; name: string; description: string | null; version: number; created_at: string };

function datasetOut(d: DatasetRow, counts?: { total: number; active: number }) {
  return {
    id: d.id, name: d.name, description: d.description, version: d.version, createdAt: d.created_at,
    ...(counts ? { itemCount: counts.total, activeCount: counts.active } : {}),
  };
}

// GET /datasets — 목록(+항목 수·활성 수)
datasetsApp.get("/datasets", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT d.id, d.name, d.description, d.version, d.created_at,
              COUNT(i.id) AS total, COALESCE(SUM(i.active), 0) AS active
         FROM eval_datasets d LEFT JOIN eval_items i ON i.dataset_id = d.id
        GROUP BY d.id ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all<DatasetRow & { total: number; active: number }>();
  return c.json({ ok: true, datasets: (results ?? []).map((r) => datasetOut(r, { total: r.total, active: r.active })) });
});

// POST /datasets — 생성(관리자)
datasetsApp.post("/datasets", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const b = (await readJson(c)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) return c.json({ ok: false, error: "name is required (max 80 chars)" }, 400);
  const desc = optText(b?.description, "description");
  if (!desc.ok) return c.json({ ok: false, error: desc.error }, 400);
  const dup = await c.env.DB.prepare("SELECT id FROM eval_datasets WHERE name = ?").bind(name).first<{ id: string }>();
  if (dup) return c.json({ ok: false, error: "dataset name already exists", existingId: dup.id }, 409);
  const id = newId("ds");
  await c.env.DB.prepare("INSERT INTO eval_datasets (id, name, description, version) VALUES (?, ?, ?, 1)").bind(id, name, desc.value).run();
  const row = await c.env.DB.prepare("SELECT id, name, description, version, created_at FROM eval_datasets WHERE id = ?").bind(id).first<DatasetRow>();
  return c.json({ ok: true, dataset: datasetOut(row!) }, 201);
});

// POST /datasets/seed — 골든 시드(멱등, 관리자). :id 라우트보다 먼저 선언.
datasetsApp.post("/datasets/seed", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  try {
    const r = await seedGoldenDataset(c.env);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: `seed failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

async function loadItems(c: Context<{ Bindings: ObsEnv }>, datasetId: string, activeFilter: string | undefined) {
  const where = activeFilter === "1" || activeFilter === "true" ? " AND active = 1" : activeFilter === "0" || activeFilter === "false" ? " AND active = 0" : "";
  const { results } = await c.env.DB
    .prepare(`SELECT ${ITEM_COLS} FROM eval_items WHERE dataset_id = ?${where} ORDER BY created_at ASC, id ASC`)
    .bind(datasetId)
    .all<ItemRow>();
  return (results ?? []).map(rowToItem);
}

// GET /datasets/:id — 데이터셋 + 항목
datasetsApp.get("/datasets/:id", async (c) => {
  const d = await c.env.DB.prepare("SELECT id, name, description, version, created_at FROM eval_datasets WHERE id = ?").bind(c.req.param("id")).first<DatasetRow>();
  if (!d) return c.json({ ok: false, error: "dataset not found" }, 404);
  const items = await loadItems(c, d.id, c.req.query("active"));
  return c.json({ ok: true, dataset: datasetOut(d, { total: items.length, active: items.filter((i) => i.active).length }), items });
});

// GET /datasets/:id/items?active=1|0
datasetsApp.get("/datasets/:id/items", async (c) => {
  const d = await c.env.DB.prepare("SELECT id, version FROM eval_datasets WHERE id = ?").bind(c.req.param("id")).first<{ id: string; version: number }>();
  if (!d) return c.json({ ok: false, error: "dataset not found" }, 404);
  return c.json({ ok: true, datasetId: d.id, version: d.version, items: await loadItems(c, d.id, c.req.query("active")) });
});

async function activeDuplicate(db: D1Database, datasetId: string, question: string, exceptId?: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT id FROM eval_items WHERE dataset_id = ? AND active = 1 AND question = ? AND id <> ? LIMIT 1")
    .bind(datasetId, question, exceptId ?? "")
    .first<{ id: string }>();
  return r?.id ?? null;
}

// POST /datasets/:id/items — 항목 추가(관리자). dataset version +1.
datasetsApp.post("/datasets/:id/items", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const datasetId = c.req.param("id");
  const ds = await c.env.DB.prepare("SELECT id FROM eval_datasets WHERE id = ?").bind(datasetId).first();
  if (!ds) return c.json({ ok: false, error: "dataset not found" }, 404);
  const p = parseItemBody(await readJson(c), true);
  if (!p.ok) return c.json({ ok: false, error: p.error }, 400);
  const v = p.value;
  const active = v.active ?? true;
  if (active) {
    const dup = await activeDuplicate(c.env.DB, datasetId, v.question!);
    if (dup) return c.json({ ok: false, error: "question already an active item", existingId: dup }, 409);
  }
  const id = newId("gi");
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO eval_items (id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, prereq, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, datasetId, v.question, v.expectedAnswer ?? null, JSON.stringify(v.expectedSources ?? []),
        v.expectedVerdict ?? "grounded", JSON.stringify(v.tags ?? []), v.source ?? "manual", v.prereq ?? null, active ? 1 : 0,
      ),
    c.env.DB.prepare("UPDATE eval_datasets SET version = version + 1 WHERE id = ?").bind(datasetId),
  ]);
  const row = await c.env.DB.prepare(`SELECT ${ITEM_COLS} FROM eval_items WHERE id = ?`).bind(id).first<ItemRow>();
  const d = await c.env.DB.prepare("SELECT version FROM eval_datasets WHERE id = ?").bind(datasetId).first<{ version: number }>();
  return c.json({ ok: true, item: rowToItem(row!), datasetVersion: d?.version }, 201);
});

// PATCH /datasets/:id/items/:itemId — 부분 수정(active 토글 포함, 관리자). 수정 시 dataset version +1.
datasetsApp.patch("/datasets/:id/items/:itemId", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const datasetId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const cur = await c.env.DB
    .prepare(`SELECT ${ITEM_COLS} FROM eval_items WHERE id = ? AND dataset_id = ?`)
    .bind(itemId, datasetId)
    .first<ItemRow>();
  if (!cur) return c.json({ ok: false, error: "item not found" }, 404);
  const p = parseItemBody(await readJson(c), false);
  if (!p.ok) return c.json({ ok: false, error: p.error }, 400);
  const v = p.value;
  if (Object.keys(v).length === 0) return c.json({ ok: false, error: "no updatable fields" }, 400);

  const question = v.question ?? cur.question;
  const active = v.active ?? (cur.active !== 0);
  if (active && (v.active !== undefined || v.question !== undefined)) {
    const dup = await activeDuplicate(c.env.DB, datasetId, question, itemId);
    if (dup) return c.json({ ok: false, error: "question already an active item", existingId: dup }, 409);
  }
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE eval_items SET question = ?, expected_answer = ?, expected_sources = ?, expected_verdict = ?, tags = ?,
                prereq = ?, active = ?, updated_at = datetime('now') WHERE id = ? AND dataset_id = ?`,
      )
      .bind(
        question,
        v.expectedAnswer !== undefined ? v.expectedAnswer : cur.expected_answer,
        v.expectedSources ? JSON.stringify(v.expectedSources) : cur.expected_sources,
        v.expectedVerdict ?? cur.expected_verdict,
        v.tags ? JSON.stringify(v.tags) : cur.tags,
        v.prereq !== undefined ? v.prereq : cur.prereq,
        active ? 1 : 0,
        itemId, datasetId,
      ),
    c.env.DB.prepare("UPDATE eval_datasets SET version = version + 1 WHERE id = ?").bind(datasetId),
  ]);
  const row = await c.env.DB.prepare(`SELECT ${ITEM_COLS} FROM eval_items WHERE id = ?`).bind(itemId).first<ItemRow>();
  const d = await c.env.DB.prepare("SELECT version FROM eval_datasets WHERE id = ?").bind(datasetId).first<{ version: number }>();
  return c.json({ ok: true, item: rowToItem(row!), datasetVersion: d?.version });
});

// POST /traces/:id/promote — 트레이스 → 골든 항목(관리자). 이미 활성 항목이면 409 + 기존 id.
datasetsApp.post("/traces/:id/promote", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const b = (await readJson(c)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return c.json({ ok: false, error: "JSON body required" }, 400);
  const parsed = parseItemBody(
    { expectedAnswer: b.expectedAnswer, expectedSources: b.expectedSources, expectedVerdict: b.expectedVerdict, tags: b.tags },
    false,
  );
  if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
  if (b.datasetId !== undefined && typeof b.datasetId !== "string") return c.json({ ok: false, error: "datasetId must be a string" }, 400);
  try {
    const itemId = await promoteTraceToItem(c.env, c.req.param("id"), {
      expectedAnswer: parsed.value.expectedAnswer,
      expectedSources: parsed.value.expectedSources,
      expectedVerdict: parsed.value.expectedVerdict,
      tags: parsed.value.tags,
      datasetId: b.datasetId as string | undefined,
    });
    return c.json({ ok: true, itemId }, 201);
  } catch (e) {
    if (e instanceof PromoteError) {
      return c.json({ ok: false, error: e.message, ...(e.existingId ? { existingId: e.existingId } : {}) }, e.status);
    }
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
