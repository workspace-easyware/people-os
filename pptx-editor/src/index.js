// People OS PPTX 편집 Worker (2026-11-21). 파일럿 pptx-edit-pilot/src/lab.js의 applyEdits()를 ops 기반 RPC로 옮겼다.
//
// Worker 이름 people-os-doc-editor (2026-11-22, people-os-pptx-editor에서 개명 — XLSX도 맡는다).
// People OS가 서비스 바인딩 DOC_EDITOR로 부른다 (RPC, WorkerEntrypoint):
//   inspect(bytes)                 → 슬라이드·요소 요약 + 서명/SmartArt 여부
//   applyOps(bytes, ops)           → 편집본 bytes + 적용 로그 + 변경 전후 텍스트 + 부품 비교
//   replaceText(bytes, find, to)   → 처음 찾은 run 1개만 바꾼 bytes (가장 가벼운 경로)
//   XLSX (2026-11-21, ./xlsx.js): inspectWorkbook(bytes) / applyWorkbookOps(bytes, ops) / replaceCell(bytes, find, to)
//   DOCX (2026-11-22, ./docx.js): inspectDocument(bytes) / applyDocumentOps(bytes, ops) / replaceDocumentText(bytes, find, to, all)
// 모든 메서드는 throw하지 않고 { ok:false, code, error }를 돌려준다 (code: "limit" | "bad_input" | "not_found" | "internal").
// R2·D1은 모른다 — 바이트만 받아 바이트를 돌려준다 (원본 보존·버전 저장은 People OS 쪽 책임).
//
// 가드 (PILOT-RESULT.md 통합 개요 6번): load(buffer, { limits })로 입력 크기·압축 해제 크기·ZIP 항목·슬라이드·도형 수를 막는다.
// 큰 덱의 Queue 소비자 처리는 이번 범위 밖 (INTEGRATION-RESULT.md 후속 과제).
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  PptxHandler,
  setPresentationRunText,
  updateChartSeriesValues,
  setChartTitle,
  duplicateSlide,
  getPptxLoadLimitViolation,
} from "pptx-viewer-core";
import { unzipSync } from "fflate";
// XLSX 편집 (2026-11-21, 같은 Worker에 합침 — 사용자 결정). 코어는 ./xlsx.js (xlvane 1.3.4).
import { EditError as XlsxEditError, applyXlsxOps, loadBook, summarizeBook, replaceCellText, toU8 as xlsxU8, xlsxLimits, XLSX_MAX_OPS } from "./xlsx.js";
// DOCX 편집 (2026-11-22, 같은 Worker에 합침). 코어는 ./docx.js (ooxml-core 2.0.0의 docx 영역 — PPTX와 같은 패키지).
import { EditError as DocxEditError, applyDocxOps, loadDoc, summarizeDoc, replaceDocxText, toU8 as docxU8, docxLimits, DOCX_MAX_OPS, DOCX_MAX_TEXT } from "./docx.js";

// Worker 진입 모듈은 핸들러·엔트리포인트 말고는 export하면 안 된다 (workerd가 "not of type ExportedHandler"로 거부).
const LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024, // People OS 업로드 상한(10MB)·RPC 메시지 여유를 같이 본 값
  maxUncompressedBytes: 200 * 1024 * 1024, // 128MB isolate 안에서 압축 해제가 터지지 않게
  maxEntries: 5000,
  maxSlides: 60,
  maxShapes: 3000,
});
// 시험·운영 조정용: [vars] PPTX_MAX_SLIDES로 슬라이드 상한을 **낮출** 수만 있다 (올리지 못한다).
// env는 배포 하나 안에서 늘 같아서 모듈 변수에 둬도 요청끼리 섞이지 않는다.
let LIM = LIMITS;
function useEnv(env) {
  const v = Number(env && env.PPTX_MAX_SLIDES);
  LIM = Number.isInteger(v) && v > 0 && v < LIMITS.maxSlides ? Object.freeze({ ...LIMITS, maxSlides: v }) : LIMITS;
}
const MAX_OPS = 30;
const MAX_TEXT_OPS = 10; // text op는 op마다 덱을 다시 읽고 쓴다 (op 1개 ≈ CPU 0.5초, 파일럿 측정)

