// 업무 외 질문 판별 (Decision Model, Clef) — 동결 전 다듬기 항목.
// runAsk의 검색 전에 질문이 업무 범위(HR 규정·회사 문서·코칭·업로드 문서)와
// 관련이 있는지 판별한다. 확신이 높을 때만 거른다 (Clef off_topic 확률 ≥ 0.85).
// 경계선·판별 실패는 정상 경로로 보낸다 (fail-open — 오판으로 업무 질문을
// 막지 않는다). 거절된 질문은 공백 큐에 쌓지 않는다 (큐 오염 방지).
// Clef는 기준선 평가에서 라이브 입증됨 (verdict_engine "clef", "clef probe ok").
// 입력 $0.24/M, 출력 무료, 중앙값 ~209ms.
import { aiGatewayOptions } from "../ai-gateway";

export const TOPIC_GUARD_MODEL_CLEF = "@cf/cloudflare/clef";
export const TOPIC_GUARD_FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** 확신 기준: Clef가 off_topic일 확률이 이 값 이상일 때만 거른다. */
export const TOPIC_GUARD_THRESHOLD = 0.85;
/** 거절 답 (고정 문구 — LLM을 부르지 않는다). */
export const TOPIC_GUARD_ANSWER =
  "이 질문은 업무와 관련이 없어 답변할 수 없어요. 인사 규정, 회사 문서, 코칭에 대해 물어봐 주세요.";

export type TopicGuardOutcome = {
  offTopic: boolean; // 확신 높은 업무 외인가
  confidence: number; // Clef P(off_topic) 또는 fallback confidence (0-1)
  engine: "clef" | "llm-fallback";
  reason: string; // "clef p=0.93" / "guard failed, fail-open" 등
};

type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

const TOPIC_QUESTION_ID = "topic";

const TOPIC_CRITERIA = {
  work_related: "질문이 인사 규정, 회사 문서, 코칭, 업로드 문서와 관련이 있다.",
  off_topic: "질문이 업무와 무관하다 (날씨, 스포츠, 연예, 일상 잡담, 일반 상식 등).",
} as const;

function buildTopicClefInput(question: string): unknown {
  const state = [
    "업무 범위: 인사 규정, 회사 문서, 코칭, 업로드 문서에 대한 질문.",
    `질문: ${question}`,
  ].join("\n");
  return {
    model: "clef",
    state,
    questions: {
      [TOPIC_QUESTION_ID]: {
        type: "choice",
        instructions:
          "이 질문이 업무 범위(인사 규정, 회사 문서, 코칭, 업로드 문서)와 관련이 있는지 판단한다. 딱 하나만 고른다.",
        criteria: TOPIC_CRITERIA,
      },
    },
  };
}

/** Clef 응답 → 판별. verdict.ts의 parseClefAnswer와 같은 관대한 읽기. */
function parseTopicClefAnswer(raw: unknown): { offTopic: boolean; confidence: number; reason: string } | null {
  const root = raw as { answers?: Record<string, unknown>; response?: { answers?: Record<string, unknown> } } | null;
  const answers = root?.answers ?? root?.response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const a = answers[TOPIC_QUESTION_ID];
  const asChoice = (v: unknown): "work_related" | "off_topic" | null => {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return s === "work_related" || s === "off_topic" ? s : null;
  };
  // bare string choice — 확률 없이 선택만 온 경우, 선택 자체를 신호로 본다.
  const direct = asChoice(a);
  if (direct) return { offTopic: direct === "off_topic", confidence: 1, reason: `clef choice=${direct}` };
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  let choice: "work_related" | "off_topic" | null = null;
  for (const k of ["choice", "answer", "option", "value", "label"]) {
    choice = asChoice(o[k]);
    if (choice) break;
  }
  const probs = (o.probabilities ?? o.probs) as Record<string, unknown> | undefined;
  let pOff = -1;
  if (probs && typeof probs === "object") {
    for (const [k, p] of Object.entries(probs)) {
      if (asChoice(k) === "off_topic" && typeof p === "number") pOff = p;
    }
  }
  if (choice === "off_topic") {
    const conf = pOff >= 0 ? pOff : 1;
    return { offTopic: conf >= TOPIC_GUARD_THRESHOLD, confidence: conf, reason: `clef p=${conf}` };
  }
  if (choice === "work_related") {
    const conf = pOff >= 0 ? pOff : 0;
    return { offTopic: false, confidence: conf, reason: `clef p=${conf}` };
  }
  // 선택은 없는데 확률표만 있는 경우 — off_topic 확률로 판단한다.
  if (pOff >= 0) return { offTopic: pOff >= TOPIC_GUARD_THRESHOLD, confidence: pOff, reason: `clef p=${pOff}` };
  return null;
}

const TOPIC_JSON_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", enum: ["work_related", "off_topic"] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["topic", "confidence", "reason"],
} as const;

function buildTopicMessages(question: string): Array<{ role: string; content: string }> {
  const system = [
    "너는 질문이 업무 범위와 관련이 있는지 분류한다. 업무 범위는 인사 규정, 회사 문서, 코칭, 업로드 문서다.",
    'JSON 하나만 출력한다: {"topic": "work_related" | "off_topic", "confidence": 0.0-1.0, "reason": "한 문장"}',
    "confidence는 off_topic일 확률이다. 애매하면 confidence를 낮게 준다 (0.5 근처).",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `질문: ${question}` },
  ];
}

function parseTopicLlmAnswer(raw: unknown): { offTopic: boolean; confidence: number; reason: string } | null {
  const text =
    typeof raw === "string"
      ? raw
      : typeof (raw as { response?: unknown })?.response === "string"
        ? (raw as { response: string }).response
        : "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { topic?: unknown; confidence?: unknown; reason?: unknown };
    if (obj.topic !== "work_related" && obj.topic !== "off_topic") return null;
    const conf = typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0;
    return {
      offTopic: obj.topic === "off_topic" && conf >= TOPIC_GUARD_THRESHOLD,
      confidence: conf,
      reason: typeof obj.reason === "string" ? obj.reason : "llm-fallback",
    };
  } catch {
    return null;
  }
}

/**
 * 질문의 업무 관련성을 판별한다. Clef 우선, 실패·파싱 불가 시 llama 폴백.
 * 판별 자체가 실패하면 fail-open (offTopic=false) — 질문을 막지 않는다.
 */
export async function classifyTopic(env: { AI: unknown }, question: string): Promise<TopicGuardOutcome> {
  const ai = env.AI as AiLike;
  try {
    const out = await ai.run(TOPIC_GUARD_MODEL_CLEF, buildTopicClefInput(question), aiGatewayOptions({ tag: "topic-guard" }));
    const parsed = parseTopicClefAnswer(out);
    if (parsed) return { ...parsed, engine: "clef" };
  } catch (e) {
    // Clef 호출 실패 → 폴백으로 (아래). 호출 자체가 막히면 안 된다.
    void e;
  }
  try {
    const out = await ai.run(
      TOPIC_GUARD_FALLBACK_MODEL,
      {
        messages: buildTopicMessages(question),
        temperature: 0,
        max_tokens: 160,
        response_format: { type: "json_schema", json_schema: TOPIC_JSON_SCHEMA },
      },
      aiGatewayOptions({ tag: "topic-guard" }),
    );
    const parsed = parseTopicLlmAnswer(out);
    if (parsed) return { ...parsed, engine: "llm-fallback" };
  } catch (e) {
    void e;
  }
  return { offTopic: false, confidence: 0, engine: "llm-fallback", reason: "guard failed, fail-open" };
}
