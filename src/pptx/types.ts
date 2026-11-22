// PPTX 편집 공용 타입 (2026-11-21, PILOT-RESULT.md 통합 개요 2번).
// 편집 자체는 별도 Worker people-os-doc-editor(폴더 pptx-editor/src/index.js)가 한다 — 여기는 ops 스키마·RPC 모양·검증만 둔다.
// 라우트(src/index.ts /api/pptx/*)와 워크플로 노드(src/workflow/nodes.ts pptx_edit)가 함께 쓴다.

/** 슬라이드 번호(slide)는 inspect 요약의 n과 같은 1부터. elementId는 inspect 요약의 id 그대로. */
export type PptxOp =
  | { op: "text"; slide: number; elementId: string; runIndex?: number; text: string }
  | { op: "shape"; slide: number; elementId: string; x?: number; y?: number; w?: number; h?: number; fill?: string }
  | { op: "cell"; slide: number; elementId: string; r: number; c: number; text: string }
  | { op: "chart"; slide: number; elementId: string; series?: (number[] | null)[]; title?: string }
  | { op: "duplicate"; slide: number };

export const PPTX_MAX_OPS = 30;
export const PPTX_MAX_TEXT_OPS = 10;
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type PptxElementSummary = {
  id: string; type: string; name?: string; x?: number; y?: number; w?: number; h?: number;
  text?: string; runs?: string[]; shapeType?: string; fill?: string; cells?: string[][];
  chart?: { type?: string; title?: string; categories?: string[]; series?: { name?: string; values?: number[] }[] };
};
export type PptxSummary = {
  slideCount: number;
  slides: { n: number; id: string; elements: PptxElementSummary[] }[];
  signed: boolean;
  hasSmartArt: boolean;
  warnings: string[];
};
export type PptxDiffEntry = { slide: number; elementId: string; type: string; before: string | null; after: string | null };
export type PptxFailure = { ok: false; code: "limit" | "bad_input" | "not_found" | "internal"; error: string };
export type PptxInspectResult = ({ ok: true; limits: Record<string, number> } & PptxSummary) | PptxFailure;
export type PptxApplyResult =
  | {
    ok: true; bytes: Uint8Array; log: Record<string, unknown>[]; before: PptxSummary; after: PptxSummary; diff: PptxDiffEntry[];
    parts: { identicalCount: number; changed: string[]; removed: string[]; added: string[]; identicalSlides: string[] };
    warnings: { signatureRemoved: boolean; smartArtEdited: boolean };
    sizes: { before: number; after: number };
  }
  | PptxFailure;
export type PptxReplaceResult = { ok: true; bytes: Uint8Array; slide: number; elementId: string; runIndex: number } | PptxFailure;

