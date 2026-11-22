// XLSX 편집 코어 (2026-11-21). xlvane 1.3.4(정확한 버전 고정) + fflate 0.8.3.
// 파일럿 xlsx-edit-pilot/src/core.js를 옮겼다 (파일럿 결과: files/workflow-verify/xlsx-edit-pilot/RESULT.md).
// 바뀐 점: 셀 상한 200,000 (파일럿 실측 100k셀 편집 ≈ CPU 4초), XML 검사는 바뀐·추가된 부품만.
// index.js의 PptxEditor 엔트리포인트가 inspectWorkbook / applyWorkbookOps / replaceCell RPC로 부른다.
//
// ops:
//   {op:"cell",    sheet, cell, value}               값 셀 (문자열·숫자·불리언·null=지움). "="로 시작해도 텍스트로 쓴다.
//   {op:"formula", sheet, cell, formula, result?}    수식 + 캐시 result (xlvane은 계산하지 않는다 — 아는 경우에만 result)
//   {op:"row",     sheet, values:[…]}                마지막 사용 행 아래에 행 추가 (표 끝에 붙으면 표가 늘어난다)
//   {op:"sheet",   name}                             빈 시트 추가 (맨 뒤). 같은 ops에서 바로 cell·row로 채울 수 있다.
// 적용 순서: sheet op 먼저(ZIP 부품 직접 추가) → 나머지는 순서대로, 이어지는 cell·formula는 editCells 한 번으로 묶는다.
import { readWorkbook, editCells, appendRows, isXlvError } from "xlvane";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

export const XLSX_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024, // 압축 해제 합계 (128MB isolate 안에서)
  maxEntries: 5000,
  maxSheets: 50,
  maxCells: 200_000, // 읽기 상한 (xlvane 셀당 약 180 B → 약 36 MB, 파일럿 100k셀 편집 CPU ≈ 4초)
});
export const XLSX_MAX_OPS = 200;
export const XLSX_MAX_ROW_VALUES = 200;
export const XLSX_MAX_TEXT = 32_767; // Excel 셀 글자 상한
export const XLSX_MAX_FORMULA = 8_192; // Excel 수식 길이 상한
const PREVIEW_ROWS = 50;
const PREVIEW_COLS = 26;

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

function checkSize(u8, lim) {
  if (u8.byteLength === 0) throw new EditError("bad_input", "빈 파일입니다.");
  if (u8.byteLength > lim.maxInputBytes) {
    throw new EditError("limit", `파일이 너무 큽니다 (${u8.byteLength.toLocaleString()} B > 상한 ${lim.maxInputBytes.toLocaleString()} B).`);
  }
  if (!(u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)) {
    throw new EditError("bad_input", "XLSX 파일이 아닙니다 (ZIP 형식이 아님).");
  }
}

const readLimits = (lim) => ({ maxInputBytes: lim.maxInputBytes, maxTotalBytes: lim.maxTotalBytes, maxEntries: lim.maxEntries, maxCells: lim.maxCells });

const LIMIT_KO = { maxCells: "셀 수", maxInputBytes: "파일 크기", maxTotalBytes: "압축을 푼 크기", maxEntries: "ZIP 항목 수", maxEntryBytes: "부품 크기", maxCompressionRatio: "압축률" };

function fromXlv(e, what, lim = XLSX_LIMITS) {
  if (isXlvError(e) && e.code === "XLV_E_LIMIT_EXCEEDED") {
    // xlvane 힌트("raise the limit")는 개발자용이라 사용자에게 보이지 않는다.
    const k = e.details && typeof e.details.limit === "string" ? e.details.limit : "";
    const max = k && lim[k] !== undefined ? ` 상한 ${Number(lim[k]).toLocaleString()}` : "";
    return new EditError("limit", `${what}: 워크북이 편집 상한을 넘습니다 — ${LIMIT_KO[k] || k || "크기"}${max}. 이 파일은 여기서 편집할 수 없습니다.`);
  }
  if (isXlvError(e)) {
    const code = e.code === "XLV_E_LIMIT_EXCEEDED" ? "limit"
      : e.code === "XLV_E_SHEET_NOT_FOUND" ? "not_found"
      : "bad_input";
    const hint = e.hint ? ` — ${e.hint}` : "";
    return new EditError(code, `${what}: ${e.message}${hint}`.slice(0, 600));
  }
  if (e instanceof EditError) return e;
  return null;
}

