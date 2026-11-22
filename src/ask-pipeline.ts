// S4 M6-α: /api/ask 파이프라인 본문 (캐시 조회 → 세션 문맥 → 근거 검색 →
// 답 생성 → 세션 저장 → 감사 기록 → 캐시 저장)을 runAsk()로 뺐다.
// - 동작은 바꾸지 않는다. opts 기본값 = S4 이전 /api/ask 동작.
// - 평가 실행기(M4)는 HTTP·Turnstile·레이트 리밋 없이 이 함수를 부른다
//   (origin:'eval', recordGap/readCache/writeCache/persistSession:false).
// - 단계마다 span을, 근거 후보마다 채택·탈락 사유를 모아 AskTrace로 만든다.
//   hooks.traceSink(M2)가 있으면 sink가 ask_events까지 기록하고, 없으면
//   지금처럼 ask_events 9개 컬럼만 INSERT한다.
// 근거 검색 helper(resolveSources, keywordGate, ensureVectorSeeded,
// d1TextSources)와 공백 큐·epoch helper도 index.ts에서 그대로 옮겼다.
// index.ts의 다른 경로(health, 게시 검증, 피드백 등)는 여기서 import한다.
import { docOwnerClause, docOwnerClauseForPool, localSearchChunks, poolForDoc, poolForKind, questionTokens, RAG_POOL_LABEL, SHARED_USER_ID, uid, vectorPoolFilter } from "./lib";
import type { RagPool, RagViewer } from "./lib";
import { aiGatewayOptions, aiGatewayOptionsWithMeta } from "./ai-gateway";
import type { AskDecision, AskTrace, RetrievalCandidate, TraceSink, TraceSpan, WhatIfSource } from "./obs/types";
// S4 M6-β: 활성 system 프롬프트는 M4 prompts.ts가 D1 prompt_versions에서 읽는다
// (테이블·행이 없으면 하드코딩 v1 폴백 — 질문 응답이 깨지지 않는다).
import { getActivePrompt } from "./obs/prompts";
import { classifyTopic, TOPIC_GUARD_ANSWER, TOPIC_GUARD_THRESHOLD, type TopicGuardOutcome } from "./obs/topic-guard";
// 판단 모델 병행 (2026-11-16): 의도 라우터 + 근거 재순위 (둘 다 Clef-omni).
import { classifyIntent, HR_REDIRECT_ANSWER, PERSONAL_REDIRECT_ANSWER, ROUTER_REDIRECT_MIN_CONFIDENCE } from "./obs/router";
import { rerankSources } from "./obs/rerank";
import { logEvent } from "./obs/log";

// runAsk와 helper가 쓰는 바인딩. index.ts의 Env는 이를 포함한다(구조적 타이핑).
export type AskEnv = {
  DB: D1Database;
  CACHE: KVNamespace;
  VECTOR: VectorizeIndex;
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
};

// llama-3-8b-instruct와 llama-3.1-8b-instruct는 2026-05-30에 deprecated 되어
// Workers AI 바인딩에서 5028을 반환한다. (REST API에서는 3.1-8b가 되지만 바인딩에서는 안 된다.)
// [2026-11-16] Qwen3-30b-a3b-fp8로 전환 — 골든셋 평가 6/6, 평균 judge 0.9 (Scout 기준선 6/6, 0.85),
// 코칭 리플렉션 유효 JSON 3/3/3, Scout 대비 ~3.7배 빠름, ~2.5-5배 저렴.
export const LLM_MODEL = "@cf/qwen/qwen3.8-27b";
// 임베딩은 bge-m3 (1024차원, 다국어, Vectorize 인덱스 people-os-index-m3).
// bge-base-en-v1.5(768차원, 영어용)는 한국어 질문을 구분하지 못해 근거 있음
// 질문과 근거 없음 질문의 코사인 유사도가 0.81~0.83으로 겹쳤다 (2026-11-13
// Chrome 확인: "연차 3일" 0.83/0.82/0.81, "출산 전후 재택" 0.82/0.82/0.81).
// 그래서 하한만으로는 근거를 가릴 수 없어 bge-m3으로 교체한다 (C5 Phase 2).
export const EMBED_MODEL = "@cf/baai/bge-m3";
// RAG 근거 하한 (C5, Baryon AX): Vectorize 코사인 유사도가 이 값 미만인
// 매치는 근거가 없는 것으로 본다. bge-base-en 시절에는 근거 있음/없음
// 질문이 둘 다 0.81~0.83으로 몰려 하한만으로 가릴 수 없었다 (2026-11-13
// Chrome 확인). bge-m3 교체 + 아래 키워드 게이트가 1차 판별자이고,
// 이 하한은 2차 안전망이다. Chrome에서 보고되는 실제 bge-m3 점수 분포로
// 다시 보정한다.
export const SCORE_FLOOR = 0.55;
// 키워드 게이트 하한 (C5 Phase 2): Vectorize 상위 매치가 D1 키워드 검색
// (localSearchChunks)에서도 이 점수 이상 겹쳐야 근거로 인정한다.
// "연차 3일"은 연차 15/근태 7/출장 1, "출장비"는 출장 8, "출산 전후 재택"은
// 전원 0이라 2가 적정하다 (로컬 검증, 2026-11-13).
export const KEYWORD_GATE_MIN = 2;
// Vectorize 시딩 상태 키 (C5 Phase 2 lazy 시딩, D1 meta 테이블).
export const VECTOR_INDEX_NAME = "people-os-index-m3";
export const VECTOR_SEED_KEY = "vector_seeded:bge-m3:people-os-index-m3";
export const VECTOR_SEED_ERROR_KEY = "vector_seed_error:bge-m3:people-os-index-m3";
export const EMBED_DIMS = 1024;
// 지식 공백 큐 (C5-b) — 지식 epoch 키.
export const KNOWLEDGE_EPOCH_KEY = "knowledge_epoch";
// 근거 최대 개수 (회수 튜닝: Vectorize + D1 병합 상한).
const MAX_SOURCES = 5;

// ---- system 프롬프트 ----
// 원문(v1)과 폴백은 src/obs/prompts.ts(M4)에 있다. migrations/0014 prompt_versions v1과 바이트 동일.
export type PromptVersion = { id: string; version: number; body: string };

// opts.promptVersionId 처리 (평가 실행의 프롬프트 A/B). 활성 버전과 같으면
// 그대로, 다르면 prompt_versions(0014)에서 읽는다. 못 찾으면 던진다 —
// 다른 프롬프트로 조용히 바꿔 돌리면 평가 결과가 거짓이 된다.
async function resolvePrompt(env: AskEnv, promptVersionId?: string): Promise<PromptVersion> {
  const active = await getActivePrompt(env, "ask-system");
  if (!promptVersionId || promptVersionId === active.id) return active;
  const row = await env.DB.prepare("SELECT id, version, body FROM prompt_versions WHERE id = ? AND name = 'ask-system'").bind(promptVersionId)
    .first<{ id: string; version: number; body: string }>();
  if (!row) throw new Error(`prompt version not found: ${promptVersionId}`);
  return { id: row.id, version: row.version, body: row.body };
}

// Workers AI가 주는 답은 {response: "..."} 상자 안에 있다. response가 문자열이
// 아닐 때도 있고, JSON 답은 ```json 펜스로 감싸져 오는 경우가 있어 통째로
// JSON.parse하면 실패한다. 문자열로 바꾸고 펜스를 벗긴 뒤 첫 {부터 마지막 }까지만 파싱한다.
// [2026-11-18 모델 교체 2차] qwen3.8-27b 같은 추론 모델은 OpenAI chat.completion 형식
// ({choices:[{message:{content, reasoning}}]})으로 답한다. content만 답으로 쓰고
// reasoning(message 안이든 최상위든)은 버린다. content가 비면 ""를 돌려 호출처의
// 빈 응답 처리(폴백/에러)로 보낸다 — 봉투 전체를 답으로 내지 않는다.
export function responseText(out: unknown): string {
  if (typeof out === "string") return out;
  const choices = (out as { choices?: unknown } | null)?.choices;
  if (Array.isArray(choices)) {
    const msg = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
    return stripThink(contentText(msg?.content));
  }
  const res = (out as { response?: unknown } | null)?.response;
  if (typeof res === "string") return res;
  return JSON.stringify(res ?? out);
}

// content는 보통 문자열이지만 [{type:"text", text}] 배열일 수도 있다. 그 밖은 "".
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  }
  return "";
}

// content 안에 추론이 <think>…</think>로 섞여 오는 경우도 제거한다 (닫는 태그만 남은 경우 포함).
function stripThink(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/g, "");
  const close = t.indexOf("</think>");
  if (close >= 0) t = t.slice(close + "</think>".length);
  const open = t.indexOf("<think>"); // 닫히지 않은 추론(토큰 한도로 잘림)은 답이 아니다
  if (open >= 0) t = t.slice(0, open);
  return t.trim();
}

export type Source = { id: string; title: string; section: string; snippet: string; score: number; kind?: "policy" | "tacit" | "transcript"; pool: RagPool; author?: string; publishedAt?: string; sectionPath?: string; nodeSummary?: string; nodeId?: string; docId?: string };

type Match = { id: string; score: number; metadata?: Record<string, unknown> };