const LIMIT_KO = {
  maxInputBytes: "파일 크기",
  maxUncompressedBytes: "압축을 푼 크기",
  maxEntries: "ZIP 항목 수",
  maxSlides: "슬라이드 수",
  maxShapes: "도형 수",
};

class EditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new EditError("bad_input", "bytes는 Uint8Array 또는 ArrayBuffer여야 합니다.");
}

/** 입력 크기를 먼저 본다 (load 전에 — 큰 파일을 열지 않는다). */
function checkSize(u8) {
  if (u8.byteLength === 0) throw new EditError("bad_input", "빈 파일입니다.");
  if (u8.byteLength > LIM.maxInputBytes) {
    throw new EditError("limit", `파일이 너무 큽니다 (${u8.byteLength.toLocaleString()} B > 상한 ${LIM.maxInputBytes.toLocaleString()} B).`);
  }
  // ZIP 시그니처 (PK\x03\x04) — PPTX가 아니면 라이브러리까지 가지 않는다.
  if (!(u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)) {
    throw new EditError("bad_input", "PPTX 파일이 아닙니다 (ZIP 형식이 아님).");
  }
}

async function loadDeck(u8) {
  checkSize(u8);
  const h = new PptxHandler();
  try {
    const data = await h.load(ab(u8), { limits: { ...LIM } });
    return { h, data };
  } catch (e) {
    const v = getPptxLoadLimitViolation(e);
    if (v) {
      const actual = v.actual === undefined ? "" : ` (${Number(v.actual).toLocaleString()}${v.limit === "maxShapes" || v.limit === "maxUncompressedBytes" ? " 이상" : ""})`;
      throw new EditError("limit", `덱이 편집 상한을 넘습니다 — ${LIMIT_KO[v.limit] || v.limit} 상한 ${Number(v.maximum).toLocaleString()}${actual}. 이 덱은 편집할 수 없습니다.`);
    }
    throw new EditError("bad_input", `PPTX를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** ZIP 항목 이름만 읽는다 (압축은 풀지 않는다). */
function partNames(u8) {
  const names = [];
  unzipSync(u8, { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

function summarizeEl(el) {
  const o = { id: el.id, type: el.type, name: el.name, x: el.x, y: el.y, w: el.width, h: el.height };
  if (el.text !== undefined) o.text = el.text;
  if (el.textSegments) o.runs = el.textSegments.map((s) => s.text);
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

function summarize(data, names) {
  const slides = data.slides.map((s) => ({ n: s.slideNumber, id: s.id, elements: s.elements.map(summarizeEl) }));
  const hasSmartArt = slides.some((s) => s.elements.some((e) => /smartart/i.test(String(e.type))));
  return {
    slideCount: slides.length,
    slides,
    signed: names.some((n) => n.startsWith("_xmlsignatures/")),
    hasSmartArt,
    warnings: (data.warnings || []).slice(0, 20).map((w) => (typeof w === "string" ? w : JSON.stringify(w)).slice(0, 300)),
  };
}

/** 변경 전후 텍스트 diff: 요소별 텍스트(표는 셀, 차트는 제목·시리즈)를 한 줄로 펴서 비교한다. */
function textLines(summary) {
  const out = new Map();
  for (const s of summary.slides) {
    for (const e of s.elements) {
      const key = `${s.n}|${e.id}`;
      let t = "";
      if (e.cells) t = e.cells.map((r) => r.join(" | ")).join(" / ");
      else if (e.chart) t = `${e.chart.title || ""} :: ${(e.chart.series || []).map((x) => `${x.name}=${(x.values || []).join(",")}`).join(" ; ")}`;
      else if (e.text !== undefined) t = e.text;
      else if (e.type === "shape") t = `[${e.shapeType || "shape"} x=${e.x} y=${e.y} w=${e.w} h=${e.h} fill=${e.fill || "-"}]`;
      out.set(key, { slide: s.n, elementId: e.id, type: e.type, text: t });
    }
  }
  return out;
}
function diffSummaries(before, after) {
  const a = textLines(before);
  const b = textLines(after);
  const changes = [];
  for (const [k, v] of b) {
    const old = a.get(k);
    if (!old) changes.push({ slide: v.slide, elementId: v.elementId, type: v.type, before: null, after: v.text });
    else if (old.text !== v.text) changes.push({ slide: v.slide, elementId: v.elementId, type: v.type, before: old.text, after: v.text });
  }
  for (const [k, v] of a) if (!b.has(k)) changes.push({ slide: v.slide, elementId: v.elementId, type: v.type, before: v.text, after: null });
  return changes;
}

const eqBytes = (x, y) => {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
function compareParts(orig, edited) {
  const A = unzipSync(orig);
  const B = unzipSync(edited);
  const identical = [];
  const changed = [];
  const removed = [];
  for (const n of Object.keys(A)) {
    if (n.endsWith("/")) continue; // 디렉터리 항목 (pptxgenjs가 넣고 ooxml-core 저장은 뺀다)
    if (!(n in B)) removed.push(n);
    else if (eqBytes(A[n], B[n])) identical.push(n);
    else changed.push(n);
  }
  const added = Object.keys(B).filter((n) => !n.endsWith("/") && !(n in A));
  const slideRe = /^ppt\/slides\/slide\d+\.xml$/;
  return {
    identicalCount: identical.length,
    changed,
    removed,
    added,
    identicalSlides: identical.filter((n) => slideRe.test(n)),
  };
}

// ---------- ops 검증 (People OS src/pptx/types.ts validateOps와 같은 규칙 — 여기서 한 번 더 본다) ----------

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const HEX = /^#?[0-9a-fA-F]{6}$/;

function checkOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new EditError("bad_input", "ops는 1개 이상인 배열이어야 합니다.");
  if (ops.length > MAX_OPS) throw new EditError("limit", `ops는 ${MAX_OPS}개까지입니다 (${ops.length}개).`);
  let textOps = 0;
  ops.forEach((o, i) => {
    const at = `ops[${i}]`;
    if (!o || typeof o !== "object") throw new EditError("bad_input", `${at}가 객체가 아닙니다.`);
    if (!Number.isInteger(o.slide) || o.slide < 1) throw new EditError("bad_input", `${at}.slide는 1 이상의 정수여야 합니다 (슬라이드 번호).`);
    switch (o.op) {
      case "text":
        textOps++;
        if (typeof o.elementId !== "string" || !o.elementId) throw new EditError("bad_input", `${at}.elementId가 필요합니다.`);
        if (typeof o.text !== "string") throw new EditError("bad_input", `${at}.text는 문자열이어야 합니다.`);
        if (o.runIndex !== undefined && (!Number.isInteger(o.runIndex) || o.runIndex < 0)) throw new EditError("bad_input", `${at}.runIndex는 0 이상의 정수여야 합니다.`);
        break;
      case "shape":
        if (typeof o.elementId !== "string" || !o.elementId) throw new EditError("bad_input", `${at}.elementId가 필요합니다.`);
        for (const k of ["x", "y", "w", "h"]) if (o[k] !== undefined && !isNum(o[k])) throw new EditError("bad_input", `${at}.${k}는 숫자여야 합니다.`);
        for (const k of ["w", "h"]) if (o[k] !== undefined && o[k] <= 0) throw new EditError("bad_input", `${at}.${k}는 0보다 커야 합니다.`);
        if (o.fill !== undefined && !(typeof o.fill === "string" && HEX.test(o.fill))) throw new EditError("bad_input", `${at}.fill은 #RRGGBB 형식이어야 합니다.`);
        if (o.x === undefined && o.y === undefined && o.w === undefined && o.h === undefined && o.fill === undefined) throw new EditError("bad_input", `${at}: 바꿀 값(x,y,w,h,fill)이 하나도 없습니다.`);
        break;
      case "cell":
        if (typeof o.elementId !== "string" || !o.elementId) throw new EditError("bad_input", `${at}.elementId가 필요합니다.`);
        if (!Number.isInteger(o.r) || o.r < 0 || !Number.isInteger(o.c) || o.c < 0) throw new EditError("bad_input", `${at}.r·c는 0 이상의 정수여야 합니다.`);
        if (typeof o.text !== "string") throw new EditError("bad_input", `${at}.text는 문자열이어야 합니다.`);
        break;
      case "chart":
        if (typeof o.elementId !== "string" || !o.elementId) throw new EditError("bad_input", `${at}.elementId가 필요합니다.`);
        if (o.series !== undefined && !(Array.isArray(o.series) && o.series.every((s) => s === null || (Array.isArray(s) && s.every(isNum))))) {
          throw new EditError("bad_input", `${at}.series는 숫자 배열의 배열이어야 합니다 (바꾸지 않을 시리즈는 null).`);
        }
        if (o.title !== undefined && typeof o.title !== "string") throw new EditError("bad_input", `${at}.title은 문자열이어야 합니다.`);
        if (o.series === undefined && o.title === undefined) throw new EditError("bad_input", `${at}: series 또는 title이 필요합니다.`);
        break;
      case "duplicate":
        break;
      default:
        throw new EditError("bad_input", `${at}.op를 알 수 없습니다: ${String(o.op)} (text·shape·cell·chart·duplicate)`);
    }
  });
  if (textOps > MAX_TEXT_OPS) throw new EditError("limit", `text op는 ${MAX_TEXT_OPS}개까지입니다 (${textOps}개). 한 번에 덜 고치거나 replaceText를 쓰세요.`);
}

