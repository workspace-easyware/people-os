// XLSX 편집 공용 타입 (2026-11-21, files/workflow-verify/xlsx-edit-pilot/RESULT.md).
// 편집 자체는 PPTX와 같은 별도 Worker people-os-doc-editor(폴더 pptx-editor/src/xlsx.js, xlvane 1.3.4)가 한다 — 여기는 ops 스키마·RPC 모양·검증만 둔다.
// 라우트(src/index.ts /api/xlsx/*)와 워크플로 노드(src/workflow/nodes.ts xlsx_edit)가 함께 쓴다. 모양은 src/pptx/types.ts와 같다.

export type XlsxScalar = string | number | boolean | null;

/**
 * sheet는 시트 이름(정확히), cell은 A1 주소. formula는 "=" 없이 또는 있이 (저장할 때 뺀다).
 * 수식은 계산되지 않는다 — result를 알 때만 넣고, Excel이 열 때 다시 계산한다 (fullCalcOnLoad).
 */
export type XlsxOp =
  | { op: "cell"; sheet: string; cell: string; value: XlsxScalar }
  | { op: "formula"; sheet: string; cell: string; formula: string; result?: string | number | boolean }
  | { op: "row"; sheet: string; values: XlsxScalar[] }
  | { op: "sheet"; name: string };

export const XLSX_MAX_OPS = 200;
export const XLSX_MAX_ROW_VALUES = 200;
export const XLSX_MAX_TEXT = 32_767;
export const XLSX_MAX_FORMULA = 8_192;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type XlsxCellBrief = { ref: string; v: unknown; f?: string | null; t?: string };
export type XlsxSheetSummary = {
  name: string; index: number; state: string; kind: string; cellCount: number; formulas: number;
  usedRange: string | null; lastRow: number; lastCol: number;
  tables: { name: string; ref: string; totalsRow: boolean; columns: string[] }[];
  charts: number; merges: number; cells: XlsxCellBrief[]; truncated: boolean;
};
export type XlsxSummary = {
  sheetCount: number; sheets: XlsxSheetSummary[]; hasMacros: boolean; externalLinks: number; fullCalcOnLoad: boolean; warnings: string[];
};
export type XlsxDiffEntry = {
  sheet: string; cell: string | null; kind: "changed" | "added" | "removed" | "sheetAdded" | "sheetRemoved";
  before: string | null; after: string | null; formula?: boolean;
};
export type XlsxFailure = { ok: false; code: "limit" | "bad_input" | "not_found" | "internal"; error: string };
export type XlsxInspectResult = ({ ok: true; limits: Record<string, number> } & XlsxSummary) | XlsxFailure;
export type XlsxApplyOk = {
  ok: true; bytes: Uint8Array; log: Record<string, unknown>[]; before: XlsxSummary; after: XlsxSummary; diff: XlsxDiffEntry[];
  parts: { identicalCount: number; changed: string[]; removed: string[]; added: string[]; identicalSheets: string[] };
  xml: { checked: number; errors: string[] };
  warnings: { codes: string[]; formulasNotRecalculated: boolean; fullCalcOnLoad: boolean };
  sizes: { before: number; after: number };
};
export type XlsxApplyResult = XlsxApplyOk | XlsxFailure;
export type XlsxReplaceResult = (XlsxApplyOk & { sheet: string; cell: string }) | XlsxFailure;

/** 서비스 바인딩 DOC_EDITOR의 XLSX RPC 모양 (pptx-editor/src/index.js PptxEditor — PPTX RPC 옆). */
export interface XlsxEditorRpc {
  inspectWorkbook(bytes: Uint8Array): Promise<XlsxInspectResult>;
  applyWorkbookOps(bytes: Uint8Array, ops: XlsxOp[]): Promise<XlsxApplyResult>;
  replaceCell(bytes: Uint8Array, find: string, to: string): Promise<XlsxReplaceResult>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown): v is XlsxScalar =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const REF = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
const BAD_SHEET = /[\[\]:*?/\\]/;

export function sheetNameError(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return "시트 이름이 비어 있습니다.";
  if (name.length > 31) return "시트 이름은 31자까지입니다.";
  if (BAD_SHEET.test(name)) return "시트 이름에 [ ] : * ? / \\ 를 쓸 수 없습니다.";
  if (name.startsWith("'") || name.endsWith("'")) return "시트 이름은 작은따옴표로 시작하거나 끝날 수 없습니다.";
  if (name.toLowerCase() === "history") return "History는 Excel 예약 이름입니다.";
  return null;
}

