import { Hono } from "hono";
import PptxGenJS from "pptxgenjs";
import { AgentSession } from "./agent-session";
import { splitOggOpus } from "./ogg";
import { coachingTranscript, localReflect, localSearchChunks, localSummarize, policies, questionTokens, sampleTranscript, splitPolicyIntoChunks, uid } from "./lib";
import { generateDigest, getLatestDigest } from "./digest";

export { AgentSession };

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  VECTOR: VectorizeIndex;
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  // 운영용 경로(/api/debug-ai, /api/seed-vectors) 보호용 시크릿.
  // 코드·wrangler.toml에 넣지 않고 `wrangler secret put ADMIN_SECRET` /
  // Cloudflare 대시보드에서만 설정한다. 미설정 시 운영 경로는 항상 거부된다.
  ADMIN_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

// llama-3-8b-instruct와 llama-3.1-8b-instruct는 2026-05-30에 deprecated 되어
// Workers AI 바인딩에서 5028을 반환한다. (REST API에서는 3.1-8b가 되지만 바인딩에서는 안 된다.)
const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
// 임베딩은 bge-m3 (1024차원, 다국어, Vectorize 인덱스 people-os-index-m3).
// bge-base-en-v1.5(768차원, 영어용)는 한국어 질문을 구분하지 못해 근거 있음
// 질문과 근거 없음 질문의 코사인 유사도가 0.81~0.83으로 겹쳤다 (2026-11-13
// Chrome 확인: "연차 3일" 0.83/0.82/0.81, "출산 전후 재택" 0.82/0.82/0.81).
// 그래서 하한만으로는 근거를 가릴 수 없어 bge-m3으로 교체한다 (C5 Phase 2).
const EMBED_MODEL = "@cf/baai/bge-m3";
// Plaud 전사본 입력의 Cloudflare판: Workers AI Whisper.
// 처음에는 `@cf/openai/whisper` + `{ audio: number[] }`를 썼으나, Ogg Opus
// 입력에서 호출이 끝나지 않고 조용히 멈췄다 (2분짜리 489KB 클립도 5분 넘게
// 무응답 — 2026-11-13 확인). Cloudflare 공식 튜토리얼(대용량 오디오 청킹)이
// 쓰는 `@cf/openai/whisper-large-v3-turbo` + Base64 문자열 입력으로 바꾼다.
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Plaud와 동일 상한
// 긴 오디오는 구간 단위로 나눠 전사한다 (사용자 합의: 한 번에 시도 → 안 되면
// 30분 → 그래도 안 되면 15분). 구간 크기는 Cloudflare 공식 청킹 튜토리얼이
// 쓰는 1MB를 따른다: 15분 구간(3.8MB)은 첫 구간 Whisper 호출이 27분 동안
// 안 끝나고 백그라운드 작업이 조용히 죽었다 (2026-11-13 확인). 1.9MB/6분
// mp3와 489KB/2분 ogg 클립은 1분 안에 전사됐다. 시간 상한 15분도 함께 둔다.
const CHUNK_SECONDS = 900;
const CHUNK_BYTES = 1024 * 1024;
// RAG 근거 하한 (C5, Baryon AX): Vectorize 코사인 유사도가 이 값 미만인
// 매치는 근거가 없는 것으로 본다. bge-base-en 시절에는 근거 있음/없음
// 질문이 둘 다 0.81~0.83으로 몰려 하한만으로 가릴 수 없었다 (2026-11-13
// Chrome 확인). bge-m3 교체 + 아래 키워드 게이트가 1차 판별자이고,
// 이 하한은 2차 안전망이다. Chrome에서 보고되는 실제 bge-m3 점수 분포로
// 다시 보정한다.
const SCORE_FLOOR = 0.55;
// 키워드 게이트 하한 (C5 Phase 2): Vectorize 상위 매치가 D1 키워드 검색
// (localSearchChunks)에서도 이 점수 이상 겹쳐야 근거로 인정한다.
// "연차 3일"은 연차 15/근태 7/출장 1, "출장비"는 출장 8, "출산 전후 재택"은
// 전원 0이라 2가 적정하다 (로컬 검증, 2026-11-13).
const KEYWORD_GATE_MIN = 2;
// Vectorize 시딩 상태 키 (C5 Phase 2 lazy 시딩, D1 meta 테이블).
const VECTOR_INDEX_NAME = "people-os-index-m3";
const VECTOR_SEED_KEY = "vector_seeded:bge-m3:people-os-index-m3";
const VECTOR_SEED_ERROR_KEY = "vector_seed_error:bge-m3:people-os-index-m3";
const EMBED_DIMS = 1024;

