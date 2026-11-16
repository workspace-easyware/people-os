// 근거 재순위 (Decision Model, Clef-omni) — 2026-11-16.
// Vectorize + D1이 뽑은 상위 후보(최대 5개) 중 질문에 가장 잘 답하는 근거를
// 판단 모델이 고른다. 벡터 유사도·키워드 겹침은 "관련 있음"을 재지만,
// 판단 모델은 "이 질문에 답이 되는가"를 직접 고른다 — 해당하는 문구를
// 빠르게 찾아내는 능력이 탁월하다는 게 실측 근거 (verdict 9/9, 토픽 가드 4/4).
// 1위를 주 근거로 삼고 나머지는 원래 순서를 유지한다.
// 실패(호출 오류·파싱 실패) 시 원래 순서를 그대로 쓴다 (fail-open).
// 후보가 1개면 재순위를 건너뛴다.
import { aiGatewayOptions } from "../ai-gateway";
import type { Source } from "../ask-pipeline";

export const RERANK_MODEL_CLEF_OMNI = "@cf/cloudflare/clef-omni";

const RERANK_QUESTION_ID = "rerank";
const MAX_RERANK_CANDIDATES = 5;

type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

function buildRerankInput(question: string, candidates: Source[]): unknown {
  const criteria: Record<string, string> = {};
  candidates.forEach((s, i) => {
    criteria[`cand_${i + 1}`] = `[${s.title} › ${s.section}] ${s.snippet.slice(0, 200)}`;
  });
  const state = [
    `질문: ${question}`,
    "근거 후보:",
    ...candidates.map((s, i) => `${i + 1}. [${s.title} › ${s.section}] ${s.snippet.slice(0, 120)}`),
  ].join("\n");
  return {
    model: "clef-omni",
    state,
    questions: {
      [RERANK_QUESTION_ID]: {
        type: "choice",
        instructions: "이 질문에 가장 잘 답하는 근거를 하나만 고른다. 답이 되는 문구가 직접 들어 있는 근거를 우대한다.",
        criteria,
      },
    },
  };
}

function parseRerankAnswer(raw: unknown, count: number): number | null {
  const root = raw as { answers?: Record<string, unknown>; response?: { answers?: Record<string, unknown> } } | null;
  const answers = root?.answers ?? root?.response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const a = answers[RERANK_QUESTION_ID];
  const asIndex = (v: unknown): number | null => {
    if (typeof v !== "string") return null;
    const m = v.trim().toLowerCase().match(/cand_?(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= count ? n - 1 : null;
  };
  const direct = asIndex(a);
  if (direct !== null) return direct;
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  for (const k of ["choice", "answer", "option", "value", "label"]) {
    const idx = asIndex(o[k]);
    if (idx !== null) return idx;
  }
  const probs = (o.probabilities ?? o.probs) as Record<string, unknown> | undefined;
  if (probs && typeof probs === "object") {
    let best = -1;
    let bestP = -1;
    for (const [k, p] of Object.entries(probs)) {
      const idx = asIndex(k);
      if (idx !== null && typeof p === "number" && p > bestP) { best = idx; bestP = p; }
    }
    if (best >= 0) return best;
  }
  return null;
}

export type RerankOutcome = {
  sources: Source[];
  reranked: boolean;
  winnerId?: string;
  reason: string;
};

/**
 * 근거 후보를 재순위한다. 실패하면 원래 순서를 그대로 돌려준다 (fail-open).
 * 호출부는 sources.length >= 2일 때만 부른다.
 */
export async function rerankSources(env: { AI: unknown }, question: string, sources: Source[]): Promise<RerankOutcome> {
  const fallback: RerankOutcome = { sources, reranked: false, reason: "rerank skipped" };
  if (sources.length < 2) return fallback;
  const candidates = sources.slice(0, MAX_RERANK_CANDIDATES);
  const ai = env.AI as AiLike;
  try {
    const out = await ai.run(RERANK_MODEL_CLEF_OMNI, buildRerankInput(question, candidates), aiGatewayOptions({ tag: "evidence-rerank" }));
    const idx = parseRerankAnswer(out, candidates.length);
    if (idx === null || idx === 0) return { sources, reranked: false, reason: idx === 0 ? "rerank kept top candidate" : "rerank parse failed, fail-open" };
    const winner = candidates[idx];
    const rest = sources.filter((s) => s.id !== winner.id);
    return { sources: [winner, ...rest], reranked: true, winnerId: winner.id, reason: `clef-omni picked rank ${idx + 1} as top` };
  } catch (e) {
    return { sources, reranked: false, reason: `rerank failed, fail-open: ${e instanceof Error ? e.message : String(e)}` };
  }
}
