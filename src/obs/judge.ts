// S4 M4 — LLM judge (정답 대조) + 규칙 판정표 + 결정적 지표.
// 설계: S4-OBSERVABILITY-EVAL-PLAN.md §6.1·§6.2.
// - judge는 추이·회귀 감지용 추정치다. 절대적인 정답 판정이 아니다 (D7).
// - 점수를 지어내지 않는다 (§C.4): 파싱·호출 실패는 error로 남기고 점수를 만들지 않는다.
// - 결정적 지표(근거 적중·근거 없음 판정 정확도)는 judge 점수와 독립적으로 계산한다.
import { aiGatewayOptions } from "../ai-gateway";
import type { ExpectedSource, ExpectedVerdict, JudgeDimension, JudgeResult, Verdict } from "./types";

// llama-4-scout = src/ask-pipeline.ts LLM_MODEL과 같은 값이지만 judge 모듈은 자기 상수를 둔다.
export const JUDGE_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
// rubric 문구(아래 RUBRIC_* · 프롬프트 규칙)를 바꾸면 +1 한다. 추이 차트 표식에 나온다.
// judge-v2 (2026-11-16): 개선 코멘트(improvement) 필드 추가 — 재귀적 자기개선 근거.
export const JUDGE_VERSION = "judge-v2";
// 통과 기준 (grounded 항목): judge >= 0.7 그리고 verdict ∈ {grounded, partial}. config_json에 남긴다.
export const PASS_THRESHOLD = 0.7;
// O2 결과 (notes/S4-M4-findings.md): workers-types에 response_format(json_object|json_schema)이
// 있어 json_schema를 먼저 쓴다. 라이브 호출로는 확인하지 못했으므로, 호출 자체가 거절되면
// 같은 스키마를 프롬프트로만 지시하는 경로로 1회 다시 부른다. 파서는 두 경로 모두 받는다.
export const JUDGE_JSON_MODE = "json_schema+prompt-fallback";

/** 11단계 척도 (0.1 단위). 값 → 정의. 프롬프트에 그대로 들어간다. */
export const RUBRIC_LEVELS: ReadonlyArray<readonly [number, string]> = [
  [1.0, "진단·근거·조치 모두 정확"],
  [0.9, "사소한 근거 세부 1개 누락"],
  [0.8, "핵심 근거 항목 1개 누락"],
  [0.7, "부정확하거나 부분적"],
  [0.6, "조치가 모호함"],
  [0.5, "부분적으로만 맞음"],
  [0.4, "대부분 누락"],
  [0.3, "대부분 틀림"],
  [0.2, "용어만 맞음"],
  [0.1, "겨우 관련 있음"],
  [0.0, "틀렸거나 무관함"],
];

export function levelLabel(v: number): string {
  const hit = RUBRIC_LEVELS.find(([lv]) => Math.abs(lv - v) < 1e-9);
  return hit ? `${hit[0].toFixed(1)} ${hit[1]}` : v.toFixed(1);
}

/**
 * 11개 값에 없는 점수를 **아래 단계로** 내린다 (0.75 → 0.7, 0.99 → 0.9).
 * 범위 밖·숫자 아님이면 null (호출자는 파싱 실패로 처리한다 — 0점으로 만들지 않는다).
 */
export function snapDown(raw: unknown): { value: number; snapped: boolean } | null {
  const x = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x < -1e-9 || x > 1 + 1e-9) return null;
  const tenths = x * 10;
  const nearest = Math.round(tenths);
  // 부동소수 오차(0.7 → 6.999999)는 정확한 단계로 본다.
  if (Math.abs(tenths - nearest) < 1e-6) return { value: Math.min(10, Math.max(0, nearest)) / 10, snapped: false };
  return { value: Math.min(10, Math.max(0, Math.floor(tenths))) / 10, snapped: true };
}

// ---- 입력 · 프롬프트 ------------------------------------------------------------

export type JudgeEvidence = { title: string; section?: string; snippet?: string };

export type JudgeInput = {
  question: string;
  /** null이면 참조 없는 judge (트레이스 표본 판정): 근거 충실도만 본다. */
  expectedAnswer: string | null;
  expectedSources?: ExpectedSource[];
  answer: string;
  evidence: JudgeEvidence[];
};

const SNIPPET_CHARS = 220;