// 운영용 경로 보호: /api/debug-ai, /api/seed-vectors는 X-Admin-Secret 헤더가
// ADMIN_SECRET 환경값과 일치할 때만 허용한다. 시크릿이 설정돼 있지 않으면
// 항상 거부한다 (fail-closed). 시크릿은 코드에 넣지 않고 wrangler secret /
// Cloudflare 대시보드에서만 설정한다.
function adminAllowed(env: Env, given: string | undefined): boolean {
  const secret = env.ADMIN_SECRET;
  if (!secret || !given || secret.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Whisper는 무음·잡음에 "Thank you very much." 같은 문장을 반복하는 환각을
// 내는 경우가 있다 (무음 wav 테스트에서 확인). 짧은 구절이 절반 이상을 차지하면
// 전사로 보지 않고 pending 처리한다.
function isDegenerateTranscript(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / words.length > 0.5;
}

// Base64 인코딩 (node:buffer 없이 — Worker에서 의존성 없이 동작).
function base64Encode(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : "=";
  }
  return out;
}

async function transcribeAudio(env: Env, bytes: Uint8Array): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    // 90초 넘게 안 끝나면 실패로 친다. Whisper 호출이 조용히 멈추는 경우가
    // 있어 (97분 ogg 15분 구간: 27분 무응답) 타임아웃 없이는 구간이 영원히
    // 멈춘다. 90초로 잡은 이유: fetch 핸들러 자체도 약 2분 뒤에 죽을 수
    // 있어, 타임아웃이 그보다 길면 핸들러가 먼저 죽어 실패 처리가 안 된다.
    // 실패 구간은 건너뛰고 나머지는 이어서 전사한다.
    const out = await Promise.race([
      env.AI.run(WHISPER_MODEL, { audio: base64Encode(bytes) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("whisper timed out after 90s")), 90_000)),
    ]);
    const text = (out as { text?: string }).text ?? "";
    if (!text.trim()) return { ok: false, reason: "whisper returned empty text" };
    if (isDegenerateTranscript(text)) return { ok: false, reason: "whisper returned repeated filler text (likely silence/noise)" };
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// R2 오디오를 구간 단위로 전사해 recordings 행을 ready/pending으로 만든다.
// 진행 위치(done_chunks)와 완료분 텍스트(partial)를 행에 남겨, 여러 호출에
// 나눠 이어갈 수 있다. 배경: waitUntil 백그라운드 작업이 약 2분 뒤에 조용히
// 죽는다 (97분 ogg: 3/24 구간까지만 진행, 2026-11-13 확인). 그래서
// - 업로드 직후 waitUntil은 처음 2구간(60초 예산)까지만 돌리고,
// - 프론트 폴링이 POST /api/recordings/:id/advance로 한 번에 1구간씩 이어간다.
// - 한 구간 Whisper 호출이 150초 넘게 안 끝나면 그 구간은 건너뛰고 다음으로 간다.
// - 동시 실행은 lock_until 잠금으로 막는다 (180초 TTL, 죽은 작업은 다음 호출이 재개).
// 전사본을 지어내지 않는다: 실패 구간은 "[구간 N 전사 실패]" 자리 표시자만 남긴다.
async function advanceRecording(env: Env, recordingId: string, opts: { maxSegments: number; maxMs: number }): Promise<{ status: string; locked?: boolean }> {
  const row = await env.DB.prepare("SELECT id, title, object_key, mime_type, transcript_status, partial, done_chunks FROM recordings WHERE id = ?").bind(recordingId)
    .first<{ id: string; title: string; object_key: string; mime_type: string; transcript_status: string; partial: string | null; done_chunks: number | null }>();
  if (!row) return { status: "missing" };
  if (row.transcript_status === "ready") return { status: "ready" };
  if (row.transcript_status === "pending") return { status: "pending" };
  const now = Date.now();
  const lockUntil = now + 180_000;
  const lockRes = await env.DB.prepare("UPDATE recordings SET lock_until = ? WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)").bind(lockUntil, recordingId, now).run();
  if ((((lockRes as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1)) return { status: "processing", locked: true };
  try {
    const obj = await env.FILES.get(row.object_key);
    if (!obj) {
      await env.DB.prepare("UPDATE recordings SET transcript_status = 'pending', progress = '실패: R2에서 오디오를 찾을 수 없습니다' WHERE id = ?").bind(recordingId).run();
      return { status: "pending" };
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const isOgg = row.mime_type.includes("ogg") || row.object_key.toLowerCase().endsWith(".ogg");
    let chunks: Uint8Array[] = [bytes];
    if (isOgg) {
      const split = splitOggOpus(bytes, CHUNK_SECONDS, CHUNK_BYTES);
      if (split && split.segments.length > 1) chunks = split.segments;
    }
    let done = row.done_chunks ?? 0;
    let partial = row.partial ?? "";
    const started = Date.now();
    let processed = 0;
    while (done < chunks.length && processed < opts.maxSegments && Date.now() - started < opts.maxMs) {
      await env.DB.prepare("UPDATE recordings SET progress = ? WHERE id = ?")
        .bind(chunks.length > 1 ? `${done + 1}/${chunks.length} 구간 전사 중` : "전사 중", recordingId).run();
      const r = await transcribeAudio(env, chunks[done]);
      if (r.ok) partial += (partial ? "\n" : "") + r.text;
      else partial += (partial ? "\n" : "") + `[구간 ${done + 1} 전사 실패 — 이 부분은 건너뛰었습니다]`;
      done++;
      processed++;
      await env.DB.prepare("UPDATE recordings SET partial = ?, done_chunks = ?, progress = ? WHERE id = ?")
        .bind(partial, done, chunks.length > 1 ? `${done}/${chunks.length} 구간 전사 중` : "전사 중", recordingId).run();
    }
    if (done >= chunks.length) {
      const realText = partial.replace(/\[구간 \d+ 전사 실패[^\]]*\]/g, "").trim();
      if (!realText) {
        await env.DB.prepare("UPDATE recordings SET transcript_status = 'pending', progress = '실패: Whisper가 텍스트를 못 뽑았습니다' WHERE id = ?").bind(recordingId).run();
        return { status: "pending" };
      }
      const docId = uid("doc");
      await env.DB.prepare("INSERT INTO documents (id, title, kind, content, r2_key) VALUES (?, ?, 'transcript', ?, ?)")
        .bind(docId, row.title.replace(/\.[^.]+$/, ""), partial, row.object_key).run();
      await env.DB.prepare("UPDATE recordings SET transcript = ?, transcript_status = 'ready', doc_id = ?, progress = NULL WHERE id = ?")
        .bind(partial, docId, recordingId).run();
      return { status: "ready" };
    }
    return { status: "processing" };
  } finally {
    await env.DB.prepare("UPDATE recordings SET lock_until = NULL WHERE id = ?").bind(recordingId).run().catch(() => {});
  }
}

// Workers AI가 주는 답은 {response: "..."} 상자 안에 있다. response가 문자열이
// 아닐 때도 있고, JSON 답은 ```json 펜스로 감싸져 오는 경우가 있어 통째로
// JSON.parse하면 실패한다. 문자열로 바꾸고 펜스를 벗긴 뒤 첫 {부터 마지막 }까지만 파싱한다.
function responseText(out: unknown): string {
  if (typeof out === "string") return out;
  const res = (out as { response?: unknown } | null)?.response;
  if (typeof res === "string") return res;
  return JSON.stringify(res ?? out);
}

function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json object in ai response");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// FlowDesk slides-export.mjs의 officeText와 동일: XML 1.0에서 금지된 문자 제거.
// 요약·액션 텍스트를 그대로 PPTX에 넣으면 깨질 수 있어 먼저 거른다.
function officeText(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

type DeckSection = { heading: string; items: string[] };

// Stage 1 덱 생성 — easy-slides 방식: pptxgenjs로 새 덱을 처음부터 만든다.
// 표지(남색) + 섹션별 내용 슬라이드. people-insight 팔레트(#123863/#2d7dde/#14233a).
// Stage 2(보류): FlowDesk식 기존 덱 제자리 편집(jszip 왕복) + R2 버전 관리 — ARCHITECTURE.md 참조.
async function buildDeck(title: string, sections: DeckSection[]): Promise<{ bytes: Uint8Array; slides: number }> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PEOPLE_OS_16_9", width: 13.33, height: 7.5 });
  pptx.layout = "PEOPLE_OS_16_9";
  pptx.author = "일잇 People OS";
  pptx.title = officeText(title);
  pptx.subject = officeText(title);
  pptx.theme = { headFontFace: "Malgun Gothic", bodyFontFace: "Malgun Gothic" };

  // 표지
  const cover = pptx.addSlide();
  cover.background = { color: "123863" };
  cover.addShape("rect", { x: 0.6, y: 0.55, w: 0.9, h: 0.08, fill: { color: "2D7DDE" }, line: { color: "2D7DDE", width: 0 } });
  cover.addText("일잇 PEOPLE OS", { x: 0.6, y: 0.85, w: 8, h: 0.4, fontSize: 14, color: "BFD3EA", bold: true, fontFace: "Malgun Gothic" });
  cover.addText(officeText(title), { x: 0.6, y: 1.5, w: 12.1, h: 2.4, fontSize: 40, color: "FFFFFF", bold: true, fontFace: "Malgun Gothic", valign: "top" });
  cover.addText("회의 요약 초안 · Cloudflare Workers", { x: 0.6, y: 4.1, w: 9, h: 0.5, fontSize: 16, color: "BFD3EA", fontFace: "Malgun Gothic" });
  cover.addText(new Date().toISOString().slice(0, 10), { x: 0.6, y: 6.8, w: 4, h: 0.4, fontSize: 12, color: "8FA8C4", fontFace: "Malgun Gothic" });

  let slides = 1;
  for (const sec of sections) {
    if (!sec.items.length) continue;
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape("rect", { x: 0.6, y: 0.5, w: 0.5, h: 0.09, fill: { color: "2D7DDE" }, line: { color: "2D7DDE", width: 0 } });
    s.addText(officeText(sec.heading), { x: 0.6, y: 0.75, w: 12.1, h: 0.7, fontSize: 28, color: "123863", bold: true, fontFace: "Malgun Gothic" });
    s.addText(
      sec.items.map((it) => ({ text: officeText(it), options: { bullet: { indent: 18 }, paraSpaceAfter: 10, fontSize: 18, color: "14233A", fontFace: "Malgun Gothic" } })),
      { x: 0.6, y: 1.7, w: 12.1, h: 5.1, valign: "top" }
    );
    s.addText("일잇 People OS", { x: 0.6, y: 7.0, w: 4, h: 0.3, fontSize: 11, color: "718096", fontFace: "Malgun Gothic" });
    slides++;
  }
  const out = await pptx.write({ outputType: "uint8array" });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
  return { bytes, slides };
}

async function ensureSchema(db: D1Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'transcript', content TEXT NOT NULL, summary TEXT, actions TEXT, r2_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, title TEXT NOT NULL, section TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reflections (id TEXT PRIMARY KEY, session_id TEXT, transcript TEXT NOT NULL, questions TEXT, patterns TEXT, next_questions TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT);
    CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, title TEXT NOT NULL, r2_key TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, slides INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'workers-ai', model TEXT NOT NULL DEFAULT '@cf/openai/whisper', object_key TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0, transcript TEXT, transcript_status TEXT NOT NULL DEFAULT 'pending', doc_id TEXT, progress TEXT, partial TEXT DEFAULT '', done_chunks INTEGER DEFAULT 0, lock_until INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, article TEXT NOT NULL, text TEXT NOT NULL, ord INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
}

async function ensureSeeded(db: D1Database) {
  await ensureSchema(db);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM policies").first<{ n: number }>();
  if (!count || count.n === 0) {
    for (const p of policies()) {
      await db.prepare("INSERT OR IGNORE INTO policies (id, title, section, body) VALUES (?, ?, ?, ?)").bind(p.id, p.title, p.section, p.body).run();
    }
  }
  // 조문 청킹 (C5): policies와 별개로 세어, 마이그레이션 0006 적용 뒤
  // 이미 정책이 있는 DB에서도 chunk가 채워지게 한다. 멱등.
  const chunkCount = await db.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
  if (!chunkCount || chunkCount.n === 0) {
    for (const p of policies()) {
      for (const ch of splitPolicyIntoChunks(p)) {
        await db.prepare("INSERT OR IGNORE INTO chunks (id, doc_id, article, text, ord) VALUES (?, ?, ?, ?, ?)").bind(ch.id, ch.doc_id, ch.article, ch.text, ch.ord).run();
      }
    }
  }
}

function bindingStatus(env: Env) {
  return {
    d1: !!env.DB,
    kv: !!env.CACHE,
    r2: !!env.FILES,
    vectorize: !!env.VECTOR,
    ai: !!env.AI,
    durable_objects: !!env.AGENT_SESSION,
  };
}

// ---- health ----
app.post("/api/health", async (c) => {
  await ensureSeeded(c.env.DB);
  // 프론트가 로드 때 POST /api/health를 부르므로, 여기서 Vectorize lazy
  // 시딩도 함께 워밍업한다 (첫 질문 전에 인덱스를 채워둔다).
  await ensureVectorSeeded(c.env);
  return c.json({ ok: true, service: "people-os", mode: "live", bindings: bindingStatus(c.env), note: "Workers AI / Vectorize는 로컬에서 폴백으로 동작할 수 있다. wrangler dev --local 기준." });
});
app.get("/api/health", async (c) => {
  await ensureSeeded(c.env.DB);
  await ensureVectorSeeded(c.env);
  return c.json({ ok: true, service: "people-os", mode: "live", bindings: bindingStatus(c.env) });
});

// Vectorize 시딩 상태 (C5 Phase 2, 공개 읽기 전용): 시딩이 안 돼 있으면
// 여기서 직접 시딩을 시도한 뒤 상태를 돌려준다. 비밀·문서 내용은 안 나온다.
app.get("/api/seed-status", async (c) => {
  await ensureSeeded(c.env.DB);
  const seed = await ensureVectorSeeded(c.env);
  const chunks = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
  const errRow = await c.env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(VECTOR_SEED_ERROR_KEY).first<{ value: string }>();
  let lastError: string | null = null;
  if (errRow) {
    try { lastError = (JSON.parse(errRow.value) as { error?: string }).error ?? errRow.value; }
    catch { lastError = errRow.value; }
  }
  return c.json({ ok: true, model: EMBED_MODEL, index: VECTOR_INDEX_NAME, dims: EMBED_DIMS, seeded: seed.seeded, upserted: seed.upserted ?? null, chunks: chunks?.n ?? 0, lastError, error: seed.error ?? null });
});

// ---- documents ----
app.post("/api/documents", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { title?: string; content?: string; kind?: string };
  if (!body.content || body.content.trim().length < 3) return c.json({ ok: false, error: "content is required" }, 400);
  const id = uid("doc");
  const title = body.title || body.content.slice(0, 40);
  const r2Key = `documents/${id}.txt`;
  let r2Stored = false;
  try {
    await c.env.FILES.put(r2Key, body.content);
    r2Stored = true;
  } catch {
    r2Stored = false; // 로컬 Miniflare R2 실패 시 D1에만 저장 (폴백)
  }
  await c.env.DB.prepare("INSERT INTO documents (id, title, kind, content, r2_key) VALUES (?, ?, ?, ?, ?)")
    .bind(id, title, body.kind || "transcript", body.content, r2Stored ? r2Key : null).run();
  return c.json({ ok: true, id, title, r2Stored, fallback: !r2Stored ? "d1-only" : null }, 201);
});

app.post("/api/documents/:id/summarize", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const doc = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<{ id: string; title: string; content: string }>();
  if (!doc) return c.json({ ok: false, error: "document not found" }, 404);
  let engine = "local-extractive";
  let summary: string[] = [];
  let actions: string[] = [];
  // 1) Workers AI 시도 (클라우드에서 동작, 로컬에서는 실패할 수 있음)
  try {
    const out = await c.env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: "다음 회의 전사본을 한국어로 3줄 요약하고 액션 아이템을 뽑아라. JSON으로만 답하라: {\"summary\":[\"...\"],\"actions\":[\"...\"]}" },
        { role: "user", content: doc.content.slice(0, 4000) },
      ],
    });
    const text = responseText(out);
    const parsed = extractJson(text);
    if (Array.isArray(parsed.summary) && parsed.summary.length) {
      summary = parsed.summary.slice(0, 3);
      actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
      engine = "workers-ai";
    } else throw new Error("empty ai summary");
  } catch {
    const fb = localSummarize(doc.content);
    summary = fb.summary;
    actions = fb.actions;
    engine = "local-extractive";
  }
  await c.env.DB.prepare("UPDATE documents SET summary = ?, actions = ? WHERE id = ?")
    .bind(JSON.stringify(summary), JSON.stringify(actions), id).run();
  return c.json({ ok: true, id, title: doc.title, summary, actions, engine });
});

