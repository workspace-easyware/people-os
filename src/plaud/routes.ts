// Plaud 연동 API (2026-11-19, migration 0033). index.ts에서 "/api/plaud"에 mount한다 (경로는 mount 기준 상대).
// 전부 세션 로그인 필수 (X-Admin-Secret만으로는 401). 구글 캘린더 C3 패턴을 그대로 따른다.
//   POST /connect      세션 + originOk. state(sha256만 저장, 1회용·10분·사용자 결합) + PKCE S256 → { url }
//   GET  /callback     세션 확인 안 함 (SameSite=Strict 쿠키가 Plaud→콜백 이동에 안 실린다). code·state를 서버가 읽지 않고,
//                      최소 HTML이 같은 출처 fetch로 /complete를 부른다.
//   POST /complete     세션 + originOk. state 검증 → code 교환 → 토큰 암호화 저장
//   GET  /status       connected / not_connected + 마스킹 이메일
//   POST /disconnect   세션 + originOk. 계정 행 삭제
//   GET  /files        내 Plaud 녹음 목록 (list_files) + 가져옴 표시. page/page_size/query/date_from/date_to
//   GET  /files/:id/transcript   전사 여부 확인 (get_transcript 1쪽) — 행마다 필요할 때만 부른다
//   POST /import       { file_id } → get_file + get_transcript(전 페이지) + get_note → 개인 문서로 저장·색인 (plaud_imports로 중복 방지)
//                      Plaud 전사가 없으면: get_file의 presigned_url(5분)을 즉시 fetch → R2(recordings/<id>/…) → recordings 행 + 기존 Whisper 전사
//                      (advanceRecording) → 202 { transcribing, recording_id }. 전사 완료 시 문서가 plaud_imports.doc_id에 연결된다 (index.ts).
// 토큰·인가 코드는 응답·로그에 넣지 않는다. 전사·요약 내용도 로그에 넣지 않는다 (식별자·상태만).
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, sha256hex, type SessionUser } from "../auth";
import { decryptToken, encryptToken } from "../calendar/crypto";
import {
  fmtClock, McpClient, McpError, noteToMarkdown, normalizeFiles, normalizeTranscript, type Segment,
} from "./mcp";
import {
  buildAuthUrl, disconnect, exchangeCode, getAccessToken, loadAccount, maskEmail, pkceChallenge, PlaudError,
  plaudConfigured, randomUrlToken, redirectAllowed, redirectUriFor, saveConnection, setEmail, setWorkspaceId, pickWorkspaceId, STATE_TTL_MS, type PlaudEnv,
} from "./oauth";

export type PlaudRouteEnv = PlaudEnv;
type C = Context<{ Bindings: PlaudEnv }>;
export const plaudApp = new Hono<{ Bindings: PlaudEnv }>();

/** index.ts가 주입한다 (indexDocument가 index.ts 안에 있어서). 문서 행 + R2 + 개인 RAG 색인까지 한다. */
export type PlaudHooks = {
  saveDocument: (env: PlaudEnv, d: { ownerId: string; title: string; content: string }) => Promise<{ docId: string; chunks: number; indexError?: string }>;
  /** 전사 없는 녹음: 오디오를 기존 업로드와 같은 규칙(recordings/<id>/<이름>)으로 R2에 저장하고 recordings 행 + 전사 시작까지 한다. */
  startTranscription: (env: PlaudEnv, ctx: { waitUntil(p: Promise<unknown>): void }, d: { ownerId: string; name: string; body: ReadableStream | ArrayBuffer; size: number; mime: string; durationMs?: number | null }) => Promise<{ recordingId: string }>;
};
let hooks: PlaudHooks | null = null;
export function setPlaudHooks(h: PlaudHooks): void { hooks = h; }