// ---- 트리 메타데이터: 근거 풍부화 (2026-11-16) ----------------------------------
// doc_nodes는 검색기가 아니라 청크에 붙는 메타데이터다. 적중한 청크의 node_id로
// 부모 노드를 조회해 섹션 경로·요약을 근거에 덧붙인다.
// - 섹션 경로: 루트 제외, 조상 제목을 " › "로 연결 (예: "제3장 휴가 › 제12조 연차휴가").
// - 노드가 루트 자체면 경로는 "" (chunk.article을 그대로 쓴다).
// - 소유자 스코핑: doc_nodes에 owner_id를 복제하지 않고 documents JOIN +
//   docOwnerClauseForPool로만 스코핑한다 (소유자 정보의 출처를 하나로 둔다).

export type NodeInfo = { path: string; summary: string | null };

export async function sectionPathForNode(
  env: AskEnv,
  docId: string,
  nodeId: string,
  viewer: RagViewer,
  pool: RagPool,
): Promise<NodeInfo> {
  const scope = docOwnerClauseForPool(viewer, "d", pool);
  const rows = await env.DB.prepare(
    `SELECT n.id, n.parent_id, n.title, n.summary, n.depth FROM doc_nodes n JOIN documents d ON d.id = n.doc_id WHERE n.doc_id = ? AND ${scope.clause} ORDER BY n.ord`,
  ).bind(docId, ...scope.params)
    .all<{ id: string; parent_id: string | null; title: string; summary: string | null; depth: number }>();
  const list = rows.results || [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  if (!node) return { path: "", summary: null };
  const titles: string[] = [];
  let cur: { id: string; parent_id: string | null; title: string; summary: string | null; depth: number } | undefined = node;
  let summary: string | null = node.summary;
  while (cur) {
    if (cur.depth > 0) titles.unshift(cur.title);
    if (!summary && cur.summary) summary = cur.summary;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return { path: titles.join(" › "), summary };
}

/** 여러 chunk의 node_id로 섹션 경로·요약을 한 번에 조회한다 (node_id → 정보). */
export async function enrichNodeInfo(
  env: AskEnv,
  chunks: Array<{ docId: string; nodeId: string | null }>,
  viewer: RagViewer,
  pool: RagPool,
): Promise<Map<string, NodeInfo>> {
  const out = new Map<string, NodeInfo>();
  const byDoc = new Map<string, string[]>();
  for (const c of chunks) {
    if (!c.nodeId) continue;
    const arr = byDoc.get(c.docId) ?? [];
    if (!arr.includes(c.nodeId)) arr.push(c.nodeId);
    byDoc.set(c.docId, arr);
  }
  for (const [docId, nodeIds] of byDoc) {
    for (const nodeId of nodeIds) {
      out.set(nodeId, await sectionPathForNode(env, docId, nodeId, viewer, pool));
    }
  }
  return out;
}

// Vectorize 매치를 조문 단위 근거로 바꾼다 (C5).
// - 입력 매치는 runAsk에서 이미 풀 필터(vectorPoolFilter)가 적용된
//   Vectorize 결과라서, 여기서 별도 소유자 검사는 하지 않는다 (방어 깊이:
//   격리는 조회 시점에 필터로 강제하고, 이 함수는 근거 변환만 맡는다).
// - chunk id(새 색인)면 D1 chunks에서 직접 읽는다.
// - policy id(재시딩 전 구 색인)면 그 정책의 조문 중 질문과 키워드가 가장
//   겹치는 조문 1개를 쓴다. chunks가 없으면 정책 본문 앞 220자로 폴백.
// - 같은 doc_id가 두 번 나오면(구 정책 벡터 + 신 chunk 벡터가 둘 다 매치)
//   score가 높은 쪽 하나만 남긴다.
// S4: outcomes를 넘기면 매치 id마다 kept / dedup(같은 문서의 더 높은 점수에
// 밀림) / unresolved(D1·메타데이터 어디서도 못 찾음)를 채운다. 결과는 같다.
export async function resolveSources(
  env: AskEnv,
  question: string,
  matches: Match[],
  outcomes?: Map<string, "kept" | "dedup" | "unresolved">,
  pool: RagPool = "shared",
  viewer: RagViewer = null,
): Promise<Source[]> {
  const byDoc = new Map<string, Source>();
  const produced = new Map<string, Source>();
  for (const m of matches) {
    // digest 벡터(`${docId}-digest`)는 문서 단위 길잡이다. 원본 청크가 근거가
    // 되게 해당 문서에서 질문과 가장 겹치는 chunk 1개를 근거로 쓴다.
    // digest가 없으면(문서 삭제 등) unresolved로 떨어진다.
    if (m.id.endsWith("-digest")) {
      const docId = m.id.slice(0, -"-digest".length);
      const docRows = await env.DB.prepare("SELECT id, doc_id, article, text, ord, node_id FROM chunks WHERE doc_id = ? ORDER BY ord").bind(docId)
        .all<{ id: string; doc_id: string; article: string; text: string; ord: number; node_id: string | null }>();
      const list = docRows.results || [];
      if (list.length) {
        const doc = await env.DB.prepare("SELECT title, kind, owner_id FROM documents WHERE id = ?").bind(docId)
          .first<{ title: string; kind: string; owner_id: string | null }>();
        const scored = localSearchChunks(question, list.map((ch) => ({ ...ch, title: doc?.title ?? docId })));
        const best = scored.length ? scored[0] : { ...list[0], score: 0 };
        const bestNodeId = (best as { node_id?: string | null }).node_id ?? list.find((c) => c.id === best.id)?.node_id ?? null;
        const src: Source = {
          id: best.id, title: doc?.title ?? docId, section: best.article, snippet: best.text,
          score: m.score, kind: doc?.kind === "transcript" ? "transcript" : doc?.kind === "tacit" ? "tacit" : "policy",
          pool: doc ? poolForDoc(doc.kind, doc.owner_id) : "shared", docId,
          nodeId: bestNodeId ?? undefined,
        };
        produced.set(m.id, src);
        const prev = byDoc.get(docId);
        if (!prev || prev.score < m.score) byDoc.set(docId, src);
      }
      continue;
    }
    const chunk = await env.DB.prepare("SELECT id, doc_id, article, text, node_id FROM chunks WHERE id = ?").bind(m.id)
      .first<{ id: string; doc_id: string; article: string; text: string; node_id: string | null }>();
    if (chunk) {
      // 제목·종류: 정책이면 policies에서, 암묵지 문서(kind='tacit')면
      // documents에서 읽는다. 암묵지는 출처 배지용 author·게시일도 채운다.
      const policy = await env.DB.prepare("SELECT title FROM policies WHERE id = ?").bind(chunk.doc_id).first<{ title: string }>();
      let title = policy?.title;
      let kind: "policy" | "tacit" | "transcript" = "policy";
      let pool: RagPool = "shared";
      let author: string | undefined;
      let publishedAt: string | undefined;
      if (!title) {
        const doc = await env.DB.prepare("SELECT title, kind, owner_id, author, created_at FROM documents WHERE id = ?").bind(chunk.doc_id)
          .first<{ title: string; kind: string; owner_id: string | null; author: string | null; created_at: string }>();
        if (doc) {
          title = doc.title;
          if (doc.kind === "tacit") { kind = "tacit"; author = doc.author || "인사팀"; publishedAt = doc.created_at.slice(0, 10); }
          else if (doc.kind === "transcript") { kind = "transcript"; }
          pool = poolForDoc(doc.kind, doc.owner_id);
        }
      }
      const src: Source = { id: chunk.id, title: title ?? chunk.doc_id, section: chunk.article, snippet: chunk.text, score: m.score, kind, pool, author, publishedAt, nodeId: chunk.node_id ?? undefined, docId: chunk.doc_id };
      produced.set(m.id, src);
      const prev = byDoc.get(chunk.doc_id);
      if (!prev || prev.score < m.score) byDoc.set(chunk.doc_id, src);
      continue;
    }
    const policy = await env.DB.prepare("SELECT id, title, section, body FROM policies WHERE id = ?").bind(m.id)
      .first<{ id: string; title: string; section: string; body: string }>();
    if (policy) {
      const rows = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE doc_id = ? ORDER BY ord").bind(policy.id)
        .all<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
      const list = rows.results || [];
      if (list.length) {
        const scored = localSearchChunks(question, list.map((ch) => ({ ...ch, title: policy.title })));
        const best = scored.length ? scored[0] : { ...list[0], score: 0, snippet: list[0].text };
        const src: Source = { id: best.id, title: policy.title, section: best.article, snippet: best.text, score: m.score, kind: "policy", pool: "shared" };
        produced.set(m.id, src);
        const prev = byDoc.get(policy.id);
        if (!prev || prev.score < m.score) byDoc.set(policy.id, src);
      } else {
        const src: Source = { id: policy.id, title: policy.title, section: policy.section, snippet: policy.body.slice(0, 220), score: m.score, kind: "policy", pool: "shared" };
        produced.set(m.id, src);
        const prev = byDoc.get(policy.id);
        if (!prev || prev.score < m.score) byDoc.set(policy.id, src);
      }
      continue;
    }
    // 알 수 없는 id — 메타데이터가 있으면 그대로 쓴다.
    // 단, 개인 풀에서는 이 폴백을 끈다 (2026-11-16): D1에 없는 chunk는
    // 근거에서 제외한다. 고아 벡터(재색인 잔재)의 메타데이터 snippet이
    // 개인 근거로 새는 것을 막기 위함이다. 공용 풀은 그대로 둔다.
    const meta = (m.metadata || {}) as { title?: string; section?: string; snippet?: string; kind?: string; user_id?: string };
    if (meta.snippet && pool !== "personal") {
      const metaKind = meta.kind;
      const kind: "policy" | "tacit" | "transcript" = metaKind === "tacit" ? "tacit" : metaKind === "transcript" ? "transcript" : "policy";
      // 메타데이터의 user_id가 있으면 소유자 기준으로 풀을 정한다 (개인 문서가 "공용"으로 보이지 않게).
      const src: Source = { id: m.id, title: meta.title || m.id, section: meta.section || "", snippet: meta.snippet, score: m.score, kind, pool: poolForDoc(metaKind, meta.user_id && meta.user_id !== SHARED_USER_ID ? meta.user_id : null) };
      produced.set(m.id, src);
      const prev = byDoc.get(m.id);
      if (!prev || prev.score < m.score) byDoc.set(m.id, src);
    }
  }
  if (outcomes) {
    const keptSet = new Set(byDoc.values());
    for (const m of matches) {
      const src = produced.get(m.id);
      outcomes.set(m.id, !src ? "unresolved" : keptSet.has(src) ? "kept" : "dedup");
    }
  }
  // 근거 풍부화 (2026-11-16): 적중한 청크의 node_id로 부모 노드 제목·요약을 붙인다.
  // 실패하면 조용히 넘어간다 (풍부화 없이도 근거는 동작한다).
  const kept = [...byDoc.values()].sort((a, b) => b.score - a.score);
  try {
    const infos = await enrichNodeInfo(env, kept.map((s) => ({ docId: s.docId ?? "", nodeId: s.nodeId ?? null })), viewer, pool);
    for (const s of kept) {
      if (!s.nodeId) continue;
      const info = infos.get(s.nodeId);
      if (!info) continue;
      if (info.path) s.sectionPath = info.path;
      if (info.summary) s.nodeSummary = info.summary;
    }
  } catch { /* 풍부화 실패는 무시 */ }
  return kept;
}

// Vectorize 시딩 (C5 Phase 2): bge-m3 1024차원 새 인덱스 people-os-index-m3.
// ADMIN_SECRET이 없어 /api/seed-vectors를 부를 수 없으므로, Worker가 첫
// 사용 때 D1 chunks를 bge-m3으로 임베딩해 직접 upsert한다 (lazy 시딩).
// D1 meta 테이블에 결과를 남겨 한 번만 시딩하고, 실패하면 다음번에 재시도한다.
// 임베딩·upsert를 각각 1회 배치 호출로 묶어 첫 사용 지연을 줄인다.
// upsert는 같은 id에 멱등이라 동시 실행이 겹쳐도 안전하다.
// 이 함수는 절대 던지지 않는다 — 실패하면 {seeded:false, error}를 돌려준다.
export async function ensureVectorSeeded(env: AskEnv, opts?: { force?: boolean }): Promise<{ seeded: boolean; dims?: number; upserted?: number; total?: number; error?: string }> {
  try {
    if (!opts?.force) {
      const flag = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(VECTOR_SEED_KEY).first<{ value: string }>();
      if (flag) {
        try {
          const parsed = JSON.parse(flag.value) as { dims?: number; upserted?: number };
          return { seeded: true, dims: parsed.dims, upserted: parsed.upserted };
        } catch { return { seeded: true }; }
      }
    }
    const rows = await env.DB.prepare(
      "SELECT c.id, c.doc_id, c.article, c.text, p.title FROM chunks c JOIN policies p ON p.id = c.doc_id ORDER BY c.doc_id, c.ord"
    ).all<{ id: string; doc_id: string; article: string; text: string; title: string }>();
    const list = rows.results || [];
    if (!list.length) return { seeded: false, error: "no chunks in D1" };
    const texts = list.map((ch) => `${ch.title} ${ch.article} ${ch.text}`);
    const emb = await env.AI.run(EMBED_MODEL, { text: texts }, aiGatewayOptions({ skipCache: true, tag: "embed" })) as { data: number[][] | number[] };
    const data = emb.data;
    if (!Array.isArray(data) || data.length !== texts.length || !Array.isArray(data[0])) {
      return { seeded: false, error: "unexpected embedding response shape" };
    }
    const dims = (data[0] as number[]).length;
    if (dims !== EMBED_DIMS) {
      return { seeded: false, error: `embedding dims ${dims} != index dims ${EMBED_DIMS}` };
    }
    // 정책 chunk는 전부 공용이라 user_id에 공용 센티넬 "shared"를 넣는다
    // (개인별 RAG 격리: Vectorize 조회는 user_id $in ["shared", 본인 id]로 묶는다).
    const vectors = list.map((ch, i) => ({ id: ch.id, values: data[i] as number[], metadata: { title: ch.title, section: ch.article, snippet: ch.text.slice(0, 220), user_id: SHARED_USER_ID } }));
    await env.VECTOR.upsert(vectors);
    const result = { seeded: true, dims, upserted: list.length, total: list.length, at: new Date().toISOString() };
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(VECTOR_SEED_KEY, JSON.stringify(result)).run();
    await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(VECTOR_SEED_ERROR_KEY).run();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .bind(VECTOR_SEED_ERROR_KEY, JSON.stringify({ error: msg, at: new Date().toISOString() })).run();
    } catch { /* meta 기록 실패는 무시 */ }
    return { seeded: false, error: msg };
  }
}

// 키워드 게이트 (C5 Phase 2): Vectorize 코사인 점수만으로는 한국어 근거를
// 가릴 수 없다 (bge-base-en: 근거 있음 0.81~0.83 / 근거 없음 0.81~0.82로 겹침).
// 그래서 Vectorize 상위 매치가 D1 키워드 검색(localSearchChunks)에서도
// 겹침이 있는지 확인한다. 겹침 점수가 KEYWORD_GATE_MIN 미만이면 근거에서 뺀다.
// - 입력 매치는 runAsk에서 이미 viewer 필터가 적용된 Vectorize 결과라서,
//   여기서 별도 소유자 검사는 하지 않는다 (방어 깊이: 격리는 조회 시점에 필터로 강제).
// - chunk id면 해당 chunk, policy id(구 색인)면 그 정책의 조문 중 최고 점수로 본다.
// - D1에서 chunk를 못 찾는 id(알 수 없는 id)는 그대로 둔다 (fail-open).
// - 질문에서 겹침 신호가 되는 토큰이 하나도 없으면 게이트를 건너뛴다
//   ("쉴 수 있나요?"처럼 조사·어미만 있는 질문은 Vectorize에 맡긴다).
// S4: scores를 넘기면 계산한 키워드 점수를 매치 id별로 남긴다. 결과는 같다.
export async function keywordGate(
  env: AskEnv,
  question: string,
  matches: Match[],
  scores?: Map<string, { keywordScore: number; docId?: string }>
): Promise<Match[]> {
  if (questionTokens(question).length === 0) return matches;
  const kept: Match[] = [];
  for (const m of matches) {
    const chunk = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE id = ?").bind(m.id)
      .first<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
    let chunks: Array<{ id: string; doc_id: string; article: string; text: string; ord: number }> = [];
    let title = m.id;
    let docId: string | undefined;
    if (chunk) {
      chunks = [chunk];
      docId = chunk.doc_id;
      // 제목은 정책이면 policies에서, 암묵지 문서면 documents에서 읽는다.
      // 제목이 doc_id로 남으면 키워드 겹침 점수(title +3)가 안 먹힌다.
      const p = await env.DB.prepare("SELECT title FROM policies WHERE id = ?").bind(chunk.doc_id).first<{ title: string }>();
      if (p) title = p.title;
      else {
        const d = await env.DB.prepare("SELECT title FROM documents WHERE id = ?").bind(chunk.doc_id).first<{ title: string }>();
        title = d?.title ?? chunk.doc_id;
      }
    } else {
      const policy = await env.DB.prepare("SELECT id, title FROM policies WHERE id = ?").bind(m.id).first<{ id: string; title: string }>();
      if (!policy) { kept.push(m); continue; } // 알 수 없는 id — fail-open
      title = policy.title;
      docId = policy.id;
      const rows = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE doc_id = ?").bind(policy.id)
        .all<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
      chunks = rows.results || [];
      if (!chunks.length) { kept.push(m); continue; }
    }
    const scored = localSearchChunks(question, chunks.map((ch) => ({ ...ch, title })));
    const best = scored.length ? Math.max(...scored.map((s) => s.score)) : 0;
    scores?.set(m.id, { keywordScore: best, docId });
    if (best >= KEYWORD_GATE_MIN) kept.push(m);
  }
  return kept;
}

// 질문 정규화: trim + 연속 공백 정리. 한글이라 소문자 변환은 하지 않는다.
function normalizeGapQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

// 공백 큐 기록: 같은 질문의 open 행이 있으면 count+1·asked_at 갱신,
// 없으면 새로 삽입한다. D1 실패 시 던지므로 호출부에서 try/catch로 감싼다.
// 0021: userId = 질문한 사용자 (익명·평가는 null). 같은 질문의 open 행에 합쳐질 때는
// 처음 질문자를 유지하고, 비어 있을 때만 이번 질문자로 채운다.
export async function recordGap(env: AskEnv, question: string, source: "no-evidence" | "downvote", userId: string | null = null): Promise<{ id: string; count: number }> {
  const q = normalizeGapQuestion(question);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT id, count FROM knowledge_gaps WHERE question = ? AND status = 'open'").bind(q).first<{ id: string; count: number }>();
  if (row) {
    const next = (row.count || 1) + 1;
    await env.DB.prepare("UPDATE knowledge_gaps SET count = ?, asked_at = ?, user_id = COALESCE(user_id, ?) WHERE id = ?").bind(next, now, userId, row.id).run();
    return { id: row.id, count: next };
  }
  const id = uid("gap");
  await env.DB.prepare("INSERT INTO knowledge_gaps (id, question, asked_at, status, doc_id, count, source, user_id) VALUES (?, ?, ?, 'open', NULL, 1, ?, ?)")
    .bind(id, q, now, source, userId).run();
  return { id, count: 1 };
}

// 지식 epoch (C5-b 캐시 무효화): 암묵지 게시 때 +1한다. ask 캐시 키에
// epoch를 넣어, 게시 후에는 게시 전 캐시 답이 나오지 않게 한다.
// meta 테이블 사용법은 Vectorize lazy 시딩 플래그와 같다.
export async function getKnowledgeEpoch(env: AskEnv): Promise<number> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(KNOWLEDGE_EPOCH_KEY).first<{ value: string }>();
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch { return 0; }
}