export function loadBook(u8, lim = XLSX_LIMITS) {
  checkSize(u8, lim);
  let wb;
  try {
    wb = readWorkbook(u8, { limits: readLimits(lim) });
  } catch (e) {
    const m = fromXlv(e, "XLSX를 읽지 못했습니다", lim);
    if (m) throw m;
    throw new EditError("bad_input", `XLSX를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (wb.sheets.length > lim.maxSheets) throw new EditError("limit", `시트 수 상한 ${lim.maxSheets} (${wb.sheets.length}). 이 파일은 편집할 수 없습니다.`);
  return wb;
}

// ---------- 요약 (inspect) ----------

const jsonVal = (v) => (v instanceof Date ? v.toISOString().replace(/\.000Z$/, "").replace(/T00:00:00$/, "") : v);
const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function cellBrief(c) {
  const o = { ref: c.ref, v: jsonVal(c.value) };
  if (c.formula) o.f = c.formula.text;
  if (c.type === "error") o.t = "error";
  return o;
}

export function summarizeBook(wb) {
  const sheets = wb.sheets.map((s) => {
    let maxRow = 0;
    let maxCol = 0;
    let formulas = 0;
    const preview = [];
    for (const c of s.cells()) {
      if (c.row > maxRow) maxRow = c.row;
      if (c.col > maxCol) maxCol = c.col;
      if (c.formula) formulas++;
      if (c.row <= PREVIEW_ROWS && c.col <= PREVIEW_COLS) preview.push(cellBrief(c));
    }
    return {
      name: s.name,
      index: s.index,
      state: s.state,
      kind: s.kind,
      cellCount: s.cellCount,
      formulas,
      usedRange: maxRow ? `A1:${colName(maxCol)}${maxRow}` : null,
      lastRow: maxRow,
      lastCol: maxCol,
      tables: s.tables.map((t) => ({ name: t.displayName, ref: t.ref, totalsRow: t.totalsRowCount > 0, columns: t.columns.map((c) => c.name) })),
      charts: s.charts.length,
      merges: s.merges.length,
      cells: preview,
      truncated: maxRow > PREVIEW_ROWS || maxCol > PREVIEW_COLS,
    };
  });
  return {
    sheetCount: sheets.length,
    sheets,
    hasMacros: wb.hasMacros,
    externalLinks: wb.externalLinkCount,
    fullCalcOnLoad: !!wb.calculation?.fullCalcOnLoad,
    warnings: (wb.warnings || []).slice(0, 20).map((w) => `${w.code}: ${w.message}`.slice(0, 300)),
  };
}

// ---------- ops 검증 ----------

const isScalar = (v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const REF = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
const BAD_SHEET = /[\[\]:*?/\\]/;

export function sheetNameError(name) {
  if (typeof name !== "string" || !name.trim()) return "시트 이름이 비어 있습니다.";
  if (name.length > 31) return "시트 이름은 31자까지입니다.";
  if (BAD_SHEET.test(name)) return "시트 이름에 [ ] : * ? / \\ 를 쓸 수 없습니다.";
  if (name.startsWith("'") || name.endsWith("'")) return "시트 이름은 작은따옴표로 시작하거나 끝날 수 없습니다.";
  if (name.toLowerCase() === "history") return "History는 Excel 예약 이름입니다.";
  return null;
}

export function checkOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new EditError("bad_input", "ops는 1개 이상인 배열이어야 합니다.");
  if (ops.length > XLSX_MAX_OPS) throw new EditError("limit", `ops는 ${XLSX_MAX_OPS}개까지입니다 (${ops.length}개).`);
  ops.forEach((o, i) => {
    const at = `ops[${i}]`;
    if (!o || typeof o !== "object") throw new EditError("bad_input", `${at}가 객체가 아닙니다.`);
    const needSheet = () => { if (typeof o.sheet !== "string" || !o.sheet) throw new EditError("bad_input", `${at}.sheet(시트 이름)가 필요합니다.`); };
    const needCell = () => { if (typeof o.cell !== "string" || !REF.test(o.cell)) throw new EditError("bad_input", `${at}.cell은 A1 형식 셀 주소여야 합니다 (예: B7).`); };
    switch (o.op) {
      case "cell":
        needSheet(); needCell();
        if (!isScalar(o.value)) throw new EditError("bad_input", `${at}.value는 문자열·숫자·불리언·null이어야 합니다.`);
        if (typeof o.value === "string" && o.value.length > XLSX_MAX_TEXT) throw new EditError("limit", `${at}.value는 ${XLSX_MAX_TEXT}자까지입니다.`);
        break;
      case "formula":
        needSheet(); needCell();
        if (typeof o.formula !== "string" || !o.formula.replace(/^=/, "").trim()) throw new EditError("bad_input", `${at}.formula가 비어 있습니다.`);
        if (o.formula.length > XLSX_MAX_FORMULA) throw new EditError("limit", `${at}.formula는 ${XLSX_MAX_FORMULA}자까지입니다.`);
        if (o.result !== undefined && (o.result === null || !isScalar(o.result))) throw new EditError("bad_input", `${at}.result는 문자열·숫자·불리언이어야 합니다 (모르면 빼세요).`);
        break;
      case "row":
        needSheet();
        if (!Array.isArray(o.values) || o.values.length === 0) throw new EditError("bad_input", `${at}.values는 1개 이상인 배열이어야 합니다.`);
        if (o.values.length > XLSX_MAX_ROW_VALUES) throw new EditError("limit", `${at}.values는 ${XLSX_MAX_ROW_VALUES}칸까지입니다.`);
        if (!o.values.every(isScalar)) throw new EditError("bad_input", `${at}.values의 칸은 문자열·숫자·불리언·null이어야 합니다.`);
        break;
      case "sheet": {
        const err = sheetNameError(o.name);
        if (err) throw new EditError("bad_input", `${at}.name: ${err}`);
        break;
      }
      default:
        throw new EditError("bad_input", `${at}.op를 알 수 없습니다: ${String(o.op)} (cell·formula·row·sheet)`);
    }
  });
}

// ---------- 시트 추가 (ZIP 부품 직접 수정 — xlvane에는 기존 파일에 시트를 더하는 API가 없다) ----------

const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescAttr = (s) => s.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const WS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const WS_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

/** names: 추가할 시트 이름들 (순서대로 맨 뒤에). 기존 부품 바이트는 그대로 두고 workbook.xml·rels·[Content_Types].xml만 고친다. */
export function addSheets(u8, names, lim = XLSX_LIMITS) {
  const files = unzipSync(u8);
  const wbPath = "xl/workbook.xml";
  const relPath = "xl/_rels/workbook.xml.rels";
  const ctPath = "[Content_Types].xml";
  if (!files[wbPath] || !files[relPath] || !files[ctPath]) throw new EditError("bad_input", "시트를 추가할 수 없는 구조입니다 (xl/workbook.xml 또는 rels가 표준 위치에 없음).");
  let wb = strFromU8(files[wbPath]);
  let rels = strFromU8(files[relPath]);
  let ct = strFromU8(files[ctPath]);
  const sheetTags = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => m[0]);
  const existing = sheetTags.map((t) => unescAttr((/\sname="([^"]*)"/.exec(t) || [])[1] || "").toLowerCase());
  if (existing.length + names.length > lim.maxSheets) throw new EditError("limit", `시트를 추가하면 시트 수 상한 ${lim.maxSheets}를 넘습니다.`);
  const idAttr = sheetTags.length ? /\s(\w+):id="/.exec(sheetTags[0]) : null;
  const rPrefix = idAttr ? idAttr[1] : "r";
  if (!idAttr && !/xmlns:r="/.test(wb)) wb = wb.replace(/<((?:\w+:)?workbook)\b/, `<$1 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
  let maxSheetId = 0;
  for (const t of sheetTags) maxSheetId = Math.max(maxSheetId, Number((/\ssheetId="(\d+)"/.exec(t) || [])[1] || 0));
  const relIds = new Set([...rels.matchAll(/\sId="([^"]+)"/g)].map((m) => m[1]));
  const wsTarget = /Type="[^"]*\/worksheet"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/worksheet"/.exec(rels);
  const absTarget = !!wsTarget && (wsTarget[1] || wsTarget[2]).startsWith("/");
  const sheetCloseTag = /<\/((?:\w+:)?sheets)>/.exec(wb);
  if (!sheetCloseTag) throw new EditError("bad_input", "workbook.xml에 <sheets>가 없습니다.");
  const sheetEl = sheetCloseTag[1].replace(/sheets$/, "sheet");
  const added = [];
  for (const name of names) {
    if (existing.includes(name.toLowerCase())) throw new EditError("bad_input", `같은 이름의 시트가 이미 있습니다: ${name}`);
    existing.push(name.toLowerCase());
    let k = 1;
    while (files[`xl/worksheets/sheet${k}.xml`]) k++;
    let r = 1;
    while (relIds.has(`rId${r}`)) r++;
    const rid = `rId${r}`;
    relIds.add(rid);
    const part = `xl/worksheets/sheet${k}.xml`;
    files[part] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1"/><sheetData/></worksheet>`,
    );
    maxSheetId++;
    wb = wb.replace(sheetCloseTag[0], `<${sheetEl} name="${escAttr(name)}" sheetId="${maxSheetId}" ${rPrefix}:id="${rid}"/>${sheetCloseTag[0]}`);
    rels = rels.replace(/<\/((?:\w+:)?Relationships)>/, `<Relationship Id="${rid}" Type="${WS_TYPE}" Target="${absTarget ? "/" : ""}${absTarget ? part : `worksheets/sheet${k}.xml`}"/></$1>`);
    ct = ct.replace(/<\/((?:\w+:)?Types)>/, `<Override PartName="/${part}" ContentType="${WS_CT}"/></$1>`);
    added.push({ name, part, sheetId: maxSheetId, rid });
  }
  files[wbPath] = strToU8(wb);
  files[relPath] = strToU8(rels);
  files[ctPath] = strToU8(ct);
  return { bytes: zipSync(files, { level: 6 }), added };
}

// ---------- 적용 ----------

function cellInput(o) {
  if (o.op === "formula") {
    const formula = o.formula.replace(/^=/, "");
    return o.result === undefined ? { formula } : { formula, result: o.result };
  }
  return o.value;
}

/** ops를 적용한 새 bytes와 로그. 원본 u8은 건드리지 않는다 (xlvane·fflate 모두 새 배열을 만든다). */
export function applyXlsxOps(input, ops, lim = XLSX_LIMITS) {
  checkOps(ops);
  const first = loadBook(input, lim);
  const before = summarizeBook(first);
  const log = [];
  const warnings = new Set();
  let bytes = input;

  const sheetOps = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.op === "sheet");
  if (sheetOps.length) {
    const r = addSheets(bytes, sheetOps.map(({ op }) => op.name), lim);
    bytes = r.bytes;
    r.added.forEach((a, j) => log.push({ i: sheetOps[j].i, op: "sheet", name: a.name, part: a.part }));
  }
  const known = new Set([...first.sheets.map((s) => s.name), ...sheetOps.map(({ op }) => op.name)]);
  const rest = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.op !== "sheet");
  for (const { op, i } of rest) {
    if (!known.has(op.sheet)) throw new EditError("not_found", `ops[${i}]: 시트가 없습니다: ${op.sheet} (있는 시트: ${[...known].join(", ")})`);
  }
  const editLimits = { limits: readLimits(lim) };
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    try {
      const r = editCells(bytes, batch.map(({ op }) => ({ sheet: op.sheet, cell: op.cell.replace(/\$/g, "").toUpperCase(), value: cellInput(op) })), editLimits);
      bytes = r.bytes;
      r.warnings.forEach((w) => warnings.add(w.code));
    } catch (e) {
      const m = fromXlv(e, `ops[${batch[0].i}…${batch[batch.length - 1].i}] 셀 편집 실패`, lim);
      if (m) throw m;
      throw e;
    }
    for (const { op, i } of batch) log.push({ i, op: op.op, sheet: op.sheet, cell: op.cell.toUpperCase() });
    batch = [];
  };
  for (const item of rest) {
    if (item.op.op === "row") {
      flush();
      try {
        const r = appendRows(bytes, item.op.sheet, [item.op.values], editLimits);
        bytes = r.bytes;
        r.warnings.forEach((w) => warnings.add(w.code));
      } catch (e) {
        const m = fromXlv(e, `ops[${item.i}] 행 추가 실패`, lim);
        if (m) throw m;
        throw e;
      }
      log.push({ i: item.i, op: "row", sheet: item.op.sheet, cells: item.op.values.length });
    } else {
      batch.push(item);
    }
  }
  flush();

  const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const re = loadBook(out, lim); // 다시 열리는지 + diff
  const after = summarizeBook(re);
  const parts = compareParts(input, out);
  const xml = checkXml(out, new Set([...parts.changed, ...parts.added]));
  if (xml.errors.length) throw new EditError("internal", `저장본 XML 검사 실패: ${xml.errors.slice(0, 3).join("; ")}`);
  return {
    ok: true,
    bytes: out,
    log,
    before,
    after,
    diff: diffBooks(first, re),
    parts,
    xml,
    warnings: { codes: [...warnings], formulasNotRecalculated: warnings.has("XLV_W_FORMULAS_NOT_RECALCULATED"), fullCalcOnLoad: after.fullCalcOnLoad },
    sizes: { before: input.byteLength, after: out.byteLength },
  };
}

