// Pilot lab Worker: make → edit → re-parse → zip/XML/byte checks, all inside workerd.
// Routes:
//   GET  /make            → pptxgenjs test deck (bytes)
//   POST /inspect         → model summary of the posted deck (JSON)
//   POST /edit            → posted deck with all pilot edits applied (bytes)
//   GET  /selftest        → make + edit + verify in one go (JSON report)
//   POST /selftest        → same, but on the posted deck instead of a freshly made one
//   POST /replace?find=&to= → minimal path: replace one text run, save (bytes)
import {
  PptxHandler,
  setPresentationRunText,
  updateChartSeriesValues,
  setChartTitle,
  duplicateSlide,
  validatePptx,
} from "pptx-viewer-core";
import { unzipSync } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { makeDeck } from "./deck.js";
import { replaceRun } from "./replace.js";

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const pptxResp = (u8, name) =>
  new Response(u8, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "content-disposition": `attachment; filename="${name}"`,
    },
  });

function summarizeEl(el) {
  const o = { id: el.id, type: el.type, name: el.name, x: el.x, y: el.y, w: el.width, h: el.height };
  if (el.text !== undefined) o.text = el.text;
  if (el.textSegments) o.segments = el.textSegments.map((s) => s.text);
  if (el.shapeType) o.shapeType = el.shapeType;
  if (el.shapeStyle?.fillColor) o.fill = el.shapeStyle.fillColor;
  if (el.type === "table" && el.tableData) o.cells = el.tableData.rows.map((r) => r.cells.map((c) => c.text));
  if (el.type === "chart" && el.chartData) {
    o.chart = {
      type: el.chartData.chartType,
      title: el.chartData.title,
      categories: el.chartData.categories,
      series: (el.chartData.series || []).map((s) => ({ name: s.name, values: s.values })),
    };
  }
  return o;
}

async function inspect(bytes) {
  const h = new PptxHandler();
  const data = await h.load(ab(bytes));
  return {
    slides: data.slides.map((s) => ({ n: s.slideNumber, id: s.id, elements: s.elements.map(summarizeEl) })),
    warnings: (data.warnings || []).slice(0, 20),
    compat: h.getCompatibilityWarnings().slice(0, 20),
  };
}

// All pilot edits. Returns { bytes, log }.
export async function applyEdits(input) {
  const log = [];
  // (a) text run replace, byte-level helper (bytes → bytes)
  let h = new PptxHandler();
  let data = await h.load(ab(input));
  const s1 = data.slides[0];
  const title = s1.elements.find((e) => (e.text || "").includes("리더십"));
  let bytes = await setPresentationRunText(input, 0, title.id, 0, "2027 리더십 코칭 중간 보고");
  log.push({ step: "text-run", via: "setPresentationRunText", elementId: title.id });

  // (b..e) model-level edits on the result
  h = new PptxHandler();
  data = await h.load(ab(bytes));
  const [sl1, sl2, sl3, sl4] = data.slides;

  // subtitle via model text (second text-edit path)
  const sub = sl1.elements.find((e) => (e.text || "").includes("파일럿 덱"));
  if (sub) {
    sub.text = "People OS 편집 파일럿 (수정됨)";
    if (sub.textSegments?.length) {
      sub.textSegments = [{ ...sub.textSegments[0], text: sub.text }];
    }
    log.push({ step: "text-model", elementId: sub.id });
  }

  // shape move / resize / fill
  const rect = sl2.elements.find((e) => e.type === "shape" && e.shapeType === "rect") || sl2.elements.find((e) => e.type === "shape");
  if (rect) {
    const before = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, fill: rect.shapeStyle?.fillColor };
    rect.x += 100;
    rect.y += 40;
    rect.width = Math.round(rect.width * 1.5);
    rect.height = Math.round(rect.height * 1.25);
    rect.shapeStyle = { ...(rect.shapeStyle || {}), fillColor: "#DC2626" };
    log.push({ step: "shape", elementId: rect.id, before, after: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, fill: "#DC2626" } });
  } else log.push({ step: "shape", error: "no shape found" });

  // table cell text
  const tbl = sl3.elements.find((e) => e.type === "table");
  if (tbl?.tableData) {
    const cell = tbl.tableData.rows[1].cells[0];
    cell.text = "최코치";
    cell.textRuns = undefined;
    const cell2 = tbl.tableData.rows[2].cells[2];
    cell2.text = "99";
    cell2.textRuns = undefined;
    log.push({ step: "table", elementId: tbl.id });
  } else log.push({ step: "table", error: "no table found" });

  // chart series data + title
  const ch = sl4.elements.find((e) => e.type === "chart");
  if (ch?.chartData) {
    updateChartSeriesValues(ch, 0, [11, 22, 33, 44]);
    updateChartSeriesValues(ch, 1, [50, 60, 70, 80]);
    setChartTitle(ch, "분기별 코칭 세션 수 (수정)");
    log.push({ step: "chart", elementId: ch.id });
  } else log.push({ step: "chart", error: "no chart found" });

  // duplicate slide 3 (table) → append as slide 6
  const dup = duplicateSlide(sl3, data.slides.length + 1);
  const slides = [...data.slides, dup];
  log.push({ step: "duplicate", from: sl3.id, newId: dup.id });

  bytes = await h.save(slides);
  return { bytes, log };
}

