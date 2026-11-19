// S4 M2 — Workers AI 단가표 (토큰 기반 비용 추정용, 설계서 §7.3).
//
// 쓰는 곳: AI Gateway 로그에 cost가 없을 때(Workers AI 호출은 비어 있을 수 있다)
// 또는 게이트웨이 동기화 전 트레이스 상세에서 추정치를 보여 줄 때. 이 표로 만든
// 값은 항상 estimated=1이고 화면에 "추정"이라고 표시한다.
//
// ⚠ 확인 상태 (2026-11-14, M2): 이 세션은 웹 접근(WebFetch/WebSearch)이 허용되지
// 않아 Workers AI 공식 가격 페이지(developers.cloudflare.com/workers-ai/platform/pricing/)를
// 직접 다시 열어 보지 못했다. 아래 값은 그 페이지의 공개 단가(USD / 100만 토큰)를
// 기억으로 옮긴 것이다 — 배포 전에 가격 페이지와 대조해 `checked` 날짜를 갱신한다
// (notes/S4-M2-findings.md §2, §6). 값이 틀려도 화면에는 "추정"으로만 나간다.
//
// 토큰이 없으면 추정하지 않는다(null). 0으로 채우지 않는다 (§7.3, §C.4).

export type ModelPrice = {
  /** USD per 1M input tokens */
  inPerM: number;
  /** USD per 1M output tokens (임베딩은 0 — 출력 토큰 개념 없음) */
  outPerM: number;
  /** 단가를 마지막으로 공식 페이지와 대조한 날짜. null = 아직 대조 안 함 */
  checked: string | null;
  note?: string;
};

export const PRICING_SOURCE = "https://developers.cloudflare.com/workers-ai/platform/pricing/";

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inPerM: 0.27, outPerM: 0.85, checked: null, note: "답 생성(ask/eval-ask)·judge" },
  "@cf/baai/bge-m3": { inPerM: 0.012, outPerM: 0, checked: null, note: "임베딩" },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 0.29, outPerM: 2.25, checked: null, note: "debug-ai 후보" },
};

// Whisper는 토큰이 아니라 오디오 분당 과금이다 — 위 토큰 단가표와 별개.
// 출처: PRICING_SOURCE (Workers AI Pricing 표), 2026-11-19 직접 확인:
//   @cf/openai/whisper-large-v3-turbo | $0.0005 per audio minute | 46.63 neurons per audio minute
//   뉴런 단가: $0.011 / 1,000 뉴런 (Workers Paid는 하루 10,000 뉴런 무료분 초과분만 과금)
export const WHISPER_PRICE = { model: "@cf/openai/whisper-large-v3-turbo", neuronsPerMin: 46.63, usdPerMin: 0.0005, checked: "2026-11-19" } as const;

/** 길이(ms) → 예상 뉴런. 길이를 모르면 null (0으로 채우지 않는다). */
export function estimateWhisperNeurons(durationMs: number | null | undefined): number | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.round((durationMs / 60_000) * WHISPER_PRICE.neuronsPerMin);
}

/** 게이트웨이 로그의 model 값은 `@cf/` 접두어가 빠져 올 수 있다 — 둘 다 받는다. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = String(model).trim();
  return MODEL_PRICES[m] ?? MODEL_PRICES[m.startsWith("@cf/") ? m : `@cf/${m}`] ?? null;
}

/**
 * 토큰 기반 추정. 단가표에 없는 모델이거나 토큰을 하나도 모르면 null.
 * 출력 토큰만 모르면(임베딩) 입력만으로 계산한다.
 */
export function estimateCostUsd(model: string | null | undefined, tokensIn: number | null | undefined, tokensOut: number | null | undefined): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const hasIn = typeof tokensIn === "number" && Number.isFinite(tokensIn);
  const hasOut = typeof tokensOut === "number" && Number.isFinite(tokensOut);
  if (!hasIn && !hasOut) return null;
  if (!hasOut && p.outPerM > 0) return null; // 생성 모델인데 출력 토큰을 모르면 추정하지 않는다
  const cost = ((hasIn ? tokensIn! : 0) * p.inPerM + (hasOut ? tokensOut! : 0) * p.outPerM) / 1_000_000;
  return Math.round(cost * 1e9) / 1e9;
}
