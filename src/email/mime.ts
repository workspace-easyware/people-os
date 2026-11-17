// 메일함 (2026-11-17): 의존성 없는 최소 MIME 파서.
// Agentic Inbox는 postal-mime으로 파싱하지만, 이 환경에서는 패키지 설치가 막혀 있어
// 같은 결과(from/to/cc/subject/messageId/inReplyTo/references/text/html/attachments)를
// 내는 작은 파서를 직접 둔다. 원문은 파싱 전에 항상 R2에 먼저 저장하므로(inbound.ts)
// 여기서 실패해도 메일은 소실되지 않는다.
// 지원: RFC 5322 헤더(접힘), RFC 2047 인코딩 단어(B/Q), RFC 2231 파라미터(filename*),
// multipart/* 재귀, base64·quoted-printable, charset(TextDecoder 라벨 — utf-8·euc-kr·ks_c_5601-1987 등),
// RFC 3676 format=flowed.
// 2026-11-17 postal-mime 2.6.1과 같은 입력으로 비교(files/email-test/compare-postal.mjs, workerd):
// postal-mime은 한글이 두 인코딩 단어에 나뉜 제목(UTF-8·EUC-KR), cp949 라벨, 8비트 EUC-KR 헤더·파일명,
// 종료 구분선 누락 메일에서 글자가 깨지거나 본문을 잃었다 → 의존성을 추가하지 않고 이 파서를 유지한다.
// postal-mime에서 가져온 것: format=flowed 복원, 첨부 파일명의 제어문자 정리.

export type ParsedAttachment = {
  filename: string;
  contentType: string;
  contentId?: string;
  inline: boolean;
  content: Uint8Array;
};

export type ParsedEmail = {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageId: string;
  inReplyTo: string;
  references: string[];
  text: string;
  html: string;
  attachments: ParsedAttachment[];
};

type Headers = Map<string, string[]>;

/** 바이트 → 바이트 그대로의 "binary string"(latin1). 오프셋이 바이트와 1:1로 맞는다. */
function toBinary(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return s;
}

function fromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// WHATWG TextDecoder가 모르는 실사용 한국어 라벨 → euc-kr(=windows-949 디코더).
// (ks_c_5601-1987·ksc5601·windows-949 등은 TextDecoder가 이미 안다.)
const CHARSET_ALIASES: Record<string, string> = {
  cp949: "euc-kr", ms949: "euc-kr", "x-windows-949": "euc-kr", uhc: "euc-kr",
  "ks_c_5601": "euc-kr", "x-euc-kr": "euc-kr", "euc_kr": "euc-kr", "utf_8": "utf-8",
};

/** charset 라벨로 디코딩. 모르는 라벨은 utf-8(비치명)로 폴백한다. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  let label = (charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  label = CHARSET_ALIASES[label] || label;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 8비트 헤더(인코딩 단어 없이 원문 바이트를 넣는 발송기)를 살린다.
 *  UTF-8로 먼저 엄격 디코딩하고, 실패하면 국내 구형 메일러가 흔히 쓰는 EUC-KR(CP949)로 읽는다. */