const SCHEMA_MSG = "Plaud 스키마가 아직 적용되지 않았습니다 (migration 0033)";
const OFF_MSG = "Plaud 연동 미설정";
const MAX_BODY = 16 * 1024;
const CONNECT_LIMIT_PER_MIN = 5;
const IMPORT_CLAIM_STALE_MS = 5 * 60_000;
const MAX_TRANSCRIPT_PAGES = 60;
const MAX_DOC_CHARS = 300_000;
const MAX_AUDIO_BYTES = 40 * 1024 * 1024; // 전사 워커가 오디오 전체를 메모리에 올리므로 상한을 둔다
const AUDIO_FETCH_TIMEOUT_MS = 100_000;   // presigned_url은 5분짜리 — 요청 안에서 즉시 받는다
const AUDIO_HOST_RE = /(^|\.)(amazonaws\.com|plaud\.ai)$/i;
const KST_MS = 9 * 3600_000;

class PlaudHttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function isSchemaMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(m) && /plaud_/i.test(m);
}

plaudApp.onError((e, c) => {
  if (e instanceof PlaudHttpError) return c.json({ ok: false, error: e.message, ...e.extra }, e.status as 400);
  if (isSchemaMissing(e)) return c.json({ ok: false, error: SCHEMA_MSG }, 503);
  console.log("[plaud] error:", e instanceof Error ? e.message : String(e));
  return c.json({ ok: false, error: "Plaud 처리 중 오류가 발생했습니다." }, 500);
});

function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try { return origin === new URL(c.req.url).origin; } catch { return false; }
}

async function requireUser(c: C): Promise<SessionUser> {
  const v = await getSessionUser(c.env, c.req.header("cookie"));
  if (!v) throw new PlaudHttpError(401, "로그인이 필요합니다.");
  c.header("cache-control", "no-store");
  return v;
}
async function requireWriter(c: C): Promise<SessionUser> {
  if (!originOk(c)) throw new PlaudHttpError(403, "허용되지 않는 요청입니다.");
  return requireUser(c);
}
async function readJson(c: C): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new PlaudHttpError(413, "요청이 너무 큽니다.");
  let v: unknown;
  try { v = JSON.parse(text || "{}"); } catch { throw new PlaudHttpError(400, "JSON 형식이 올바르지 않습니다."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PlaudHttpError(400, "JSON 객체가 필요합니다.");
  return v as Record<string, unknown>;
}

// 콜백은 설정 여부와 무관하게 HTML만 돌려준다. 나머지는 미설정이면 503 (fail-closed).
plaudApp.use("*", async (c, next) => {
  if (c.req.path.endsWith("/callback")) return next();
  if (!plaudConfigured(c.env)) {
    c.header("cache-control", "no-store");
    return c.json({ ok: false, error: OFF_MSG, configured: false }, 503);
  }
  await next();
});

// ---- 연결 (OAuth) ----

plaudApp.post("/connect", async (c) => {
  const v = await requireWriter(c);
  const redirectUri = redirectUriFor(c.env, c.req.url);
  if (!redirectUri) throw new PlaudHttpError(400, "이 주소에서는 Plaud 연결을 시작할 수 없습니다 (등록되지 않은 리디렉션 주소).");
  const now = Date.now();
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM plaud_oauth_states WHERE user_id = ? AND created_at > ?")
    .bind(v.id, now - 60_000).first<{ n: number }>();
  if ((recent?.n || 0) >= CONNECT_LIMIT_PER_MIN) throw new PlaudHttpError(429, "잠시 후 다시 시도하세요.");
  const state = randomUrlToken(32);
  const verifier = randomUrlToken(32);
  const verifierEnc = await encryptToken(c.env.GCAL_TOKEN_KEY, v.id, "plaud-pkce", verifier);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM plaud_oauth_states WHERE created_at < ?").bind(now - 86400_000),
    c.env.DB.prepare("INSERT INTO plaud_oauth_states (state_hash, user_id, code_verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256hex(state), v.id, verifierEnc, redirectUri, now),
  ]);
  return c.json({ ok: true, url: buildAuthUrl(c.env, { redirectUri, state, challenge: await pkceChallenge(verifier) }) });
});