// D1 텍스트 폴백 (C5-b): chunks 전부를 키워드 검색해 근거 Source[]로 바꾼다.
// minScore 이상만 남긴다 (0이면 localSearch의 score>0 필터만 적용).
// LEFT JOIN으로 암묵지 chunk(doc_id가 policies에 없음)도 찾고,
// 암묵지 chunk는 출처 배지용 kind/author/게시일도 함께 싣는다.
// 풀 분리 (2026-11-16): pool 인자로 D1 범위를 정한다. shared면 공용 문서만
// (owner_id IS NULL), personal이면 본인 소유 문서만. 기본값은 viewer의
// 기존 범위(공용+본인) — 호출부가 pool을 넘기지 않으면 예전 동작 유지.
export async function d1TextSources(env: AskEnv, question: string, minScore = 0, viewer: RagViewer | null = null, pool?: RagPool): Promise<Source[]> {
  const scope = pool ? docOwnerClauseForPool(viewer, "d", pool) : docOwnerClause(viewer, "d");
  const rows = await env.DB.prepare(
    `SELECT c.id, c.doc_id, c.node_id, c.article, c.text, c.ord, COALESCE(p.title, d.title, c.doc_id) AS title, d.kind AS doc_kind, d.owner_id AS doc_owner, d.author AS doc_author, d.created_at AS doc_created FROM chunks c LEFT JOIN policies p ON p.id = c.doc_id LEFT JOIN documents d ON d.id = c.doc_id WHERE ${scope.clause}`
  ).bind(...scope.params).all<{ id: string; doc_id: string; node_id: string | null; article: string; text: string; ord: number; title: string; doc_kind: string | null; doc_owner: string | null; doc_author: string | null; doc_created: string | null }>();
  const list = rows.results || [];
  const found = localSearchChunks(question, list);
  const byId = new Map(list.map((r) => [r.id, r]));
  const out = found
    .filter((f) => f.score >= minScore)
    .map((f) => {
      const row = byId.get(f.id);
      const docKind = row?.doc_kind;
      const tacit = docKind === "tacit";
      const kind: "policy" | "tacit" | "transcript" = tacit ? "tacit" : docKind === "transcript" ? "transcript" : "policy";
      return { id: f.id, title: f.title, section: f.article, snippet: f.snippet, score: f.score, kind, pool: poolForDoc(docKind, row?.doc_owner), author: tacit ? (row?.doc_author || "인사팀") : undefined, publishedAt: tacit ? row?.doc_created?.slice(0, 10) : undefined, nodeId: row?.node_id ?? null, docId: row?.doc_id ?? "" } as Source;
    });
  // 근거 풍부화 (2026-11-16): D1 키워드 폴백 근거에도 resolveSources와 같은
  // 섹션 경로·노드 요약을 붙인다. 실패하면 조용히 넘어간다.
  try {
    const infos = await enrichNodeInfo(env, out.map((s) => ({ docId: s.docId ?? "", nodeId: s.nodeId ?? null })), viewer, pool ?? "shared");
    for (const s of out) {
      if (!s.nodeId) continue;
      const info = infos.get(s.nodeId);
      if (!info) continue;
      if (info.path) s.sectionPath = info.path;
      if (info.summary) s.nodeSummary = info.summary;
    }
  } catch { /* 풍부화 실패는 무시 */ }
  return out;
}

