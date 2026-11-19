// Plaud 연동 (2026-11-19): Plaud MCP 서버(Streamable HTTP)의 최소 클라이언트.
// 참고 구현: custom-connectors/custom.plaud/bin/client.py — initialize → notifications/initialized → tools/call,
// Mcp-Session-Id 유지, JSON 또는 SSE 응답 파싱. 읽기 전용 도구 5개만 허용한다 (Plaud MCP가 읽기 전용).
import { plaudBase, type PlaudEnv } from "./oauth";

const ALLOWED_TOOLS = new Set(["list_files", "get_file", "get_note", "get_transcript", "get_current_user"]);
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const TIMEOUT_MS = 30_000;

export class McpError extends Error {
  /** unauthorized = 401/403 (토큰 갱신 후 재시도 대상), rpc = JSON-RPC·도구 오류, http/network/protocol = 전송 문제 */
  constructor(public kind: "unauthorized" | "http" | "network" | "protocol" | "rpc", message: string) {
    super(message);
  }
}

type JsonObj = Record<string, unknown>;

/** SSE 본문에서 id가 맞는 JSON-RPC 메시지를 찾는다. */
function pickFromSse(text: string, id: number): JsonObj | null {
  let data: string[] = [];
  const flush = (): JsonObj | null => {
    if (!data.length) return null;
    const raw = data.join("\n");
    data = [];
    try {
      const m = JSON.parse(raw) as JsonObj;
      if (m && m.jsonrpc === "2.0" && m.id === id) return m;
    } catch { /* 다음 이벤트로 */ }
    return null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line === "") { const m = flush(); if (m) return m; }
  }
  return flush();
}

export class McpClient {
  private session: string | null = null;
  private protocol = PROTOCOLS[0];
  private seq = 0;
  private ready = false;
  constructor(private env: PlaudEnv, private accessToken: string) {}

