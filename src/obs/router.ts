// 의도 라우터 (Decision Model, Clef-omni) — 2026-11-16.
// 질문이 어느 풀에 속하는지 분류한다: HR 규정(공용) / 개인 업무(개인) / 업무 외.
// HR 창은 공용만, 개인 창은 개인만 검색하므로, 라우터는 "잘못된 창" 질문을
// 안내 문구로 돌려보내는 가드다. 판단 모델은 선택에는 강하지만 생성은 못
// 하므로, 라우터는 분류만 하고 답은 만들지 않는다.
// 실패(호출 오류·파싱 실패) 시 null을 돌려 호출부가 fail-open으로 정상
// 진행한다 — 라우터 장애가 검색을 막지 않게 한다.
import { aiGatewayOptions } from "../ai-gateway";

export const ROUTER_MODEL_CLEF_OMNI = "@cf/cloudflare/clef-omni";

/** 돌려보내기 최소 확신도. 라우터 확신도가 이 값 미만이면 현재 풀에서
 * 검색한다 (fail-open) — 잘못된 창으로 돌려보내는 것보다 현재 풀에서
 * 찾는 게 낫다. 텍스트만으로는 "어느 풀에 답이 있는지"를 확신할 수
 * 없기 때문이다 (프로젝트명 같은 개인 콘텐츠는 텍스트에서 안 보인다).
 * 실측: 올바른 personal 판별이 0.7372로 나와 0.8 기준을 못 넘겨
 * 돌려보내기가 안 되던 것을 확인하고 0.7로 낮췄다 (2026-11-16).
 * off_topic 차단 기준(0.85)과는 별개다. */
export const ROUTER_REDIRECT_MIN_CONFIDENCE = 0.7;

export type Intent = "hr_regulation" | "personal" | "off_topic";

export type IntentOutcome = {
  intent: Intent;
  confidence: number; // 선택된 의도의 확률 (0-1, 없으면 1)
  engine: "clef-omni";
  reason: string;
};

/** HR 창에서 개인 업무 질문이 왔을 때의 안내 (근거 없음, 공백 큐에 안 쌓음). */
export const PERSONAL_REDIRECT_ANSWER =
  "이 질문은 개인 업무와 관련이 있어 보여요. 개인 전사본·업로드 문서는 '개인 업무 검색' 메뉴에서 물어봐 주세요.";
/** 개인 창에서 HR 규정 질문이 왔을 때의 안내. */
export const HR_REDIRECT_ANSWER =
  "이 질문은 HR 규정과 관련이 있어 보여요. HR 규정 검색에서 물어봐 주세요.";

const ROUTER_QUESTION_ID = "intent";

const ROUTER_CRITERIA = {
  hr_regulation: "질문이 HR 규정, 회사 정책, 사내 암묵지(인사팀 답변)에 대한 것이다.",
  personal: "질문이 개인의 회의·강의 전사본, 개인이 업로드한 문서, 개인 업무 기록에 대한 것이다.",
  off_topic: "질문이 업무와 무관하다 (날씨, 스포츠, 연예, 일상 잡담, 일반 상식 등).",
} as const;

function buildRouterClefInput(question: string): unknown {
  const state = [
    "구분: HR 규정(공용 풀) / 개인 업무(개인 풀) / 업무 외.",
    `질문: ${question}`,
  ].join("\n");
  return {
    model: "clef-omni",
    state,
    questions: {
      [ROUTER_QUESTION_ID]: {
        type: "choice",
        instructions:
          "이 질문이 HR 규정, 개인 업무, 업무 외 중 어디에 속하는지 판단한다. 딱 하나만 고른다.",
        criteria: ROUTER_CRITERIA,
      },
    },
  };
}

type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

function asIntent(v: unknown): Intent | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s === "hr_regulation" || s === "personal" || s === "off_topic" ? (s as Intent) : null;
}

/** Clef-omni 응답 → 의도. verdict.ts/topic-guard.ts의 parseClefAnswer와 같은 관대한 읽기. */
function parseRouterAnswer(raw: unknown): IntentOutcome | null {
  const root = raw as { answers?: Record<string, unknown>; response?: { answers?: Record<string, unknown> } } | null;
  const answers = root?.answers ?? root?.response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const a = answers[ROUTER_QUESTION_ID];
  const direct = asIntent(a);
  if (direct) return { intent: direct, confidence: 1, engine: "clef-omni", reason: `clef-omni choice=${direct}` };
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  let intent: Intent | null = null;
  for (const k of ["choice", "answer", "option", "value", "label"]) {
    intent = asIntent(o[k]);
    if (intent) break;
  }
  const probs = (o.probabilities ?? o.probs) as Record<string, unknown> | undefined;
  let pIntent = -1;
  if (probs && typeof probs === "object" && intent) {
    for (const [k, p] of Object.entries(probs)) {
      if (asIntent(k) === intent && typeof p === "number") pIntent = p;
    }
  }
  if (intent) {
    const conf = pIntent >= 0 ? pIntent : 1;
    return { intent, confidence: conf, engine: "clef-omni", reason: `clef-omni p=${conf}` };
  }
  // 선택은 없는데 확률표만 있는 경우 — 최댓값을 택한다.
  if (probs && typeof probs === "object") {
    let best: Intent | null = null;
    let bestP = -1;
    for (const [k, p] of Object.entries(probs)) {
      const v = asIntent(k);
      if (v && typeof p === "number" && p > bestP) { best = v; bestP = p; }
    }
    if (best) return { intent: best, confidence: bestP, engine: "clef-omni", reason: `clef-omni p=${bestP}` };
  }
  return null;
}

/**
 * 질문의 의도를 분류한다. 실패(호출 오류·파싱 불가) 시 null — 호출부는
 * fail-open으로 정상 진행한다 (라우터가 검색을 막지 않는다).
 */
export async function classifyIntent(env: { AI: unknown }, question: string): Promise<IntentOutcome | null> {
  const ai = env.AI as AiLike;
  try {
    const out = await ai.run(ROUTER_MODEL_CLEF_OMNI, buildRouterClefInput(question), aiGatewayOptions({ tag: "intent-router" }));
    return parseRouterAnswer(out);
  } catch {
    return null;
  }
}
