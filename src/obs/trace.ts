// S4 M2 — 트레이스 수집 (TraceSink 구현, 설계서 §7.1 · §9.2).
//
// runAsk(M6-α)가 끝날 때 hooks.traceSink.record(env, trace, ctx)를 1회 부른다.
// hooks.traceSink가 있으면 runAsk는 ask_events INSERT를 하지 않으므로, 이 sink가
// ask_events 행까지 책임진다. 순서:
//   ① ask_events 9개 컬럼 INSERT — S4 이전 /api/ask와 같은 SQL·같은 값 형식.
//      이것만 성공하면 /api/feedback·/api/gaps·C7 처리 과정 패널은 지금처럼 동작한다.
//   ② obs 스키마(0013)가 없으면 여기서 끝 (= "trace sink unavailable → 오늘과 같은 기록").
//   ③ D1 batch(원자적): UPDATE ask_events 트레이스 컬럼 + trace_spans + trace_retrievals.
//   ④ R2 traces/<eventId>.json (프롬프트·원 응답 원문) — ctx가 있으면 waitUntil로 응답 뒤에.
// 어느 단계가 실패해도 record()는 throw하지 않는다 (질문 응답을 망가뜨리지 않는다, §7.1).
//
// 'unresolved' 결정 (M6-α 인계 메모, notes/S4-M2-findings.md §5):
// types.ts의 RetrievalCandidate.outcome enum에는 'unresolved'가 없다(M1 계약, 수정 금지).
// 이 sink는 더 넓은 TraceRetrievalInput(outcome에 'unresolved' 포함)을 받아 그대로
// trace_retrievals.outcome에 쓴다(컬럼은 CHECK 없는 TEXT). 지금 runAsk는 unresolved
// 후보를 목록에서 빼고 gate span attrs.unresolved에 개수만 남기므로, 그 경우에는
// chunk id를 지어내지 않고 상세 API가 attrs.unresolved를 unresolvedCount로 보여 준다.
import { runBatch, obsSchemaReady, parseJson, newId } from "./db";
import type { AskTrace, ObsEnv, RetrievalCandidate, TraceSink, TraceSpan } from "./types";

export const TRACE_R2_PREFIX = "traces/";
export const TRACE_JSON_VERSION = 1;

/** sink가 받아 저장하는 근거 후보 결과 — M1 enum + 'unresolved'(M2 결정). */
export type TraceRetrievalOutcome = RetrievalCandidate["outcome"] | "unresolved";
export type TraceRetrievalInput = Omit<RetrievalCandidate, "outcome"> & { outcome: TraceRetrievalOutcome };

/** 모든 outcome 값 (UI 범례·필터 순서). */
export const RETRIEVAL_OUTCOMES: TraceRetrievalOutcome[] = ["kept", "below_floor", "keyword_gate", "dedup", "over_max", "unresolved"];

export function traceR2Key(eventId: string): string {
  return `${TRACE_R2_PREFIX}${eventId}.json`;
}

/** 테스트용 실패 주입 (수용 기준 ②). 운영 코드는 넘기지 않는다. */
export type TraceSinkOptions = {
  inject?: { failBase?: boolean; failBatch?: boolean; failR2?: boolean };
  log?: (msg: string) => void;
};

type SinkEnv = Pick<ObsEnv, "DB"> & Partial<Pick<ObsEnv, "FILES">>;

/** R2에 남기는 원문 JSON 형식 (상세 화면의 프롬프트/응답 블록 원천). */
export type TraceBlob = {
  version: number;
  eventId: string;
  recordedAt: string;
  origin: AskTrace["origin"];
  evalRunId?: string;
  sessionId: string;
  question: string;
  searchQuestion: string;
  answer: string;
  status: AskTrace["status"];
  engine: string;
  searchEngine: string;
  model: string;
  promptVersion: string;
  knowledgeEpoch: number;
  usage?: AskTrace["usage"];
  aigLogIds: string[];
  prompt?: AskTrace["prompt"];
  rawResponse?: unknown;
  sources: AskTrace["sources"];
};