function findEl(data, op, at) {
  const slide = data.slides[op.slide - 1];
  if (!slide) throw new EditError("not_found", `${at}: ${op.slide}번 슬라이드가 없습니다 (전체 ${data.slides.length}장).`);
  const el = slide.elements.find((e) => e.id === op.elementId);
  if (!el) throw new EditError("not_found", `${at}: ${op.slide}번 슬라이드에 요소 ${op.elementId}가 없습니다.`);
  return { slide, el };
}

/**
 * ops 적용. 순서:
 *  1) text op — setPresentationRunText (바이트 → 바이트, 다른 run·서식·부품 보존). op마다 덱을 다시 읽는다.
 *  2) 나머지(shape·cell·chart·duplicate) — 한 번 읽어 모델을 고치고 save() 한 번.
 * duplicate는 맨 뒤에 덧붙이므로 앞 op의 슬라이드 번호가 바뀌지 않는다.
 */
async function applyOpsImpl(input, ops) {
  checkOps(ops);
  const log = [];
  const first = await loadDeck(input);
  const before = summarize(first.data, partNames(input));
  let smartArtEdited = false;

  // 1) text
  let bytes = input;
  ops.forEach((op, i) => {
    if (op.op !== "text") return;
    const { el } = findEl(first.data, op, `ops[${i}]`);
    if (/smartart/i.test(String(el.type))) smartArtEdited = true;
    const runs = el.textSegments || [];
    const ri = op.runIndex ?? 0;
    if (!runs.length) throw new EditError("not_found", `ops[${i}]: 요소 ${op.elementId}에 텍스트 run이 없습니다.`);
    if (ri >= runs.length) throw new EditError("not_found", `ops[${i}]: runIndex ${ri}가 범위를 벗어납니다 (run ${runs.length}개).`);
  });
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op !== "text") continue;
    bytes = await setPresentationRunText(bytes, op.slide - 1, op.elementId, op.runIndex ?? 0, op.text);
    log.push({ i, op: "text", slide: op.slide, elementId: op.elementId, runIndex: op.runIndex ?? 0 });
  }

  // 2) model ops
  const modelOps = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.op !== "text");
  if (modelOps.length) {
    const { h, data } = bytes === input ? first : await loadDeck(bytes);
    const dups = [];
    for (const { op, i } of modelOps) {
      const at = `ops[${i}]`;
      if (op.op === "duplicate") {
        const slide = data.slides[op.slide - 1];
        if (!slide) throw new EditError("not_found", `${at}: ${op.slide}번 슬라이드가 없습니다 (전체 ${data.slides.length}장).`);
        const n = data.slides.length + dups.length + 1;
        if (n > LIM.maxSlides) throw new EditError("limit", `${at}: 복제하면 슬라이드가 상한 ${LIM.maxSlides}장을 넘습니다.`);
        dups.push(duplicateSlide(slide, n));
        log.push({ i, op: "duplicate", slide: op.slide, newSlide: n });
        continue;
      }
      const { el } = findEl(data, op, at);
      if (/smartart/i.test(String(el.type))) smartArtEdited = true;
      if (op.op === "shape") {
        if (op.x !== undefined) el.x = Math.round(op.x);
        if (op.y !== undefined) el.y = Math.round(op.y);
        if (op.w !== undefined) el.width = Math.round(op.w);
        if (op.h !== undefined) el.height = Math.round(op.h);
        if (op.fill !== undefined) el.shapeStyle = { ...(el.shapeStyle || {}), fillColor: (op.fill.startsWith("#") ? op.fill : `#${op.fill}`).toUpperCase() };
        log.push({ i, op: "shape", slide: op.slide, elementId: op.elementId });
      } else if (op.op === "cell") {
        if (el.type !== "table" || !el.tableData) throw new EditError("bad_input", `${at}: 요소 ${op.elementId}는 표가 아닙니다.`);
        const row = el.tableData.rows[op.r];
        const cell = row?.cells?.[op.c];
        if (!cell) throw new EditError("not_found", `${at}: 표에 셀 (${op.r}, ${op.c})이 없습니다 (행 ${el.tableData.rows.length}개).`);
        cell.text = op.text;
        cell.textRuns = undefined; // 파일럿: run을 비워야 text가 저장된다
        log.push({ i, op: "cell", slide: op.slide, elementId: op.elementId, r: op.r, c: op.c });
      } else if (op.op === "chart") {
        if (el.type !== "chart" || !el.chartData) throw new EditError("bad_input", `${at}: 요소 ${op.elementId}는 차트가 아닙니다.`);
        const series = el.chartData.series || [];
        (op.series || []).forEach((vals, si) => {
          if (vals === null) return;
          if (si >= series.length) throw new EditError("not_found", `${at}: 시리즈 ${si}가 없습니다 (시리즈 ${series.length}개).`);
          updateChartSeriesValues(el, si, vals);
        });
        if (op.title !== undefined) setChartTitle(el, op.title);
        log.push({ i, op: "chart", slide: op.slide, elementId: op.elementId });
      }
    }
    bytes = await h.save([...data.slides, ...dups]);
  }

  const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 다시 읽어 값 확인 (UI diff + 저장본이 다시 열리는지)
  const re = await loadDeck(out);
  const after = summarize(re.data, partNames(out));
  return {
    ok: true,
    bytes: out,
    log,
    before,
    after,
    diff: diffSummaries(before, after),
    parts: compareParts(input, out),
    warnings: {
      signatureRemoved: before.signed && !after.signed,
      smartArtEdited,
    },
    sizes: { before: input.byteLength, after: out.byteLength },
  };
}

