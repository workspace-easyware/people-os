// S4 M4 — prompt_versions (Langfuse Prompt management의 거울).
// getActivePrompt(env, name)는 ask-pipeline.ts의 임시 구현(M6-α)과 **같은 시그니처**다.
// M6-β가 ask-pipeline.ts에서 임시 함수를 지우고 이 함수를 import한다.
import type { PromptVersion } from "../ask-pipeline";
import { newId } from "./db";

// S4 이전 /api/ask system 프롬프트 원문 — migrations/0014 prompt_versions v1, ask-pipeline.ts
// ASK_SYSTEM_PROMPT_V1과 바이트 동일. 테이블이 없거나 활성 행이 없을 때의 폴백이다.
export const ASK_SYSTEM_PROMPT_V1 = "너는 HR 규정 안내 에이전트다. 주어진 근거 문서만을 근거로 한국어로 답하고, 근거에 없는 내용은 지어내지 마라. 근거 문서명을 답에 포함하라.";
export const ASK_SYSTEM_PROMPT_V1_ID = "pv_ask_system_v1";
export const PROMPT_NAMES = ["ask-system"] as const;
export const PROMPT_BODY_MAX = 4000;

export type PromptRow = {
  id: string;
  name: string;
  version: number;
  body: string;
  status: "draft" | "active" | "retired";
  note: string | null;
  created_at: string;
  activated_at: string | null;
};

function dbOf(env: unknown): D1Database | undefined {
  return (env as { DB?: D1Database } | null)?.DB;
}

/**
 * 활성 버전을 D1에서 읽는다. 테이블 없음(0014 미적용)·행 없음·조회 실패면 하드코딩 v1으로 폴백한다
 * (질문 응답이 프롬프트 저장소 때문에 깨지지 않게).
 */
export async function getActivePrompt(env: unknown, name: string): Promise<PromptVersion> {
  if (name !== "ask-system") throw new Error(`unknown prompt: ${name}`);
  const db = dbOf(env);
  if (db) {
    try {
      const row = await db
        .prepare("SELECT id, version, body FROM prompt_versions WHERE name = ? AND status = 'active' ORDER BY activated_at DESC, version DESC LIMIT 1")
        .bind(name)
        .first<{ id: string; version: number; body: string }>();
      if (row && typeof row.body === "string" && row.body.length > 0) return { id: row.id, version: row.version, body: row.body };
    } catch {
      /* no such table 등 — 폴백 */
    }
  }
  return { id: ASK_SYSTEM_PROMPT_V1_ID, version: 1, body: ASK_SYSTEM_PROMPT_V1 };
}

export async function getPromptById(env: { DB: D1Database }, id: string): Promise<PromptRow | null> {
  return (await env.DB.prepare("SELECT * FROM prompt_versions WHERE id = ?").bind(id).first<PromptRow>()) ?? null;
}

export async function listPrompts(env: { DB: D1Database }, name?: string): Promise<PromptRow[]> {
  const stmt = name
    ? env.DB.prepare("SELECT * FROM prompt_versions WHERE name = ? ORDER BY version DESC").bind(name)
    : env.DB.prepare("SELECT * FROM prompt_versions ORDER BY name, version DESC");
  const { results } = await stmt.all<PromptRow>();
  return results || [];
}

export type CreateDraftResult = { ok: true; prompt: PromptRow } | { ok: false; status: 400; error: string };

/** 초안 작성 (version = 같은 이름의 최대 + 1). UNIQUE(name, version) 충돌이면 1회 재시도. */
export async function createPromptDraft(env: { DB: D1Database }, input: { name?: string; body?: unknown; note?: unknown }): Promise<CreateDraftResult> {
  const name = input.name || "ask-system";
  if (!(PROMPT_NAMES as readonly string[]).includes(name)) return { ok: false, status: 400, error: `unknown prompt name: ${name}` };
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return { ok: false, status: 400, error: "body required" };
  if (body.length > PROMPT_BODY_MAX) return { ok: false, status: 400, error: `body too long (max ${PROMPT_BODY_MAX})` };
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const max = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM prompt_versions WHERE name = ?").bind(name).first<{ v: number }>();
    const version = (max?.v ?? 0) + 1;
    const id = newId("pv");
    try {
      await env.DB.prepare("INSERT INTO prompt_versions (id, name, version, body, status, note) VALUES (?, ?, ?, ?, 'draft', ?)").bind(id, name, version, body, note).run();
      const row = await getPromptById(env, id);
      if (row) return { ok: true, prompt: row };
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  return { ok: false, status: 400, error: "could not allocate version" };
}

export type ActivateResult = { ok: true; prompt: PromptRow; retired: string[] } | { ok: false; status: 404 | 409; error: string };

/** 활성화 (관리자): 같은 이름의 기존 active를 retired로, 이 버전을 active로 — 한 batch(원자적). */
export async function activatePrompt(env: { DB: D1Database }, id: string): Promise<ActivateResult> {
  const row = await getPromptById(env, id);
  if (!row) return { ok: false, status: 404, error: "prompt version not found" };
  if (row.status === "active") return { ok: true, prompt: row, retired: [] };
  const prev = await env.DB.prepare("SELECT id FROM prompt_versions WHERE name = ? AND status = 'active'").bind(row.name).all<{ id: string }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE prompt_versions SET status = 'retired' WHERE name = ? AND status = 'active' AND id <> ?").bind(row.name, id),
    env.DB.prepare("UPDATE prompt_versions SET status = 'active', activated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  const updated = await getPromptById(env, id);
  return { ok: true, prompt: updated ?? row, retired: (prev.results || []).map((r) => r.id).filter((x) => x !== id) };
}
