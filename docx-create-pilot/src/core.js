// docx 새 문서 만들기 core (파일럿). 라이브 통합 때 그대로 옮긴다.
// 입력: 구조화된 문서 정의
//   { title, subtitle?, sections: [{ heading?, level?(1|2), paragraphs?: string[], bullets?: string[],
//     numbered?: string[], table?: { header: string[], rows: string[][] }, pageBreakBefore?: boolean }] }
// 문단 문자열은 **굵게**·*기울임*을 지원한다 (그 밖의 마크다운은 글자 그대로).
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  AlignmentType, LevelFormat, PageBreak, ShadingType, BorderStyle, TableLayoutType,
} from "docx";
import { unzipSync, strFromU8 } from "fflate";

export const DOCX_LIMITS = Object.freeze({
  maxSections: 50,
  maxParagraphsPerSection: 100,
  maxItemsPerList: 100,
  maxTotalBlocks: 2_000, // 문단 + 목록 항목 + 표 행 합계
  maxTableCols: 12,
  maxTableRows: 200,
  maxTableCells: 2_000, // 문서 전체 표 셀 합계
  maxText: 8_000, // 문단·셀 하나의 글자 수
  maxTitle: 200,
});

export class DocxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // bad_input | limit | internal
  }
}

const isStr = (v) => typeof v === "string";
// XML 1.0에서 쓸 수 없는 제어문자(탭·줄바꿈 제외)와 짝 없는 서로게이트를 지운다 — 남기면 Word가 파일을 열지 못한다.
const BAD_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const cleanText = (s) => s.replace(BAD_XML_CHARS, "");
const strList = (v, what, max, lim) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DocxError("bad_input", `${what}는 문자열 배열이어야 합니다`);
  if (v.length > max) throw new DocxError("limit", `${what} 항목이 너무 많습니다 (상한 ${max})`);
  return v.map((x, i) => {
    if (typeof x === "number" || typeof x === "boolean") x = String(x);
    if (!isStr(x)) throw new DocxError("bad_input", `${what}[${i}]는 문자열이어야 합니다`);
    if (x.length > lim.maxText) throw new DocxError("limit", `${what}[${i}] 글자 수가 상한 ${lim.maxText}를 넘습니다`);
    return cleanText(x);
  });
};

// 정의를 검사하고 정규화한다. 상한을 넘으면 DocxError("limit").
export function normalizeDef(def, lim = DOCX_LIMITS) {
  if (!def || typeof def !== "object" || Array.isArray(def)) throw new DocxError("bad_input", "문서 정의는 객체여야 합니다");
  const title = isStr(def.title) ? cleanText(def.title).trim() : "";
  if (!title) throw new DocxError("bad_input", "title(문서 제목)이 필요합니다");
  if (title.length > lim.maxTitle) throw new DocxError("limit", `제목은 ${lim.maxTitle}자 이하여야 합니다`);
  const subtitle = isStr(def.subtitle) ? cleanText(def.subtitle).trim().slice(0, lim.maxTitle) : "";
  if (!Array.isArray(def.sections)) throw new DocxError("bad_input", "sections는 배열이어야 합니다");
  if (def.sections.length > lim.maxSections) throw new DocxError("limit", `섹션이 너무 많습니다 (상한 ${lim.maxSections})`);
  let blocks = 0;
  let cells = 0;
  const sections = def.sections.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new DocxError("bad_input", `sections[${i}]는 객체여야 합니다`);
    const heading = isStr(s.heading) ? cleanText(s.heading).trim() : "";
    if (heading.length > lim.maxTitle) throw new DocxError("limit", `sections[${i}].heading은 ${lim.maxTitle}자 이하여야 합니다`);
    const level = s.level === 2 || s.level === "2" ? 2 : 1;
    const paragraphs = strList(s.paragraphs, `sections[${i}].paragraphs`, lim.maxParagraphsPerSection, lim);
    const bullets = strList(s.bullets, `sections[${i}].bullets`, lim.maxItemsPerList, lim);
    const numbered = strList(s.numbered, `sections[${i}].numbered`, lim.maxItemsPerList, lim);
    let table = null;
    if (s.table !== undefined && s.table !== null) {
      const t = s.table;
      if (typeof t !== "object" || Array.isArray(t)) throw new DocxError("bad_input", `sections[${i}].table은 {header, rows} 객체여야 합니다`);
      const header = strList(t.header, `sections[${i}].table.header`, lim.maxTableCols, lim);
      if (!header.length) throw new DocxError("bad_input", `sections[${i}].table.header가 비었습니다`);
      if (!Array.isArray(t.rows)) throw new DocxError("bad_input", `sections[${i}].table.rows는 배열이어야 합니다`);
      if (t.rows.length > lim.maxTableRows) throw new DocxError("limit", `표 행이 너무 많습니다 (상한 ${lim.maxTableRows})`);
      const rows = t.rows.map((r, ri) => {
        const row = strList(r, `sections[${i}].table.rows[${ri}]`, lim.maxTableCols, lim);
        // 열 수를 헤더에 맞춘다 (모자라면 빈 칸, 넘치면 오류)
        if (row.length > header.length) throw new DocxError("bad_input", `sections[${i}].table.rows[${ri}] 칸 수(${row.length})가 헤더(${header.length})보다 많습니다`);
        while (row.length < header.length) row.push("");
        return row;
      });
      cells += header.length * (rows.length + 1);
      blocks += rows.length + 1;
      table = { header, rows };
    }
    blocks += paragraphs.length + bullets.length + numbered.length + (heading ? 1 : 0);
    if (!heading && !paragraphs.length && !bullets.length && !numbered.length && !table) throw new DocxError("bad_input", `sections[${i}]에 내용이 없습니다`);
    return { heading, level, paragraphs, bullets, numbered, table, pageBreakBefore: s.pageBreakBefore === true };
  });
  if (blocks > lim.maxTotalBlocks) throw new DocxError("limit", `문서 블록(문단·목록·표 행) 합계 ${blocks}가 상한 ${lim.maxTotalBlocks}를 넘습니다`);
  if (cells > lim.maxTableCells) throw new DocxError("limit", `표 셀 합계 ${cells}가 상한 ${lim.maxTableCells}를 넘습니다`);
  return { title, subtitle, sections, stats: { sections: sections.length, blocks, tableCells: cells } };
}