// ---- transcribe (음성 전사 입력, Plaud transcribe/route.ts 형태의 Cloudflare판) ----
// multipart/form-data file 필드(최대 25MB) → R2 저장 + HEAD 크기 검증 → Whisper 전사
// → 전사본 있으면 documents 행까지 만들고, 없으면 오디오만 pending으로 저장한다.
// 전사본을 지어내지 않는다.
app.post("/api/transcribe", async (c) => {
  await ensureSeeded(c.env.DB);
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: "multipart form-data is required" }, 400);
  const file = form.get("file");
  const isUpload = file !== null && typeof file === "object" && "arrayBuffer" in file && typeof (file as File).size === "number";
  if (!isUpload) return c.json({ ok: false, error: "audio file is required (field: file)" }, 400);
  const f = file as File;
  const audioExts = ["mp3", "m4a", "wav", "ogg", "webm", "mp4", "flac", "aac", "wma"];
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const isAudio = f.type.startsWith("audio/") || f.type.startsWith("video/") || audioExts.includes(ext);
  if (!isAudio) return c.json({ ok: false, error: "audio file is required" }, 400);
  if (f.size <= 0) return c.json({ ok: false, error: "empty file" }, 400);
  if (f.size > MAX_AUDIO_BYTES) return c.json({ ok: false, error: "file must be 25MB or smaller" }, 400);

  const id = uid("rec");
  const title = f.name.replace(/\.[^.]+$/, "") || f.name;
  const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "audio";
  const objectKey = `recordings/${id}/${safeName}`;
  const bytes = new Uint8Array(await f.arrayBuffer());
  // R2 저장 + HEAD 크기 검증 (Plaud DOT_PLAUD_SYNC.md 패턴: put 직후 HEAD로 검증)
  await c.env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: f.type || "application/octet-stream" } });
  const head = await c.env.FILES.head(objectKey).catch(() => null);
  if (!head || head.size !== f.size) return c.json({ ok: false, error: "r2 verify failed after upload", recordingId: id }, 502);

  // 행을 먼저 만들고 전사는 백그라운드로: 긴 파일은 동기 Whisper 호출이
  // 응답 시간 안에 안 끝나서(97분 ogg, 27분 무응답) 행 자체가 안 남았다.
  // 전사본을 지어내지 않는다 — 행은 'processing'으로 시작한다.
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT INTO recordings (id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, doc_id, created_at) VALUES (?, ?, 'workers-ai', ?, ?, ?, ?, NULL, 'processing', NULL, ?)")
    .bind(id, f.name, WHISPER_MODEL, objectKey, f.type || "application/octet-stream", f.size, now).run();
  c.executionCtx.waitUntil(advanceRecording(c.env, id, { maxSegments: 2, maxMs: 60_000 }));
  return c.json({ ok: true, recordingId: id, title: f.name, transcript: null, transcriptStatus: "processing", r2Verified: true, provider: "workers-ai", model: WHISPER_MODEL }, 201);
});