/** 셀 단위 diff (값·수식). 시트 추가/삭제 포함. 최대 500개. */
export function diffBooks(a, b) {
  const changes = [];
  const fmt = (c) => (c ? (c.formula ? `=${c.formula.text ?? "?"} → ${String(jsonVal(c.value) ?? "")}` : String(jsonVal(c.value) ?? "")) : null);
  const mapOf = (s) => { const m = new Map(); for (const c of s.cells()) m.set(c.ref, c); return m; };
  const aNames = new Map(a.sheets.map((s) => [s.name, s]));
  for (const sb of b.sheets) {
    const sa = aNames.get(sb.name);
    if (!sa) {
      changes.push({ sheet: sb.name, cell: null, kind: "sheetAdded", before: null, after: `(새 시트, 셀 ${sb.cellCount}개)` });
      for (const c of sb.cells()) changes.push({ sheet: sb.name, cell: c.ref, kind: "added", before: null, after: fmt(c), formula: !!c.formula });
      continue;
    }
    const ma = mapOf(sa);
    const mb = mapOf(sb);
    for (const [ref, cb] of mb) {
      const ca = ma.get(ref);
      const x = fmt(ca);
      const y = fmt(cb);
      if (x !== y) changes.push({ sheet: sb.name, cell: ref, kind: ca ? "changed" : "added", before: x, after: y, formula: !!cb.formula });
    }
    for (const [ref, ca] of ma) if (!mb.has(ref)) changes.push({ sheet: sb.name, cell: ref, kind: "removed", before: fmt(ca), after: null, formula: !!ca.formula });
  }
  const bNames = new Set(b.sheets.map((s) => s.name));
  for (const sa of a.sheets) if (!bNames.has(sa.name)) changes.push({ sheet: sa.name, cell: null, kind: "sheetRemoved", before: sa.name, after: null });
  return changes.slice(0, 500);
}

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
  const sheetRe = /^xl\/worksheets\/sheet\d+\.xml$/;
  return { identicalCount: identical.length, changed, removed, added, identicalSheets: identical.filter((n) => sheetRe.test(n)) };
}