function callbackHtml(nonce: string): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Plaud 연결 — People OS</title>
<style>body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f6f6f7;color:#14233a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center}
a{color:#123863}</style></head>
<body><main><h1 style="font-size:18px;margin:0 0 12px">Plaud 연결</h1>
<p id="m" role="status">연결을 마무리하는 중…</p><p id="b" hidden><a href="/#upload">녹음전사로 돌아가기</a></p></main>
<script nonce="${nonce}">
(function () {
  var p = new URLSearchParams(location.search);
  var code = p.get('code'), state = p.get('state'), err = p.get('error');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var m = document.getElementById('m'), b = document.getElementById('b');
  function fail(t) { m.textContent = t; b.hidden = false; }
  if (err) { fail(err === 'access_denied' ? 'Plaud 연결을 취소했습니다.' : 'Plaud가 연결 요청을 거절했습니다.'); return; }
  if (!code || !state) { fail('연결 정보가 없습니다. 녹음전사 화면에서 다시 시도하세요.'); return; }
  fetch('/api/plaud/complete', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code, state: state })
  }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (j) {
      if (j && j.ok) { m.textContent = 'Plaud를 연결했습니다. 녹음전사로 이동합니다…'; location.replace('/#upload'); }
      else fail('연결하지 못했습니다. ' + ((j && j.error) || ''));
    })
    .catch(function () { fail('네트워크 오류로 연결하지 못했습니다.'); });
})();
</script></body></html>`;
}

plaudApp.get("/callback", (c) => {
  const nonce = randomUrlToken(16);
  return c.html(callbackHtml(nonce), 200, {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
});

plaudApp.post("/complete", async (c) => {
  const v = await requireWriter(c);
  const b = await readJson(c);
  const code = b.code, state = b.state;
  if (typeof code !== "string" || !code || code.length > 2048) throw new PlaudHttpError(400, "인가 코드가 올바르지 않습니다.");
  if (typeof state !== "string" || !state || state.length > 256) throw new PlaudHttpError(400, "연결 요청이 올바르지 않습니다.");
  const now = Date.now();
  const st = await c.env.DB.prepare(
    `UPDATE plaud_oauth_states SET used_at = ?1
     WHERE state_hash = ?2 AND user_id = ?3 AND used_at IS NULL AND created_at > ?4
     RETURNING code_verifier, redirect_uri`,
  ).bind(now, await sha256hex(state), v.id, now - STATE_TTL_MS).first<{ code_verifier: string; redirect_uri: string }>();
  if (!st) throw new PlaudHttpError(400, "연결 요청이 만료되었거나 이미 사용되었습니다. 다시 연결하세요.");
  if (!redirectAllowed(c.env, st.redirect_uri)) throw new PlaudHttpError(400, "등록되지 않은 리디렉션 주소입니다.");
  let verifier: string;
  try { verifier = await decryptToken(c.env.GCAL_TOKEN_KEY, v.id, "plaud-pkce", st.code_verifier); }
  catch { throw new PlaudHttpError(400, "연결 요청을 확인할 수 없습니다. 다시 연결하세요."); }
  let t;
  try {
    t = await exchangeCode(c.env, { code, redirectUri: st.redirect_uri, verifier });
  } catch (e) {
    if (e instanceof PlaudError) {
      console.log(`[plaud] code exchange failed (${e.kind}: ${e.code}) user=${v.id}`);
      throw new PlaudHttpError(e.kind === "invalid_grant" ? 400 : 502, `Plaud 인증을 마치지 못했습니다 (${e.code}). 다시 연결하세요.`);
    }
    throw e;
  }
  await saveConnection(c.env, v.id, t, null);
  // 계정 확인(get_current_user)은 표시용 — 실패해도 연결은 유지한다.
  let email: string | null = null;
  try {
    const u = (await new McpClient(c.env, t.accessToken).call("get_current_user")) as Record<string, unknown>;
    email = typeof u.email === "string" ? u.email.slice(0, 320) : null;
    if (email) await setEmail(c.env, v.id, email);
    await setWorkspaceId(c.env, v.id, pickWorkspaceId(u)); // 진단(임시)
  } catch { /* 표시용 */ }
  console.log(`[plaud] connected user=${v.id}`);
  return c.json({ ok: true, status: "connected", email: maskEmail(email) });
});

plaudApp.get("/status", async (c) => {
  const v = await requireUser(c);
  // 목록 호출 없이 계정 행만 본다 (토큰 갱신은 실제 사용 시점에).
  const row = await loadAccount(c.env, v.id);
  if (!row) return c.json({ ok: true, configured: true, status: "not_connected" });
  return c.json({ ok: true, configured: true, status: "connected", email: maskEmail(row.plaud_email) });
});

plaudApp.post("/disconnect", async (c) => {
  const v = await requireWriter(c);
  const r = await disconnect(c.env, v.id);
  console.log(`[plaud] disconnected user=${v.id} existed=${r.existed}`);
  return c.json({ ok: true, status: "not_connected" });
});

// ---- MCP 호출 공통 ----

/** 내 토큰으로 MCP 작업을 돌린다. 401이면 한 번 갱신해 다시 시도하고, 그래도 안 되면 연결 해제 상태로 돌린다. */
async function withMcp<T>(c: C, userId: string, fn: (mcp: McpClient) => Promise<T>): Promise<T> {
  const notConnected = (expired?: boolean) =>
    new PlaudHttpError(409, expired ? "Plaud 연결이 만료되어 해제되었습니다. 다시 연결하세요." : "Plaud가 연결되어 있지 않습니다.", { code: "NOT_CONNECTED", expired: !!expired });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = await getAccessToken(c.env, userId, attempt === 1);
      if (a.state !== "connected") throw notConnected(a.expired);
      try {
        return await fn(new McpClient(c.env, a.accessToken));
      } catch (e) {
        if (e instanceof McpError && e.kind === "unauthorized") {
          if (attempt === 0) continue;
          await disconnect(c.env, userId);
          console.log(`[plaud] mcp unauthorized after refresh → disconnected user=${userId}`);
          throw notConnected(true);
        }
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof PlaudHttpError) throw e;
    if (e instanceof PlaudError || e instanceof McpError) {
      console.log(`[plaud] upstream error (${e.kind}) user=${userId}`);
      throw new PlaudHttpError(502, "Plaud에서 정보를 가져오지 못했습니다. 잠시 후 다시 시도하세요.", { code: "PLAUD_ERROR" });
    }
    throw e;
  }
  throw new PlaudHttpError(502, "Plaud에서 정보를 가져오지 못했습니다.", { code: "PLAUD_ERROR" });
}

const FILE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 이 사용자가 이미 가져온(그리고 문서가 아직 있는) 녹음 id → doc_id. */
async function importedMap(c: C, userId: string, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const ph = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT p.plaud_file_id, p.doc_id FROM plaud_imports p JOIN documents d ON d.id = p.doc_id
     WHERE p.user_id = ? AND p.plaud_file_id IN (${ph})`,
  ).bind(userId, ...ids).all<{ plaud_file_id: string; doc_id: string }>();
  for (const r of rows.results || []) m.set(r.plaud_file_id, r.doc_id);
  return m;
}