// **굵게**, *기울임* → TextRun 배열
export function inlineRuns(text, base = {}) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    if (m[1] !== undefined) runs.push(new TextRun({ ...base, text: m[1], bold: true }));
    else runs.push(new TextRun({ ...base, text: m[2], italics: true }));
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(new TextRun({ ...base, text: text.slice(last) }));
  if (!runs.length) runs.push(new TextRun({ ...base, text: "" }));
  return runs;
}

const FONT = "Malgun Gothic";
const border = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
const cellBorders = { top: border, bottom: border, left: border, right: border };

// ---------- 표 열 너비 (내용 비례) ----------
// docx 9.16은 PERCENTAGE의 숫자 size를 "퍼센트"로 받아 ×50 해서 쓴다 (size 100 → w:w 5000 = 100%).
// 예전 코드는 size 5000(→ 5000%)·셀 floor(5000/n)(→ 열마다 1666%·2500%)를 줘서 표가 터무니없이 넓고 열이 모두 같은 너비였다.
// 지금: 표 너비 100%, 열 너비는 열마다 가장 긴 줄의 표시 폭(한글·한자·전각 2, 그 밖 1)에 비례한 twips grid (합 = 본문 폭).
export const TABLE_TEXT_TWIPS = 9026; // A4 세로(11906) - 좌우 여백 1인치(1440 × 2). docx 기본 구역 = 이 문서의 구역
export const COL_WEIGHT_MIN = 6; // 표시 폭 6 미만 열(한 글자 요일 등)도 6으로 본다 — 머리글 굵은 글씨·셀 여백 몫
export const COL_WEIGHT_MAX = 40; // 긴 문장 열은 40에서 자른다 — 어차피 줄바꿈되므로 다른 열을 지나치게 밀어내지 않게
export const COL_MIN_TWIPS = 700; // 열 하나 최소 약 1.2 cm (열이 많아 본문 폭/n이 더 작으면 그 값)
const WIDE_CHAR = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/;
export function displayWidth(s) {
  let w = 0;
  for (const ch of s.replace(/\*\*|\*/g, "")) w += WIDE_CHAR.test(ch) ? 2 : 1;
  return w;
}
export function columnWidthsFor(t, total = TABLE_TEXT_TWIPS) {
  const n = t.header.length;
  const weights = t.header.map((h, c) => {
    let m = 0;
    for (const cell of [h, ...t.rows.map((r) => r[c] ?? "")]) for (const line of cell.split("\n")) m = Math.max(m, displayWidth(line));
    return Math.min(Math.max(m, COL_WEIGHT_MIN), COL_WEIGHT_MAX);
  });
  // 비례 배분 → 최소 폭보다 좁은 열은 최소 폭으로 고정하고 나머지를 다시 배분한다 (고정 열이 늘지 않을 때까지).
  const floor = Math.min(COL_MIN_TWIPS, total / n);
  const fixed = new Array(n).fill(false);
  let w = [];
  for (let iter = 0; iter <= n; iter++) {
    const freeWeight = weights.reduce((a, x, i) => (fixed[i] ? a : a + x), 0);
    const freeTotal = total - floor * fixed.filter(Boolean).length;
    w = weights.map((x, i) => (fixed[i] ? floor : (freeTotal * x) / freeWeight));
    let changed = false;
    w.forEach((x, i) => { if (!fixed[i] && x < floor) { fixed[i] = true; changed = true; } });
    if (!changed) break;
  }
  const out = w.map((x) => Math.floor(x));
  out[n - 1] += total - out.reduce((a, x) => a + x, 0); // 합을 본문 폭에 정확히 맞춘다
  return out;
}

