// DOCX 편집 코어 (2026-11-22). ooxml-core 2.0.0의 docx 영역(loadDocx → 모델 수정 → save, 손대지 않은 부품·XML은 그대로 두는 patch 방식 writer) + fflate.
// 파일럿 files/workflow-verify/docx-edit-pilot/src/core.js를 그대로 옮겼다 (파일럿 결과: files/workflow-verify/docx-edit-pilot/RESULT.md).
// index.js의 PptxEditor 엔트리포인트가 inspectDocument / applyDocumentOps / replaceDocumentText RPC로 부른다.
//
// 문단 번호(index)는 inspect가 돌려주는 "읽는 순서" 번호다 (1부터): 본문 문단, 표는 행·셀 순서대로 셀 안의 문단. ops의 index는 모두 **편집 전** 문서 기준이다.
// ops:
//   {op:"replace",   find, to, all?}          글자 찾아 바꾸기 (본문·표·머리글·바닥글). all이 true가 아니면 처음 1곳만. run이 쪼개진 글자도 찾는다.
//   {op:"paragraph", index, text}             문단 글 전체를 바꾼다 (첫 run의 글자 서식을 따른다. 필드·그림은 남는다)
//   {op:"cell",      table, r, c, text}       table번째 표(1부터)의 r행 c열(0부터) 셀 글을 바꾼다 (셀의 첫 문단에 쓰고 나머지 문단은 비운다)
//   {op:"insert",    after, text}             after번 문단 뒤에 새 문단을 넣는다 (그 문단의 스타일을 따른다. 0이면 문서 맨 앞). 본문 문단만.
//   {op:"delete",    index}                   문단을 지운다. 본문 문단만.
// 삭제로 추적된 글자(w:del)·필드 결과·각주 표시·그림·수식은 건드리지 않는다.
import { loadDocx } from "ooxml-core/docx";
import { unzipSync, strFromU8 } from "fflate";

export const DOCX_EDIT_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024, // People OS 업로드 상한(10MB)·RPC 메시지 여유
  maxTotalBytes: 200 * 1024 * 1024, // 압축 해제 합계 (128MB isolate 안에서)
  maxParts: 5000,
  maxDocumentPartBytes: 8 * 1024 * 1024, // word/document.xml (파일럿 실측: 문단 5,000개 ≈ 1.6 MB)
  maxParagraphs: 5000, // 읽는 순서 문단 수 (표 셀 안 포함)
});
export const DOCX_MAX_OPS = 100;
export const DOCX_MAX_TEXT = 10_000; // op 하나의 글자 수
export const DOCX_MAX_FIND = 500;
const PREVIEW_BLOCKS = 400;
const PREVIEW_TEXT = 300;

export class EditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new EditError("bad_input", "bytes는 Uint8Array 또는 ArrayBuffer여야 합니다.");
}

/** [vars] DOCX_MAX_PARAGRAPHS로 문단 상한을 **낮출** 수만 있다 (올리지 못한다). */
export function docxLimits(env) {
  const v = Number(env && env.DOCX_MAX_PARAGRAPHS);
  return Number.isInteger(v) && v > 0 && v < DOCX_EDIT_LIMITS.maxParagraphs ? Object.freeze({ ...DOCX_EDIT_LIMITS, maxParagraphs: v }) : DOCX_EDIT_LIMITS;
}

const LIMIT_KO = { maxInputBytes: "파일 크기", maxEntries: "ZIP 항목 수", maxEntryBytes: "부품 크기", maxTotalBytes: "압축을 푼 크기", declaredSize: "선언된 크기", maxDocumentPartBytes: "본문(document.xml) 크기" };

function checkSize(u8, lim) {
  if (u8.byteLength === 0) throw new EditError("bad_input", "빈 파일입니다.");
  if (u8.byteLength > lim.maxInputBytes) {
    throw new EditError("limit", `파일이 너무 큽니다 (${u8.byteLength.toLocaleString()} B > 상한 ${lim.maxInputBytes.toLocaleString()} B).`);
  }
  if (!(u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)) {
    throw new EditError("bad_input", "DOCX 파일이 아닙니다 (ZIP 형식이 아님).");
  }
}

