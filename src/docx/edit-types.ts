// DOCX 편집 공용 타입 (2026-11-22, files/workflow-verify/docx-edit-pilot/RESULT.md).
// 편집 자체는 PPTX·XLSX와 같은 별도 Worker people-os-doc-editor(pptx-editor/src/docx.js, ooxml-core 2.0.0의 docx 영역)가 한다 — 여기는 ops 스키마·RPC 모양·검증만 둔다.
// 라우트(src/index.ts /api/docx/inspect·edit·versions)와 워크플로 노드(src/workflow/nodes.ts docx_edit)가 함께 쓴다. 모양은 src/xlsx/types.ts와 같다.
// (새 문서 만들기는 src/docx/create.ts — 본체 Worker의 docx 9.16.0, 이 파일과 무관하다.)

/**
 * 문단 번호(index·after)는 inspect가 돌려주는 읽는 순서 번호다 (1부터, 표 셀 안의 문단 포함). 모두 **편집 전** 문서 기준이다.
 * table은 표 번호(1부터), r·c는 행·열(0부터, PPTX cell op와 같다).
 */
export type DocxEditOp =
  | { op: "replace"; find: string; to: string; all?: boolean }
  | { op: "paragraph"; index: number; text: string }
  | { op: "cell"; table: number; r: number; c: number; text: string }
  | { op: "insert"; after: number; text: string }
  | { op: "delete"; index: number };

export const DOCX_EDIT_MAX_OPS = 100;
export const DOCX_EDIT_MAX_TEXT = 10_000;
export const DOCX_EDIT_MAX_FIND = 500;

export type DocxBlockBrief =
  | { type: "paragraph"; index: number; text: string; style?: string; list?: boolean; clipped?: boolean }
  | { type: "table"; table: number; rows: { text: string; paragraphs: number[]; clipped?: boolean }[][]; rowCount: number };
export type DocxEditSummary = {
  paragraphCount: number; tableCount: number; blocks: DocxBlockBrief[]; truncated: boolean;
  headers: string[]; footers: string[]; signed: boolean; trackedChanges: number; comments: number; fields: number; images: number;
  protected: boolean; title: string | null; warnings: string[];
};
export type DocxDiffEntry = {
  index: number | null; where: "body" | "table" | "header" | "footer"; kind: "changed" | "added" | "removed";
  before: string | null; after: string | null; table?: number; r?: number; c?: number; afterIndex?: number;
};
export type DocxEditFailure = { ok: false; code: "limit" | "bad_input" | "not_found" | "internal"; error: string };
export type DocxInspectResult = ({ ok: true; limits: Record<string, number> } & DocxEditSummary) | DocxEditFailure;
export type DocxApplyOk = {
  ok: true; bytes: Uint8Array; log: Record<string, unknown>[]; before: DocxEditSummary; after: DocxEditSummary; diff: DocxDiffEntry[];
  parts: { identicalCount: number; changed: string[]; removed: string[]; added: string[] };
  xml: { checked: number; errors: string[] };
  warnings: { signatureRemoved: boolean; trackedChanges: boolean; fixedRunsKept: boolean; fixedRunsRemoved: boolean };
  sizes: { before: number; after: number };
};
export type DocxApplyResult = DocxApplyOk | DocxEditFailure;
export type DocxReplaceResult = (DocxApplyOk & { count: number }) | DocxEditFailure;