// ---- runAsk ----

export type AskInput = {
  question: string; // 이미 trim·검증된 질문
  sessionId: string;
  // 처리 시간 측정 시작 시각. /api/ask는 Turnstile·레이트 리밋 전에 잰
  // 시각을 넘긴다 (timings.total이 S4 이전과 같은 구간을 재도록).
  startedAt?: number;
};

export type AskOptions = {
  origin?: "user" | "eval" | "personal" | "metadata"; // 기본 'user'
  evalRunId?: string;
  recordGap?: boolean; // 근거 없음 → knowledge_gaps (기본 true, 평가는 false)
  readCache?: boolean; // KV/D1 답 캐시 조회 (기본 true, force면 false)
  writeCache?: boolean; // 답 캐시 저장 (기본 true)
  persistSession?: boolean; // DO/D1 세션에 대화 저장 (기본 true)
  gatewaySkipCache?: boolean; // AI Gateway 캐시 건너뛰기 — LLM 호출만 (기본 false, force면 true)
  promptVersionId?: string; // 기본: 활성 버전
  viewer?: RagViewer | null; // RAG 조회자 (기본 null = 익명/평가, 공용만 조회)
  // 검색 풀 (2026-11-16, HR/개인 창 분리). 기본 "shared" — HR 규정 검색창은
  // 공용만 본다. 개인 창은 "personal"을 넘긴다. 두 풀을 섞어 검색하지 않는다.
  pool?: RagPool;
  // 관점 선택 (2026-11-16): hr_admin이 개인 창에서 다른 사용자를 고르면 그 사용자의
  // 개인 풀을 검색한다. 없으면 viewer. DO 세션 키·캐시 키·트레이스 user_id는
  // 계속 viewer(실제 요청자)를 쓴다 — 검색 범위만 바뀐다.
  scopeViewer?: RagViewer | null;
};

export type AskHooks = {
  traceSink?: TraceSink;
  ctx?: ExecutionContext; // traceSink.record에 넘긴다 (R2 쓰기 waitUntil용)
};

export type AskResponse = {
  ok: true;
  sessionId: string;
  question: string;
  answer: string;
  sources: Source[];
  grounded: boolean;
  engine: string;
  searchEngine: string;
  sessionVia: string;
  cached: false;
  eventId: string;
  timings: Record<string, number>;
  // XAI 보완 (2026-11-19) — 모두 선택 필드. 사용자 경로(HR·개인 창)에서만 채운다.
  decisiveSourceId?: string; // 근거 재순위가 고른 1순위 근거 id (재순위를 안 거쳤으면 없음)
  decision?: AskDecision; // 라우터 전환·토픽 가드 차단 사유 + 신뢰도 (일반 답이면 없음)
};

// ---- XAI 보완: What-If ("이 답이 달라지려면") ----
// 답과 분리 (2026-11-19): 답은 What-If를 기다리지 않고 바로 나간다. 화면이 답을 그린 뒤
// GET /api/ask/:eventId/whatif 를 따로 불러 아래 함수들로 한두 문장을 받는다.
// 입력은 트레이스(R2)에 남겨 둔 whatIfContext(근거 3개 × 180자)와 ask_events의 질문·답이다.
// 실패·빈 응답·시간 초과면 whatIf 없음 (fail-open) — 답에는 영향이 없다.
// 로컬 실측 (2026-11-19): 3.8s · 11.0s 성공, 1건은 20s 초과 → 상한 15s.
const WHAT_IF_TIMEOUT_MS = 15000;
const WHAT_IF_MAX_CHARS = 240;