/** ZIP 항목 이름과 압축 푼 크기만 읽는다 (압축은 풀지 않는다). */
function partInfo(u8) {
  const parts = [];
  unzipSync(u8, { filter: (f) => { parts.push({ name: f.name, size: f.originalSize }); return false; } });
  return parts;
}

export async function loadDoc(u8, lim = DOCX_EDIT_LIMITS) {
  checkSize(u8, lim);
  let parts;
  try { parts = partInfo(u8); } catch (e) {
    throw new EditError("bad_input", `DOCX를 읽지 못했습니다 (ZIP 오류): ${e instanceof Error ? e.message : String(e)}`);
  }
  const main = parts.find((p) => p.name === "word/document.xml");
  if (!main) throw new EditError("bad_input", "Word 문서가 아닙니다 (word/document.xml이 없음). .docx 파일만 편집할 수 있습니다.");
  if (main.size > lim.maxDocumentPartBytes) {
    throw new EditError("limit", `문서가 편집 상한을 넘습니다 — 본문(document.xml) 크기 상한 ${lim.maxDocumentPartBytes.toLocaleString()} B (${main.size.toLocaleString()} B). 이 문서는 여기서 편집할 수 없습니다.`);
  }
  let loaded;
  try {
    loaded = await loadDocx(u8, { limits: { maxInputBytes: lim.maxInputBytes, maxTotalBytes: lim.maxTotalBytes, maxParts: lim.maxParts, maxDocumentPartBytes: lim.maxDocumentPartBytes } });
  } catch (e) {
    if (e && e.code === "ZIP_BOMB") {
      const k = typeof e.kind === "string" ? e.kind : "";
      throw new EditError("limit", `문서가 편집 상한을 넘습니다 — ${LIMIT_KO[k] || k || "크기"} 상한 ${Number(e.limit).toLocaleString()}. 이 문서는 여기서 편집할 수 없습니다.`);
    }
    throw new EditError("bad_input", `DOCX를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600));
  }
  const idx = indexDoc(loaded.model);
  if (idx.paragraphs.length > lim.maxParagraphs) {
    throw new EditError("limit", `문서가 편집 상한을 넘습니다 — 문단 수 상한 ${lim.maxParagraphs.toLocaleString()} (${idx.paragraphs.length.toLocaleString()}). 이 문서는 여기서 편집할 수 없습니다.`);
  }
  return { loaded, idx, parts };
}

// ---------- 모델 읽기 ----------

const isDeleted = (r) => !!r.revision && (r.revision.kind === "delete" || r.revision.kind === "moveFrom");
/** 글자를 바꿔도 되는 run: 보통 글자만 (필드·그림·각주 표시·수식·기호·삭제 추적은 뺀다). */
const editable = (r) => !r.image && !r.break && !r.noteReference && !r.noteMark && !r.noteSeparator && !r.field && !r.fieldChar
  && r.fieldCode === undefined && !r.equation && !r.symbol && !r.formField && !r.positionalTab && !isDeleted(r);
/** 화면에 보이는 문단 글 (삭제 추적 글자는 뺀다). */
export const paraText = (p) => p.runs.filter((r) => !isDeleted(r)).map((r) => r.text || "").join("");

/**
 * 읽는 순서 색인. paragraphs[i] = { p, where:"body"|"table", container(문단이 든 배열), table?, r?, c? }  (index = i + 1)
 * tables[j] = 최상위 표 (table = j + 1). 중첩 표는 읽기 전용이라 넣지 않는다. stories = 머리글·바닥글 문단 (replace만).
 */
export function indexDoc(model) {
  const paragraphs = [];
  const tables = [];
  const order = []; // 미리보기용 블록 순서
  for (const b of model.blocks) {
    if (b.type === "paragraph") {
      paragraphs.push({ p: b, where: "body", container: model.blocks });
      order.push({ type: "paragraph", i: paragraphs.length });
    } else if (b.type === "table") {
      tables.push(b);
      const t = tables.length;
      const rows = b.rows.map((row, r) => row.map((cell, c) => {
        const ids = [];
        for (const p of cell.paragraphs || []) {
          paragraphs.push({ p, where: "table", container: cell.paragraphs, table: t, r, c });
          ids.push(paragraphs.length);
        }
        return ids;
      }));
      order.push({ type: "table", t, rows });
    }
  }
  const stories = [];
  const seen = new Set();
  for (const s of model.sections || []) {
    for (const [kind, slots] of [["header", s.headers], ["footer", s.footers]]) {
      for (const slot of Object.values(slots || {})) {
        if (!slot || !Array.isArray(slot.blocks) || seen.has(slot)) continue;
        seen.add(slot);
        if (slot.partName) { if (seen.has(slot.partName)) continue; seen.add(slot.partName); }
        const walk = (blocks) => {
          for (const b of blocks) {
            if (b.type === "paragraph") stories.push({ p: b, where: kind, part: slot.partName || kind });
            else if (b.type === "table") for (const row of b.rows) for (const cell of row) walk(cell.paragraphs || []);
          }
        };
        walk(slot.blocks);
      }
    }
  }
  return { paragraphs, tables, order, stories };
}

const clip = (s, n = PREVIEW_TEXT) => (s.length > n ? s.slice(0, n) + "…" : s);

export function summarizeDoc(loaded, idx, parts) {
  const m = loaded.model;
  const blocks = [];
  for (const o of idx.order) {
    if (blocks.length >= PREVIEW_BLOCKS) break;
    if (o.type === "paragraph") {
      const e = idx.paragraphs[o.i - 1];
      const t = paraText(e.p);
      const b = { type: "paragraph", index: o.i, text: clip(t) };
      if (t.length > PREVIEW_TEXT) b.clipped = true; // 잘린 미리보기 — 화면에서 직접 고치면 뒷부분이 사라지므로 UI가 읽기 전용으로 둔다
      if (e.p.style) b.style = e.p.style;
      if (e.p.numbering) b.list = true;
      blocks.push(b);
    } else {
      blocks.push({
        type: "table", table: o.t,
        rows: o.rows.slice(0, 60).map((row) => row.map((ids) => {
          const t = ids.map((i) => paraText(idx.paragraphs[i - 1].p)).join("\n");
          return t.length > PREVIEW_TEXT ? { text: clip(t), paragraphs: ids, clipped: true } : { text: t, paragraphs: ids };
        })),
        rowCount: o.rows.length,
      });
    }
  }
  let tracked = 0;
  let fields = 0;
  let images = 0;
  for (const e of [...idx.paragraphs, ...idx.stories]) {
    for (const r of e.p.runs) {
      if (r.revision) tracked++;
      if (r.field || r.fieldChar) fields++;
      if (r.image) images++;
    }
  }
  const story = (kind) => idx.stories.filter((s) => s.where === kind).map((s) => clip(paraText(s.p), 200)).filter(Boolean).slice(0, 20);
  return {
    paragraphCount: idx.paragraphs.length,
    tableCount: idx.tables.length,
    blocks,
    truncated: idx.order.length > blocks.length,
    headers: story("header"),
    footers: story("footer"),
    signed: !!m.signatures || parts.some((p) => p.name.startsWith("_xmlsignatures/")),
    trackedChanges: tracked,
    comments: (m.comments || []).length,
    fields,
    images,
    protected: !!m.protection,
    title: (m.properties && m.properties.title) || null,
    warnings: [],
  };
}

// ---------- 글자 정리 ----------

/** XML에 쓸 수 없는 제어문자·짝 없는 서로게이트를 지운다 (Word가 열지 못한다). \t·\n은 둔다 (탭·줄바꿈). */
export function cleanText(s) {
  return String(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ---------- ops 검증 ----------

export function checkOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new EditError("bad_input", "ops는 1개 이상인 배열이어야 합니다.");
  if (ops.length > DOCX_MAX_OPS) throw new EditError("limit", `ops는 ${DOCX_MAX_OPS}개까지입니다 (${ops.length}개).`);
  ops.forEach((o, i) => {
    const at = `ops[${i}]`;
    if (!o || typeof o !== "object") throw new EditError("bad_input", `${at}가 객체가 아닙니다.`);
    const text = (k = "text") => {
      if (typeof o[k] !== "string") throw new EditError("bad_input", `${at}.${k}는 문자열이어야 합니다.`);
      if (o[k].length > DOCX_MAX_TEXT) throw new EditError("limit", `${at}.${k}는 ${DOCX_MAX_TEXT.toLocaleString()}자까지입니다.`);
    };
    const pos = (k, min) => { if (!Number.isInteger(o[k]) || o[k] < min) throw new EditError("bad_input", `${at}.${k}는 ${min} 이상의 정수여야 합니다.`); };
    switch (o.op) {
      case "replace":
        if (typeof o.find !== "string" || !o.find) throw new EditError("bad_input", `${at}.find가 비어 있습니다.`);
        if (o.find.length > DOCX_MAX_FIND) throw new EditError("limit", `${at}.find는 ${DOCX_MAX_FIND}자까지입니다.`);
        text("to");
        if (o.all !== undefined && typeof o.all !== "boolean") throw new EditError("bad_input", `${at}.all은 true/false여야 합니다.`);
        break;
      case "paragraph": pos("index", 1); text(); break;
      case "cell": pos("table", 1); pos("r", 0); pos("c", 0); text(); break;
      case "insert": pos("after", 0); text(); break;
      case "delete": pos("index", 1); break;
      default:
        throw new EditError("bad_input", `${at}.op를 알 수 없습니다: ${String(o.op)} (replace·paragraph·cell·insert·delete)`);
    }
  });
}

// ---------- 문단 편집 ----------

/** 문단 글 전체를 text로. 첫 편집 가능 run에 쓰고 나머지 편집 가능 run은 뺀다 (필드·그림 등은 제자리에 남는다). */
function setParaText(p, text) {
  const first = p.runs.findIndex(editable);
  if (first < 0) {
    // 글자 run이 없다 (빈 문단이거나 필드·그림만) → 맨 앞에 새 run
    p.runs = [{ text }, ...p.runs.filter((r) => !(r.text === "" && Object.keys(r).length === 1))];
    return;
  }
  const keep = p.runs[first];
  // 링크·메모 범위는 첫 run의 것을 그대로 둔다. 삽입 추적(w:ins)도 그대로.
  keep.text = text;
  p.runs = p.runs.filter((r, i) => i === first || !editable(r));
}

/** 문단 안에서 find → to. 이어진 편집 가능 run들을 한 줄로 이어 찾으므로 run 경계에 걸친 글자도 찾는다. 바꾼 횟수를 돌려준다. */
function replaceInPara(p, find, to, max) {
  let count = 0;
  const emptied = new Set();
  let i = 0;
  while (i < p.runs.length && count < max) {
    if (!editable(p.runs[i])) { i++; continue; }
    let j = i;
    while (j < p.runs.length && editable(p.runs[j])) j++;
    const seg = p.runs.slice(i, j);
    const joined = seg.map((r) => r.text || "").join("");
    const hits = [];
    let from = 0;
    while (hits.length + count < max) {
      const at = joined.indexOf(find, from);
      if (at < 0) break;
      hits.push(at);
      from = at + find.length;
    }
    if (hits.length) {
      const starts = [];
      let acc = 0;
      for (const r of seg) { starts.push(acc); acc += (r.text || "").length; }
      const locate = (off, end) => {
        // end=true면 끝 위치: 경계에서는 앞 run에 둔다
        for (let k = seg.length - 1; k >= 0; k--) {
          if (end ? off > starts[k] : off >= starts[k]) return { k, o: off - starts[k] };
        }
        return { k: 0, o: off };
      };
      for (let h = hits.length - 1; h >= 0; h--) {
        const s = locate(hits[h], false);
        const e = locate(hits[h] + find.length, true);
        if (s.k === e.k) {
          const r = seg[s.k];
          r.text = r.text.slice(0, s.o) + to + r.text.slice(e.o);
        } else {
          seg[e.k].text = seg[e.k].text.slice(e.o);
          if (!seg[e.k].text) emptied.add(seg[e.k]);
          for (let k = s.k + 1; k < e.k; k++) { seg[k].text = ""; emptied.add(seg[k]); }
          seg[s.k].text = seg[s.k].text.slice(0, s.o) + to;
        }
        emptied.delete(seg[s.k]);
      }
      count += hits.length;
    }
    i = j;
  }
  if (emptied.size) {
    const rest = p.runs.filter((r) => !emptied.has(r));
    p.runs = rest.length ? rest : [p.runs[0]];
  }
  return count;
}

let seq = 0;
/** anchor 문단의 문단 서식(스타일·목록·정렬)을 따르는 새 문단. 책갈피·추적·메모·링크는 물려받지 않는다. */
function newParaLike(anchor, text, taken) {
  let id;
  do { id = `pnew${++seq}`; } while (taken.has(id));
  taken.add(id);
  const p = { type: "paragraph", id, runs: [] };
  if (anchor) {
    for (const [k, v] of Object.entries(anchor)) {
      if (["type", "id", "runs", "bookmarks", "permissions", "markRevision", "formatRevision", "restoredParagraphPropertiesXml", "dropCap", "pageBreakBefore", "contentControl"].includes(k)) continue;
      p[k] = typeof v === "object" && v !== null ? structuredClone(v) : v;
    }
    const src = anchor.runs.find(editable);
    const run = { text };
    if (src) {
      for (const [k, v] of Object.entries(src)) {
        if (["text", "revision", "formatRevision", "commentIds", "link", "contentControl", "restoredRunPropertiesXml", "fieldInstanceId", "fieldFlags"].includes(k)) continue;
        if (k === "style" && src.link) continue; // 하이퍼링크 글자 스타일은 물려받지 않는다
        run[k] = typeof v === "object" && v !== null ? structuredClone(v) : v;
      }
    }
    p.runs.push(run);
  } else {
    p.runs.push({ text });
  }
  return p;
}

/** ops를 모델에 적용한다 (index는 모두 편집 전 기준 — 먼저 대상 문단을 다 찾아 둔 뒤 고친다). 변경 기록(diff)과 로그를 돌려준다. */
function mutate(model, idx, ops) {
  const log = [];
  const diff = [];
  const notes = new Set();
  const para = (n, at) => {
    const e = idx.paragraphs[n - 1];
    if (!e) throw new EditError("not_found", `${at}: ${n}번 문단이 없습니다 (문단 ${idx.paragraphs.length}개).`);
    return e;
  };
  // 1) 대상 찾기 (고치기 전에 전부)
  const targets = ops.map((op, i) => {
    const at = `ops[${i}]`;
    if (op.op === "paragraph" || op.op === "delete") {
      const e = para(op.index, at);
      if (op.op === "delete" && e.where !== "body") throw new EditError("bad_input", `${at}: 표 안의 문단은 지울 수 없습니다 (cell op로 셀 글을 비우세요).`);
      return e;
    }
    if (op.op === "insert") {
      if (op.after === 0) return null;
      const e = para(op.after, at);
      if (e.where !== "body") throw new EditError("bad_input", `${at}: 표 안의 문단 뒤에는 넣을 수 없습니다 (본문 문단 번호를 쓰세요).`);
      return e;
    }
    if (op.op === "cell") {
      const t = idx.tables[op.table - 1];
      if (!t) throw new EditError("not_found", `${at}: ${op.table}번 표가 없습니다 (표 ${idx.tables.length}개).`);
      const row = t.rows[op.r];
      const cell = row && row[op.c];
      if (!cell) throw new EditError("not_found", `${at}: ${op.table}번 표에 셀 (${op.r}, ${op.c})이 없습니다 (행 ${t.rows.length}개${row ? `, 이 행의 셀 ${row.length}개` : ""}).`);
      if (!cell.paragraphs || !cell.paragraphs.length) throw new EditError("bad_input", `${at}: 셀 (${op.r}, ${op.c})에 문단이 없어 고칠 수 없습니다.`);
      return cell;
    }
    return null;
  });
  const taken = new Set(idx.paragraphs.map((e) => e.p.id));
  const deleted = new Set();
  const insertedAfter = new WeakMap();
  const numOf = new Map(idx.paragraphs.map((e, i) => [e.p, i + 1]));
  const hasFixed = (p) => p.runs.some((r) => !editable(r) && !isDeleted(r) && (r.field || r.image || r.noteReference || r.equation));

  ops.forEach((op, i) => {
    const at = `ops[${i}]`;
    if (op.op === "replace") {
      const find = op.find;
      const to = cleanText(op.to);
      let left = op.all === true ? Infinity : 1;
      let n = 0;
      for (const e of [...idx.paragraphs, ...idx.stories]) {
        if (left <= 0) break;
        if (deleted.has(e.p)) continue;
        const before = paraText(e.p);
        const c = replaceInPara(e.p, find, to, left);
        if (!c) continue;
        n += c;
        left -= c;
        diff.push({ index: numOf.get(e.p) ?? null, where: e.where, kind: "changed", before, after: paraText(e.p) });
      }
      if (!n) throw new EditError("not_found", `${at}: 글자를 찾지 못했습니다: ${find.slice(0, 80)} (필드·삭제 추적 안의 글자는 찾지 않습니다)`);
      log.push({ i, op: "replace", count: n });
    } else if (op.op === "paragraph") {
      const e = targets[i];
      if (deleted.has(e.p)) throw new EditError("bad_input", `${at}: ${op.index}번 문단은 같은 ops에서 지워졌습니다.`);
      const before = paraText(e.p);
      if (hasFixed(e.p)) notes.add("fixedRunsKept");
      setParaText(e.p, cleanText(op.text));
      diff.push({ index: op.index, where: e.where, kind: "changed", before, after: paraText(e.p) });
      log.push({ i, op: "paragraph", index: op.index });
    } else if (op.op === "cell") {
      const cell = targets[i];
      const ps = cell.paragraphs;
      const before = ps.map(paraText).join("\n");
      setParaText(ps[0], cleanText(op.text));
      ps.splice(1);
      diff.push({ index: numOf.get(ps[0]) ?? null, where: "table", table: op.table, r: op.r, c: op.c, kind: "changed", before, after: ps.map(paraText).join("\n").replace(/\n+$/, "") });
      log.push({ i, op: "cell", table: op.table, r: op.r, c: op.c, paragraphs: ps.length });
    } else if (op.op === "insert") {
      const e = targets[i];
      const p = newParaLike(e ? e.p : null, cleanText(op.text), taken);
      if (!e) model.blocks.unshift(p);
      else {
        const k = model.blocks.indexOf(e.p);
        if (k < 0) throw new EditError("bad_input", `${at}: ${op.after}번 문단은 같은 ops에서 지워졌습니다.`);
        // 같은 문단 뒤에 여러 개를 넣으면 ops 순서대로 쌓인다
        let k2 = k + 1;
        while (k2 < model.blocks.length && insertedAfter.get(model.blocks[k2]) === e.p) k2++;
        insertedAfter.set(p, e.p);
        model.blocks.splice(k2, 0, p);
      }
      diff.push({ index: null, where: "body", kind: "added", afterIndex: op.after, before: null, after: paraText(p) });
      log.push({ i, op: "insert", after: op.after });
    } else if (op.op === "delete") {
      const e = targets[i];
      if (deleted.has(e.p)) return;
      const k = model.blocks.indexOf(e.p);
      if (k < 0) throw new EditError("internal", `${at}: 문단 위치를 찾지 못했습니다.`);
      const bodyParas = model.blocks.filter((b) => b.type === "paragraph").length;
      if (bodyParas <= 1) throw new EditError("bad_input", `${at}: 본문의 마지막 문단은 지울 수 없습니다.`);
      if (k === model.blocks.length - 1) throw new EditError("bad_input", `${at}: 문서의 마지막 문단은 지울 수 없습니다 (구역 설정이 붙어 있습니다). paragraph op로 글을 비우세요.`);
      if (hasFixed(e.p)) notes.add("fixedRunsRemoved");
      model.blocks.splice(k, 1);
      deleted.add(e.p);
      diff.push({ index: op.index, where: "body", kind: "removed", before: paraText(e.p), after: null });
      log.push({ i, op: "delete", index: op.index });
    }
  });
  return { log, diff, notes: [...notes] };
}

// ---------- 적용 ----------

const eqBytes = (x, y) => {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
export function compareParts(orig, edited) {
  const A = unzipSync(orig);
  const B = unzipSync(edited);
  const identical = [];
  const changed = [];
  const removed = [];
  for (const n of Object.keys(A)) {
    if (n.endsWith("/")) continue;
    if (!(n in B)) removed.push(n);
    else if (eqBytes(A[n], B[n])) identical.push(n);
    else changed.push(n);
  }
  const added = Object.keys(B).filter((n) => !n.endsWith("/") && !(n in A));
  return { identicalCount: identical.length, changed, removed, added, files: B };
}

const allTexts = (idx) => [...idx.paragraphs.map((e) => paraText(e.p)), "\u0000", ...idx.stories.map((e) => paraText(e.p))];

/** ops를 적용한 새 bytes. 원본 u8은 건드리지 않는다. 저장본을 다시 읽어 의도한 글과 같은지 확인한다. */
export async function applyDocxOps(input, ops, lim = DOCX_EDIT_LIMITS) {
  checkOps(ops);
  const { loaded, idx, parts } = await loadDoc(input, lim);
  const before = summarizeDoc(loaded, idx, parts);
  const { log, diff, notes } = mutate(loaded.model, idx, ops);
  // 고친 모델에서 기대 글 목록
  const expectIdx = indexDoc(loaded.model);
  if (expectIdx.paragraphs.length > lim.maxParagraphs) throw new EditError("limit", `문단을 넣으면 문단 수 상한 ${lim.maxParagraphs.toLocaleString()}을 넘습니다.`);
  const expect = allTexts(expectIdx);
  let out;
  try {
    out = await loaded.save(loaded.model);
  } catch (e) {
    throw new EditError("bad_input", `이 편집은 저장할 수 없습니다 (문서 구조를 보존할 수 없음): ${e instanceof Error ? e.message : String(e)}`.slice(0, 600));
  }
  out = out instanceof Uint8Array ? out : new Uint8Array(out);
  // 다시 열리는지 + 글이 의도대로인지
  const re = await loadDoc(out, { ...lim, maxParagraphs: Infinity });
  const got = allTexts(re.idx);
  if (got.length !== expect.length || got.some((t, i) => t !== expect[i])) {
    const at = got.findIndex((t, i) => t !== expect[i]);
    throw new EditError("internal", `저장본 확인 실패: 다시 읽은 글이 편집 결과와 다릅니다 (문단 ${at + 1}: "${clip(String(got[at] ?? ""), 60)}" ≠ "${clip(String(expect[at] ?? ""), 60)}").`);
  }
  const after = summarizeDoc(re.loaded, re.idx, re.parts);
  const cmp = compareParts(input, out);
  const xmlErrors = [];
  let checked = 0;
  for (const n of [...cmp.changed, ...cmp.added]) {
    if (!/\.(xml|rels)$/i.test(n)) continue;
    checked++;
    const err = wellFormed(strFromU8(cmp.files[n]));
    if (err) xmlErrors.push(`${n}: ${err}`);
  }
  if (xmlErrors.length) throw new EditError("internal", `저장본 XML 검사 실패: ${xmlErrors.slice(0, 3).join("; ")}`);
  return {
    ok: true,
    bytes: out,
    log,
    before,
    after,
    diff: diff.slice(0, 500),
    parts: { identicalCount: cmp.identicalCount, changed: cmp.changed, removed: cmp.removed, added: cmp.added },
    xml: { checked, errors: xmlErrors },
    warnings: {
      signatureRemoved: before.signed && !after.signed,
      trackedChanges: before.trackedChanges > 0,
      fixedRunsKept: notes.includes("fixedRunsKept"),
      fixedRunsRemoved: notes.includes("fixedRunsRemoved"),
    },
    sizes: { before: input.byteLength, after: out.byteLength },
  };
}

/** 가벼운 교체 경로: find → to (all이 true가 아니면 처음 1곳). */
export async function replaceDocxText(u8, find, to, all, lim = DOCX_EDIT_LIMITS) {
  if (typeof find !== "string" || !find) throw new EditError("bad_input", "find가 비어 있습니다.");
  if (typeof to !== "string") throw new EditError("bad_input", "to는 문자열이어야 합니다.");
  const r = await applyDocxOps(u8, [{ op: "replace", find, to, ...(all === true ? { all: true } : {}) }], lim);
  return { ...r, count: r.log[0].count };
}

// ---------- XML well-formed 검사 (xlsx.js와 같은 검사기) ----------

const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;
const BAD_ENT = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
export function wellFormed(xml) {
  if (BAD_CHAR.test(xml)) return "XML 금지 제어문자";
  const stack = [];
  let i = 0;
  let root = 0;
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    const text = xml.slice(i, lt);
    if (BAD_ENT.test(text)) return `잘못된 엔티티 (위치 ${i})`;
    if (!stack.length && text.trim() && root) return `루트 밖 텍스트 (위치 ${i})`;
    if (xml.startsWith("<?", lt)) { const e = xml.indexOf("?>", lt); if (e < 0) return "닫히지 않은 PI"; i = e + 2; continue; }
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt); if (e < 0) return "닫히지 않은 주석"; i = e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt); if (e < 0) return "닫히지 않은 CDATA"; i = e + 3; continue; }
    if (xml.startsWith("<!", lt)) return "DTD/선언 사용";
    let j = lt + 1;
    let q = 0;
    while (j < xml.length) {
      const ch = xml.charCodeAt(j);
      if (q) { if (ch === q) q = 0; } else if (ch === 34 || ch === 39) q = ch; else if (ch === 62) break;
      j++;
    }
    if (j >= xml.length) return `닫히지 않은 태그 (위치 ${lt})`;
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (top !== name) return `태그 짝이 맞지 않음: </${name}> (열린 태그 ${top ?? "없음"})`;
      continue;
    }
    const self = body.endsWith("/");
    const inner = self ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m || !NAME.test(m[1])) return `잘못된 태그 이름 (위치 ${lt})`;
    const attrs = inner.slice(m[1].length);
    const seen = new Set();
    const re = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let consumed = 0;
    let am;
    while ((am = re.exec(attrs))) {
      if (am.index !== consumed) return `속성 구문 오류 <${m[1]}>`;
      consumed = re.lastIndex;
      if (!NAME.test(am[1])) return `잘못된 속성 이름 ${am[1]}`;
      if (seen.has(am[1])) return `속성 중복 ${am[1]} <${m[1]}>`;
      seen.add(am[1]);
      const v = am[3] ?? am[4];
      if (v.includes("<") || BAD_ENT.test(v)) return `속성 값 오류 ${am[1]} <${m[1]}>`;
    }
    if (attrs.slice(consumed).trim()) return `속성 구문 오류 <${m[1]}>`;
    if (!stack.length) { if (root) return "루트 요소가 두 개"; root = 1; }
    if (!self) stack.push(m[1]);
  }
  if (stack.length) return `닫히지 않은 요소: ${stack.join(" > ")}`;
  if (!root) return "루트 요소 없음";
  return null;
}

export function checkXml(u8) {
  const files = unzipSync(u8);
  const errors = [];
  let checked = 0;
  for (const [n, d] of Object.entries(files)) {
    if (!/\.(xml|rels)$/i.test(n)) continue;
    checked++;
    const err = wellFormed(strFromU8(d));
    if (err) errors.push(`${n}: ${err}`);
  }
  return { checked, errors };
}