// 최근 음성 녹음 목록 (전사본 내용은 안 돌려준다 — 목록은 메타데이터만)
app.get("/api/recordings", async (c) => {
  await ensureSeeded(c.env.DB);
  const rows = await c.env.DB.prepare("SELECT id, title, provider, model, mime_type, size, transcript_status, progress, doc_id, created_at FROM recordings ORDER BY created_at DESC LIMIT 20").all();
  return c.json({ ok: true, recordings: rows.results || [] });
});

app.get("/api/recordings/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const row = await c.env.DB.prepare("SELECT id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, progress, doc_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; provider: string; model: string; object_key: string; mime_type: string; size: number; transcript: string | null; transcript_status: string; progress: string | null; doc_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  return c.json({ ok: true, recording: row });
});

// 프론트 폴링이 부르는 전사 이어가기: 잠금이 없으면 다음 1구간을 여기서
// 직접 전사한다 (fetch 안에서 1회 Whisper 호출, 약 40~60초). 페이지를
// 열어두는 동안 구간마다 전사가 이어진다 — waitUntil 수명(약 2분)에
// 기대지 않는 경로다. 잠금이 걸려 있으면 현재 행만 돌려준다.
app.post("/api/recordings/:id/advance", async (c) => {
  await ensureSeeded(c.env.DB);
  // advanceRecording이 던져도 행을 돌려준다: 500 HTML이 가면 프론트
  // r.json()이 터져 폴링 루프가 죽는다.
  await advanceRecording(c.env, c.req.param("id"), { maxSegments: 1, maxMs: 120_000 }).catch(() => {});
  const row = await c.env.DB.prepare("SELECT id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, progress, doc_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; provider: string; model: string; object_key: string; mime_type: string; size: number; transcript: string | null; transcript_status: string; progress: string | null; doc_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  return c.json({ ok: true, recording: row });
});

// pending 녹음을 R2 오디오로 다시 전사한다. 전사도 백그라운드로 돌린다.
// ready 행은 건드리지 않고, processing 중인 행은 중복 실행하지 않는다.
// 단, processing이 30분 넘게 멈춰 있으면(백그라운드 작업이 조용히 죽은 경우)
// 다시 시작할 수 있게 한다 — 진행 상황은 chunk마다 progress에 남으므로,
// 30분 동안 진전이 없으면 죽은 것으로 본다. 멈춘 processing 행은 완료분
// (partial/done_chunks)을 유지한 채 이어가고, pending 행은 처음부터 다시 한다.
app.post("/api/recordings/:id/retry", async (c) => {
  await ensureSeeded(c.env.DB);
  const row = await c.env.DB.prepare("SELECT id, title, object_key, transcript, transcript_status, doc_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; object_key: string; transcript: string | null; transcript_status: string; doc_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  if (row.transcript_status === "ready" && row.transcript) return c.json({ ok: true, recordingId: row.id, transcriptStatus: "ready", transcript: row.transcript, docId: row.doc_id, note: "already ready" });
  if (row.transcript_status === "processing") {
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < 30 * 60 * 1000) return c.json({ ok: true, recordingId: row.id, transcriptStatus: "processing", note: "already processing" });
    // 30분 넘게 멈춰 있음 — 죽은 작업으로 보고 완료분은 유지한 채 이어간다.
  } else {
    // pending 행은 처음부터 다시 한다.
    await c.env.DB.prepare("UPDATE recordings SET partial = '', done_chunks = 0 WHERE id = ?").bind(row.id).run();
  }
  await c.env.DB.prepare("UPDATE recordings SET transcript_status = 'processing', progress = NULL WHERE id = ?").bind(row.id).run();
  c.executionCtx.waitUntil(advanceRecording(c.env, row.id, { maxSegments: 2, maxMs: 60_000 }));
  return c.json({ ok: true, recordingId: row.id, transcriptStatus: "processing" });
});

type Source = { id: string; title: string; section: string; snippet: string; score: number };

// Vectorize 매치를 조문 단위 근거로 바꾼다 (C5).
// - chunk id(새 색인)면 D1 chunks에서 직접 읽는다.
// - policy id(재시딩 전 구 색인)면 그 정책의 조문 중 질문과 키워드가 가장
//   겹치는 조문 1개를 쓴다. chunks가 없으면 정책 본문 앞 220자로 폴백.
// - 같은 doc_id가 두 번 나오면(구 정책 벡터 + 신 chunk 벡터가 둘 다 매치)
//   score가 높은 쪽 하나만 남긴다.
async function resolveSources(
  env: Env,
  question: string,
  matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>
): Promise<Source[]> {
  const byDoc = new Map<string, Source>();
  for (const m of matches) {
    const chunk = await env.DB.prepare("SELECT id, doc_id, article, text FROM chunks WHERE id = ?").bind(m.id)
      .first<{ id: string; doc_id: string; article: string; text: string }>();
    if (chunk) {
      const policy = await env.DB.prepare("SELECT title FROM policies WHERE id = ?").bind(chunk.doc_id).first<{ title: string }>();
      const src: Source = { id: chunk.id, title: policy?.title ?? chunk.doc_id, section: chunk.article, snippet: chunk.text, score: m.score };
      const prev = byDoc.get(chunk.doc_id);
      if (!prev || prev.score < m.score) byDoc.set(chunk.doc_id, src);
      continue;
    }
    const policy = await env.DB.prepare("SELECT id, title, section, body FROM policies WHERE id = ?").bind(m.id)
      .first<{ id: string; title: string; section: string; body: string }>();
    if (policy) {
      const rows = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE doc_id = ? ORDER BY ord").bind(policy.id)
        .all<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
      const list = rows.results || [];
      if (list.length) {
        const scored = localSearchChunks(question, list.map((ch) => ({ ...ch, title: policy.title })));
        const best = scored.length ? scored[0] : { ...list[0], score: 0, snippet: list[0].text };
        const src: Source = { id: best.id, title: policy.title, section: best.article, snippet: best.text, score: m.score };
        const prev = byDoc.get(policy.id);
        if (!prev || prev.score < m.score) byDoc.set(policy.id, src);
      } else {
        const src: Source = { id: policy.id, title: policy.title, section: policy.section, snippet: policy.body.slice(0, 220), score: m.score };
        const prev = byDoc.get(policy.id);
        if (!prev || prev.score < m.score) byDoc.set(policy.id, src);
      }
      continue;
    }
    // 알 수 없는 id — 메타데이터가 있으면 그대로 쓴다.
    const meta = (m.metadata || {}) as { title?: string; section?: string; snippet?: string };
    if (meta.snippet) {
      const src: Source = { id: m.id, title: meta.title || m.id, section: meta.section || "", snippet: meta.snippet, score: m.score };
      const prev = byDoc.get(m.id);
      if (!prev || prev.score < m.score) byDoc.set(m.id, src);
    }
  }
  return [...byDoc.values()].sort((a, b) => b.score - a.score);
}

// Vectorize 시딩 (C5 Phase 2): bge-m3 1024차원 새 인덱스 people-os-index-m3.
// ADMIN_SECRET이 없어 /api/seed-vectors를 부를 수 없으므로, Worker가 첫
// 사용 때 D1 chunks를 bge-m3으로 임베딩해 직접 upsert한다 (lazy 시딩).
// D1 meta 테이블에 결과를 남겨 한 번만 시딩하고, 실패하면 다음번에 재시도한다.
// 임베딩·upsert를 각각 1회 배치 호출로 묶어 첫 사용 지연을 줄인다.
// upsert는 같은 id에 멱등이라 동시 실행이 겹쳐도 안전하다.
// 이 함수는 절대 던지지 않는다 — 실패하면 {seeded:false, error}를 돌려준다.
async function ensureVectorSeeded(env: Env, opts?: { force?: boolean }): Promise<{ seeded: boolean; dims?: number; upserted?: number; total?: number; error?: string }> {
  try {
    if (!opts?.force) {
      const flag = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(VECTOR_SEED_KEY).first<{ value: string }>();
      if (flag) {
        try {
          const parsed = JSON.parse(flag.value) as { dims?: number; upserted?: number };
          return { seeded: true, dims: parsed.dims, upserted: parsed.upserted };
        } catch { return { seeded: true }; }
      }
    }
    const rows = await env.DB.prepare(
      "SELECT c.id, c.doc_id, c.article, c.text, p.title FROM chunks c JOIN policies p ON p.id = c.doc_id ORDER BY c.doc_id, c.ord"
    ).all<{ id: string; doc_id: string; article: string; text: string; title: string }>();
    const list = rows.results || [];
    if (!list.length) return { seeded: false, error: "no chunks in D1" };
    const texts = list.map((ch) => `${ch.title} ${ch.article} ${ch.text}`);
    const emb = await env.AI.run(EMBED_MODEL, { text: texts }) as { data: number[][] | number[] };
    const data = emb.data;
    if (!Array.isArray(data) || data.length !== texts.length || !Array.isArray(data[0])) {
      return { seeded: false, error: "unexpected embedding response shape" };
    }
    const dims = (data[0] as number[]).length;
    if (dims !== EMBED_DIMS) {
      return { seeded: false, error: `embedding dims ${dims} != index dims ${EMBED_DIMS}` };
    }
    const vectors = list.map((ch, i) => ({ id: ch.id, values: data[i] as number[], metadata: { title: ch.title, section: ch.article, snippet: ch.text.slice(0, 220) } }));
    await env.VECTOR.upsert(vectors);
    const result = { seeded: true, dims, upserted: list.length, total: list.length, at: new Date().toISOString() };
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(VECTOR_SEED_KEY, JSON.stringify(result)).run();
    await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(VECTOR_SEED_ERROR_KEY).run();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .bind(VECTOR_SEED_ERROR_KEY, JSON.stringify({ error: msg, at: new Date().toISOString() })).run();
    } catch { /* meta 기록 실패는 무시 */ }
    return { seeded: false, error: msg };
  }
}