/** 전사 중인 녹음(전사 없는 Plaud 녹음을 People OS Whisper로 보낸 것) file id → recordings.id. 마이그레이션 0035 전이면 빈 맵. */
async function transcribingMap(c: C, userId: string, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const ph = ids.map(() => "?").join(",");
  try {
    const rows = await c.env.DB.prepare(
      `SELECT plaud_file_id, recording_id FROM plaud_imports WHERE user_id = ? AND doc_id IS NULL AND recording_id IS NOT NULL AND plaud_file_id IN (${ph})`,
    ).bind(userId, ...ids).all<{ plaud_file_id: string; recording_id: string }>();
    for (const r of rows.results || []) m.set(r.plaud_file_id, r.recording_id);
  } catch { /* 0035 미적용 */ }
  return m;
}

/** 이 사용자의 Plaud 녹음 file id → 연결된 recordings.id (Whisper로 전사한 녹음). doc_id 유무와 무관. 0035 전이면 빈 맵. */
async function linkedRecordingMap(c: C, userId: string, ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const ph = ids.map(() => "?").join(",");
  try {
    const rows = await c.env.DB.prepare(
      `SELECT plaud_file_id, recording_id FROM plaud_imports WHERE user_id = ? AND recording_id IS NOT NULL AND plaud_file_id IN (${ph})`,
    ).bind(userId, ...ids).all<{ plaud_file_id: string; recording_id: string }>();
    for (const r of rows.results || []) m.set(r.plaud_file_id, r.recording_id);
  } catch { /* 0035 미적용 */ }
  return m;
}