function toFailure(e) {
  if (e instanceof EditError || e instanceof XlsxEditError || e instanceof DocxEditError) return { ok: false, code: e.code, error: e.message };
  console.error("[pptx-editor] internal", e instanceof Error ? e.stack : String(e));
  return { ok: false, code: "internal", error: `편집 중 오류: ${e instanceof Error ? e.message : String(e)}` };
}

export class PptxEditor extends WorkerEntrypoint {
  async inspect(bytes) {
    useEnv(this.env);
    try {
      const u8 = toU8(bytes);
      const { data } = await loadDeck(u8);
      return { ok: true, ...summarize(data, partNames(u8)), limits: { ...LIM, maxOps: MAX_OPS, maxTextOps: MAX_TEXT_OPS } };
    } catch (e) {
      return toFailure(e);
    }
  }

  async applyOps(bytes, ops) {
    useEnv(this.env);
    try {
      return await applyOpsImpl(toU8(bytes), ops);
    } catch (e) {
      return toFailure(e);
    }
  }

  /** 처음 찾은 run 1개의 `find`를 `to`로 바꾼다 (파일럿 replace.js). */
  async replaceText(bytes, find, to) {
    useEnv(this.env);
    try {
      const u8 = toU8(bytes);
      if (typeof find !== "string" || !find) throw new EditError("bad_input", "find가 비어 있습니다.");
      if (typeof to !== "string") throw new EditError("bad_input", "to는 문자열이어야 합니다.");
      const { data } = await loadDeck(u8);
      for (let si = 0; si < data.slides.length; si++) {
        for (const el of data.slides[si].elements) {
          const segs = el.textSegments || [];
          const ri = segs.findIndex((s) => (s.text || "").includes(find));
          if (ri >= 0) {
            const out = await setPresentationRunText(u8, si, el.id, ri, segs[ri].text.replace(find, to));
            return { ok: true, bytes: out, slide: si + 1, elementId: el.id, runIndex: ri };
          }
        }
      }
      throw new EditError("not_found", `텍스트를 찾지 못했습니다: ${find}`);
    } catch (e) {
      return toFailure(e);
    }
  }

