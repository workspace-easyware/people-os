// S4 관측·평가 공용 계약 (M1 소유). 모든 obs 모듈이 import한다.
// 계약을 바꿔야 하면 이 파일의 변경 요청으로 올린다 (S4 설계서 §9.0).

// ---- §7.1 수집 계약 ---------------------------------------------------------

export type TraceSpan = {
  name: "cache" | "session" | "topic_guard" | "embed" | "vectorize" | "gate" | "d1_merge" | "llm" | "session_save";
  product: "kv" | "durable-objects" | "workers-ai" | "vectorize" | "d1";
  startMs: number;
  durationMs: number;
  ok: boolean;
  attrs?: Record<string, unknown>;
};

export type RetrievalCandidate = {
  chunkId: string;
  docId?: string;
  title?: string;
  article?: string;
  stage: "vectorize" | "d1";
  rank: number;
  vectorScore?: number;
  keywordScore?: number;
  outcome: "kept" | "below_floor" | "keyword_gate" | "dedup" | "over_max";
};

export type AskTrace = {
  eventId: string;
  sessionId: string;
  origin: "user" | "eval";
  evalRunId?: string;
  question: string;
  searchQuestion: string;
  answer: string;
  status: "grounded" | "no_evidence" | "off_topic" | "error";
  gapId?: string;
  engine: string;
  searchEngine: string;
  promptVersion: string;
  model: string;
  knowledgeEpoch: number;
  timings: Record<string, number>;
  spans: TraceSpan[];
  retrieval: RetrievalCandidate[];
  sources: Array<{ id: string; title: string; section: string; score: number; kind?: string }>;
  prompt?: { messages: Array<{ role: string; content: string }> };
  rawResponse?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number };
  aigLogIds: string[];
};

export interface TraceSink {
  record(env: unknown, trace: AskTrace, ctx?: ExecutionContext): Promise<void>;
}

// ---- §9.1 평가·개선 타입 (0014 스키마와 1:1) ---------------------------------

/** 판정 4지선다 (verdict 모델 출력). */
export type Verdict = "grounded" | "partial" | "ungrounded" | "off_topic";

export type ExpectedVerdict = "grounded" | "ungrounded";

/** eval_items.expected_sources 한 항목 — 근거 적중 판정용. */
export type ExpectedSource = { doc_id?: string; title_like?: string; article_like?: string };

export type EvalItem = {
  id: string;
  datasetId: string;
  question: string;
  expectedAnswer: string | null;
  expectedSources: ExpectedSource[];
  expectedVerdict: ExpectedVerdict;
  tags: string[];
  source: "seed" | "gap" | "trace" | "manual";
  originRef: string | null;
  prereq: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EvalRunStatus = "queued" | "running" | "done" | "partial" | "failed" | "aborted" | "skipped";

export type EvalRun = {
  id: string;
  datasetId: string;
  datasetVersion: number;
  trigger: "manual" | "cron" | "regression";
  status: EvalRunStatus;
  config: Record<string, unknown>;
  configHash: string | null;
  itemsTotal: number;
  itemsDone: number;
  itemsError: number;
  passCount: number | null;
  passRate: number | null;
  avgJudge: number | null;
  retrievalHitRate: number | null;
  noEvidenceAccuracy: number | null;
  verdictDist: Partial<Record<Verdict, number>> | null;
  costEstimateUsd: number | null;
  baseRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
};

/** judge 한 차원 (diagnosis | evidence | fix). level은 0.1 단위 11단계 값. */
export type JudgeDimension = { level: number; reason: string };

export type JudgeResult = {
  /** 0.0~1.0, 0.1 단위. 파싱 실패 시 이 객체 대신 error를 쓴다(점수를 만들지 않는다). */
  score: number;
  level: string;
  dimensions: { diagnosis: JudgeDimension; evidence: JudgeDimension; fix: JudgeDimension };
  reasoning: string;
  /** score가 11개 값에 없어 아래 단계로 내려 맞췄는가. */
  snapped: boolean;
  judgeVersion?: string;
};

export type EvalResult = {
  id: string;
  runId: string;
  itemId: string;
  eventId: string | null;
  answer: string | null;
  grounded: boolean | null;
  retrievedIds: string[];
  retrievalHit: boolean | null;
  judgeScore: number | null;
  judgeDims: JudgeResult["dimensions"] | null;
  judgeReason: string | null;
  judgeSnapped: boolean;
  /** 'rule' | 'no_evidence' | ... — judge를 건너뛴 이유. */
  judgeSkipped: string | null;
  verdict: Verdict | null;
  /** 'clef' | 'llm-fallback' | 'rule' */
  verdictEngine: string | null;
  passed: boolean | null;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
};

export type GapKind = "no_evidence" | "downvote" | "low_score" | "hallucination_risk" | "regression";

/** 통합 공백 목록 한 행 (/api/obs/gaps). key = `<kind>:<ref>`. */
export type GapRow = {
  key: string;
  kind: GapKind;
  question: string;
  status: string;
  count: number;
  gapId?: string;
  eventId?: string;
  resultId?: string;
  itemId?: string;
  docId?: string;
  lastSeenAt?: string;
  actions?: ImprovementAction[];
};

export type ImprovementActionType = "publish_tacit" | "fix_document" | "adjust_prompt" | "promote" | "dismiss";

export type ImprovementAction = {
  id: string;
  gapKey: string;
  kind: GapKind;
  action: ImprovementActionType;
  status: "applied" | "verified" | "regressed" | "dismissed";
  question: string | null;
  gapId: string | null;
  eventId: string | null;
  resultId: string | null;
  itemId: string | null;
  docId: string | null;
  promptVersionId: string | null;
  note: string | null;
  createdAt: string;
  verifiedRunId: string | null;
  verifiedAt: string | null;
};

// ---- 환경·큐 메시지 ---------------------------------------------------------

/** obs 모듈이 쓰는 바인딩. index.ts의 Env는 이를 포함한다(구조적 타이핑). */
export type ObsEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  AI: Ai;
  PIPELINE: Queue<unknown>;
  ADMIN_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  AIG_LOGS_TOKEN?: string;
};

export type EvalItemMessage = {
  type: "eval-item";
  version: 1;
  runId: string;
  itemId: string;
  enqueuedAt: string;
};