export function buildWhatIfMessages(question: string, answer: string, sources: WhatIfSource[], pool: RagPool): Array<{ role: string; content: string }> {
  const kindWord = pool === "personal" ? "문서" : "규정";
  if (!sources.length) {
    return [
      { role: "system", content: `너는 사내 Q&A 답변을 설명하는 검토자다. 이 질문은 등록된 ${kindWord}에서 근거를 찾지 못해 답하지 못했다. 어떤 근거(어떤 ${kindWord}·조항·내용)가 등록되어 있으면 답할 수 있는지 한국어 한두 문장(150자 이내)으로만 쓴다. 근거가 있다고 단정하지 않는다. 머리말 없이 문장만 쓴다.` },
      { role: "user", content: `질문: ${question.slice(0, 300)}` },
    ];
  }
  const ctx = sources.slice(0, 3).map((s) => `[${s.title} › ${s.section}] ${s.snippet.slice(0, 180)}`).join("\n");
  return [
    { role: "system", content: `너는 사내 Q&A 답변을 설명하는 검토자다. 질문·근거·답을 보고, 이 답의 결론이 달라지려면 어떤 조건이나 근거가 필요한지 한국어 한두 문장(150자 이내)으로만 쓴다. "~라면 결론이 달라질 수 있습니다" 형태로 쓰고, 근거에 없는 사실을 단정하지 않는다. 머리말 없이 문장만 쓴다.` },
    { role: "user", content: `질문: ${question.slice(0, 300)}\n근거:\n${ctx}\n답: ${answer.slice(0, 500)}` },
  ];
}

export function cleanWhatIf(text: string): string | undefined {
  let t = text.replace(/^["'“”\s]+|["'“”\s]+$/g, "").replace(/^(답|What-?If|이 답이 달라지려면)\s*[:：]\s*/i, "").replace(/\s+/g, " ").trim();
  if (t.length < 8) return undefined;
  if (t.length > WHAT_IF_MAX_CHARS) t = t.slice(0, WHAT_IF_MAX_CHARS - 1).trimEnd() + "…";
  return t;
}

/** What-If 1건 생성 (엔드포인트용). 실패·빈 응답·시간 초과면 error와 함께 whatIf 없이 돌려준다 (throw 안 함). */
export async function generateWhatIf(
  env: Pick<AskEnv, "AI">,
  input: { eventId: string; question: string; answer: string; sources: WhatIfSource[]; pool: RagPool },
): Promise<{ whatIf?: string; ms: number; error?: string; grounded: boolean }> {
  const start = Date.now();
  const grounded = input.sources.length > 0;
  try {
    const call = env.AI.run(LLM_MODEL, {
      reasoning_effort: "low",
      messages: buildWhatIfMessages(input.question, input.answer, input.sources, input.pool),
    }, aiGatewayOptionsWithMeta({ skipCache: false, tag: "what-if", metadata: { eventId: input.eventId, tag: "what-if" } }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("what-if timeout")), WHAT_IF_TIMEOUT_MS); });
    const out = await Promise.race([call, timeout]).finally(() => { if (timer) clearTimeout(timer); });
    const whatIf = cleanWhatIf(responseText(out));
    return whatIf ? { whatIf, ms: Date.now() - start, grounded } : { ms: Date.now() - start, error: "empty what-if", grounded };
  } catch (e) {
    return { ms: Date.now() - start, error: errMsg(e), grounded };
  }
}

/** 전환·차단 사유 문구(예: "개인 질문으로 판단되어 개인 업무 검색으로 안내합니다 (신뢰도 0.85)"). */
export function decisionMessage(kind: AskDecision["kind"], confidence: number): string {
  const c = (Math.round(confidence * 100) / 100).toFixed(2);
  if (kind === "redirect_personal") return `개인 질문으로 판단되어 개인 업무 검색으로 안내합니다 (신뢰도 ${c})`;
  if (kind === "redirect_hr") return `HR 규정 질문으로 판단되어 HR 규정 검색으로 안내합니다 (신뢰도 ${c})`;
  return `HR 규정과 관련 없는 질문으로 판단되어 답변하지 않습니다 (신뢰도 ${c})`;
}

export type AskRunResult =
  // 캐시 적중: 원본 호출의 응답 + cached:true. 새 트레이스는 만들지 않는다 (§1 주의).
  | { cached: true; body: Record<string, unknown> }
  | { cached: false; body: AskResponse; trace: AskTrace };

type SpanName = TraceSpan["name"];
type SpanProduct = TraceSpan["product"];