  // ---------- XLSX (2026-11-21) — PPTX RPC는 위에 그대로, 같은 { ok:false, code, error } 규칙 ----------

  /** 시트·표·셀 미리보기(시트마다 50행×26열) 요약. */
  async inspectWorkbook(bytes) {
    try {
      const lim = xlsxLimits(this.env);
      const wb = loadBook(xlsxU8(bytes), lim);
      return { ok: true, ...summarizeBook(wb), limits: { ...lim, maxOps: XLSX_MAX_OPS } };
    } catch (e) {
      return toFailure(e);
    }
  }

  /** ops: cell · formula · row · sheet (src/xlsx/types.ts XlsxOp). 편집본 bytes + 셀 diff + 부품 비교. */
  async applyWorkbookOps(bytes, ops) {
    try {
      return applyXlsxOps(xlsxU8(bytes), ops, xlsxLimits(this.env));
    } catch (e) {
      return toFailure(e);
    }
  }

  /** 처음 찾은 텍스트 셀 1개의 find → to (가장 가벼운 경로). */
  async replaceCell(bytes, find, to) {
    try {
      return replaceCellText(xlsxU8(bytes), find, to, xlsxLimits(this.env));
    } catch (e) {
      return toFailure(e);
    }
  }

  // ---------- DOCX (2026-11-22) — 같은 { ok:false, code, error } 규칙 ----------