/** 서비스 바인딩 DOC_EDITOR의 RPC 모양 (pptx-editor/src/index.js PptxEditor). */
export interface PptxEditorRpc {
  inspect(bytes: Uint8Array): Promise<PptxInspectResult>;
  applyOps(bytes: Uint8Array, ops: PptxOp[]): Promise<PptxApplyResult>;
  replaceText(bytes: Uint8Array, find: string, to: string): Promise<PptxReplaceResult>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const HEX = /^#?[0-9a-fA-F]{6}$/;

/**
 * ops를 검증하고 알려진 키만 남긴다 (LLM이 만든 ops도 이 함수를 거친다). 편집 Worker가 같은 규칙으로 한 번 더 본다.
 * 문자열 숫자("2")는 받지 않는다 — LLM 출력이 흐트러지면 실패로 알린다.
 */
export function validateOps(raw: unknown): { ok: true; ops: PptxOp[] } | { ok: false; error: string } {
  const arr = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: "ops는 1개 이상인 배열이어야 합니다." };
  if (arr.length > PPTX_MAX_OPS) return { ok: false, error: `ops는 ${PPTX_MAX_OPS}개까지입니다 (${arr.length}개).` };
  const ops: PptxOp[] = [];
  let textOps = 0;
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    const at = `ops[${i}]`;
    if (!isObj(o)) return { ok: false, error: `${at}가 객체가 아닙니다.` };
    if (!isInt(o.slide, 1)) return { ok: false, error: `${at}.slide는 1 이상의 정수여야 합니다.` };
    const slide = o.slide as number;
    const elementId = typeof o.elementId === "string" ? o.elementId.trim() : "";
    const needEl = () => (elementId ? null : `${at}.elementId가 필요합니다.`);
    switch (o.op) {
      case "text": {
        const e = needEl(); if (e) return { ok: false, error: e };
        if (typeof o.text !== "string") return { ok: false, error: `${at}.text는 문자열이어야 합니다.` };
        if (o.runIndex !== undefined && !isInt(o.runIndex, 0)) return { ok: false, error: `${at}.runIndex는 0 이상의 정수여야 합니다.` };
        textOps++;
        ops.push({ op: "text", slide, elementId, text: o.text.slice(0, 2000), ...(o.runIndex !== undefined ? { runIndex: o.runIndex as number } : {}) });
        break;
      }
      case "shape": {
        const e = needEl(); if (e) return { ok: false, error: e };
        const op: PptxOp = { op: "shape", slide, elementId };
        for (const k of ["x", "y", "w", "h"] as const) {
          if (o[k] === undefined) continue;
          if (!isNum(o[k])) return { ok: false, error: `${at}.${k}는 숫자여야 합니다.` };
          if ((k === "w" || k === "h") && (o[k] as number) <= 0) return { ok: false, error: `${at}.${k}는 0보다 커야 합니다.` };
          op[k] = o[k] as number;
        }
        if (o.fill !== undefined) {
          if (!(typeof o.fill === "string" && HEX.test(o.fill))) return { ok: false, error: `${at}.fill은 #RRGGBB 형식이어야 합니다.` };
          op.fill = o.fill;
        }
        if (op.x === undefined && op.y === undefined && op.w === undefined && op.h === undefined && op.fill === undefined) {
          return { ok: false, error: `${at}: 바꿀 값(x,y,w,h,fill)이 하나도 없습니다.` };
        }
        ops.push(op);
        break;
      }
      case "cell": {
        const e = needEl(); if (e) return { ok: false, error: e };
        if (!isInt(o.r, 0) || !isInt(o.c, 0)) return { ok: false, error: `${at}.r·c는 0 이상의 정수여야 합니다.` };
        if (typeof o.text !== "string") return { ok: false, error: `${at}.text는 문자열이어야 합니다.` };
        ops.push({ op: "cell", slide, elementId, r: o.r as number, c: o.c as number, text: o.text.slice(0, 2000) });
        break;
      }
      case "chart": {
        const e = needEl(); if (e) return { ok: false, error: e };
        const op: PptxOp = { op: "chart", slide, elementId };
        if (o.series !== undefined) {
          if (!Array.isArray(o.series) || !o.series.every((s) => s === null || (Array.isArray(s) && s.every(isNum)))) {
            return { ok: false, error: `${at}.series는 숫자 배열의 배열이어야 합니다 (바꾸지 않을 시리즈는 null).` };
          }
          op.series = o.series as (number[] | null)[];
        }
        if (o.title !== undefined) {
          if (typeof o.title !== "string") return { ok: false, error: `${at}.title은 문자열이어야 합니다.` };
          op.title = o.title.slice(0, 300);
        }
        if (op.series === undefined && op.title === undefined) return { ok: false, error: `${at}: series 또는 title이 필요합니다.` };
        ops.push(op);
        break;
      }
      case "duplicate":
        ops.push({ op: "duplicate", slide });
        break;
      default:
        return { ok: false, error: `${at}.op를 알 수 없습니다: ${String(o.op)} (text·shape·cell·chart·duplicate)` };
    }
  }
  if (textOps > PPTX_MAX_TEXT_OPS) return { ok: false, error: `text op는 ${PPTX_MAX_TEXT_OPS}개까지입니다 (${textOps}개).` };
  return { ok: true, ops };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
