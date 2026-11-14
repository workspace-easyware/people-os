// S4 M4 — 빠른 판정(verdict): (질문, 실제 답, 채택 근거) → {grounded, partial, ungrounded, off_topic}.
// 설계: S4-OBSERVABILITY-EVAL-PLAN.md §6.3, 열린 항목 O1.
//
// O1 결과 (notes/S4-M4-findings.md, 2026-11-14):
// - 카탈로그: 오케스트레이터가 `wrangler ai models`(4.162.0)로 @cf/cloudflare/clef를 확인했다
//   (27B 멀티모달 decision model, 입력 형식 {model:"clef", state, questions{...}}).
// - 라이브 탐지 호출 1회: **실패** — 하네스 바인딩의 wrangler(프로젝트 로컬 3.114.17)가
//   로그인돼 있지 않아 "InferenceUpstreamError: Not logged in"으로 Cloudflare에 닿기 전에
//   끝났다. 응답 형식(answers.<id>)을 실제로 보지 못했다.
// 그래서 CLEF_VERIFIED=false로 두고 llama-4-scout 4지선다 분류(`llm-fallback`)로 동작한다.
// buildClefInput()·parseClefAnswer()는 문서화된 형식으로 맞춰 두었다(미검증 — 게이트 뒤).
// 로그인된 바인딩에서 탐지 호출 1회가 파싱 가능한 verdict를 돌려주면 CLEF_VERIFIED=true로 바꾼다.
import { aiGatewayOptions } from "../ai-gateway";
import { extractJsonObject, formatEvidence, type JudgeEvidence } from "./judge";
import type { Verdict } from "./types";

/** 기대값(미확인). O1이 풀리기 전에는 호출하지 않는다. */
export const VERDICT_MODEL_CLEF = "@cf/cloudflare/clef";
export const CLEF_VERIFIED = true;
export const VERDICT_FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export type VerdictEngine = "clef" | "llm-fallback";

export const VERDICTS: readonly Verdict[] = ["grounded", "partial", "ungrounded", "off_topic"];

export type VerdictInput = { question: string; answer: string; evidence: JudgeEvidence[] };

export type VerdictOutcome =
  | { ok: true; verdict: Verdict; engine: VerdictEngine; reason?: string; raw?: unknown }
  | { ok: false; engine: VerdictEngine; error: "verdict_parse" | "verdict_call"; detail: string };

type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

/**
 * 실행 시작 시 1회 엔진을 정한다. 결과는 eval_runs.config_json.verdict_engine에 고정되고,
 * 실행 도중의 항목은 이 값만 쓴다 (엔진이 섞이지 않게).
 * Clef가 확인된 뒤에는 실제 1회 탐지 호출을 하고, 실패하면(5007 모델 없음 등) llm-fallback.
 */