export function buildTraceBlob(trace: AskTrace, recordedAt = new Date().toISOString()): TraceBlob {
  return {
    version: TRACE_JSON_VERSION,
    eventId: trace.eventId,
    recordedAt,
    origin: trace.origin,
    ...(trace.evalRunId ? { evalRunId: trace.evalRunId } : {}),
    sessionId: trace.sessionId,
    question: trace.question,
    searchQuestion: trace.searchQuestion,
    answer: trace.answer,
    status: trace.status,
    engine: trace.engine,
    searchEngine: trace.searchEngine,
    model: trace.model,
    promptVersion: trace.promptVersion,
    knowledgeEpoch: trace.knowledgeEpoch,
    ...(trace.usage ? { usage: trace.usage } : {}),
    aigLogIds: trace.aigLogIds || [],
    ...(trace.prompt ? { prompt: trace.prompt } : {}),
    ...(trace.rawResponse !== undefined ? { rawResponse: trace.rawResponse } : {}),
    sources: trace.sources,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function intOrNull(n: unknown): number | null {
  const v = finiteOrNull(n);
  return v == null ? null : Math.round(v);
}

/** 단계 이름 순서 — 같은 시작 오프셋일 때 파이프라인 순서로 정렬한다. */
const SPAN_ORDER: Record<string, number> = { cache: 0, session: 1, router: 1, topic_guard: 1, embed: 2, vectorize: 3, gate: 4, d1_merge: 5, rerank: 5, llm: 6, session_save: 7 };

export function sortSpans(spans: TraceSpan[]): TraceSpan[] {
  return [...spans].sort((a, b) => a.startMs - b.startMs || (SPAN_ORDER[a.name] ?? 99) - (SPAN_ORDER[b.name] ?? 99));
}

/** 9개 컬럼 INSERT — runAsk의 traceSink 미사용 경로와 같은 SQL·같은 값 형식. */
export function baseInsertStatement(db: D1Database, trace: AskTrace): D1PreparedStatement {
  const grounded = trace.status === "grounded";
  return db
    .prepare(
      // 0021: user_id = 질문한 사용자 (익명·평가는 NULL).
      "INSERT INTO ask_events (id, session_id, question, answer, source_ids, grounded, engine, search_engine, timings_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      trace.eventId,
      trace.sessionId,
      trace.question,
      trace.answer,
      JSON.stringify(trace.sources.map((s) => s.id)),
      grounded ? 1 : 0,
      trace.engine,
      trace.searchEngine,
      JSON.stringify(trace.timings),
      trace.userId ?? null,
    );
}

/** ③ 단계의 문장들 (UPDATE + spans + retrievals). r2Key가 null이면 trace_r2_key를 비운다. */
export function traceStatements(db: D1Database, trace: AskTrace, r2Key: string | null): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const usage = trace.usage || {};
  stmts.push(
    db
      .prepare(
        `UPDATE ask_events SET origin = ?, status = ?, gap_id = ?, eval_run_id = ?, prompt_version = ?, model = ?,
           prompt_tokens = ?, completion_tokens = ?, latency_ms = ?, knowledge_epoch = ?, trace_r2_key = ?, aig_log_ids = ?
         WHERE id = ?`,
      )
      .bind(
        trace.origin,
        trace.status,
        trace.gapId ?? null,
        trace.evalRunId ?? null,
        trace.promptVersion || null,
        trace.model || null,
        // 토큰을 모르면 NULL — 0으로 채우지 않는다 (§7.3).
        intOrNull(usage.promptTokens),
        intOrNull(usage.completionTokens),
        intOrNull(trace.timings?.total),
        intOrNull(trace.knowledgeEpoch),
        r2Key,
        JSON.stringify(Array.isArray(trace.aigLogIds) ? trace.aigLogIds.filter((x) => typeof x === "string" && x) : []),
        trace.eventId,
      ),
  );
  const spanSql = "INSERT OR REPLACE INTO trace_spans (id, event_id, name, product, start_ms, duration_ms, ok, attrs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  sortSpans(trace.spans || []).forEach((s, i) => {
    stmts.push(
      db.prepare(spanSql).bind(
        `${trace.eventId}:s${i}`,
        trace.eventId,
        s.name,
        s.product ?? null,
        Math.max(0, intOrNull(s.startMs) ?? 0),
        Math.max(0, intOrNull(s.durationMs) ?? 0),
        s.ok ? 1 : 0,
        JSON.stringify(s.attrs ?? {}),
      ),
    );
  });
  const retSql =
    "INSERT OR REPLACE INTO trace_retrievals (id, event_id, chunk_id, doc_id, title, article, stage, rank, vector_score, keyword_score, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  ((trace.retrieval || []) as TraceRetrievalInput[]).forEach((r, i) => {
    stmts.push(
      db.prepare(retSql).bind(
        `${trace.eventId}:r${i}`,
        trace.eventId,
        String(r.chunkId),
        r.docId ?? null,
        r.title ?? null,
        r.article ?? null,
        r.stage,
        intOrNull(r.rank) ?? i + 1,
        finiteOrNull(r.vectorScore),
        finiteOrNull(r.keywordScore),
        RETRIEVAL_OUTCOMES.includes(r.outcome) ? r.outcome : "unresolved",
      ),
    );
  });
  return stmts;
}