// 키워드 게이트 (C5 Phase 2): Vectorize 코사인 점수만으로는 한국어 근거를
// 가릴 수 없다 (bge-base-en: 근거 있음 0.81~0.83 / 근거 없음 0.81~0.82로 겹침).
// 그래서 Vectorize 상위 매치가 D1 키워드 검색(localSearchChunks)에서도
// 겹침이 있는지 확인한다. 겹침 점수가 KEYWORD_GATE_MIN 미만이면 근거에서 뺀다.
// - chunk id면 해당 chunk, policy id(구 색인)면 그 정책의 조문 중 최고 점수로 본다.
// - D1에서 chunk를 못 찾는 id(알 수 없는 id)는 그대로 둔다 (fail-open).
// - 질문에서 겹침 신호가 되는 토큰이 하나도 없으면 게이트를 건너뛴다
//   ("쉴 수 있나요?"처럼 조사·어미만 있는 질문은 Vectorize에 맡긴다).
async function keywordGate(
  env: Env,
  question: string,
  matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>
): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>> {
  if (questionTokens(question).length === 0) return matches;
  const kept: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];
  for (const m of matches) {
    const chunk = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE id = ?").bind(m.id)
      .first<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
    let chunks: Array<{ id: string; doc_id: string; article: string; text: string; ord: number }> = [];
    let title = m.id;
    if (chunk) {
      chunks = [chunk];
      const p = await env.DB.prepare("SELECT title FROM policies WHERE id = ?").bind(chunk.doc_id).first<{ title: string }>();
      title = p?.title ?? chunk.doc_id;
    } else {
      const policy = await env.DB.prepare("SELECT id, title FROM policies WHERE id = ?").bind(m.id).first<{ id: string; title: string }>();
      if (!policy) { kept.push(m); continue; } // 알 수 없는 id — fail-open
      title = policy.title;
      const rows = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE doc_id = ?").bind(policy.id)
        .all<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
      chunks = rows.results || [];
      if (!chunks.length) { kept.push(m); continue; }
    }
    const scored = localSearchChunks(question, chunks.map((ch) => ({ ...ch, title })));
    const best = scored.length ? Math.max(...scored.map((s) => s.score)) : 0;
    if (best >= KEYWORD_GATE_MIN) kept.push(m);
  }
  return kept;
}