// ---------- XML well-formed 검사 (태그 짝·속성 따옴표·이름) ----------

const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;
export function wellFormed(xml) {
  const stack = [];
  let i = 0;
  let root = 0;
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    const text = xml.slice(i, lt);
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return `잘못된 엔티티 (위치 ${i})`;
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
      if (v.includes("<") || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(v)) return `속성 값 오류 ${am[1]} <${m[1]}>`;
    }
    if (attrs.slice(consumed).trim()) return `속성 구문 오류 <${m[1]}>`;
    if (!stack.length) { if (root) return "루트 요소가 두 개"; root = 1; }
    if (!self) stack.push(m[1]);
  }
  if (stack.length) return `닫히지 않은 요소: ${stack.join(" > ")}`;
  if (!root) return "루트 요소 없음";
  return null;
}

// ---------- 운영 조정 + 가벼운 교체 경로 ----------

/** [vars] XLSX_MAX_CELLS / XLSX_MAX_SHEETS로 상한을 **낮출** 수만 있다 (올리지 못한다). */
export function xlsxLimits(env) {
  const lower = (k, base) => {
    const v = Number(env && env[k]);
    return Number.isInteger(v) && v > 0 && v < base ? v : base;
  };
  const maxCells = lower("XLSX_MAX_CELLS", XLSX_LIMITS.maxCells);
  const maxSheets = lower("XLSX_MAX_SHEETS", XLSX_LIMITS.maxSheets);
  return maxCells === XLSX_LIMITS.maxCells && maxSheets === XLSX_LIMITS.maxSheets ? XLSX_LIMITS : Object.freeze({ ...XLSX_LIMITS, maxCells, maxSheets });
}