export type RecordResult = {
  base: boolean; // ask_events 9개 컬럼
  schema: boolean; // obs 스키마 있음
  trace: boolean; // UPDATE + spans + retrievals
  r2: "written" | "deferred" | "skipped" | "failed";
  spans: number;
  retrievals: number;
  errors: string[];
};

/**
 * 트레이스 1건 기록. 절대 throw하지 않는다.
 * ctx가 있으면 R2 쓰기는 waitUntil로 미루고 r2='deferred'를 돌려준다.
 */
export async function recordTrace(env: SinkEnv, trace: AskTrace, ctx?: ExecutionContext, opts: TraceSinkOptions = {}): Promise<RecordResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const out: RecordResult = { base: false, schema: false, trace: false, r2: "skipped", spans: 0, retrievals: 0, errors: [] };
  try {
    if (!env?.DB) throw new Error("DB binding missing");
    // ①
    try {
      if (opts.inject?.failBase) throw new Error("injected: base insert failure");
      await baseInsertStatement(env.DB, trace).run();
      out.base = true;
    } catch (e) {
      out.errors.push(`base: ${errMsg(e)}`);
      log(`[trace] ask_events insert failed: ${errMsg(e)}`);
      return out; // 부모 행이 없으면 자식 행을 만들지 않는다
    }
    // ②
    out.schema = await obsSchemaReady(env.DB);
    if (!out.schema) {
      log("[trace] obs schema not migrated (0013) — ask_events recorded with base columns only");
      return out;
    }
    // ③
    const r2Key = env.FILES ? traceR2Key(trace.eventId) : null;
    try {
      if (opts.inject?.failBatch) throw new Error("injected: trace batch failure");
      const stmts = traceStatements(env.DB, trace, r2Key);
      await runBatch(env.DB, stmts);
      out.trace = true;
      out.spans = (trace.spans || []).length;
      out.retrievals = (trace.retrieval || []).length;
    } catch (e) {
      out.errors.push(`trace: ${errMsg(e)}`);
      log(`[trace] trace batch failed: ${errMsg(e)}`);
      // 기본 행은 남아 있다 — 트레이스 컬럼만 비어 있는 S4 이전 형식 행이 된다.
      // R2는 계속 시도한다(원문이 있으면 나중에 다시 붙일 수 있다). 단 trace_r2_key는 비어 있다.
    }
    // ④
    if (r2Key && env.FILES) {
      const files = env.FILES;
      const write = async () => {
        try {
          if (opts.inject?.failR2) throw new Error("injected: r2 failure");
          await files.put(r2Key, JSON.stringify(buildTraceBlob(trace)), {
            httpMetadata: { contentType: "application/json; charset=utf-8" },
            customMetadata: { eventId: trace.eventId, origin: trace.origin },
          });
          return true;
        } catch (e) {
          log(`[trace] R2 put failed (${r2Key}): ${errMsg(e)}`);
          // 원문이 없는데 키를 가리키지 않게 비운다 (상세 API는 키가 없으면 "원문 없음").
          if (out.trace) {
            try { await env.DB.prepare("UPDATE ask_events SET trace_r2_key = NULL WHERE id = ? AND trace_r2_key = ?").bind(trace.eventId, r2Key).run(); }
            catch { /* 무시 */ }
          }
          return false;
        }
      };
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(write());
        out.r2 = "deferred";
      } else {
        out.r2 = (await write()) ? "written" : "failed";
        if (out.r2 === "failed") out.errors.push("r2: put failed");
      }
    }
  } catch (e) {
    out.errors.push(`record: ${errMsg(e)}`);
    log(`[trace] record failed: ${errMsg(e)}`);
  }
  return out;
}

/**
 * 메타데이터 생성 트레이스 (2026-11-16) — AI가 들어가는 모든 곳을 관측 대상으로.
 * 트리 빌더의 LLM 호출(전사본 주제 구간 + 구조화 요약) 직후, 성공/실패 모두 부른다.
 * ask_events에 origin='metadata' 행 1개를 남기고, R2 원문은 간단한 JSON
 * (문서 id, operation, 세그먼트 수, digest 유무, 에러)이다. 가시성 규칙은
 * 질문 트레이스와 같다 (목록·상세 마스킹 공개, R2 원문은 관리자만).
 * 절대 throw하지 않는다 (트리 빌드는 fail-open).
 */
export type MetadataTraceInput = {
  docId: string;
  operation: string; // 예: "build-transcript-tree"
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  ok: boolean;
  segments?: number;
  digest?: boolean;
  error?: string;
};