export function formatEvidence(evidence: JudgeEvidence[]): string {
  if (!evidence.length) return "(채택 근거 없음)";
  return evidence
    .map((e, i) => `${i + 1}. ${e.title}${e.section ? ` › ${e.section}` : ""} › ${(e.snippet || "").replace(/\s+/g, " ").slice(0, SNIPPET_CHARS)}`)
    .join("\n");
}

function formatExpectedSources(src: ExpectedSource[] | undefined): string {
  if (!src || !src.length) return "(지정 없음)";
  return src.map((s) => [s.title_like, s.article_like, s.doc_id ? `doc:${s.doc_id}` : ""].filter(Boolean).join(" › ")).join(" / ");
}

export const JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", enum: RUBRIC_LEVELS.map(([v]) => v) },
    level: { type: "string" },
    dimensions: {
      type: "object",
      properties: {
        diagnosis: { type: "object", properties: { level: { type: "number" }, reason: { type: "string" } }, required: ["level", "reason"] },
        evidence: { type: "object", properties: { level: { type: "number" }, reason: { type: "string" } }, required: ["level", "reason"] },
        fix: { type: "object", properties: { level: { type: "number" }, reason: { type: "string" } }, required: ["level", "reason"] },
      },
      required: ["diagnosis", "evidence", "fix"],
    },
    reasoning: { type: "string" },
    improvement: { type: "string" },
  },
  required: ["score", "level", "dimensions", "reasoning", "improvement"],
} as const;