/** 처음 찾은 텍스트 셀(수식 아님) 1개의 find → to. 시트 순서·행 순서대로 찾는다. */
export function replaceCellText(u8, find, to, lim = XLSX_LIMITS) {
  if (typeof find !== "string" || !find) throw new EditError("bad_input", "find가 비어 있습니다.");
  if (typeof to !== "string") throw new EditError("bad_input", "to는 문자열이어야 합니다.");
  const wb = loadBook(u8, lim);
  for (const s of wb.sheets) {
    for (const c of s.cells()) {
      if (c.formula || typeof c.value !== "string" || !c.value.includes(find)) continue;
      const value = c.value.replace(find, to);
      if (value.length > XLSX_MAX_TEXT) throw new EditError("limit", `바꾼 값이 ${XLSX_MAX_TEXT}자를 넘습니다.`);
      const r = applyXlsxOps(u8, [{ op: "cell", sheet: s.name, cell: c.ref, value }], lim);
      return { ...r, sheet: s.name, cell: c.ref };
    }
  }
  throw new EditError("not_found", `텍스트를 찾지 못했습니다: ${find}`);
}

/** only: 검사할 부품 이름 집합 (없으면 전부). 바뀌지 않은 부품은 원본 그대로라 다시 볼 필요가 없다. */
export function checkXml(u8, only) {
  const files = unzipSync(u8, only ? { filter: (f) => only.has(f.name) } : undefined);
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