export async function recordMetadataTrace(env: SinkEnv, input: MetadataTraceInput): Promise<void> {
  try {
    const eventId = newId("ev");
    const summary = input.ok
      ? `segments: ${input.segments ?? 0}, digest: ${input.digest ? "있음" : "없음"}`
      : `error: ${(input.error || "unknown").slice(0, 200)}`;
    const trace: AskTrace = {
      eventId,
      sessionId: `metadata:${input.docId}`,
      origin: "metadata",
      question: `[metadata] ${input.operation} doc:${input.docId}`,
      searchQuestion: `[metadata] ${input.operation} doc:${input.docId}`,
      answer: summary,
      status: input.ok ? "grounded" : "error",
      engine: "tree",
      searchEngine: "tree",
      promptVersion: "tree-v1",
      model: input.model,
      knowledgeEpoch: 0,
      timings: { total: Math.max(0, Math.round(input.latencyMs)) },
      spans: [{ name: "llm", product: "workers-ai", startMs: 0, durationMs: Math.max(0, Math.round(input.latencyMs)), ok: input.ok }],
      retrieval: [],
      sources: [],
      usage: {
        ...(typeof input.promptTokens === "number" ? { promptTokens: input.promptTokens } : {}),
        ...(typeof input.completionTokens === "number" ? { completionTokens: input.completionTokens } : {}),
      },
      aigLogIds: [],
      rawResponse: {
        operation: input.operation,
        docId: input.docId,
        segments: input.segments ?? null,
        digest: input.digest ?? null,
        error: input.error ?? null,
      },
    };
    await recordTrace(env, trace);
  } catch (e) {
    console.log(`[trace] recordMetadataTrace failed: ${errMsg(e)}`);
  }
}

/**
 * M1 TraceSink 구현. `createTraceSink()` 또는 `createTraceSink(env)` — env 인자는
 * 호환용으로만 받고 쓰지 않는다(record가 매번 env를 받는다: isolate 간 공유 안전).
 */
export function createTraceSink(_env?: unknown, opts: TraceSinkOptions = {}): TraceSink & { last?: RecordResult } {
  const sink: TraceSink & { last?: RecordResult } = {
    async record(env: unknown, trace: AskTrace, ctx?: ExecutionContext): Promise<void> {
      sink.last = await recordTrace(env as SinkEnv, trace, ctx, opts);
    },
  };
  return sink;
}

// ---- 점수 (trace_scores) -------------------------------------------------------

export type ScoreInput = {
  eventId: string;
  name: "user_feedback" | "judge_score" | "verdict" | "human_score" | "retrieval_hit" | string;
  value?: number | null;
  label?: string | null;
  source: "user" | "judge" | "verdict" | "human" | "rule" | string;
  evalRunId?: string | null;
  comment?: string | null;
};

/** trace_scores 1행. 스키마가 없거나 실패하면 null (throw 안 함). */
export async function recordScore(env: Pick<ObsEnv, "DB">, s: ScoreInput): Promise<string | null> {
  try {
    if (!(await obsSchemaReady(env.DB))) return null;
    const id = newId("scr");
    await env.DB.prepare(
      "INSERT INTO trace_scores (id, event_id, name, value, label, source, eval_run_id, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, s.eventId, s.name, finiteOrNull(s.value), s.label ?? null, s.source, s.evalRunId ?? null, s.comment ? String(s.comment).slice(0, 500) : null)
      .run();
    return id;
  } catch (e) {
    console.log(`[trace] recordScore failed: ${errMsg(e)}`);
    return null;
  }
}

/**
 * 👍/👎 미러링 (§2 "ask_events.feedback → trace_scores(name='user_feedback')").
 * /api/feedback(M6 소유)가 UPDATE 뒤에 부르면 된다. 같은 이벤트의 이전 피드백 점수는 지운다
 * (사용자가 👍→👎로 바꾸면 최신 1개만 남는다).
 */
export async function mirrorFeedbackScore(env: Pick<ObsEnv, "DB">, eventId: string, rating: "up" | "down", comment?: string | null): Promise<string | null> {
  try {
    if (!(await obsSchemaReady(env.DB))) return null;
    await env.DB.prepare("DELETE FROM trace_scores WHERE event_id = ? AND name = 'user_feedback'").bind(eventId).run();
  } catch { /* 무시 — 아래 INSERT가 다시 시도 */ }
  return recordScore(env, { eventId, name: "user_feedback", value: rating === "up" ? 1 : 0, label: rating, source: "user", comment: comment ?? null });
}

/** R2 원문 읽기. 없거나 실패하면 null. */
export async function readTraceBlob(env: Partial<Pick<ObsEnv, "FILES">>, key: string | null | undefined): Promise<TraceBlob | null> {
  if (!key || !env.FILES) return null;
  try {
    const obj = await env.FILES.get(key);
    if (!obj) return null;
    return parseJson<TraceBlob | null>(await obj.text(), null);
  } catch {
    return null;
  }
}