// ---- 목록 ----

plaudApp.get("/files", async (c) => {
  const v = await requireUser(c);
  const page = Math.max(1, Math.min(1000, parseInt(c.req.query("page") || "1", 10) || 1));
  const pageSize = Math.max(10, Math.min(50, parseInt(c.req.query("page_size") || "20", 10) || 20));
  const args: Record<string, unknown> = { page, page_size: pageSize };
  const q = (c.req.query("query") || "").trim().slice(0, 100);
  if (q) args.query = q;
  for (const k of ["date_from", "date_to"] as const) {
    const d = c.req.query(k);
    if (d) {
      if (!DATE_RE.test(d)) throw new PlaudHttpError(400, `${k}는 YYYY-MM-DD 형식이어야 합니다.`);
      args[k] = d;
    }
  }
  const raw = await withMcp(c, v.id, async (mcp) => {
    // 진단(임시): workspace_id 저장 — 실패해도 목록 조회는 계속한다.
    try {
      const u = await mcp.call("get_current_user");
      await setWorkspaceId(c.env, v.id, pickWorkspaceId(u));
      if (u && typeof u === "object") console.log(`[plaud] get_current_user keys=${Object.keys(u as object).join(",")}`);
    } catch { /* 진단이 목록을 막지 않는다 */ }
    return mcp.call("list_files", args);
  });
  // 진단(임시): 구조만 로그 — 제목·전사·요약 등 내용은 넣지 않는다.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    console.log(`[plaud] list_files keys=${Object.keys(r).join(",")} data_len=${Array.isArray(r.data) ? r.data.length : "n/a"}`);
  } else {
    console.log(`[plaud] list_files type=${Array.isArray(raw) ? "array len=" + raw.length : typeof raw}`);
  }
  const { files, complete } = normalizeFiles(raw);
  // 목록은 최신순으로 요청한다 (Plaud 기본 순서). 혹시 오름차순이면 아래에서 뒤집지 않고 그대로 보여 준다.
  const imp = await importedMap(c, v.id, files.map((f) => f.id));
  const trans = await transcribingMap(c, v.id, files.map((f) => f.id));
  const linked = await linkedRecordingMap(c, v.id, files.map((f) => f.id));
  return c.json({
    ok: true, page, page_size: pageSize, has_more: files.length >= pageSize, complete,
    files: files.map((f) => ({ ...f, imported: imp.has(f.id), doc_id: imp.get(f.id) ?? null, recording_id: imp.has(f.id) ? null : trans.get(f.id) ?? null, linked_recording_id: linked.get(f.id) ?? null })),
  });
});