// ---- ask (RAG) ----
app.post("/api/ask", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { question?: string; sessionId?: string };
  if (!body.question || body.question.trim().length < 2) return c.json({ ok: false, error: "question is required" }, 400);
  const question = body.question.trim();
  const sessionId = body.sessionId || uid("sess");

  // KV 캐시 조회 (실패 시 D1 cache 테이블 폴백)
  // 캐시 키에 sessionId를 포함한다: 후속 질문은 세션 문맥에 따라 답이 달라지므로,
  // 세션과 무관한 키로 캐시하면 다른 세션의 오래된(잘못된) 답을 돌려주게 된다.
  const cacheKey = `ask:${sessionId}:${question}`;
  try {
    const cached = await c.env.CACHE.get(cacheKey);
    if (cached) return c.json({ ...JSON.parse(cached), cached: true, sessionId });
  } catch { /* KV 로컬 실패 시 아래 D1 캐시로 */ }
  const d1Cache = await c.env.DB.prepare("SELECT value FROM cache WHERE key = ?").bind(cacheKey).first<{ value: string }>();
  if (d1Cache) return c.json({ ...JSON.parse(d1Cache.value), cached: true, cacheVia: "d1", sessionId });

  // 후속 질문 문맥: 같은 세션의 직전 질문을 검색 쿼리에 보태 주제를 잃지 않게 한다.
  // 단, 현재 질문에 내용 토큰이 하나라도 있으면 독립 질문으로 보고 보태지 않는다
  // ("출산 전후 재택" 뒤에 "연차 3일"을 보태면 연차 근거가 딸려오는 오염이 생긴다).
  // 내용 토큰이 전혀 없는 지시어성 후속 질문("그건 어떻게 돼?", "며칠 전에?")에만 보탠다.
  let searchQuestion = question;
  try {
    const stub = c.env.AGENT_SESSION.get(c.env.AGENT_SESSION.idFromName(sessionId));
    const res = await stub.fetch("https://do/history");
    const data = await res.json() as { history?: Array<{ role: string; content: string }> };
    const lastUser = [...(data.history || [])].reverse().find((h) => h.role === "user");
    if (lastUser && questionTokens(question).length === 0) searchQuestion = `${question} ${lastUser.content}`;
  } catch {
    try {
      const prev = await c.env.DB.prepare("SELECT history FROM sessions WHERE id = ?").bind(sessionId).first<{ history: string }>();
      if (prev) {
        const hist = JSON.parse(prev.history) as Array<{ role: string; content: string }>;
        const lastUser = [...hist].reverse().find((h) => h.role === "user");
        if (lastUser && questionTokens(question).length === 0) searchQuestion = `${question} ${lastUser.content}`;
      }
    } catch { /* 세션 조회 실패 시 현재 질문만으로 검색 */ }
  }

  // 근거 검색: 질문을 임베딩해 Vectorize에서 검색 → 실패 시 D1 조문 텍스트 검색 폴백
  // C5 (Baryon AX): Vectorize 점수 하한 SCORE_FLOOR를 적용한다. 조회는
  // 성공했는데 하한을 넘는 근거가 없으면 근거가 없는 것이므로 D1 폴백·LLM
  // 호출 없이 grounded:false로 답한다 (근거를 지어내지 않는다).
  // C5 Phase 2: 검색 전에 lazy 시딩을 보장하고, 하한을 통과한 매치에
  // 키워드 게이트를 한 번 더 건다 (코사인 점수만으로는 한국어를 못 가린다).
  let sources: Source[] = [];
  let searchEngine = "d1-text";
  let noEvidence = false; // Vectorize가 성공했는데 하한을 넘는 근거가 없음
  try {
    await ensureVectorSeeded(c.env);
    const emb = await c.env.AI.run(EMBED_MODEL, { text: [searchQuestion] }) as { data: number[][] | number[] };
    const raw = emb.data;
    const values = new Float32Array(Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]));
    const vec = await c.env.VECTOR.query(values, { topK: 3, returnMetadata: "all" });
    const all = vec.matches || [];
    const matches = all.filter((m) => (m.score || 0) >= SCORE_FLOOR);
    if (matches.length > 0) {
      const gated = await keywordGate(c.env, searchQuestion, matches.map((m) => ({ id: String(m.id), score: m.score || 0, metadata: (m.metadata || {}) as Record<string, unknown> })));
      if (gated.length === 0) {
        noEvidence = true; // Vectorize는 찾았으나 키워드 관련성 없음 — D1 폴백도 안 탐
      } else {
        searchEngine = "vectorize";
        sources = await resolveSources(c.env, searchQuestion, gated);
        if (sources.length === 0) throw new Error("no resolvable matches");
      }
    } else if (all.length > 0) {
      noEvidence = true; // 하한 이하 — 근거 없음 확정, 폴백 안 탐
    } else {
      throw new Error("no vectorize matches");
    }
  } catch {
    if (!noEvidence) {
      const rows = await c.env.DB.prepare(
        "SELECT c.id, c.doc_id, c.article, c.text, c.ord, p.title FROM chunks c JOIN policies p ON p.id = c.doc_id"
      ).all<{ id: string; doc_id: string; article: string; text: string; ord: number; title: string }>();
      const found = localSearchChunks(searchQuestion, rows.results || []);
      sources = found.map((f) => ({ id: f.id, title: f.title, section: f.article, snippet: f.snippet, score: f.score }));
      searchEngine = "d1-text";
    }
  }
  // 근거 없음: LLM을 호출하지 않고 경고로 답한다 (C5, Baryon AX).
  // 연차휴가 규정을 강제 근거로 넣던 폴백은 삭제했다 — 근거가 없는데
  // 있는 것처럼 답하는 것이 데모에서 드러나는 약점이었다.
  const grounded = sources.length > 0;
  let answer = "";
  let engine = "local-template";
  if (!grounded) {
    answer = "등록된 규정에서 근거를 찾지 못했습니다. 이 질문에 대한 답은 아직 등록된 규정에 없습니다. 인사팀에 확인해 주세요.";
    engine = "none";
  } else {
    // 답변 생성: Workers AI 시도 → 실패 시 근거 기반 템플릿 답변
    try {
      const context = sources.map((s) => `[${s.title} › ${s.section}] ${s.snippet}`).join("\n");
      const out = await c.env.AI.run(LLM_MODEL, {
        messages: [
          { role: "system", content: "너는 HR 규정 안내 에이전트다. 주어진 근거 문서만을 근거로 한국어로 답하고, 근거에 없는 내용은 지어내지 마라. 근거 문서명을 답에 포함하라." },
          { role: "user", content: `질문: ${question}\n근거:\n${context}` },
        ],
      });
      const text = responseText(out);
      if (text && text.trim().length > 10) { answer = text.trim(); engine = "workers-ai"; } else throw new Error("empty ai answer");
    } catch {
      const top = sources[0];
      answer = `근거 문서 「${top.title}(${top.section})」에 따르면, ${top.snippet} 질문하신 "${question}"에 대해서는 위 규정을 기준으로 안내드립니다. 정확한 적용은 인사팀 확인이 필요합니다.`;
      engine = "local-template";
    }
  }

  // Durable Objects 세션에 대화 저장 시도 → 실패 시 D1 sessions 폴백
  let sessionVia = "durable-objects";
  try {
    const stub = c.env.AGENT_SESSION.get(c.env.AGENT_SESSION.idFromName(sessionId));
    await stub.fetch("https://do/message", { method: "POST", body: JSON.stringify({ role: "user", content: question }) });
    await stub.fetch("https://do/message", { method: "POST", body: JSON.stringify({ role: "assistant", content: answer }) });
  } catch {
    sessionVia = "d1";
    const existing = await c.env.DB.prepare("SELECT history FROM sessions WHERE id = ?").bind(sessionId).first<{ history: string }>();
    const history = existing ? JSON.parse(existing.history) : [];
    history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    await c.env.DB.prepare("INSERT OR REPLACE INTO sessions (id, history, updated_at) VALUES (?, ?, datetime('now'))").bind(sessionId, JSON.stringify(history.slice(-20))).run();
  }

  const result = { ok: true, sessionId, question, answer, sources, grounded, engine, searchEngine, sessionVia, cached: false };
  // 캐시 저장 (KV 시도, 실패 시 D1)
  try { await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }); }
  catch { await c.env.DB.prepare("INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)").bind(cacheKey, JSON.stringify(result)).run(); }
  return c.json(result);
});