function zipEntries(u8) {
  return unzipSync(u8);
}
const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
const td = new TextDecoder();

async function verify(orig, edited, log) {
  const A = zipEntries(orig);
  const B = zipEntries(edited);
  const namesA = Object.keys(A).sort();
  const namesB = Object.keys(B).sort();
  const xmlErrors = [];
  for (const n of namesB) {
    if (!/\.(xml|rels)$/.test(n)) continue;
    const r = XMLValidator.validate(td.decode(B[n]));
    if (r !== true) xmlErrors.push({ part: n, err: r.err });
  }
  const parts = {};
  for (const n of namesA) {
    parts[n] = !(n in B) ? "removed" : eq(A[n], B[n]) ? "identical" : "changed";
  }
  const added = namesB.filter((n) => !(n in A));
  const changed = Object.entries(parts).filter(([, v]) => v === "changed").map(([k]) => k);
  const removed = Object.entries(parts).filter(([, v]) => v === "removed").map(([k]) => k);
  const identicalCount = Object.values(parts).filter((v) => v === "identical").length;

  const reparsed = await inspect(edited);
  let validation;
  try {
    validation = await validatePptx(ab(edited));
  } catch (e) {
    validation = { error: String(e) };
  }
  return {
    sizes: { original: orig.byteLength, edited: edited.byteLength, delta: edited.byteLength - orig.byteLength },
    parts: { original: namesA.length, edited: namesB.length, identical: identicalCount, changed, removed, added },
    controlSlide5: parts["ppt/slides/slide5.xml"],
    xmlWellFormed: xmlErrors.length === 0,
    xmlErrors,
    validatePptx: validation,
    editLog: log,
    reparsed,
  };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/make") return pptxResp(await makeDeck(), "test-deck.pptx");
      if (url.pathname === "/inspect" && req.method === "POST")
        return json(await inspect(new Uint8Array(await req.arrayBuffer())));
      if (url.pathname === "/edit" && req.method === "POST") {
        const { bytes } = await applyEdits(new Uint8Array(await req.arrayBuffer()));
        return pptxResp(bytes, "edited.pptx");
      }
      if (url.pathname === "/selftest") {
        const t0 = Date.now();
        const orig = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : await makeDeck();
        const t1 = Date.now();
        const original = await inspect(orig);
        const t2 = Date.now();
        const { bytes, log } = await applyEdits(orig);
        const t3 = Date.now();
        const report = await verify(orig, bytes, log);
        const t4 = Date.now();
        return json({ timingsMs: { make: t1 - t0, load: t2 - t1, edit: t3 - t2, verify: t4 - t3 }, original, ...report });
      }
      if (url.pathname === "/limits") {
        const { limits } = await import("./limits.js");
        return json(await limits());
      }
      if (url.pathname === "/replace" && req.method === "POST") {
        const out = await replaceRun(new Uint8Array(await req.arrayBuffer()), url.searchParams.get("find") || "", url.searchParams.get("to") || "");
        return pptxResp(out, "replaced.pptx");
      }
      return json({ routes: ["/make", "/inspect", "/edit", "/selftest", "/replace"] }, 404);
    } catch (e) {
      return json({ error: String(e), stack: e?.stack?.split("\n").slice(0, 12) }, 500);
    }
  },
};