/** 서비스 바인딩 DOC_EDITOR의 DOCX RPC 모양 (pptx-editor/src/index.js PptxEditor — PPTX·XLSX RPC 옆). */
export interface DocxEditorRpc {
  inspectDocument(bytes: Uint8Array): Promise<DocxInspectResult>;
  applyDocumentOps(bytes: Uint8Array, ops: DocxEditOp[]): Promise<DocxApplyResult>;
  replaceDocumentText(bytes: Uint8Array, find: string, to: string, all: boolean): Promise<DocxReplaceResult>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * ops를 검증하고 알려진 키만 남긴다 (LLM이 만든 ops도 이 함수를 거친다). 편집 Worker(pptx-editor/src/docx.js checkOps)가 같은 규칙으로 한 번 더 본다.
 * lenient(AI 계획에만): 숫자가 문자열("3")로 온 번호, all이 "true"로 온 것을 고쳐 받는다.
 */
export function validateDocxEditOps(raw: unknown, lenient = false): { ok: true; ops: DocxEditOp[] } | { ok: false; error: string; limit?: boolean } {
  const arr = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: "ops는 1개 이상인 배열이어야 합니다." };
  if (arr.length > DOCX_EDIT_MAX_OPS) return { ok: false, limit: true, error: `ops는 ${DOCX_EDIT_MAX_OPS}개까지입니다 (${arr.length}개).` };
  const ops: DocxEditOp[] = [];
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    const at = `ops[${i}]`;
    if (!isObj(o)) return { ok: false, error: `${at}가 객체가 아닙니다.` };
    const num = (k: string, min: number): number | string => {
      let v = o[k];
      if (lenient && typeof v === "string" && /^\d{1,7}$/.test(v.trim())) v = Number(v.trim());
      return typeof v === "number" && Number.isInteger(v) && v >= min ? v : `${at}.${k}는 ${min} 이상의 정수여야 합니다.`;
    };
    const text = (k: string): { v: string } | { error: string; limit?: boolean } => {
      const v = o[k];
      if (typeof v !== "string") return { error: `${at}.${k}는 문자열이어야 합니다.` };
      if (v.length > DOCX_EDIT_MAX_TEXT) return { limit: true, error: `${at}.${k}는 ${DOCX_EDIT_MAX_TEXT.toLocaleString()}자까지입니다.` };
      return { v };
    };
    switch (o.op) {
      case "replace": {
        if (typeof o.find !== "string" || !o.find) return { ok: false, error: `${at}.find가 비어 있습니다.` };
        if (o.find.length > DOCX_EDIT_MAX_FIND) return { ok: false, limit: true, error: `${at}.find는 ${DOCX_EDIT_MAX_FIND}자까지입니다.` };
        const t = text("to"); if ("error" in t) return { ok: false, ...t };
        const all = lenient && typeof o.all === "string" ? o.all.trim().toLowerCase() === "true" : o.all;
        if (all !== undefined && all !== null && typeof all !== "boolean") return { ok: false, error: `${at}.all은 true/false여야 합니다.` };
        ops.push({ op: "replace", find: o.find, to: t.v, ...(all === true ? { all: true } : {}) });
        break;
      }
      case "paragraph": {
        const n = num("index", 1); if (typeof n === "string") return { ok: false, error: n };
        const t = text("text"); if ("error" in t) return { ok: false, ...t };
        ops.push({ op: "paragraph", index: n, text: t.v });
        break;
      }
      case "cell": {
        const tb = num("table", 1); if (typeof tb === "string") return { ok: false, error: tb };
        const r = num("r", 0); if (typeof r === "string") return { ok: false, error: r };
        const c = num("c", 0); if (typeof c === "string") return { ok: false, error: c };
        const t = text("text"); if ("error" in t) return { ok: false, ...t };
        ops.push({ op: "cell", table: tb, r, c, text: t.v });
        break;
      }
      case "insert": {
        const n = num("after", 0); if (typeof n === "string") return { ok: false, error: n };
        const t = text("text"); if ("error" in t) return { ok: false, ...t };
        ops.push({ op: "insert", after: n, text: t.v });
        break;
      }
      case "delete": {
        const n = num("index", 1); if (typeof n === "string") return { ok: false, error: n };
        ops.push({ op: "delete", index: n });
        break;
      }
      default:
        return { ok: false, error: `${at}.op를 알 수 없습니다: ${String(o.op)} (replace·paragraph·cell·insert·delete)` };
    }
  }
  return { ok: true, ops };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