// mode "proportional"(채택): 내용 비례 grid. "autofit"(비교용, 파일럿만): 열 너비 없이 Word 자동 맞춤에 맡긴다.
function buildTable(t, mode = "proportional") {
  // 셀에는 너비를 주지 않는다 → docx가 columnWidths(twips)를 각 셀 tcW(dxa)로 넣는다.
  const mk = (txt, head) => new TableCell({
    borders: cellBorders,
    shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: "D9E2F3" } : undefined,
    children: [new Paragraph({ children: inlineRuns(txt, head ? { bold: true } : {}) })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, // → w:tblW w:type="pct" w:w="5000" (= 100%)
    ...(mode === "autofit" ? { layout: TableLayoutType.AUTOFIT } : { columnWidths: columnWidthsFor(t) }),
    rows: [
      new TableRow({ tableHeader: true, children: t.header.map((h) => mk(h, true)) }),
      ...t.rows.map((r) => new TableRow({ children: r.map((c) => mk(c, false)) })),
    ],
  });
}

// 정규화된 정의 → docx Document
export function buildDocument(nd, meta = {}) {
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(nd.title)] })];
  if (nd.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: nd.subtitle, italics: true, color: "555555" })] }));
  let numInstance = 0;
  nd.sections.forEach((s) => {
    if (s.pageBreakBefore) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (s.heading) children.push(new Paragraph({ heading: s.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1, children: [new TextRun(s.heading)] }));
    for (const p of s.paragraphs) children.push(new Paragraph({ children: inlineRuns(p) }));
    for (const b of s.bullets) children.push(new Paragraph({ children: inlineRuns(b), numbering: { reference: "po-bullet", level: 0 } }));
    if (s.numbered.length) {
      numInstance++; // 목록마다 1부터 다시 센다
      for (const n of s.numbered) children.push(new Paragraph({ children: inlineRuns(n), numbering: { reference: "po-number", level: 0, instance: numInstance } }));
    }
    if (s.table) {
      children.push(buildTable(s.table, meta.tableMode));
      children.push(new Paragraph({ children: [] }));
    }
  });
  return new Document({
    creator: meta.creator || "People OS",
    title: nd.title,
    description: meta.description || "People OS에서 만든 문서",
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
    },
    numbering: {
      config: [
        { reference: "po-bullet", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: "po-number", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: [{ children }],
  });
}

export async function createDocx(def, lim = DOCX_LIMITS, meta = {}) {
  const nd = normalizeDef(def, lim);
  let ab;
  try {
    ab = await Packer.toArrayBuffer(buildDocument(nd, meta));
  } catch (e) {
    throw new DocxError("internal", `docx 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { bytes: new Uint8Array(ab), stats: nd.stats, title: nd.title };
}

// ---------- 다시 열어 구조 읽기 (document.xml) ----------

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const runText = (xml) => {
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br w:type="page"\/>/g;
  let m;
  while ((m = re.exec(xml))) if (m[1] !== undefined) out += unesc(m[1]);
  return out;
};

// document.xml → [{type:"p", style, text, num?, bold?, italic?, pageBreak?} | {type:"table", rows:[[...]]}]
export function readDocx(u8) {
  const files = unzipSync(u8);
  const doc = files["word/document.xml"];
  if (!doc) throw new DocxError("bad_input", "word/document.xml이 없습니다");
  const xml = strFromU8(doc);
  const body = xml.slice(xml.indexOf("<w:body>") + 8, xml.lastIndexOf("</w:body>"));
  const blocks = [];
  // 최상위 w:p / w:tbl만 순서대로 (표 안 문단은 표로 묶는다)
  let i = 0;
  while (i < body.length) {
    const p = body.indexOf("<w:p", i);
    const t = body.indexOf("<w:tbl>", i);
    const isP = (k) => k >= 0 && (body.startsWith("<w:p>", k) || body.startsWith("<w:p ", k));
    let pNext = p;
    while (pNext >= 0 && !isP(pNext)) pNext = body.indexOf("<w:p", pNext + 1);
    if (t >= 0 && (pNext < 0 || t < pNext)) {
      const end = body.indexOf("</w:tbl>", t);
      const tbl = body.slice(t, end);
      const rows = [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => runText(c[0])));
      blocks.push({ type: "table", rows, headerRow: /<w:tblHeader\/>/.test(tbl) });
      i = end + 8;
      continue;
    }
    if (pNext < 0) break;
    const selfClose = body.indexOf("/>", pNext);
    const gt = body.indexOf(">", pNext);
    let pxml;
    if (selfClose >= 0 && selfClose + 1 === gt) { pxml = body.slice(pNext, gt + 1); i = gt + 1; }
    else { const end = body.indexOf("</w:p>", pNext); pxml = body.slice(pNext, end + 6); i = end + 6; }
    const style = /<w:pStyle w:val="([^"]+)"\/>/.exec(pxml)?.[1] ?? null;
    const num = /<w:numId w:val="(\d+)"\/>/.exec(pxml)?.[1] ?? null;
    const b = { type: "p", style, text: runText(pxml) };
    if (num) b.numId = Number(num);
    if (/<w:b\/>/.test(pxml)) b.bold = true;
    if (/<w:i\/>/.test(pxml)) b.italic = true;
    if (/<w:br w:type="page"\/>/.test(pxml)) b.pageBreak = true;
    blocks.push(b);
  }
  return { parts: Object.keys(files).sort(), blocks };
}

// ---------- 자리표시자 (src/docx/create.ts와 같은 규칙 — 라이브 사본) ----------
// 칸 전체가 자리표시자인 것 (괄호·따옴표를 벗긴 뒤): "(작성 필요)", "TBD", "추후 작성", "예시", "○○○", "..." 등
const PH_WHOLE = /^(?:작성\s*필요|작성\s*예정|추후\s*(?:작성|기재|입력|확정|업데이트)|입력\s*필요|기재\s*필요|내용\s*입력|내용\s*작성|미기재|미작성|빈\s*칸|예시|샘플|TBD|TBA|TODO|x{2,}|○+|◯+|O{2,}|\?+|…+|\.{3,}|-{2,})$/i;
// 칸 안 어디에 있어도 자리표시자로 보는 것
const PH_ANY = /작성\s*필요|추후\s*작성|\bTBD\b|\bTODO\b|\[\s*(?:입력|작성)[^\]]*\]/i;
export function isPlaceholder(s) {
  const t0 = String(s).replace(/\*\*|\*/g, "").trim();
  if (!t0) return false;
  const t = t0.replace(/^[\s("'\[{<（［【「『“‘]+|[\s)"'\]}>）］】」』”’]+$/g, "").trim();
  return PH_WHOLE.test(t || t0) || PH_ANY.test(t0);
}
// 정규화된 정의에서 표 셀·목록 항목·문단의 자리표시자 수
export function placeholderStats(nd) {
  const out = { tableCells: 0, tableBodyCells: 0, headerCells: 0, listItems: 0, listPlaceholders: 0, paragraphs: 0, tables: [] };
  nd.sections.forEach((s, i) => {
    const list = [...s.bullets, ...s.numbered];
    out.listItems += list.length;
    out.listPlaceholders += list.filter(isPlaceholder).length;
    out.paragraphs += s.paragraphs.filter((p) => PH_ANY.test(p)).length;
    if (!s.table) return;
    const body = s.table.rows.flat();
    const ph = body.filter(isPlaceholder).length;
    const hph = s.table.header.filter(isPlaceholder).length;
    out.tableCells += ph;
    out.tableBodyCells += body.length;
    out.headerCells += hph;
    out.tables.push({ section: i, header: hph, body: ph, bodyCells: body.length });
  });
  return out;
}
// 계획 실패로 볼 자리표시자 문제 (없으면 null): 헤더 셀이 자리표시자 / 본문 셀 절반 이상 / 목록 항목 절반 이상(항목 2개 이상)
export function placeholderProblem(nd) {
  for (const [i, s] of nd.sections.entries()) {
    if (s.table) {
      const body = s.table.rows.flat().filter((c) => c.trim());
      const ph = body.filter(isPlaceholder).length;
      if (s.table.header.some(isPlaceholder)) return `sections[${i}].table 헤더에 자리표시자가 있다`;
      if (body.length && ph * 2 >= body.length) return `sections[${i}].table 본문 셀 ${body.length}개 중 ${ph}개가 자리표시자다`;
    }
    const list = [...s.bullets, ...s.numbered];
    const lph = list.filter(isPlaceholder).length;
    if (list.length >= 2 && lph * 2 >= list.length) return `sections[${i}] 목록 항목 ${list.length}개 중 ${lph}개가 자리표시자다`;
  }
  return null;
}

// ---------- 표 XML 검사 (열 너비 버그 확인용) ----------
// document.xml의 표마다 tblW, tblLayout, gridCol, 첫 행 tcW, 셀 글자, 자리표시자 셀 수
export function inspectTables(u8) {
  const xml = strFromU8(unzipSync(u8)["word/document.xml"]);
  return [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => {
    const tbl = m[0];
    const tblW = /<w:tblW w:type="([^"]+)" w:w="([^"]+)"\/>/.exec(tbl);
    const grid = [...tbl.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((g) => Number(g[1]));
    const rows = [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => r[0]);
    const tcW = [...(rows[0] || "").matchAll(/<w:tcW w:type="([^"]+)" w:w="([^"]+)"\/>/g)].map((c) => `${c[1]} ${c[2]}`);
    const cells = rows.map((r) => [...r.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => runText(c[0])));
    const gridSum = grid.reduce((a, x) => a + x, 0);
    const body = cells.slice(1).flat();
    return {
      tblW: tblW ? `${tblW[1]} ${tblW[2]}` : null,
      tblWPercent: tblW && tblW[1] === "pct" ? Number(tblW[2]) / 50 : null,
      layout: /<w:tblLayout w:type="([^"]+)"\/>/.exec(tbl)?.[1] ?? "autofit(기본)",
      gridCol: grid,
      gridSum,
      gridShare: grid.map((g) => (gridSum ? Math.round((g / gridSum) * 1000) / 10 : 0)),
      firstRowTcW: tcW,
      maxDisplayWidth: (cells[0] || []).map((_, c) => Math.max(...cells.map((r) => Math.max(...String(r[c] ?? "").split("\n").map(displayWidth))))),
      rows: cells.length,
      placeholderCells: { header: (cells[0] || []).filter(isPlaceholder).length, body: body.filter(isPlaceholder).length, bodyCells: body.length },
      cells,
    };
  });
}

// numbering.xml의 numId → abstract 형식(bullet/decimal)
export function numFormats(u8) {
  const files = unzipSync(u8);
  const xml = files["word/numbering.xml"] ? strFromU8(files["word/numbering.xml"]) : "";
  const abs = {};
  for (const m of xml.matchAll(/<w:abstractNum [^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) abs[m[1]] = /<w:numFmt w:val="([^"]+)"/.exec(m[2])?.[1];
  const out = {};
  for (const m of xml.matchAll(/<w:num w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"\/>/g)) out[m[1]] = abs[m[2]];
  return out;
}

// ---------- XML well-formed 검사 (xlsx 파일럿 검사기와 같다) ----------

const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;
export function wellFormed(xml) {
  const stack = [];
  let i = 0;
  let root = 0;
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.exec(xml);
  if (bad) return `XML에 쓸 수 없는 문자 U+${bad[0].charCodeAt(0).toString(16).padStart(4, "0")} (위치 ${bad.index})`;
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