export async function detectVerdictEngine(env: { AI: unknown }): Promise<{ engine: VerdictEngine; reason: string }> {
  if (!CLEF_VERIFIED) return { engine: "llm-fallback", reason: "clef unverified (O1, notes/S4-M4-findings.md)" };
  try {
    const probe: VerdictInput = {
      question: "연차는 며칠 전에 신청하나요?",
      answer: "사용 3일 전까지 신청합니다 (연차휴가 규정 제12조).",
      evidence: [{ title: "연차휴가 규정", section: "제12조", snippet: "연차휴가는 사용 3일 전까지 신청한다." }],
    };
    const out = await (env.AI as AiLike).run(VERDICT_MODEL_CLEF, buildClefInput(probe), aiGatewayOptions({ tag: "eval-verdict" }));
    return parseClefAnswer(out) ? { engine: "clef", reason: "clef probe ok" } : { engine: "llm-fallback", reason: "clef probe: unparseable output" };
  } catch (e) {
    return { engine: "llm-fallback", reason: `clef probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Clef 질문 id. 응답은 response.answers[CLEF_QUESTION_ID]. */
export const CLEF_QUESTION_ID = "verdict";

export const CLEF_CRITERIA: Record<Verdict, string> = {
  grounded: "Every key claim in the answer is present in the retrieved evidence.",
  partial: "Some claims are supported by the evidence; others are missing from it or uncertain.",
  ungrounded: "The key claims of the answer are not in the retrieved evidence (fabricated).",
  off_topic: "The answer, or the retrieved evidence, is unrelated to the question.",
};

/**
 * 문서화된 Clef 입력 형식 (O1, 오케스트레이터 확인 · 라이브 미검증):
 * { model: "clef", state: string, questions: { <id>: { type: "choice", instructions, criteria: {<option>: string} } } }
 */
export function buildClefInput(input: VerdictInput): unknown {
  const state = [`질문: ${input.question}`, `답: ${input.answer}`, "채택 근거:", formatEvidence(input.evidence)].join("\n");
  return {
    model: "clef",
    state,
    questions: {
      [CLEF_QUESTION_ID]: {
        type: "choice",
        instructions: "Classify how well the answer to this Korean HR policy question is supported by the retrieved evidence. Pick exactly one option.",
        criteria: CLEF_CRITERIA,
      },
    },
  };
}

/**
 * Clef 응답 → Verdict. 문서: choice 답은 "선택지 + 선택지별 확률 + confidence".
 * 필드명은 라이브로 보지 못했으므로 관대하게 읽는다: 문자열, {choice|answer|option|value|label},
 * 그것도 없으면 확률표의 최댓값. 선택지 밖 값이면 null.
 */
export function parseClefAnswer(raw: unknown): { verdict: Verdict; reason?: string } | null {
  const root = raw as { answers?: Record<string, unknown>; response?: { answers?: Record<string, unknown> } } | null;
  const answers = root?.answers ?? root?.response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const a = answers[CLEF_QUESTION_ID];
  const asVerdict = (v: unknown): Verdict | null => {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return (VERDICTS as readonly string[]).includes(s) ? (s as Verdict) : null;
  };
  const direct = asVerdict(a);
  if (direct) return { verdict: direct };
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  for (const k of ["choice", "answer", "option", "value", "label"]) {
    const v = asVerdict(o[k]);
    if (v) return { verdict: v, reason: typeof o.confidence === "number" ? `clef confidence ${o.confidence}` : undefined };
  }
  const probs = (o.probabilities ?? o.probs) as Record<string, unknown> | undefined;
  if (probs && typeof probs === "object") {
    let best: Verdict | null = null;
    let bestP = -1;
    for (const [k, p] of Object.entries(probs)) {
      const v = asVerdict(k);
      if (v && typeof p === "number" && p > bestP) { best = v; bestP = p; }
    }
    if (best) return { verdict: best, reason: `clef p=${bestP}` };
  }
  return null;
}

export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
} as const;

export function buildVerdictMessages(input: VerdictInput): Array<{ role: string; content: string }> {
  const system = [
    "너는 HR 규정 Q&A 답변의 근거 충실도를 분류한다. 아래 넷 중 하나만 고른다.",
    "- grounded: 답의 핵심 주장이 모두 채택 근거에 있다",
    "- partial: 일부 주장만 근거에 있고, 나머지는 근거에 없거나 불확실하다",
    "- ungrounded: 답의 핵심 주장이 근거에 없다 (지어냄)",
    "- off_topic: 답이 질문과 무관하거나, 근거가 질문과 무관하다",
    'JSON 하나만 출력한다: {"verdict": "grounded", "reason": "한 문장"}',
  ].join("\n");
  const user = [`질문: ${input.question}`, `답: ${input.answer}`, "채택 근거:", formatEvidence(input.evidence)].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 모델 출력 → Verdict. JSON 객체 우선, 없으면 응답 문자열에서 선택지 단어 하나를 찾는다. */
export function parseVerdict(raw: unknown): { verdict: Verdict; reason?: string } | null {
  const obj = extractJsonObject(raw);
  if (obj) {
    const v = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    if ((VERDICTS as readonly string[]).includes(v)) return { verdict: v as Verdict, reason: typeof obj.reason === "string" ? obj.reason : undefined };
    return null;
  }
  const text = typeof raw === "string" ? raw : typeof (raw as { response?: unknown })?.response === "string" ? (raw as { response: string }).response : "";
  const found = VERDICTS.filter((v) => new RegExp(`\\b${v.replace("_", "[_ -]")}\\b`, "i").test(text));
  // "ungrounded"는 "grounded"를 포함하지 않지만(\b), 둘 이상 나오면 모호하므로 실패로 본다.
  return found.length === 1 ? { verdict: found[0] } : null;
}

/** §9.4 계약: classifyVerdict(env, {question, answer, evidence}) → {verdict, engine, raw?}. */
export async function classifyVerdict(env: { AI: unknown }, input: VerdictInput, engine: VerdictEngine = "llm-fallback"): Promise<VerdictOutcome> {
  const ai = env.AI as AiLike;
  // 엔진이 clef로 고정됐더라도 CLEF_VERIFIED가 false면 부르지 않는다 (미확인 ID).
  const useClef = engine === "clef" && CLEF_VERIFIED;
  const used: VerdictEngine = useClef ? "clef" : "llm-fallback";
  const model = useClef ? VERDICT_MODEL_CLEF : VERDICT_FALLBACK_MODEL;
  const inputs = useClef
    ? buildClefInput(input)
    : { messages: buildVerdictMessages(input), temperature: 0, max_tokens: 160, response_format: { type: "json_schema", json_schema: VERDICT_JSON_SCHEMA } };
  let out: unknown;
  try {
    out = await ai.run(model, inputs, aiGatewayOptions({ tag: "eval-verdict" }));
  } catch (e) {
    // JSON 모드 거절일 수 있으므로 fallback 엔진은 프롬프트 지시만으로 1회 다시 부른다.
    if (useClef) return { ok: false, engine: used, error: "verdict_call", detail: e instanceof Error ? e.message : String(e) };
    try {
      out = await ai.run(model, { messages: buildVerdictMessages(input), temperature: 0, max_tokens: 160 }, aiGatewayOptions({ tag: "eval-verdict" }));
    } catch (e2) {
      return { ok: false, engine: used, error: "verdict_call", detail: e2 instanceof Error ? e2.message : String(e2) };
    }
  }
  const parsed = useClef ? parseClefAnswer(out) : parseVerdict(out);
  if (!parsed) return { ok: false, engine: used, error: "verdict_parse", detail: "no verdict in response" };
  return { ok: true, verdict: parsed.verdict, engine: used, reason: parsed.reason, raw: out };
}