// 전사 여부: 목록 응답에 필드가 없어 get_transcript 1쪽(구간 존재 여부)으로 판단한다. 행마다 필요할 때만 부른다.
plaudApp.get("/files/:id/transcript", async (c) => {
  const v = await requireUser(c);
  const id = c.req.param("id");
  if (!FILE_ID_RE.test(id)) throw new PlaudHttpError(400, "녹음 id가 올바르지 않습니다.");
  const raw = await withMcp(c, v.id, (mcp) => mcp.call("get_transcript", { file_id: id, limit: 10 }));
  const { segments } = normalizeTranscript(raw);
  return c.json({ ok: true, file_id: id, has_transcript: segments.length > 0 });
});

// ---- 가져오기 ----

function kstDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : new Date(t + KST_MS).toISOString().slice(0, 10);
}

function transcriptLines(segs: Segment[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const s of segs) {
    const line = `[${fmtClock(s.start)}] ${s.speaker ? s.speaker + ": " : ""}${s.content}`;
    size += line.length + 1;
    if (size > MAX_DOC_CHARS) { lines.push("(문서 길이 제한으로 이후 전사는 생략되었습니다.)"); break; }
    lines.push(line);
  }
  return lines.join("\n");
}

/** get_file 응답에서 presigned_url을 찾는다 (최상위·file 객체·data 중첩). https + 허용 호스트만 — 아니면 null. */
function findPresignedUrl(...objs: Record<string, unknown>[]): string | null {
  const cands: unknown[] = [];
  for (const o of objs) {
    for (const k of ["presigned_url", "presignedUrl", "download_url", "audio_url"]) cands.push(o[k]);
    const d = o.data;
    if (d && typeof d === "object") for (const k of ["presigned_url", "presignedUrl"]) cands.push((d as Record<string, unknown>)[k]);
  }
  for (const u of cands) {
    if (typeof u !== "string" || u.length > 4096) continue;
    try {
      const p = new URL(u);
      if (p.protocol === "https:" && AUDIO_HOST_RE.test(p.hostname)) return u;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** 오디오를 받는다. Content-Length가 있으면 본문 스트림 그대로 (메모리에 올리지 않고 R2로), 없으면 한도 안에서 통째로 읽는다. URL·내용은 로그에 남기지 않는다. */
async function fetchAudio(url: string): Promise<{ body: ReadableStream | ArrayBuffer; size: number; mime: string }> {
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS), redirect: "follow" }); }
  catch (e) {
    const er = e as { name?: string; message?: string };
    console.log(`[plaud] audio fetch failed err=${String(er?.name || "Error").slice(0, 40)}: ${String(er?.message || "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 120)}`);
    throw new PlaudHttpError(502, "Plaud 오디오를 받지 못했습니다. 잠시 후 다시 시도하세요.", { code: "AUDIO_FETCH_FAILED" });
  }
  if (!res.ok || !res.body) {
    console.log(`[plaud] audio fetch status=${res.status}`);
    await res.body?.cancel().catch(() => {});
    throw new PlaudHttpError(502, "Plaud 오디오를 받지 못했습니다. (주소가 만료되었을 수 있습니다. 다시 시도하세요.)", { code: "AUDIO_FETCH_FAILED" });
  }
  const len = parseInt(res.headers.get("content-length") || "", 10);
  const mime = (res.headers.get("content-type") || "").startsWith("audio/") ? (res.headers.get("content-type") as string) : "audio/ogg";
  const tooBig = () => new PlaudHttpError(413, `오디오가 너무 큽니다 (최대 ${MAX_AUDIO_BYTES / 1048576}MB).`, { code: "AUDIO_TOO_LARGE" });
  if (Number.isFinite(len) && len > 0) {
    if (len > MAX_AUDIO_BYTES) { await res.body.cancel().catch(() => {}); throw tooBig(); }
    return { body: res.body, size: len, mime };
  }
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new PlaudHttpError(502, "Plaud 오디오가 비어 있습니다.", { code: "AUDIO_FETCH_FAILED" });
  if (buf.byteLength > MAX_AUDIO_BYTES) throw tooBig();
  return { body: buf, size: buf.byteLength, mime };
}