// ---- coaching ----
app.post("/api/coaching/reflect", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { transcript?: string; sessionId?: string };
  const transcript = body.transcript || coachingTranscript();
  if (transcript.trim().length < 10) return c.json({ ok: false, error: "transcript is required" }, 400);
  let engine = "local-rule";
  let out = localReflect(transcript);
  try {
    const ai = await c.env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: "너는 코칭 리플렉션 분석가다. 세션 전사본에서 핵심 질문, 반복 패턴, 다음 세션 질문 3개를 한국어로 뽑아 JSON으로만 답하라: {\"questions\":[],\"patterns\":[],\"next_questions\":[]}" },
        { role: "user", content: transcript.slice(0, 4000) },
      ],
    });
    const text = responseText(ai);
    const parsed = extractJson(text) as { questions?: unknown; patterns?: unknown; next_questions?: unknown };
    if (Array.isArray(parsed.patterns) && parsed.patterns.length) {
      out = {
        questions: (parsed.questions as string[]) || [],
        patterns: parsed.patterns as string[],
        next_questions: (parsed.next_questions as string[]) || [],
      };
      engine = "workers-ai";
    }
  } catch { /* 로컬 폴백 유지 */ }
  const id = uid("refl");
  await c.env.DB.prepare("INSERT INTO reflections (id, session_id, transcript, questions, patterns, next_questions) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, body.sessionId || null, transcript, JSON.stringify(out.questions), JSON.stringify(out.patterns), JSON.stringify(out.next_questions)).run();
  return c.json({ ok: true, id, ...out, engine });
});

// ---- home (작업 공간 대시보드) ----
app.get("/api/home", async (c) => {
  await ensureSeeded(c.env.DB);
  const count = async (sql: string) => (await c.env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const documents = await count("SELECT COUNT(*) AS n FROM documents");
  const summaries = await count("SELECT COUNT(*) AS n FROM documents WHERE summary IS NOT NULL AND summary != ''");
  const openTasks = await count("SELECT COUNT(*) AS n FROM tasks WHERE done = 0");
  const reflections = await count("SELECT COUNT(*) AS n FROM reflections");
  const recentDocuments = (await c.env.DB.prepare("SELECT id, title, kind, created_at FROM documents ORDER BY created_at DESC LIMIT 5").all()).results || [];
  const tasks = (await c.env.DB.prepare("SELECT id, title, source, created_at FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 5").all()).results || [];
  const recentReflections = (await c.env.DB.prepare("SELECT id, patterns, created_at FROM reflections ORDER BY created_at DESC LIMIT 3").all()).results || [];
  return c.json({ ok: true, counts: { documents, summaries, openTasks, reflections }, recentDocuments, openTasks: tasks, recentReflections });
});

// ---- tasks (할 일 체크리스트) ----
app.get("/api/tasks", async (c) => {
  await ensureSeeded(c.env.DB);
  const rows = await c.env.DB.prepare("SELECT id, title, source, done, created_at, done_at FROM tasks ORDER BY done ASC, created_at DESC").all();
  return c.json({ ok: true, tasks: rows.results || [] });
});

app.post("/api/tasks", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { title?: string; source?: string };
  if (!body.title || body.title.trim().length < 1) return c.json({ ok: false, error: "title is required" }, 400);
  const id = uid("task");
  await c.env.DB.prepare("INSERT INTO tasks (id, title, source) VALUES (?, ?, ?)").bind(id, body.title.trim().slice(0, 200), body.source || null).run();
  return c.json({ ok: true, id, title: body.title.trim().slice(0, 200), source: body.source || null }, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { done?: boolean };
  const row = await c.env.DB.prepare("SELECT done FROM tasks WHERE id = ?").bind(id).first<{ done: number }>();
  if (!row) return c.json({ ok: false, error: "task not found" }, 404);
  const done = typeof body.done === "boolean" ? (body.done ? 1 : 0) : (row.done ? 0 : 1);
  await c.env.DB.prepare("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?").bind(done, done ? new Date().toISOString() : null, id).run();
  return c.json({ ok: true, id, done: done === 1 });
});

app.delete("/api/tasks/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ ok: false, error: "task not found" }, 404);
  return c.json({ ok: true, id });
});