export async function runAsk(env: AskEnv, input: AskInput, opts: AskOptions = {}, hooks: AskHooks = {}): Promise<AskRunResult> {
  const origin = opts.origin ?? "user";
  // 사용자 경로 단계(라우터·토픽 가드·재순위)는 HR 창(user)과 개인 창(personal) 모두 돈다.
  // eval·metadata 호출만 건너뛴다. origin은 트레이스 구분용이다.
  const isUserPath = origin === "user" || origin === "personal";
  const viewer = opts.viewer ?? null; // 개인별 RAG 격리: null이면 공용만 조회
  // 관점 선택: 검색 범위 사용자 (기본 = viewer). 세션·캐시 키는 viewer 그대로.
  const scopeViewer: RagViewer | null = opts.scopeViewer !== undefined ? opts.scopeViewer : viewer;
  // 풀 분리 (2026-11-16): 기본 shared — HR 창은 공용만, 개인 창은 personal을 넘긴다.
  const pool: RagPool = opts.pool ?? "shared";
  const readCache = opts.readCache ?? true;
  const writeCache = opts.writeCache ?? true;
  const persistSession = opts.persistSession ?? true;
  const shouldRecordGap = opts.recordGap ?? true;
  const gatewaySkipCache = opts.gatewaySkipCache ?? false;
  const { question, sessionId } = input;
  // DO 격리 강화 (2026-11-16): DO 인스턴스 + D1 sessions 폴백 키에 viewer id를
  // 넣는다. sessionId만으로는 서버가 "이 세션이 이 사용자의 것인지"를 검증하지
  // 않아서, sessionId가 같으면(공유·예측) 다른 사용자의 대화 기록을 읽을 수 있다.
  // viewer id를 붙이면 sessionId가 같아도 사용자가 다르면 다른 인스턴스가 된다.
  // (캐시 키는 이미 viewer id를 포함한다 — 같은 패턴.) 기존 세션 기록은 구 키로
  // 남아 있어 새 키로는 안 보이지만, 세션 기억은 휘발성(최근 20턴)이라 무시한다.
  const sessionKey = `${viewer?.id ?? "anon"}:${sessionId}`;

  // 처리 시간 측정 (C7): 단계별 ms를 응답·감사 기록에 남긴다.
  const t0 = input.startedAt ?? Date.now();
  // S4 M6-β: eventId를 AI 호출 전에 만든다 — 게이트웨이 로그 metadata.eventId로
  // 비용 동기화가 트레이스와 대조한다 (aiGatewayLogId는 동시 요청에서 덮어써질 수 있어 보조).
  const eventId = uid("evt");
  const gwMeta = (tag: string) => ({ eventId, tag });
  const timings: Record<string, number> = {};
  const mark = (stage: string, started: number) => { timings[stage] = Date.now() - started; };
  // S4 트레이스: span(시작 오프셋 + 길이)과 근거 후보. 응답·timings에는 넣지 않는다.
  const spans: TraceSpan[] = [];
  const span = (name: SpanName, product: SpanProduct, started: number, ok: boolean, attrs?: Record<string, unknown>) => {
    spans.push({ name, product, startMs: started - t0, durationMs: Date.now() - started, ok, ...(attrs ? { attrs } : {}) });
  };
  const retrieval: RetrievalCandidate[] = [];
  const aigLogIds: string[] = [];
  const takeAigLogId = () => {
    // O3(M2 확인 대기): 바인딩이 aiGatewayLogId를 노출하면 모은다. 없으면 빈 배열.
    try {
      const id = (env.AI as unknown as { aiGatewayLogId?: unknown }).aiGatewayLogId;
      if (typeof id === "string" && id && !aigLogIds.includes(id)) aigLogIds.push(id);
    } catch { /* 무시 */ }
  };

  // KV 캐시 조회 (실패 시 D1 cache 테이블 폴백). force면 다시 생성한다.
  // 캐시 키에 sessionId를 포함한다: 후속 질문은 세션 문맥에 따라 답이 달라지므로,
  // 세션과 무관한 키로 캐시하면 다른 세션의 오래된(잘못된) 답을 돌려주게 된다.
  // C5-b: 지식 epoch도 키에 넣는다. 암묵지 게시 때 epoch가 올라가면
  // 게시 전 캐시 답(근거 없음 경고)이 나오지 않고 새로 계산한다.
  // 캐시 키에 viewer id도 넣는다: 같은 세션 id라도 사용자가 바뀌면
  // 다른 사람의 개인 문서 기반 답이 캐시에서 새는 것을 막기 위함이다
  // (viewer 없으면 "anon" — 익명/평가 호출은 공용만 보니 공유해도 안전하다).
  // 풀도 키에 넣는다 (2026-11-16): 같은 질문이라도 HR 창(공용)과 개인 창
  // (개인)의 답은 다르므로 풀별로 캐시를 나눈다.
  const knowledgeEpoch = await getKnowledgeEpoch(env);
  const cacheKey = `ask:${pool}:${viewer?.id ?? "anon"}:${sessionId}:${question}:${knowledgeEpoch}`;
  const cacheStart = Date.now();
  if (readCache) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        const body = { ...JSON.parse(cached), cached: true, sessionId };
        logEvent("ask.cache_hit", { via: "kv", origin, pool, userId: viewer?.id ?? null, ms: Date.now() - t0 });
        return { cached: true, body };
      }
    } catch { /* KV 로컬 실패 시 아래 D1 캐시로 */ }
    const d1Cache = await env.DB.prepare("SELECT value FROM cache WHERE key = ?").bind(cacheKey).first<{ value: string }>();
    if (d1Cache) {
      logEvent("ask.cache_hit", { via: "d1", origin, pool, userId: viewer?.id ?? null, ms: Date.now() - t0 });
      return { cached: true, body: { ...JSON.parse(d1Cache.value), cached: true, cacheVia: "d1", sessionId } };
    }
  }
  mark("cache", cacheStart);
  span("cache", "kv", cacheStart, true, { readCache, hit: false });

  // 후속 질문 문맥: 같은 세션의 직전 질문을 검색 쿼리에 보태 주제를 잃지 않게 한다.
  // 단, 현재 질문에 내용 토큰이 하나라도 있으면 독립 질문으로 보고 보태지 않는다
  // ("출산 전후 재택" 뒤에 "연차 3일"을 보태면 연차 근거가 딸려오는 오염이 생긴다).
  // 내용 토큰이 전혀 없는 지시어성 후속 질문("그건 어떻게 돼?", "며칠 전에?")에만 보탠다.
  let searchQuestion = question;
  const sessionStart = Date.now();
  let sessionReadVia: "durable-objects" | "d1" = "durable-objects";
  try {
    const stub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionKey));
    const res = await stub.fetch("https://do/history");
    const data = await res.json() as { history?: Array<{ role: string; content: string }> };
    const lastUser = [...(data.history || [])].reverse().find((h) => h.role === "user");
    if (lastUser && questionTokens(question).length === 0) searchQuestion = `${question} ${lastUser.content}`;
  } catch {
    sessionReadVia = "d1";
    try {
      const prev = await env.DB.prepare("SELECT history FROM sessions WHERE id = ?").bind(sessionKey).first<{ history: string }>();
      if (prev) {
        const hist = JSON.parse(prev.history) as Array<{ role: string; content: string }>;
        const lastUser = [...hist].reverse().find((h) => h.role === "user");
        if (lastUser && questionTokens(question).length === 0) searchQuestion = `${question} ${lastUser.content}`;
      }
    } catch { /* 세션 조회 실패 시 현재 질문만으로 검색 */ }
  }
  mark("session", sessionStart);
  // XAI 보완: viewerRole = 질문 시점 질문자 역할 (설명서의 "질문자 역할" 원천, 익명·평가 null).
  span("session", sessionReadVia, sessionStart, true, { via: sessionReadVia, followUp: searchQuestion !== question, viewerRole: viewer?.role ?? null });

  // 의도 라우터 (Decision Model, Clef-omni) — 2026-11-16. HR/개인 창 분리 가드.
  // 세션 문맥을 더한 searchQuestion으로 판별한다. 평가 호출(origin='eval')은
  // 건너뛴다 — 골든셋은 전부 HR 규정 질문이다. 판별 실패는 fail-open으로
  // 정상 진행한다 (라우터가 검색을 막지 않는다).
  // - personal인데 HR 창(pool shared) → 개인 창 안내로 돌려보낸다 (검색 안 함).
  // - hr_regulation인데 개인 창(pool personal) → HR 창 안내로 돌려보낸다.
  // - 돌려보내기는 확신도 ≥ 0.8일 때만 한다. 확신도가 낮으면 현재 풀에서
  //   검색한다 (fail-open). 텍스트만으로는 "어느 풀에 답이 있는지"를 확신할
  //   수 없기 때문이다 — 프로젝트명 같은 개인 콘텐츠는 텍스트에서 안 보인다.
  // - off_topic은 HR 창에서만, 확신도 ≥ 0.85일 때만 거른다 (토픽 가드와
  //   같은 기준). 개인 창에서는 off_topic 판별을 무시한다 — 개인 문서는
  //   임의의 프로젝트명·주제를 포함해 텍스트만으로 업무 외를 가릴 수 없고,
  //   검색 자체가 필터다 (맞는 문서가 없으면 근거 없음으로 답한다).
  let guardedOffTopic = false;
  let routerRedirect: string | undefined;
  let routerInfo: { intent: string; confidence: number; engine: string; reason: string } | undefined;
  if (isUserPath) {
    const routerStart = Date.now();
    try {
      const routed = await classifyIntent(env, searchQuestion);
      if (routed) {
        routerInfo = routed;
        const confident = routed.confidence >= ROUTER_REDIRECT_MIN_CONFIDENCE;
        if (routed.intent === "personal" && pool === "shared" && confident) routerRedirect = PERSONAL_REDIRECT_ANSWER;
        else if (routed.intent === "hr_regulation" && pool === "personal" && confident) routerRedirect = HR_REDIRECT_ANSWER;
        else if (routed.intent === "off_topic" && pool === "shared" && routed.confidence >= TOPIC_GUARD_THRESHOLD) guardedOffTopic = true;
      }
    } catch { /* 라우터 실패 시 fail-open — 정상 진행 */ }
    span("router", "workers-ai", routerStart, true, {
      intent: routerInfo?.intent ?? "fail-open",
      confidence: routerInfo?.confidence ?? 0,
      engine: routerInfo?.engine ?? "none",
      redirect: !!routerRedirect,
      offTopic: guardedOffTopic,
      ...(routerInfo ? { reason: routerInfo.reason } : {}),
    });
    mark("router", routerStart);
  }

  // 업무 외 질문 판별 (Decision Model, Clef + Clef-omni 앙상블): 확신 높을 때만 거른다.
  // 세션 문맥을 더한 searchQuestion으로 판별한다 (후속 질문 "그건 어떻게 돼?"가
  // 단독으로는 업무와 무관해 보일 수 있어서). 평가 호출(origin='eval')은
  // 건너뛴다 — 골든셋은 전부 업무 질문이다. 경계선·판별 실패는 정상 경로(fail-open).
  // 라우터가 이미 off_topic으로 판별했으면 토픽 가드 호출을 건너뛴다.
  let guardInfo: TopicGuardOutcome | undefined;
  // 라우터가 이미 off_topic으로 판별했거나 돌려보내기로 정했으면 토픽 가드
  // 호출을 건너뛴다 (검색을 안 하는데 판별할 필요가 없다).
  // 개인 창(pool personal)에서는 토픽 가드를 아예 안 돌린다 — 개인 문서는
  // 임의의 프로젝트명·주제를 포함해 텍스트만으로 업무 외를 가릴 수 없고,
  // 검색 자체가 필터다 (맞는 문서가 없으면 근거 없음으로 답한다).
  if (isUserPath && !guardedOffTopic && !routerRedirect && pool === "shared") {
    const guardStart = Date.now();
    try {
      guardInfo = await classifyTopic(env, searchQuestion);
      guardedOffTopic = guardInfo.offTopic;
    } catch (e) {
      guardInfo = { offTopic: false, confidence: 0, engine: "clef", reason: `guard error, fail-open: ${errMsg(e)}` };
    }
    span("topic_guard", "workers-ai", guardStart, true, {
      offTopic: guardedOffTopic,
      confidence: guardInfo.confidence,
      engine: guardInfo.engine,
      reason: guardInfo.reason,
    });
    mark("topic_guard", guardStart);
  }

  // XAI 보완 (2026-11-19): 전환·차단 사유. 라우터/가드가 이미 계산한 confidence를 그대로 쓴다.
  // 일반 답(전환·차단 없음)에는 만들지 않는다.
  let decision: AskDecision | undefined;
  if (routerRedirect && routerInfo) {
    const kind: AskDecision["kind"] = routerRedirect === PERSONAL_REDIRECT_ANSWER ? "redirect_personal" : "redirect_hr";
    decision = { kind, by: "router", confidence: routerInfo.confidence, message: decisionMessage(kind, routerInfo.confidence) };
  } else if (guardedOffTopic) {
    const byGuard = !!guardInfo?.offTopic;
    const conf = byGuard ? guardInfo!.confidence : routerInfo?.confidence ?? 0;
    decision = { kind: "off_topic", by: byGuard ? "topic_guard" : "router", confidence: conf, message: decisionMessage("off_topic", conf) };
  }

  // 근거 검색 — 하이브리드 (회수 튜닝): Vectorize + D1 키워드 검색을 합친다.
  // Vectorize만 쓰면 topK 밖 순위의 chunk를 못 가져온다. 문장형 질문은
  // 임베딩 점수가 흩어져 맞는 chunk가 4위 이하로 밀리는데, 그때도 정책
  // chunk 3개가 하한·게이트를 통과하면 D1을 볼 기회가 없었다 (Nokia·DOCX
  // 빗나감). 그래서 Vectorize 후보를 topK 5로 넓히고, D1 키워드 검색을
  // 항상 돌려 Vectorize에 없는 chunk를 보충한다. D1은 키워드 게이트와
  // 같은 하한(≥2)을 적용하므로 안전망 수준은 같고, 이미 있는 chunk는
  // 빼고 최대 MAX_SOURCES개까지만 쓴다. 근거가 아예 없으면
  // grounded:false로 LLM 미호출 — 지어내기 금지는 그대로 (C5).
  let sources: Source[] = [];
  let searchEngine = guardedOffTopic || routerRedirect ? "none" : "d1-text";
  let d1FallbackRan = false; // Vectorize/AI 실패 시 D1 폴백이 이미 돎
  let decisiveSourceId: string | undefined; // XAI 보완: 재순위가 고른 1순위 (재순위 미경유면 없음)
  let vectorError: string | undefined;
  // 라우터가 돌려보낸 질문(잘못된 창)은 검색하지 않는다.
  if (!guardedOffTopic && !routerRedirect) {
    try {
      await ensureVectorSeeded(env);
      const embedStart = Date.now();
      let emb: { data: number[][] | number[] };
      try {
        emb = await env.AI.run(EMBED_MODEL, { text: [searchQuestion] }, aiGatewayOptionsWithMeta({ skipCache: true, tag: "embed", metadata: gwMeta("embed") })) as { data: number[][] | number[] };
        takeAigLogId();
      } catch (e) {
        span("embed", "workers-ai", embedStart, false, { model: EMBED_MODEL, error: errMsg(e) });
        throw e;
      }
      mark("embed", embedStart);
      span("embed", "workers-ai", embedStart, true, { model: EMBED_MODEL });
      const raw = emb.data;
      const values = new Float32Array(Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]));
      const vecStart = Date.now();
      let vec: VectorizeMatches;
      try {
        // 풀 분리 (2026-11-16): HR 창은 공용 벡터만, 개인 창은 본인 개인
        // 벡터만 조회한다. vectorPoolFilter는 서버에서 강제하고 topK는
        // 필터된 집합에서 뽑힌다 (필터 밖 문서는 순위에도 들지 않는다).
        // vectorPoolFilter는 Record<string, unknown>을 돌려줘 workers-types의
        // VectorizeVectorMetadataFilter와 직접 맞지 않아 최소한의 캐스트를 쓴다.
        vec = await env.VECTOR.query(values, { topK: 5, returnMetadata: "all", filter: vectorPoolFilter(scopeViewer, pool) as VectorizeVectorMetadataFilter });
      } catch (e) {
        span("vectorize", "vectorize", vecStart, false, { topK: 5, error: errMsg(e) });
        throw e;
      }
      mark("vectorize", vecStart);
      const all = vec.matches || [];
      span("vectorize", "vectorize", vecStart, true, { topK: 5, matches: all.length, scoreFloor: SCORE_FLOOR });
      const matches = all.filter((m) => (m.score || 0) >= SCORE_FLOOR);
      // 근거 후보: Vectorize 순위 그대로. 하한 미달은 여기서 확정, 나머지는 게이트·병합 뒤 채운다.
      const vecCands = all.map((m, i) => {
        const meta = (m.metadata || {}) as { title?: unknown; section?: unknown };
        const cand: RetrievalCandidate = {
          chunkId: String(m.id), stage: "vectorize", rank: i + 1, vectorScore: m.score || 0,
          title: typeof meta.title === "string" ? meta.title : undefined,
          article: typeof meta.section === "string" ? meta.section : undefined,
          outcome: (m.score || 0) >= SCORE_FLOOR ? "kept" : "below_floor",
        };
        return cand;
      });
      retrieval.push(...vecCands);
      if (matches.length > 0) {
        const gateStart = Date.now();
        const gateScores = new Map<string, { keywordScore: number; docId?: string }>();
        const resolved = new Map<string, "kept" | "dedup" | "unresolved">();
        let gatedCount = 0;
        try {
          const gated = await keywordGate(env, searchQuestion, matches.map((m) => ({ id: String(m.id), score: m.score || 0, metadata: (m.metadata || {}) as Record<string, unknown> })), gateScores);
          gatedCount = gated.length;
          const gatedIds = new Set(gated.map((g) => g.id));
          for (const cand of vecCands) {
            const gs = gateScores.get(cand.chunkId);
            if (gs) { cand.keywordScore = gs.keywordScore; if (gs.docId) cand.docId = gs.docId; }
            if (cand.outcome === "kept" && !gatedIds.has(cand.chunkId)) cand.outcome = "keyword_gate";
          }
          if (gated.length > 0) {
            searchEngine = "vectorize";
            sources = await resolveSources(env, searchQuestion, gated, resolved, pool, scopeViewer);
            if (sources.length === 0) throw new Error("no resolvable matches");
          }
        } finally {
          // dedup: 같은 문서의 더 높은 점수 매치에 밀림. unresolved(D1·메타데이터 없음)는
          // 계약 enum에 없어서 후보 목록에서 빼고 gate span attrs에 개수만 남긴다.
          let unresolved = 0;
          for (let i = vecCands.length - 1; i >= 0; i--) {
            const r = resolved.get(vecCands[i].chunkId);
            if (r === "dedup") vecCands[i].outcome = "dedup";
            else if (r === "unresolved") { unresolved++; retrieval.splice(retrieval.indexOf(vecCands[i]), 1); }
          }
          span("gate", "d1", gateStart, sources.length > 0 || gatedCount === 0, {
            candidates: matches.length, passed: gatedCount, resolved: sources.length, unresolved, keywordGateMin: KEYWORD_GATE_MIN,
          });
        }
        mark("gate", gateStart);
      }
      // 하한·게이트를 통과한 매치가 없어도 아래 D1 병합이 본다.
    } catch (e) {
      vectorError = errMsg(e);
      // Vectorize/AI 실패 — D1 텍스트 검색으로 답한다 (로컬 dev 경로).
      // minScore 0: 기존 동작 유지 (약한 겹침도 로컬에서는 근거로 쓴다).
      if (sources.length === 0) {
        // 게이트 뒤 resolve 실패로 들어온 경우 Vectorize 후보는 근거가 아니다.
        for (const cand of retrieval) if (cand.stage === "vectorize" && cand.outcome === "kept") cand.outcome = "keyword_gate";
        const fbStart = Date.now();
        sources = await d1TextSources(env, searchQuestion, 0, scopeViewer, pool);
        if (sources.length > 0) searchEngine = "d1-text";
        d1FallbackRan = true;
        sources.forEach((s, i) => retrieval.push({ chunkId: s.id, title: s.title, article: s.section, stage: "d1", rank: i + 1, keywordScore: s.score, outcome: "kept" }));
        span("d1_merge", "d1", fbStart, true, { mode: "fallback", minScore: 0, found: sources.length, reason: vectorError });
      }
    }
    // D1 병합: Vectorize에서 못 가져온 chunk를 키워드 검색으로 보충한다.
    // 암묵지 문서는 Vectorize upsert가 늦거나 실패해도 D1 chunk에는
    // 있으므로 여기서 잡힌다 (C5-b). (실측: "출산 전후 재택"은 정책 chunk
    // 전원 0점, 암묵지 chunk 27점.)
    if (!d1FallbackRan) {
      const mergeStart = Date.now();
      // d1TextSources(…, KEYWORD_GATE_MIN)과 같은 결과: 같은 조회를 하한 0으로
      // 받아 여기서 하한을 적용한다 (하한 미달 후보도 트레이스에 남기려고).
      const d1All = await d1TextSources(env, searchQuestion, 0, scopeViewer, pool);
      const d1Extra = d1All.filter((s) => s.score >= KEYWORD_GATE_MIN);
      const haveIds = new Set(sources.map((s) => s.id));
      let added = 0;
      let full = false;
      d1All.forEach((s, i) => {
        if (s.score < KEYWORD_GATE_MIN) retrieval.push({ chunkId: s.id, title: s.title, article: s.section, stage: "d1", rank: i + 1, keywordScore: s.score, outcome: "below_floor" });
      });
      for (const s of d1Extra) {
        const rank = d1All.indexOf(s) + 1;
        const cand: RetrievalCandidate = { chunkId: s.id, title: s.title, article: s.section, stage: "d1", rank, keywordScore: s.score, outcome: "kept" };
        if (!full && sources.length >= MAX_SOURCES) full = true;
        if (full) { cand.outcome = "over_max"; retrieval.push(cand); continue; }
        if (!haveIds.has(s.id)) { sources.push(s); haveIds.add(s.id); added++; }
        else cand.outcome = "dedup";
        retrieval.push(cand);
      }
      span("d1_merge", "d1", mergeStart, true, { mode: "merge", minScore: KEYWORD_GATE_MIN, found: d1Extra.length, added, maxSources: MAX_SOURCES });
    }
    // 근거 재순위 (Decision Model, Clef-omni) — 2026-11-16. 후보가 2개 이상이면
    // 판단 모델이 질문에 가장 잘 답하는 근거를 골라 1위로 올린다. 실패하면
    // 원래 순서를 유지한다 (fail-open). 평가 호출(origin='eval')은 건너뛴다 —
    // 골든셋 기준선을 그대로 유지하고, 재순위는 사용자 경로에서만 검증한다.
    if (isUserPath && sources.length >= 2) {
      const rerankStart = Date.now();
      try {
        const rr = await rerankSources(env, searchQuestion, sources);
        sources = rr.sources;
        // 재순위 모델이 실제로 고른 경우만 결정적 근거로 표시한다 (파싱·호출 실패 = 표시 안 함).
        if (rr.decidedId && sources.some((s) => s.id === rr.decidedId)) decisiveSourceId = rr.decidedId;
        span("rerank", "workers-ai", rerankStart, true, { reranked: rr.reranked, winnerId: rr.winnerId ?? null, decisiveId: decisiveSourceId ?? null, reason: rr.reason });
        mark("rerank", rerankStart);
      } catch (e) {
        span("rerank", "workers-ai", rerankStart, false, { error: errMsg(e) });
      }
    }
  }
  // 근거 없음: LLM을 호출하지 않고 경고로 답한다 (C5, Baryon AX).
  // 연차휴가 규정을 강제 근거로 넣던 폴백은 삭제했다 — 근거가 없는데
  // 있는 것처럼 답하는 것이 데모에서 드러나는 약점이었다.
  const grounded = sources.length > 0;
  let answer = "";
  let engine = "local-template";
  let gapId: string | undefined;
  let promptVersion = "";
  let promptMessages: Array<{ role: string; content: string }> | undefined;
  let rawResponse: unknown;
  let usage: AskTrace["usage"];
  if (!grounded) {
    // 업무 외 판별 거절·라우터 돌려보내기: 고정 답, LLM 미호출, 공백 큐에
    // 쌓지 않는다 (큐 오염 방지 — 잘못된 창 질문은 지식 공백이 아니다).
    answer = routerRedirect ?? (guardedOffTopic ? TOPIC_GUARD_ANSWER : "등록된 규정에서 근거를 찾지 못했습니다. 이 질문에 대한 답은 아직 등록된 규정에 없습니다. 인사팀에 확인해 주세요.");
    engine = "none";
    timings.llm = 0; // 근거 없음 — LLM을 호출하지 않는다
    // C5-b: 근거 없는 질문은 지식 공백 큐에 쌓는다 (라이브러리에서 담당자가 답한다).
    // 기록 실패가 질문 응답을 망가뜨리지 않게 try/catch로 감싼다.
    // 평가 호출(opts.recordGap=false)은 공백 큐에 행을 만들지 않는다.
    if (shouldRecordGap && !guardedOffTopic && !routerRedirect) {
      try { gapId = (await recordGap(env, question, "no-evidence", viewer?.id ?? null)).id; }
      catch (e) { console.log("[gaps] recordGap failed:", e instanceof Error ? e.message : String(e)); }
    }
  } else {
    // system 프롬프트: 활성 버전(또는 opts.promptVersionId). 못 찾으면 던진다.
    const prompt = await resolvePrompt(env, opts.promptVersionId);
    promptVersion = prompt.id;
    // 답변 생성: Workers AI 시도 → 실패 시 근거 기반 템플릿 답변
    const llmStart = Date.now();
    let llmError: string | undefined;
    try {
      const context = sources.map((s) => {
        const section = s.sectionPath || s.section;
        const summary = s.nodeSummary ? `〈${s.nodeSummary.slice(0, 120)}〉 ` : "";
        return `[${RAG_POOL_LABEL[s.pool]} › ${s.title} › ${section}] ${summary}${s.snippet}`;
      }).join("\n");
      promptMessages = [
        { role: "system", content: prompt.body },
        { role: "user", content: `질문: ${question}\n근거:\n${context}` },
      ];
      const out = await env.AI.run(LLM_MODEL, {
        reasoning_effort: "low",
        messages: promptMessages,
      }, aiGatewayOptionsWithMeta({ skipCache: gatewaySkipCache, tag: origin === "eval" ? "eval-ask" : "ask", metadata: gwMeta(origin === "eval" ? "eval-ask" : "ask") }));
      takeAigLogId();
      rawResponse = out;
      const u = (out as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
      if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
        usage = {
          promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
          completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
        };
      }
      const text = responseText(out);
      if (text && text.trim().length > 10) { answer = text.trim(); engine = "workers-ai"; } else throw new Error("empty ai answer");
    } catch (e) {
      llmError = errMsg(e);
      const top = sources[0];
      answer = `근거 문서 「${top.title}(${top.section})」에 따르면, ${top.snippet} 질문하신 "${question}"에 대해서는 위 규정을 기준으로 안내드립니다. 정확한 적용은 인사팀 확인이 필요합니다.`;
      engine = "local-template";
    }
    mark("llm", llmStart);
    span("llm", "workers-ai", llmStart, engine === "workers-ai", { model: LLM_MODEL, engine, promptVersion, ...(llmError ? { error: llmError } : {}) });
  }

  // What-If는 답과 분리했다 (2026-11-19): 여기서 LLM을 부르지 않는다. What-If 엔드포인트가 쓸
  // 근거 요약(3개 × 180자)만 트레이스에 남긴다. 전환·차단 답(고정 안내문)에는 만들지 않는다.
  const whatIfContext: WhatIfSource[] | undefined = isUserPath && !routerRedirect && !guardedOffTopic
    ? sources.slice(0, 3).map((s) => ({ title: s.title, section: s.sectionPath || s.section, snippet: s.snippet.slice(0, 180) }))
    : undefined;

  // Durable Objects 세션에 대화 저장 시도 → 실패 시 D1 sessions 폴백
  let sessionVia = "durable-objects";
  if (persistSession) {
    const saveStart = Date.now();
    try {
      const stub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionKey));
      await stub.fetch("https://do/message", { method: "POST", body: JSON.stringify({ role: "user", content: question }) });
      await stub.fetch("https://do/message", { method: "POST", body: JSON.stringify({ role: "assistant", content: answer }) });
    } catch {
      sessionVia = "d1";
      const existing = await env.DB.prepare("SELECT history FROM sessions WHERE id = ?").bind(sessionKey).first<{ history: string }>();
      const history = existing ? JSON.parse(existing.history) : [];
      history.push({ role: "user", content: question }, { role: "assistant", content: answer });
      await env.DB.prepare("INSERT OR REPLACE INTO sessions (id, history, updated_at) VALUES (?, ?, datetime('now'))").bind(sessionKey, JSON.stringify(history.slice(-20))).run();
    }
    span("session_save", sessionVia === "d1" ? "d1" : "durable-objects", saveStart, true, { via: sessionVia });
  } else {
    sessionVia = "none"; // 평가 호출: 세션에 저장하지 않는다
  }

  timings.total = Date.now() - t0;
  const result: AskResponse = {
    ok: true, sessionId, question, answer, sources, grounded, engine, searchEngine, sessionVia, cached: false, eventId, timings,
    ...(decisiveSourceId ? { decisiveSourceId } : {}), ...(decision ? { decision } : {}),
  };
  const trace: AskTrace = {
    eventId, sessionId, origin, ...(opts.evalRunId ? { evalRunId: opts.evalRunId } : {}),
    question, searchQuestion, answer,
    status: guardedOffTopic ? "off_topic" : grounded ? "grounded" : "no_evidence",
    ...(gapId ? { gapId } : {}),
    engine, searchEngine, promptVersion, model: grounded ? LLM_MODEL : "",
    knowledgeEpoch, timings: { ...timings }, spans, retrieval,
    sources: sources.map((s) => ({ id: s.id, title: s.title, section: s.section, score: s.score, pool: s.pool, ...(s.kind ? { kind: s.kind } : {}) })),
    ...(promptMessages ? { prompt: { messages: promptMessages } } : {}),
    ...(rawResponse !== undefined ? { rawResponse } : {}),
    ...(usage ? { usage } : {}),
    aigLogIds,
    userId: viewer?.id ?? null, // 0021: 질문한 사용자 (익명·평가 null)
    userRole: viewer?.role ?? null,
    ...(whatIfContext ? { whatIfContext } : {}), ...(decisiveSourceId ? { decisiveSourceId } : {}), ...(decision ? { decision } : {}),
  };
  // Workers Logs (전체 점검 2026-11-18): 숫자·식별자만. 질문·답변·근거 제목은 싣지 않는다 (src/obs/log.ts 규칙).
  logEvent("ask.complete", {
    eventId, origin, pool, status: trace.status, grounded, engine, searchEngine,
    sources: sources.length, totalMs: timings.total, llmMs: timings.llm ?? null,
    promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null,
    userId: viewer?.id ?? null, evalRunId: opts.evalRunId ?? null,
  });
  // C7 답변 감사: 질문 1건마다 ask_events 행 1건. 기록 실패가 질문 자체를
  // 망가뜨리지는 않게 try/catch로 감싼다. 캐시된 답은 원본 호출의 행을
  // 공유하므로(같은 eventId) 새로 기록하지 않는다.
  // S4: traceSink(M2)가 있으면 sink가 ask_events(9개 컬럼 + 새 컬럼)와
  // 자식 테이블·R2를 기록한다. 없으면 S4 이전과 같은 9개 컬럼 INSERT.
  if (hooks.traceSink) {
    try { await hooks.traceSink.record(env, trace, hooks.ctx); }
    catch (e) { console.log("[trace] traceSink.record failed:", errMsg(e)); }
  } else {
    try {
      await env.DB.prepare(
        "INSERT INTO ask_events (id, session_id, question, answer, source_ids, grounded, engine, search_engine, timings_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(eventId, sessionId, question, answer, JSON.stringify(sources.map((s) => s.id)), grounded ? 1 : 0, engine, searchEngine, JSON.stringify(timings), viewer?.id ?? null).run();
    } catch (e) {
      console.log("[audit] ask_events insert failed:", e instanceof Error ? e.message : String(e));
    }
  }
  // 캐시 저장 (KV 시도, 실패 시 D1)
  if (writeCache) {
    try { await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }); }
    catch { await env.DB.prepare("INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)").bind(cacheKey, JSON.stringify(result)).run(); }
  }
  return { cached: false, body: result, trace };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