  private async send(method: string, params: JsonObj, notification = false): Promise<JsonObj | null> {
    const id = notification ? null : ++this.seq;
    const body: JsonObj = { jsonrpc: "2.0", method, params };
    if (id !== null) body.id = id;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.accessToken}`,
      "mcp-protocol-version": this.protocol,
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    let res: Response;
    try {
      res = await fetch(`${plaudBase(this.env)}/mcp`, {
        // workerd는 redirect:"error"를 지원하지 않는다 → "manual"로 받고 3xx는 아래에서 오류 처리 (토큰이 든 요청을 따라가지 않는다).
        method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new McpError("network", "Plaud MCP 요청이 완료되지 않았습니다.");
    }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); throw new McpError("http", "리디렉션은 허용되지 않습니다."); }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); throw new McpError("unauthorized", `http ${res.status}`); }
    const sid = res.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]+$/.test(sid)) this.session = sid;
    if (notification) {
      await res.body?.cancel().catch(() => {});
      if (res.status !== 202 && res.status !== 200) throw new McpError("protocol", "initialized 알림이 거절되었습니다.");
      return null;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new McpError("http", `http ${res.status}`); }
    let text: string;
    try { text = await res.text(); } catch { throw new McpError("network", "Plaud MCP 응답을 읽지 못했습니다."); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    let msg: JsonObj | null = null;
    if (ct === "text/event-stream") msg = pickFromSse(text, id as number);
    else {
      try { msg = JSON.parse(text) as JsonObj; } catch { msg = null; }
    }
    if (!msg || msg.jsonrpc !== "2.0" || msg.id !== id) throw new McpError("protocol", "응답 형식이 올바르지 않습니다.");
    if (msg.error) throw new McpError("rpc", "Plaud MCP가 오류를 돌려줬습니다.");
    if (!msg.result || typeof msg.result !== "object") throw new McpError("protocol", "result가 없습니다.");
    return msg.result as JsonObj;
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    const r = await this.send("initialize", {
      protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: "people-os", version: "1" },
    });
    const proto = r?.protocolVersion;
    const caps = r?.capabilities as JsonObj | undefined;
    if (typeof proto !== "string" || !PROTOCOLS.includes(proto) || !caps || typeof caps.tools !== "object") {
      throw new McpError("protocol", "지원하는 MCP 도구 프로토콜이 아닙니다.");
    }
    this.protocol = proto;
    await this.send("notifications/initialized", {}, true);
    this.ready = true;
  }

  /** 도구 호출 → 구조화된 결과(structuredContent, 없으면 text 콘텐츠를 JSON으로 해석). 도구 오류(isError)는 McpError("rpc"). */
  async call(name: string, args: JsonObj = {}): Promise<unknown> {
    if (!ALLOWED_TOOLS.has(name)) throw new McpError("protocol", "허용되지 않은 도구입니다.");
    await this.init();
    const r = (await this.send("tools/call", { name, arguments: args })) as JsonObj;
    if (r.isError) throw new McpError("rpc", "Plaud 도구가 오류를 돌려줬습니다.");
    if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
    const content = Array.isArray(r.content) ? (r.content as JsonObj[]) : [];
    const text = content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n");
    if (!text) return {};
    const parsed = parseToolText(text);
    if (parsed.via === "wrapper") console.log(`[plaud] ${name} json extracted from wrapper`);
    return parsed.value;
  }
}

/** text → JSON. 그대로 파싱 → 실패 시 가장 바깥 {…}를 잘라 파싱(인젝션 방어 래퍼 대응) → 그래도 실패면 {text}. 내용은 로그하지 않는다. */
export function parseToolText(text: string): { value: unknown; via: "direct" | "wrapper" | "fallback" } {
  try { return { value: JSON.parse(text), via: "direct" }; } catch { /* fall through */ }
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { return { value: JSON.parse(text.slice(a, b + 1)), via: "wrapper" }; } catch { /* fall through */ }
  }
  return { value: { text }, via: "fallback" };
}

// ---- 결과 정규화 (응답 필드 이름이 문서와 조금 달라도 견디도록 방어적으로) ----

const asObj = (v: unknown): JsonObj => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function firstArray(o: unknown, keys: string[]): JsonObj[] {
  if (Array.isArray(o)) return o.filter((x) => x && typeof x === "object") as JsonObj[];
  const obj = asObj(o);
  for (const k of keys) if (Array.isArray(obj[k])) return (obj[k] as unknown[]).filter((x) => x && typeof x === "object") as JsonObj[];
  for (const v of Object.values(obj)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v as JsonObj[];
  return [];
}

export type PlaudFile = { id: string; name: string; created_at: string | null; start_at: string | null; duration_ms: number | null };

export function normalizeFiles(raw: unknown): { files: PlaudFile[]; complete: boolean | null } {
  const files = firstArray(raw, ["files", "items", "recordings", "data", "results"])
    .map((f) => ({
      id: str(f.id ?? f.file_id),
      name: str(f.name ?? f.title) || "(이름 없음)",
      created_at: str(f.created_at) || null,
      start_at: str(f.start_at) || null,
      duration_ms: num(f.duration),
    }))
    .filter((f) => f.id);
  const c = asObj(raw).complete;
  return { files, complete: typeof c === "boolean" ? c : null };
}

export type Segment = { start: number | null; end: number | null; speaker: string; content: string };

export function normalizeTranscript(raw: unknown): { segments: Segment[]; nextCursor: string | null } {
  const o = asObj(raw);
  const segments = firstArray(raw, ["segments", "transcript", "items"])
    .map((s) => ({ start: num(s.start_time), end: num(s.end_time), speaker: str(s.speaker), content: str(s.content ?? s.text).trim() }))
    .filter((s) => s.content);
  const nc = o.next_cursor;
  return { segments, nextCursor: typeof nc === "string" && nc ? nc : null };
}

/** 밀리초 → 'm:ss' / 'h:mm:ss'. */
export function fmtClock(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
}

/** get_note 결과 → 마크다운. 구조를 모르므로 문자열·목록·중첩 객체를 일반 규칙으로 옮기고 URL·토큰·ID 류 키는 뺀다. */
export function noteToMarkdown(raw: unknown, maxChars = 20_000): string {
  const skip = /(^|_)(id|ids|url|urls|token|presigned_url|created_at|updated_at|version)$/i;
  const out: string[] = [];
  const walk = (v: unknown, depth: number, label: string | null): void => {
    if (out.join("\n").length > maxChars) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) return;
      if (label && depth <= 3) out.push(`${"#".repeat(Math.min(depth + 2, 5))} ${label}`);
      out.push(t);
    } else if (typeof v === "number" || typeof v === "boolean") {
      return;
    } else if (Array.isArray(v)) {
      const items = v.filter((x) => x !== null && x !== undefined);
      if (!items.length) return;
      if (label && depth <= 3) out.push(`${"#".repeat(Math.min(depth + 2, 5))} ${label}`);
      for (const it of items) {
        if (typeof it === "string") out.push(`- ${it.trim()}`);
        else walk(it, depth + 1, null);
      }
    } else if (v && typeof v === "object") {
      if (label && depth <= 3) out.push(`${"#".repeat(Math.min(depth + 2, 5))} ${label}`);
      for (const [k, val] of Object.entries(v as JsonObj)) {
        if (skip.test(k)) continue;
        walk(val, depth + 1, k);
      }
    }
  };
  walk(raw, 0, null);
  return out.join("\n\n").slice(0, maxChars);
}