// ---- deck (PPTX 초안, easy-slides식 신규 생성) ----
app.post("/api/deck", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { title?: string; summary?: string[]; actions?: string[]; bullets?: string[]; source?: string };
  const title = (body.title || "People OS 요약").slice(0, 120);
  const sections: DeckSection[] = [];
  if (Array.isArray(body.summary) && body.summary.length) sections.push({ heading: "요약", items: body.summary.slice(0, 6).map(String) });
  if (Array.isArray(body.actions) && body.actions.length) sections.push({ heading: "액션", items: body.actions.slice(0, 8).map(String) });
  if (!sections.length && Array.isArray(body.bullets) && body.bullets.length) sections.push({ heading: "내용", items: body.bullets.slice(0, 10).map(String) });
  if (!sections.length) return c.json({ ok: false, error: "summary, actions or bullets is required" }, 400);
  const { bytes, slides } = await buildDeck(title, sections);
  const id = uid("deck");
  const r2Key = `decks/${id}.pptx`;
  await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: PPTX_MIME } });
  await c.env.DB.prepare("INSERT INTO decks (id, title, r2_key, bytes, slides) VALUES (?, ?, ?, ?, ?)").bind(id, title, r2Key, bytes.length, slides).run();
  return c.json({ ok: true, id, title, url: `/api/deck/${id}`, bytes: bytes.length, slides, source: body.source || null }, 201);
});

app.get("/api/deck/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id, title, r2_key, bytes FROM decks WHERE id = ?").bind(id).first<{ id: string; title: string; r2_key: string; bytes: number }>();
  if (!row) return c.json({ ok: false, error: "deck not found" }, 404);
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ ok: false, error: "deck file not found" }, 404);
  // Content-Disposition의 filename은 ASCII만 허용된다 (Fetch 명세).
  // 한글 제목은 RFC 5987 filename*에 UTF-8 인코딩으로 싣고, filename은 ASCII 폴백.
  const safe = row.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "deck";
  const encoded = encodeURIComponent(`${row.title}.pptx`);
  return new Response(obj.body, {
    headers: {
      "Content-Type": PPTX_MIME,
      "Content-Length": String(row.bytes),
      "Content-Disposition": `attachment; filename="${safe}.pptx"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
});

// ---- library ----
app.get("/api/library", async (c) => {
  await ensureSeeded(c.env.DB);
  const docs = await c.env.DB.prepare("SELECT id, title, kind, summary, actions, created_at FROM documents ORDER BY created_at DESC LIMIT 20").all();
  const pols = await c.env.DB.prepare("SELECT id, title, section FROM policies ORDER BY id").all();
  const refls = await c.env.DB.prepare("SELECT id, session_id, patterns, next_questions, created_at FROM reflections ORDER BY created_at DESC LIMIT 10").all();
  return c.json({ ok: true, documents: docs.results || [], policies: pols.results || [], reflections: refls.results || [] });
});

// 디버그용: 임베딩·Vectorize 조회·LLM 호출을 직접 돌려 원인을 확인한다.
// 운영용 경로 — X-Admin-Secret 헤더 + ADMIN_SECRET 없이는 401 (C6 잠금).
app.get("/api/debug-ai", async (c) => {
  if (!adminAllowed(c.env, c.req.header("x-admin-secret"))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const out: Record<string, unknown> = {};
  out.vectorSeed = await ensureVectorSeeded(c.env);
  try {
    const emb = await c.env.AI.run(EMBED_MODEL, { text: ["출장비 청구"] }) as { data: number[][] | number[] };
    const raw = emb.data;
    const vals = Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]);
    out.embed = { ok: true, dims: vals.length };
    try {
      const vec = await c.env.VECTOR.query(new Float32Array(vals), { topK: 3, returnMetadata: "all" });
      out.vectorize = { ok: true, matches: (vec.matches || []).map((m) => ({ id: String(m.id), score: m.score })) };
    } catch (e) {
      out.vectorize = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } catch (e) {
    out.embed = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // LLM 후보를 순서대로 시도해 바인딩에서 실제로 되는 모델을 확인한다.
  const llmCandidates = [LLM_MODEL, "@cf/meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
  const llmResults: Array<Record<string, unknown>> = [];
  for (const model of llmCandidates) {
    try {
      const res = await c.env.AI.run(model, { messages: [{ role: "user", content: "한 줄로 답해: 2+2는?" }] });
      const text = responseText(res);
      llmResults.push({ model, ok: true, text: text.slice(0, 200) });
    } catch (e) {
      llmResults.push({ model, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.llm = llmResults;
  return c.json({ ok: true, ...out });
});

app.get("/api/seed", async (c) => {
  await ensureSeeded(c.env.DB);
  return c.json({ ok: true, sampleTranscript: sampleTranscript(), coachingTranscript: coachingTranscript(), policies: policies() });
});

// 규정 7건을 조문 단위로 임베딩해 Vectorize 인덱스에 넣는다 (관리자 강제 재시딩).
// 평소에는 ask/health가 lazy 시딩으로 알아서 채우므로 이 경로는 정책이
// 바뀌었을 때 다시 임베딩하는 용도다. 새 인덱스(people-os-index-m3)는
// 처음부터 chunk id만 들어가서 구 정책 단위 벡터를 지울 일이 없다.
// 운영용 경로 — X-Admin-Secret 헤더 + ADMIN_SECRET 없이는 401 (C6 잠금).
app.get("/api/seed-vectors", async (c) => {
  if (!adminAllowed(c.env, c.req.header("x-admin-secret"))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await ensureSeeded(c.env.DB);
  const r = await ensureVectorSeeded(c.env, { force: true });
  return c.json({ ok: r.seeded, upserted: r.upserted ?? 0, total: r.upserted ?? 0, deletedOld: 0, model: EMBED_MODEL, index: VECTOR_INDEX_NAME, dims: r.dims ?? null, errors: r.error ? [r.error] : [] });
});

// ---- digest (아침 다이제스트, C9) ----
app.get("/api/digest", async (c) => {
  const digest = await getLatestDigest(c.env);
  if (!digest) return c.json({ ok: true, digest: null, message: "아직 생성된 다이제스트가 없습니다. 매일 07:00에 생성됩니다." });
  return c.json({ ok: true, digest });
});

// 프론트는 [assets] 바인딩이 서빙한다. / 가 없으면 index.html로.
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "unknown api route" }, 404);
  try {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
  } catch { /* assets 없으면 아래 폴백 */ }
  return c.html("<h1>People OS</h1><p>Frontend asset not found. Run wrangler dev with public/ present.</p>", 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(generateDigest(env, new Date(event.scheduledTime)));
  },
};