export function buildJudgeMessages(input: JudgeInput): Array<{ role: string; content: string }> {
  const scale = RUBRIC_LEVELS.map(([v, d]) => `${v.toFixed(1)} = ${d}`).join("\n");
  const refFree = input.expectedAnswer == null;
  const system = [
    "너는 HR 규정 Q&A 답변을 채점하는 평가자다. 한국어로 판단하고 JSON 하나만 출력한다.",
    "세 차원으로 본다:",
    "- diagnosis(진단): 질문에 대한 결론(가능/불가, 해당/비해당)이 맞는가",
    "- evidence(근거): 맞는 규정·조문·수치(일수, 기한)를 들었는가",
    "- fix(조치): 다음에 할 일(신청 경로, 기한, 문의처)이 구체적인가",
    "척도 (0.1 단위 11단계):",
    scale,
    "규칙:",
    "1. score와 각 차원의 level은 위 11개 값 중 하나만 쓴다.",
    "2. 두 단계 사이라면 낮은 쪽을 고른다.",
    "3. 차원별 reason에는 어느 단계에 해당하는지와 그 이유를 쓴다 (예: \"0.8 — 제12조의 '3일 전 신청' 누락\").",
    refFree
      ? "4. 기대 답이 없다. 실제 답이 채택 근거에 없는 내용을 지어냈으면 evidence 차원에서 감점한다 (근거 충실도 중심)."
      : "4. 기대 답에 없는 내용을 실제 답이 지어냈으면 evidence 차원에서 감점한다.",
    "5. improvement: 이 결과를 다음에 더 좋게 하려면 시스템·코드·데이터·프롬프트 중 무엇을 어떻게 바꿔야 하는지, 구체적이고 실행 가능하게 1–3문장으로 적는다. 점수가 이미 높아서 바꿀 게 없으면 '없음 — 현 상태를 유지한다'고 적는다. 채점 사유(reasoning/dimensions)를 반복하지 말고, 바꿀 대상과 방법을 적는다.",
    "   improvement 예: \"검색이 제12조를 못 찾았다 — '연차' 동의어(휴가)를 쿼리 확장에 추가하면 된다\" / \"답이 '근속 2년마다 1일 가산'을 빠뜨렸다 — 시스템 프롬프트에 '가산 조항을 빠뜨리지 말 것'을 명시하면 된다\" / \"청크가 조문을 반으로 잘랐다 — 조문 경계에서 청킹하도록 수정하면 된다\"",
    '출력 형식: {"score": 0.8, "level": "0.8 핵심 근거 항목 1개 누락", "dimensions": {"diagnosis": {"level": 1.0, "reason": "..."}, "evidence": {"level": 0.8, "reason": "..."}, "fix": {"level": 0.9, "reason": "..."}}, "reasoning": "종합: ...", "improvement": "무엇을 — 어떻게 바꾼다"}',
  ].join("\n");
  const user = [
    `질문: ${input.question}`,
    refFree ? "기대 답: (없음 — 참조 없는 판정)" : `기대 답: ${input.expectedAnswer}`,
    `기대 근거: ${formatExpectedSources(input.expectedSources)}`,
    `실제 답: ${input.answer}`,
    "실제 채택 근거:",
    formatEvidence(input.evidence),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---- 파싱 -------------------------------------------------------------------------

/** Workers AI 응답에서 JSON 객체를 꺼낸다. JSON 모드면 response가 이미 객체다. */
export function extractJsonObject(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  if (v && typeof v === "object" && !Array.isArray(v) && "response" in (v as Record<string, unknown>)) {
    v = (v as Record<string, unknown>).response;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== "string") return null;
  const text = v.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type JudgeParse = { ok: true; result: JudgeResult } | { ok: false; error: "judge_parse"; detail: string };

/** 모델 출력 → JudgeResult. score·차원 level을 아래 단계로 내리고, score를 내렸으면 snapped. */
export function parseJudgeOutput(raw: unknown): JudgeParse {
  const obj = extractJsonObject(raw);
  if (!obj) return { ok: false, error: "judge_parse", detail: "no JSON object in response" };
  const score = snapDown(obj.score);
  if (!score) return { ok: false, error: "judge_parse", detail: `score out of range or not a number: ${JSON.stringify(obj.score)}` };
  const dimsRaw = obj.dimensions as Record<string, unknown> | undefined;
  if (!dimsRaw || typeof dimsRaw !== "object") return { ok: false, error: "judge_parse", detail: "dimensions missing" };
  const snapped = score.snapped;
  const dims = {} as JudgeResult["dimensions"];
  for (const name of ["diagnosis", "evidence", "fix"] as const) {
    const d = dimsRaw[name] as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return { ok: false, error: "judge_parse", detail: `dimension ${name} missing` };
    const lv = snapDown(d.level);
    if (!lv) return { ok: false, error: "judge_parse", detail: `dimension ${name} level invalid: ${JSON.stringify(d.level)}` };
    // 차원 level도 아래 단계로 내리지만, judge_snapped는 §6.2대로 score 기준이다.
    const dim: JudgeDimension = { level: lv.value, reason: typeof d.reason === "string" ? d.reason : "" };
    dims[name] = dim;
  }
  return {
    ok: true,
    result: {
      score: score.value,
      level: levelLabel(score.value),
      dimensions: dims,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
      // 개선 코멘트가 없거나 문자열이 아니어도 채점은 깨지지 않는다 ("" 기본값).
      improvement: typeof obj.improvement === "string" ? obj.improvement.trim() : "",
      snapped,
      judgeVersion: JUDGE_VERSION,
    },
  };
}

// ---- 호출 -------------------------------------------------------------------------

export type JudgeOutcome =
  | { ok: true; result: JudgeResult; jsonMode: "json_schema" | "prompt"; attempts: number; usage?: { promptTokens?: number; completionTokens?: number } }
  | { ok: false; error: "judge_parse" | "judge_call"; detail: string; attempts: number };

type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

function usageOf(out: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  const u = (out as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u) return undefined;
  return {
    promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
  };
}

/**
 * §6.2 judge. temperature 0 + 게이트웨이 캐시 허용 (같은 입력이면 같은 판정, 비용 절약).
 * - 1차: response_format json_schema. 호출이 거절되면(JSON 모드 미지원 등) 프롬프트 지시 경로로 바꾼다.
 * - 파싱 실패·범위 밖이면 1회 재시도, 그래도 안 되면 error='judge_parse' (점수를 만들지 않는다).
 */
export async function judgeAnswer(env: { AI: unknown }, input: JudgeInput): Promise<JudgeOutcome> {
  const ai = env.AI as AiLike;
  const messages = buildJudgeMessages(input);
  let mode: "json_schema" | "prompt" = "json_schema";
  let lastDetail = "";
  let lastError: "judge_parse" | "judge_call" = "judge_parse";
  const MAX_ATTEMPTS = 2; // 최초 1회 + 재시도 1회
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let out: unknown;
    try {
      const inputs: Record<string, unknown> = { messages, temperature: 0, max_tokens: 900 };
      if (mode === "json_schema") inputs.response_format = { type: "json_schema", json_schema: JUDGE_JSON_SCHEMA };
      out = await ai.run(JUDGE_MODEL, inputs, aiGatewayOptions({ tag: "eval-judge" }));
    } catch (e) {
      lastError = "judge_call";
      lastDetail = e instanceof Error ? e.message : String(e);
      // JSON 모드가 원인일 수 있으므로 다음 시도는 프롬프트 경로로.
      mode = "prompt";
      continue;
    }
    const parsed = parseJudgeOutput(out);
    if (parsed.ok) return { ok: true, result: parsed.result, jsonMode: mode, attempts: attempt, usage: usageOf(out) };
    lastError = "judge_parse";
    lastDetail = parsed.detail;
  }
  return { ok: false, error: lastError, detail: lastDetail, attempts: MAX_ATTEMPTS };
}

// ---- §6.1 규칙 판정표 ----------------------------------------------------------------

export type SystemStatus = "grounded" | "no_evidence" | "off_topic" | "error";

export type RulePlan =
  /** 규칙으로 통과 — judge·verdict 생략 (judge_skipped='rule'). */
  | { kind: "rule_pass"; judgeSkipped: "rule" }
  /** 규칙으로 실패 — verdict만 실행해 기록 (지어내기 위험). */
  | { kind: "rule_fail_verdict_only"; judgeSkipped: "rule" }
  /** 규칙으로 실패 — judge_score 0.0, verdict 생략. */
  | { kind: "rule_fail_zero"; judgeSkipped: "no_evidence"; judgeScore: 0 }
  /** verdict → judge 둘 다 실행. */
  | { kind: "judge" }
  /** 실행 오류 — 점수를 만들지 않는다. 통과율 분모에서 빠진다. */
  | { kind: "error" };

export function planByRule(expected: ExpectedVerdict, status: SystemStatus): RulePlan {
  if (status === "error") return { kind: "error" };
  if (expected === "ungrounded") {
    return status === "no_evidence" ? { kind: "rule_pass", judgeSkipped: "rule" } : { kind: "rule_fail_verdict_only", judgeSkipped: "rule" };
  }
  return status === "no_evidence" ? { kind: "rule_fail_zero", judgeSkipped: "no_evidence", judgeScore: 0 } : { kind: "judge" };
}

/** grounded 항목의 통과 판정. verdict가 없으면(분류 실패) 통과로 보지 않는다. */
export function decidePass(judgeScore: number | null, verdict: Verdict | null): boolean {
  if (judgeScore == null || verdict == null) return false;
  return judgeScore >= PASS_THRESHOLD - 1e-9 && (verdict === "grounded" || verdict === "partial");
}

// ---- 결정적 지표 (judge와 독립) --------------------------------------------------------

export type KeptSource = { id: string; title: string; section: string; docId?: string };

function norm(s: string | undefined): string {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

function docIdOf(src: KeptSource): string | undefined {
  if (src.docId) return src.docId;
  const m = src.id.match(/^(.*)-chunk-\d+$/);
  return m ? m[1] : undefined;
}

/**
 * 근거 적중: 기대 근거 항목 하나라도, 지정된 조건(doc_id / title_like / article_like)이
 * **모두** 같은 채택 근거 하나에서 맞으면 적중. 기대 근거가 없으면 null (지표 분모에서 빠짐).
 */
export function computeRetrievalHit(expected: ExpectedSource[], kept: KeptSource[]): boolean | null {
  const specs = expected.filter((e) => e && (e.doc_id || e.title_like || e.article_like));
  if (!specs.length) return null;
  return specs.some((e) =>
    kept.some((s) => {
      if (e.doc_id && !(s.id === e.doc_id || docIdOf(s) === e.doc_id)) return false;
      if (e.title_like && !norm(s.title).includes(norm(e.title_like))) return false;
      if (e.article_like && !norm(s.section).includes(norm(e.article_like))) return false;
      return true;
    })
  );
}

/** 근거 없음 판정이 기대와 맞는가: (시스템이 no_evidence) === (기대가 ungrounded). 오류면 null. */
export function noEvidenceCorrect(expected: ExpectedVerdict, status: SystemStatus): boolean | null {
  if (status === "error") return null;
  return (status === "no_evidence") === (expected === "ungrounded");
}