function binaryHeaderToText(s: string): string {
  if (!/[\x80-\xff]/.test(s)) return s;
  const bytes = fromBinary(s);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("euc-kr", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function decodeBase64Binary(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  // atob은 패딩이 맞지 않으면 throw — 4의 배수로 맞춘다.
  const trimmed = clean.replace(/=+$/, "");
  const padded = trimmed + "===".slice(0, (4 - (trimmed.length % 4)) % 4);
  try {
    return atob(padded.length % 4 === 1 ? padded.slice(0, -1) : padded);
  } catch {
    return "";
  }
}

function decodeQuotedPrintableBinary(s: string, header = false): string {
  if (header) s = s.replace(/_/g, " ");
  return s
    .replace(/=[ \t]*\r?\n/g, "") // 소프트 줄바꿈 (일부 메일러는 '=' 뒤에 공백을 남긴다)
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** RFC 2047 인코딩 단어 디코딩. 인접한 인코딩 단어 사이 공백은 지운다.
 *  같은 charset의 인접 단어는 바이트를 먼저 이어 붙인 뒤 한 번에 디코딩한다 — 발송기가
 *  한글 한 글자(UTF-8 3바이트·EUC-KR 2바이트)를 두 단어에 나눠 담는 경우가 흔해서,
 *  단어별로 따로 디코딩하면 경계 글자가 깨진다(�). */
export function decodeWords(value: string): string {
  const v = binaryHeaderToText(value).replace(/(\?=)\s+(=\?)/g, "$1$2");
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let pendCs = "";
  let pendBin = "";
  const flush = () => {
    if (pendCs) out += decodeCharset(fromBinary(pendBin), pendCs);
    pendCs = "";
    pendBin = "";
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    const charset = m[1].split("*")[0].toLowerCase(); // RFC 2231 언어 접미사 제거
    const bin = m[2].toUpperCase() === "B" ? decodeBase64Binary(m[3]) : decodeQuotedPrintableBinary(m[3], true);
    const adjacent = m.index === last && pendCs !== "";
    if (!adjacent || charset !== pendCs) {
      flush();
      out += v.slice(last, m.index);
    }
    pendCs = charset;
    pendBin += bin;
    last = m.index + m[0].length;
  }
  flush();
  return out + v.slice(last);
}

function parseHeaders(block: string): Headers {
  const map: Headers = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    const arr = map.get(name);
    if (arr) arr.push(value);
    else map.set(name, [value]);
  }
  return map;
}

function h(map: Headers, name: string): string {
  const v = map.get(name);
  return v && v.length ? v[0] : "";
}

/** `type/sub; a=b; c*=utf-8''..` → { value, params }. RFC 2231 연속(name*0*, name*1)도 합친다. */
function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") inQ = !inQ;
    if (ch === ";" && !inQ) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const main = (parts.shift() || "").trim().toLowerCase();
  const raw: Record<string, { v: string; ext: boolean }[]> = {};
  const simple: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = key.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (m) {
      const base = m[1];
      const idx = m[2] ? parseInt(m[2], 10) : 0;
      const ext = !!m[3] || (!m[2] && key.endsWith("*"));
      (raw[base] ||= [])[idx] = { v: val, ext };
    } else {
      simple[key] = val;
    }
  }
  // 일반 파라미터: 인코딩 단어(=?..?=) 또는 8비트 원문(filename="휴가.pdf"를 UTF-8/EUC-KR 바이트 그대로) 모두 처리.
  // RFC 2231 값은 아래에서 이미 유니코드로 디코딩되므로 여기서 다시 바이트 해석을 하지 않는다.
  const params: Record<string, string> = {};
  // boundary는 '='·'?'를 합법적으로 포함할 수 있으므로 원문 그대로 둔다.
  for (const [k, val] of Object.entries(simple)) params[k] = k === "boundary" ? val : decodeWords(val);
  for (const [base, segs] of Object.entries(raw)) {
    let charset = "utf-8";
    let bin = "";
    segs.forEach((s, i) => {
      if (!s) return;
      let v = s.v;
      if (s.ext) {
        if (i === 0) {
          const q = v.match(/^([^']*)'[^']*'(.*)$/);
          if (q) { charset = q[1] || "utf-8"; v = q[2]; }
        }
        bin += v.replace(/%([0-9A-Fa-f]{2})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
      } else {
        bin += v;
      }
    });
    params[base] = decodeCharset(fromBinary(bin), charset);
  }
  return { value: main, params };
}

function splitHeaderBody(bin: string): { head: string; body: string } {
  // 헤더 없는 파트(구분선 바로 뒤 빈 줄) — 기본값 text/plain; us-ascii로 본문만 있다.
  const lead = bin.match(/^\r?\n/);
  if (lead) return { head: "", body: bin.slice(lead[0].length) };
  const m = bin.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { head: bin, body: "" };
  return { head: bin.slice(0, m.index), body: bin.slice(m.index + m[0].length) };
}

function decodeTransfer(body: string, cte: string): string {
  const e = cte.trim().toLowerCase();
  if (e === "base64") return decodeBase64Binary(body);
  if (e === "quoted-printable") return decodeQuotedPrintableBinary(body);
  return body;
}

/** RFC 3676 format=flowed 복원 (postal-mime 대응 — Thunderbird·일부 모바일 메일러).
 *  공백으로 끝나는 줄은 다음 줄(같은 인용 깊이)과 이어 붙이고, delsp=yes면 그 공백을 지운다.
 *  줄 맨 앞 공백 하나는 space-stuffing이라 제거한다. 서명 구분선 "-- "은 이어 붙이지 않는다. */
export function unflowText(text: string, delsp: boolean): string {
  const out: string[] = [];
  let buf: string | null = null;
  let bufDepth = -1;
  for (const line of text.split(/\r?\n/)) {
    const q = line.match(/^>+/);
    const depth = q ? q[0].length : 0;
    let content = line.slice(depth);
    if (content.startsWith(" ")) content = content.slice(1);
    const flowed = content.endsWith(" ") && content !== "-- ";
    if (flowed && delsp) content = content.slice(0, -1);
    if (buf !== null && depth === bufDepth) {
      buf += content;
    } else {
      if (buf !== null) out.push(buf);
      buf = (depth ? ">".repeat(depth) + " " : "") + content;
      bufDepth = depth;
    }
    if (!flowed) { out.push(buf); buf = null; bufDepth = -1; }
  }
  if (buf !== null) out.push(buf);
  return out.join("\n");
}

/** 첨부 파일명 정리 (Agentic Inbox lib/attachments.ts와 같은 문자 집합): 경로 구분자·제어문자 등을 '_'로. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\:*?"<>|\x00-\x1f\x7f]/g, "_").trim().slice(0, 255);
}

type Acc = { text: string[]; html: string[]; attachments: ParsedAttachment[] };

function walk(bin: string, acc: Acc, depth: number): void {
  if (depth > 12) return; // 비정상 중첩 방지
  const { head, body } = splitHeaderBody(bin);
  const headers = parseHeaders(head);
  const ct = parseParams(h(headers, "content-type") || "text/plain; charset=us-ascii");
  const disp = parseParams(h(headers, "content-disposition"));
  const cte = h(headers, "content-transfer-encoding");
  const type = ct.value || "text/plain";

  if (type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) { acc.text.push(binaryHeaderToText(body)); return; }
    // 구분선은 줄 시작에서 "--boundary" + (선택 "--") + 공백만 있는 줄이어야 한다(RFC 2046).
    // 단순 split("--"+boundary)은 바깥 boundary가 안쪽 boundary의 접두사일 때
    // (예: "b1" / "b1_alt") 안쪽 구분선에서도 잘라 구조를 망가뜨린다.
    const lines = body.split(/(?<=\n)/); // 줄바꿈 유지
    const delim = "--" + boundary;
    let cur: string[] | null = null; // null = preamble
    const parts: string[] = [];
    let closed = false;
    for (const line of lines) {
      const bare = line.replace(/[ \t]*\r?\n$/, "").replace(/[ \t]+$/, "");
      if (bare === delim || bare === delim + "--") {
        if (cur) parts.push(cur.join("").replace(/\r?\n$/, "")); // 구분선 앞 CRLF는 구분선 소속
        if (bare !== delim) { closed = true; cur = null; break; }
        cur = [];
        continue;
      }
      if (cur) cur.push(line);
    }
    if (!closed && cur) parts.push(cur.join("")); // 종료 구분선 없이 잘린 메일도 살린다
    for (const seg of parts) walk(seg, acc, depth + 1);
    return;
  }

  const filename = sanitizeFilename(disp.params.filename || ct.params.name || "");
  const decoded = decodeTransfer(body, cte);
  // 본문: 파일명 없는 text/plain·text/html (attachment 처분 제외). 그 밖(text/calendar 포함)은 첨부.
  const isBody = (type === "text/plain" || type === "text/html") && disp.value !== "attachment" && !filename;
  if (isBody) {
    // charset이 없거나 us-ascii인데 8비트 바이트가 있으면 (국내 구형 발송기) UTF-8 엄격 → EUC-KR 순으로 읽는다.
    const cs = (ct.params.charset || "").trim().toLowerCase();
    let text = !cs || cs === "us-ascii" || cs === "ascii" ? binaryHeaderToText(decoded) : decodeCharset(fromBinary(decoded), cs);
    if (type === "text/plain" && (ct.params.format || "").toLowerCase() === "flowed") {
      text = unflowText(text, (ct.params.delsp || "").toLowerCase() === "yes");
    }
    (type === "text/html" ? acc.html : acc.text).push(text);
    return;
  }
  const cid = h(headers, "content-id").replace(/^<|>$/g, "");
  const ext = type === "message/rfc822" ? ".eml" : "";
  acc.attachments.push({
    filename: filename || `attachment-${acc.attachments.length + 1}${ext}`,
    contentType: type,
    contentId: cid || undefined,
    // Content-Disposition 없이 Content-ID만 있는 이미지(multipart/related 본문 내 그림)도 인라인.
    inline: disp.value === "inline" || (!disp.value && !!cid),
    content: fromBinary(decoded),
  });
}

function messageIds(v: string): string[] {
  return (v.match(/<[^<>\s]+>/g) || []).map((x) => x.trim());
}

/** 원문(.eml 바이트)을 파싱한다. 실패하면 throw — 호출자가 parse_error로 남긴다. */
export function parseEmail(raw: Uint8Array): ParsedEmail {
  const bin = toBinary(raw);
  const { head } = splitHeaderBody(bin);
  const headers = parseHeaders(head);
  const acc: Acc = { text: [], html: [], attachments: [] };
  walk(bin, acc, 0);
  const text = acc.text.join("\n\n").trim();
  const html = acc.html.join("\n").trim();
  return {
    from: decodeWords(h(headers, "from")),
    to: decodeWords((headers.get("to") || []).join(", ")),
    cc: decodeWords((headers.get("cc") || []).join(", ")),
    subject: decodeWords(h(headers, "subject")),
    date: h(headers, "date"),
    messageId: messageIds(h(headers, "message-id"))[0] || "",
    inReplyTo: messageIds(h(headers, "in-reply-to"))[0] || "",
    references: messageIds((headers.get("references") || []).join(" ")),
    text: text || (html ? htmlToText(html) : ""),
    html,
    attachments: acc.attachments,
  };
}

/** HTML만 있는 메일의 검색·미리보기용 텍스트. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** "이름 <a@b.c>, c@d.e" → 주소 목록(소문자). */
export function extractAddresses(v: string): string[] {
  const out: string[] = [];
  const re = /<([^<>\s]+@[^<>\s]+)>|([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) out.push((m[1] || m[2]).toLowerCase());
  return [...new Set(out)];
}

/** 스레딩용 제목 정규화: Re:/Fwd:/회신:/답장:/전달: 접두와 [태그] 공백 정리. */
export function normalizeSubject(s: string): string {
  let t = (s || "").trim();
  for (let i = 0; i < 6; i++) {
    const n = t.replace(/^\s*((re|fw|fwd|aw|sv|회신|답장|전달)\s*(\[\d+\])?\s*[:：]\s*)/i, "");
    if (n === t) break;
    t = n;
  }
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}