/**
 * ops를 검증하고 알려진 키만 남긴다 (LLM이 만든 ops도 이 함수를 거친다). 편집 Worker(pptx-editor/src/xlsx.js checkOps)가 같은 규칙으로 한 번 더 본다.
 * 문자열 숫자("2")를 숫자로 바꾸지 않는다 — 텍스트 "2"와 숫자 2는 Excel에서 다르다.
 */
export function validateXlsxOps(raw: unknown): { ok: true; ops: XlsxOp[] } | { ok: false; error: string } {
  const arr = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: "ops는 1개 이상인 배열이어야 합니다." };
  if (arr.length > XLSX_MAX_OPS) return { ok: false, error: `ops는 ${XLSX_MAX_OPS}개까지입니다 (${arr.length}개).` };
  const ops: XlsxOp[] = [];
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    const at = `ops[${i}]`;
    if (!isObj(o)) return { ok: false, error: `${at}가 객체가 아닙니다.` };
    const sheet = typeof o.sheet === "string" ? o.sheet : "";
    const cell = typeof o.cell === "string" ? o.cell.trim().toUpperCase() : "";
    const needSheet = () => (sheet ? null : `${at}.sheet(시트 이름)가 필요합니다.`);
    const needCell = () => (REF.test(cell) ? null : `${at}.cell은 A1 형식 셀 주소여야 합니다 (예: B7).`);
    switch (o.op) {
      case "cell": {
        const e = needSheet() || needCell(); if (e) return { ok: false, error: e };
        if (!isScalar(o.value)) return { ok: false, error: `${at}.value는 문자열·숫자·불리언·null이어야 합니다.` };
        if (typeof o.value === "string" && o.value.length > XLSX_MAX_TEXT) return { ok: false, error: `${at}.value는 ${XLSX_MAX_TEXT}자까지입니다.` };
        ops.push({ op: "cell", sheet, cell, value: o.value });
        break;
      }
      case "formula": {
        const e = needSheet() || needCell(); if (e) return { ok: false, error: e };
        if (typeof o.formula !== "string" || !o.formula.replace(/^=/, "").trim()) return { ok: false, error: `${at}.formula가 비어 있습니다.` };
        if (o.formula.length > XLSX_MAX_FORMULA) return { ok: false, error: `${at}.formula는 ${XLSX_MAX_FORMULA}자까지입니다.` };
        if (o.result !== undefined && (o.result === null || !isScalar(o.result))) return { ok: false, error: `${at}.result는 문자열·숫자·불리언이어야 합니다 (모르면 빼세요).` };
        ops.push({ op: "formula", sheet, cell, formula: o.formula.replace(/^=/, ""), ...(o.result !== undefined ? { result: o.result as string | number | boolean } : {}) });
        break;
      }
      case "row": {
        const e = needSheet(); if (e) return { ok: false, error: e };
        if (!Array.isArray(o.values) || o.values.length === 0) return { ok: false, error: `${at}.values는 1개 이상인 배열이어야 합니다.` };
        if (o.values.length > XLSX_MAX_ROW_VALUES) return { ok: false, error: `${at}.values는 ${XLSX_MAX_ROW_VALUES}칸까지입니다.` };
        if (!o.values.every(isScalar)) return { ok: false, error: `${at}.values의 칸은 문자열·숫자·불리언·null이어야 합니다.` };
        if (o.values.some((v) => typeof v === "string" && v.length > XLSX_MAX_TEXT)) return { ok: false, error: `${at}.values의 칸은 ${XLSX_MAX_TEXT}자까지입니다.` };
        ops.push({ op: "row", sheet, values: o.values as XlsxScalar[] });
        break;
      }
      case "sheet": {
        const err = sheetNameError(o.name);
        if (err) return { ok: false, error: `${at}.name: ${err}` };
        ops.push({ op: "sheet", name: o.name as string });
        break;
      }
      default:
        return { ok: false, error: `${at}.op를 알 수 없습니다: ${String(o.op)} (cell·formula·row·sheet)` };
    }
  }
  return { ok: true, ops };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