  /** 문단·표 미리보기(블록 400개까지) + 머리글·바닥글 글 + 추적·메모·서명 여부. */
  async inspectDocument(bytes) {
    try {
      const lim = docxLimits(this.env);
      const { loaded, idx, parts } = await loadDoc(docxU8(bytes), lim);
      return { ok: true, ...summarizeDoc(loaded, idx, parts), limits: { ...lim, maxOps: DOCX_MAX_OPS, maxText: DOCX_MAX_TEXT } };
    } catch (e) {
      return toFailure(e);
    }
  }

  /** ops: replace · paragraph · cell · insert · delete (src/docx/edit-types.ts DocxEditOp). 편집본 bytes + 문단 diff + 부품 비교. */
  async applyDocumentOps(bytes, ops) {
    try {
      return await applyDocxOps(docxU8(bytes), ops, docxLimits(this.env));
    } catch (e) {
      return toFailure(e);
    }
  }

  /** find → to (all이 true가 아니면 처음 1곳만). 본문·표·머리글·바닥글. */
  async replaceDocumentText(bytes, find, to, all) {
    try {
      return await replaceDocxText(docxU8(bytes), find, to, all === true, docxLimits(this.env));
    } catch (e) {
      return toFailure(e);
    }
  }
}

// 기본 진입점: 바깥 HTTP는 상태 확인만 (편집은 RPC로만 연다 — 인증은 People OS가 한다).
export default class extends PptxEditor {
  async fetch() {
    useEnv(this.env);
    return new Response(JSON.stringify({ ok: true, service: "people-os-doc-editor", rpc: ["inspect", "applyOps", "replaceText", "inspectWorkbook", "applyWorkbookOps", "replaceCell", "inspectDocument", "applyDocumentOps", "replaceDocumentText"], limits: LIM, xlsxLimits: xlsxLimits(this.env), docxLimits: docxLimits(this.env) }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