plaudApp.post("/import", async (c) => {
  const v = await requireWriter(c);
  if (!hooks) throw new PlaudHttpError(503, "가져오기 기능이 준비되지 않았습니다.");
  const b = await readJson(c);
  const fileId = b.file_id;
  if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) throw new PlaudHttpError(400, "녹음 id가 올바르지 않습니다.");
  const db = c.env.DB;
  const now = Date.now();

  // 문서가 지워진 옛 가져오기 기록은 치워서 다시 가져올 수 있게 한다.
  await db.prepare(
    "DELETE FROM plaud_imports WHERE user_id = ?1 AND plaud_file_id = ?2 AND doc_id IS NOT NULL AND doc_id NOT IN (SELECT id FROM documents)",
  ).bind(v.id, fileId).run();
  // 점유: 같은 녹음을 동시에 두 번 가져오지 못하게 한다.
  const claim = await db.prepare("INSERT OR IGNORE INTO plaud_imports (user_id, plaud_file_id, doc_id, title, created_at) VALUES (?, ?, NULL, NULL, ?)")
    .bind(v.id, fileId, now).run();
  if (!claim.meta.changes) {
    let ex = await db.prepare("SELECT doc_id, created_at, recording_id FROM plaud_imports WHERE user_id = ? AND plaud_file_id = ?")
      .bind(v.id, fileId).first<{ doc_id: string | null; created_at: number; recording_id: string | null }>()
      .catch(() => db.prepare("SELECT doc_id, created_at FROM plaud_imports WHERE user_id = ? AND plaud_file_id = ?")
        .bind(v.id, fileId).first<{ doc_id: string | null; created_at: number; recording_id: string | null }>()); // 0035 미적용 폴백
    if (ex?.doc_id) throw new PlaudHttpError(409, "이미 가져온 녹음입니다.", { code: "ALREADY_IMPORTED", doc_id: ex.doc_id });
    // 전사 큐에 이미 건 녹음: 다시 가져오기를 눌러도 중복으로 쌓지 않는다 (진행 상태만 알려 준다).
    if (ex?.recording_id) {
      const rec = await db.prepare("SELECT transcript_status FROM recordings WHERE id = ? AND owner_id = ?").bind(ex.recording_id, v.id).first<{ transcript_status: string }>();
      if (rec) {
        throw new PlaudHttpError(409, rec.transcript_status === "pending"
          ? "이 녹음의 전사가 중단되었습니다. 녹음 목록에서 '다시 전사'를 눌러 이어가세요."
          : "이 녹음은 이미 전사 중입니다.",
        { code: "TRANSCRIBING", recording_id: ex.recording_id, recording_status: rec.transcript_status });
      }
      // 녹음 행이 사라졌으면 옛 점유로 보고 아래에서 다시 시작한다.
      await db.prepare("UPDATE plaud_imports SET recording_id = NULL, created_at = 0 WHERE user_id = ? AND plaud_file_id = ? AND doc_id IS NULL").bind(v.id, fileId).run();
      ex = { ...ex, recording_id: null, created_at: 0 };
    }
    if (ex && now - ex.created_at < IMPORT_CLAIM_STALE_MS) throw new PlaudHttpError(409, "이 녹음을 가져오는 중입니다.", { code: "IN_PROGRESS" });
    const take = await db.prepare("UPDATE plaud_imports SET created_at = ? WHERE user_id = ? AND plaud_file_id = ? AND doc_id IS NULL AND created_at = ?")
      .bind(now, v.id, fileId, ex?.created_at ?? 0).run();
    if (!take.meta.changes) throw new PlaudHttpError(409, "이 녹음을 가져오는 중입니다.", { code: "IN_PROGRESS" });
  }
  const release = () => db.prepare("DELETE FROM plaud_imports WHERE user_id = ? AND plaud_file_id = ? AND doc_id IS NULL").bind(v.id, fileId).run();

  try {
    const got = await withMcp(c, v.id, async (mcp) => {
      const fileRaw = (await mcp.call("get_file", { file_id: fileId })) as Record<string, unknown>;
      const segs: Segment[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_TRANSCRIPT_PAGES; i++) {
        const raw = await mcp.call("get_transcript", { file_id: fileId, block: "transaction", limit: 500, ...(cursor ? { cursor } : {}) });
        const p = normalizeTranscript(raw);
        segs.push(...p.segments);
        if (!p.nextCursor || p.nextCursor === cursor) break;
        cursor = p.nextCursor;
      }
      let note = "";
      if (segs.length) {
        try { note = noteToMarkdown(await mcp.call("get_note", { file_id: fileId })); } catch { note = ""; } // 요약은 있으면 붙인다
      }
      return { fileRaw, segs, note };
    });
    const f = (got.fileRaw.file && typeof got.fileRaw.file === "object" ? got.fileRaw.file : got.fileRaw) as Record<string, unknown>;
    const name = (typeof f.name === "string" && f.name.trim() ? f.name.trim() : "Plaud 녹음").slice(0, 200);
    const when = kstDate(typeof f.start_at === "string" ? f.start_at : typeof f.created_at === "string" ? f.created_at : null);
    const dur = typeof f.duration === "number" ? fmtClock(f.duration) : "";
    const head = `출처: Plaud 녹음${when ? ` · 녹음일 ${when}` : ""}${dur ? ` · 길이 ${dur}` : ""} · Plaud 파일 ID ${fileId}`;

    if (!got.segs.length) {
      // Plaud 전사가 없다 → get_file의 presigned_url(5분)로 오디오를 지금 받아 R2에 저장하고,
      // 기존 업로드 전사 흐름(recordings 행 + advanceRecording + 파이프라인 큐)에 태운다. 전사는 오래 걸리므로 202로 진행 중을 돌려준다.
      const url = findPresignedUrl(got.fileRaw, f);
      if (!url) throw new PlaudHttpError(502, "Plaud가 오디오 주소를 주지 않아 전사할 수 없습니다.", { code: "NO_AUDIO_URL" });
      const audio = await fetchAudio(url);
      const { recordingId } = await hooks.startTranscription(c.env, c.executionCtx, {
        ownerId: v.id, name: `${name.replace(/\.[^.]+$/, "") || "Plaud 녹음"}.ogg`, body: audio.body, size: audio.size, mime: audio.mime,
        durationMs: typeof f.duration === "number" ? f.duration : null, // Plaud duration은 ms (fmtClock과 같은 단위)
      });
      await db.prepare("UPDATE plaud_imports SET recording_id = ?, header = ?, title = ? WHERE user_id = ? AND plaud_file_id = ?")
        .bind(recordingId, head, name, v.id, fileId).run();
      console.log(`[plaud] transcribe queued user=${v.id} recording=${recordingId} bytes=${audio.size}`);
      return c.json({ ok: true, transcribing: true, recording_id: recordingId, title: name, size: audio.size }, 202);
    }
    const content = [`# ${name}`, "", head, "", got.note ? `## 요약\n\n${got.note}\n` : "", "## 전사", "", transcriptLines(got.segs)]
      .filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
    const saved = await hooks.saveDocument(c.env, { ownerId: v.id, title: name, content });
    await db.prepare("UPDATE plaud_imports SET doc_id = ?, title = ? WHERE user_id = ? AND plaud_file_id = ?").bind(saved.docId, name, v.id, fileId).run();
    console.log(`[plaud] imported user=${v.id} doc=${saved.docId} segments=${got.segs.length} chunks=${saved.chunks}`);
    return c.json({
      ok: true, doc_id: saved.docId, title: name, segments: got.segs.length, has_summary: !!got.note,
      chunks: saved.chunks, ...(saved.indexError ? { indexError: saved.indexError } : {}),
    }, 201);
  } catch (e) {
    await release().catch(() => {});
    throw e;
  }
});
