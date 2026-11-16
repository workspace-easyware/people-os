// 트리 메타데이터 (2026-11-16) — Fable 5.2 자문 결론: Vector DB를 유지하고,
// 트리는 검색기가 아니라 청크에 붙는 메타데이터(섹션 경로, 주제 구간)로만 얇게 도입한다.
// 질의 시 LLM이 트리를 타고 내려가는 탐색은 하지 않는다 (골든셋에 "50쪽 이상
// 구조 문서에서 벡터가 빗나간다"는 사례가 쌓일 때만 검토).
//
// - 파일(보고서형 PDF/DOCX/HWPX에서 추출한 markdown): `#` 제목을 결정적으로 파싱.
// - 전사본: LLM 1회 호출로 주제 구간을 나누고, 구조화 요약(digest)과 같은 호출로
//   함께 만든다. 요약 1개가 곧 깊이 2짜리 트리다 (루트=문서 요약, 자식=주제 구간).
// - 검색은 지금처럼 벡터+키워드로 하고, 적중한 청크의 부모 노드 제목·요약을
//   근거에 덧붙인다 (resolveSources의 근거 풍부화).
// - HR 규정(kind='policy')에는 트리를 도입하지 않는다. 조문 단위로 이미 깔끔하게
//   나뉘어 있고, 요약하면 "30일 이내" 같은 정확한 문구가 뭉개진다.
// - 문서 삭제 시 노드도 함께 지워야 한다. 삭제 순서: 노드 → 청크 → 벡터 →
//   documents → R2. (삭제 엔드포인트가 아직 없어 로직은 없고, 순서만 주석으로 남긴다.)
import { poolForDoc, splitMarkdownIntoChunks, vectorUserIdForDoc } from "./lib";
import { aiGatewayOptions } from "./ai-gateway";
import { EMBED_DIMS, EMBED_MODEL, LLM_MODEL, responseText } from "./ask-pipeline";
import { recordMetadataTrace } from "./obs/trace";

// tree 빌더가 쓰는 바인딩. index.ts의 Env는 이를 포함한다(구조적 타이핑).
export type TreeEnv = {
  DB: D1Database;
  VECTOR: VectorizeIndex;
  AI: Ai;
  FILES?: R2Bucket; // 메타데이터 트레이스의 R2 원문용 (없으면 R2 쓰기를 건너뛴다).
};

/** doc_nodes 행. */
export type TreeNode = {
  id: string;
  doc_id: string;
  parent_id: string | null;
  ord: number;
  depth: number;
  title: string;
  summary: string | null;
  chunk_start: number;
  chunk_end: number;
  source: "heading" | "llm-topic";
};

/** 전사본 구조화 요약 (LLM Wiki 얇은 조각). */
export type TranscriptDigest = {
  summary: string;
  decisions: string[];
  actions: string[];
  attendees: string[];
  tags: string[];
};

/** 전사본 LLM 출력: digest + 주제 구간 + 사용량(메타데이터 트레이스용). */
export type TranscriptTreeResult = {
  nodes: TreeNode[];
  digest: TranscriptDigest;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export const DIGEST_VECTOR_SUFFIX = "-digest";
export const digestVectorId = (docId: string): string => `${docId}${DIGEST_VECTOR_SUFFIX}`;

/** 본문의 SHA-256 해시 (재빌드 생략용 tree_hash). */
export async function treeHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- 파일 트리: `#` 제목 결정적 파싱 -----------------------------------------

type Heading = { level: number; title: string; line: number };

function parseHeadings(markdown: string): Heading[] {
  const lines = markdown.split("\n");
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2].trim(), line: i });
  }
  return out;
}

/** chunk 텍스트의 첫 내용 줄 (메타 줄은 건너뛴다). */
function chunkFirstLine(text: string): string {
  for (const l of text.split("\n")) {
    const t = l.trim().replace(/^#+\s*/, "");
    if (t.length > 3 && !/^(작성자:|원 질문:)/.test(t)) return t;
  }
  return "";
}

/**
 * 파일 markdown의 `#` 제목을 결정적으로 파싱해 트리를 만든다 (LLM 없이).
 * - 루트 노드(depth 0): 문서 제목, 전 청크 범위.
 * - 제목 노드: depth = 제목 수준, parent = 가장 가까운 상위 제목 (없으면 루트).
 * - 각 제목의 chunk 범위는 그 제목 아래(자손 제목 포함)의 청크 범위.
 * - 제목이 하나도 없으면 루트만 만든다.
 */
export function buildFileTree(markdown: string, docId: string, docTitle: string): TreeNode[] {
  const chunks = splitMarkdownIntoChunks({ id: docId, title: docTitle, body: markdown });
  const lastOrd = Math.max(0, chunks.length - 1);
  const root: TreeNode = {
    id: `${docId}-node-0`, doc_id: docId, parent_id: null, ord: 0, depth: 0,
    title: docTitle, summary: null, chunk_start: 0, chunk_end: lastOrd, source: "heading",
  };
  if (!chunks.length) return [root];
  const headings = parseHeadings(markdown);
  if (!headings.length) return [root];

  // chunk가 속한 leaf 제목: chunk 첫 줄이 나타나는 markdown 줄 앞의 마지막 제목.
  const lines = markdown.split("\n");
  let searchFrom = 0;
  const leafOfChunk = new Map<number, number>(); // chunk ord -> heading index (-1 = 루트)
  for (const ch of chunks) {
    const first = chunkFirstLine(ch.text);
    let chunkLine = -1;
    if (first) {
      const needle = first.slice(0, 40);
      for (let i = searchFrom; i < lines.length; i++) {
        const clean = lines[i].trim().replace(/^#+\s*/, "");
        if (clean.length > 3 && (clean.startsWith(needle) || needle.startsWith(clean.slice(0, 40)))) {
          chunkLine = i;
          searchFrom = i;
          break;
        }
      }
    }
    let leaf = -1;
    for (let h = 0; h < headings.length; h++) {
      if (headings[h].line <= chunkLine) leaf = h;
      else break;
    }
    leafOfChunk.set(ch.ord, leaf);
  }

  // 제목 계층: 스택으로 parent를 정한다.
  const parentOf: number[] = []; // heading index -> parent heading index (-1 = 루트)
  const stack: number[] = [];
  for (let h = 0; h < headings.length; h++) {
    while (stack.length > 0 && headings[stack[stack.length - 1]].level >= headings[h].level) stack.pop();
    parentOf.push(stack.length > 0 ? stack[stack.length - 1] : -1);
    stack.push(h);
  }
  // 자손 판정: heading j가 heading h의 자손이면 parent 체인에 h가 있다.
  const isDescendantOrSelf = (j: number, h: number): boolean => {
    let cur: number | null = j;
    while (cur !== -1 && cur !== null) {
      if (cur === h) return true;
      cur = parentOf[cur] ?? -1;
      if (cur === -1) return false;
    }
    return false;
  };

  const nodes: TreeNode[] = [root];
  // heading별 chunk 범위와 노드 ord를 먼저 정한다 (청크 없는 제목은 건너뛴다).
  const nodeOrdOf = new Map<number, number>();
  const ranges = new Map<number, { start: number; end: number }>();
  let ord = 1;
  for (let h = 0; h < headings.length; h++) {
    const ords: number[] = [];
    for (const ch of chunks) {
      const leaf = leafOfChunk.get(ch.ord) ?? -1;
      if (leaf !== -1 && isDescendantOrSelf(leaf, h)) ords.push(ch.ord);
    }
    if (!ords.length) continue;
    nodeOrdOf.set(h, ord);
    ranges.set(h, { start: Math.min(...ords), end: Math.max(...ords) });
    ord++;
  }
  for (let h = 0; h < headings.length; h++) {
    const nodeOrd = nodeOrdOf.get(h);
    const range = ranges.get(h);
    if (nodeOrd === undefined || !range) continue;
    // parent: 가장 가까운 조상 제목 중 노드가 있는 것, 없으면 루트.
    let parentId: string = root.id;
    let p = parentOf[h];
    while (p !== -1) {
      const pOrd = nodeOrdOf.get(p);
      if (pOrd !== undefined) { parentId = `${docId}-node-${pOrd}`; break; }
      p = parentOf[p] ?? -1;
    }
    nodes.push({
      id: `${docId}-node-${nodeOrd}`, doc_id: docId,
      parent_id: parentId,
      ord: nodeOrd, depth: headings[h].level,
      title: headings[h].title, summary: null,
      chunk_start: range.start, chunk_end: range.end, source: "heading",
    });
  }
  return nodes;
}

// ---- 전사본 트리: LLM 1회 호출로 주제 구간 + 구조화 요약 ----------------------

const MAX_SEGMENT_CHUNKS = 40; // LLM에 넘기는 chunk 수 상한
const SEGMENT_SNIPPET_LEN = 150;

/**
 * 전사본을 LLM 1회 호출로 주제 구간으로 나누고 구조화 요약도 함께 만든다.
 * 출력 JSON: {digest: {summary, decisions, actions, attendees, tags},
 *              segments: [{label, summary, chunk_start, chunk_end}]}
 * - 루트 노드(depth 0)는 문서 요약, 자식 노드(depth 1)는 주제 구간.
 * - 구간은 chunk ord 범위로 지정한다 (LLM이 본 chunk 목록 기준).
 * - LLM 호출·파싱 실패 시 throw한다 (소비자가 fail-open으로 건너뛴다).
 */
export async function buildTranscriptTree(
  content: string,
  docId: string,
  docTitle: string,
  ai: Ai,
): Promise<TranscriptTreeResult> {
  const chunks = splitMarkdownIntoChunks({ id: docId, title: docTitle, body: content });
  const listed = chunks.slice(0, MAX_SEGMENT_CHUNKS);
  const chunkList = listed.map((ch) => `[chunk ${ch.ord}] ${ch.text.slice(0, SEGMENT_SNIPPET_LEN).replace(/\n/g, " ")}`).join("\n");
  const out = await ai.run(LLM_MODEL, {
    messages: [
      {
        role: "system",
        content: "너는 회의 전사본 분석가다. 전사본을 주제 구간으로 나누고 구조화 요약을 만든다. JSON 하나만 출력한다.",
      },
      {
        role: "user",
        content: [
          `전사본 chunk 목록 (순서대로, chunk ${listed.length}개):`,
          chunkList,
          "",
          "아래 JSON으로만 답하라:",
          '{"digest": {"summary": "전체 요약 200자 이내", "decisions": ["결정사항"], "actions": ["액션"], "attendees": ["참석자"], "tags": ["주제어"]}, "segments": [{"label": "구간 라벨 20자 이내", "summary": "구간 요약 100자 이내", "chunk_start": 0, "chunk_end": 2}]}',
          "규칙: segments는 chunk 0부터 마지막 chunk까지 순서대로, 겹치지 않게, 빈틈없이 나눈다. chunk_start <= chunk_end. label과 summary는 한국어로.",
        ].join("\n"),
      },
    ],
  }, aiGatewayOptions({ tag: "tree" }));
  const usageRaw = (out as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const usage: { promptTokens?: number; completionTokens?: number } = {
    ...(typeof usageRaw?.prompt_tokens === "number" ? { promptTokens: usageRaw.prompt_tokens } : {}),
    ...(typeof usageRaw?.completion_tokens === "number" ? { completionTokens: usageRaw.completion_tokens } : {}),
  };
  const text = responseText(out);
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json object in tree response");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    digest?: { summary?: unknown; decisions?: unknown; actions?: unknown; attendees?: unknown; tags?: unknown };
    segments?: Array<{ label?: unknown; summary?: unknown; chunk_start?: unknown; chunk_end?: unknown }>;
  };
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.slice(0, 200)).slice(0, 10) : [];
  const digest: TranscriptDigest = {
    summary: typeof parsed.digest?.summary === "string" ? parsed.digest.summary.slice(0, 500) : "",
    decisions: strList(parsed.digest?.decisions),
    actions: strList(parsed.digest?.actions),
    attendees: strList(parsed.digest?.attendees),
    tags: strList(parsed.digest?.tags),
  };
  if (!digest.summary) throw new Error("empty digest summary");
  const lastOrd = Math.max(0, chunks.length - 1);
  const nodes: TreeNode[] = [{
    id: `${docId}-node-0`, doc_id: docId, parent_id: null, ord: 0, depth: 0,
    title: docTitle, summary: digest.summary, chunk_start: 0, chunk_end: lastOrd, source: "llm-topic",
  }];
  const segs = Array.isArray(parsed.segments) ? parsed.segments : [];
  let ord = 1;
  let prevEnd = -1;
  for (const s of segs) {
    const label = typeof s.label === "string" ? s.label.trim().slice(0, 40) : "";
    const summary = typeof s.summary === "string" ? s.summary.trim().slice(0, 300) : "";
    let cs = typeof s.chunk_start === "number" ? Math.floor(s.chunk_start) : -1;
    let ce = typeof s.chunk_end === "number" ? Math.floor(s.chunk_end) : -1;
    if (!label || cs < 0 || ce < cs) continue;
    cs = Math.max(0, Math.min(cs, lastOrd));
    ce = Math.max(cs, Math.min(ce, lastOrd));
    // 겹침·빈틈 보정: 이전 구간 끝 다음부터 시작하게 한다.
    if (cs <= prevEnd) cs = prevEnd + 1;
    if (cs > lastOrd) break;
    if (ce < cs) ce = cs;
    nodes.push({
      id: `${docId}-node-${ord}`, doc_id: docId, parent_id: nodes[0].id, ord, depth: 1,
      title: label, summary: summary || null, chunk_start: cs, chunk_end: ce, source: "llm-topic",
    });
    ord++;
    prevEnd = ce;
  }
  // 구간이 하나도 안 나오면 루트만 둔다 (트리 없이 넘어가는 것과 같다).
  return { nodes, digest, usage };
}

// ---- 저장 ------------------------------------------------------------------------

/**
 * chunk → 가장 깊은(구체적인) 노드 연결. node_id가 NULL인 chunk만 채운다.
 * (재색인으로 chunk가 다시 만들어졌을 때, tree_hash는 그대로인데 chunk의
 * node_id만 비어 있는 경우를 메운다.)
 */
export async function linkChunksToNodes(env: TreeEnv, docId: string, nodes: TreeNode[]): Promise<number> {
  let linked = 0;
  const byDepth = [...nodes].sort((a, b) => b.depth - a.depth);
  for (const n of byDepth) {
    const r = await env.DB.prepare("UPDATE chunks SET node_id = ? WHERE doc_id = ? AND ord >= ? AND ord <= ? AND node_id IS NULL")
      .bind(n.id, docId, n.chunk_start, n.chunk_end).run();
    linked += r.meta?.changes ?? 0;
  }
  const root = nodes.find((n) => n.depth === 0);
  if (root) {
    const r = await env.DB.prepare("UPDATE chunks SET node_id = ? WHERE doc_id = ? AND node_id IS NULL").bind(root.id, docId).run();
    linked += r.meta?.changes ?? 0;
  }
  return linked;
}

/**
 * 노드를 D1에 저장한다 (멱등): 해당 doc의 노드를 지우고 다시 넣고,
 * 각 chunk의 node_id를 가장 깊은(구체적인) 노드로 정한다.
 */
export async function saveTreeNodes(env: TreeEnv, docId: string, nodes: TreeNode[]): Promise<void> {
  await env.DB.prepare("DELETE FROM doc_nodes WHERE doc_id = ?").bind(docId).run();
  if (nodes.length) {
    const stmts = nodes.map((n) =>
      env.DB.prepare(
        "INSERT INTO doc_nodes (id, doc_id, parent_id, ord, depth, title, summary, chunk_start, chunk_end, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(n.id, n.doc_id, n.parent_id, n.ord, n.depth, n.title, n.summary, n.chunk_start, n.chunk_end, n.source),
    );
    await env.DB.batch(stmts);
  }
  await linkChunksToNodes(env, docId, nodes);
}

/**
 * 구조화 요약을 저장한다: digest_json은 D1 documents에, 루트 요약은
 * Vectorize에 kind=digest 벡터로 넣는다 (길잡이용 — 답변 근거는 원본 청크).
 * 구간 요약은 Vectorize에 넣지 않는다 (루트 digest만 넣어 본 뒤 회수율을 보고 정한다).
 * 벡터 upsert 실패는 best-effort로 넘긴다 (노드 저장은 이미 끝났고, 검색은 청크로 동작).
 */
export async function saveDigest(
  env: TreeEnv,
  doc: { id: string; title: string; kind: string; owner_id: string | null },
  digest: TranscriptDigest,
): Promise<{ vectorOk: boolean; error?: string }> {
  await env.DB.prepare("UPDATE documents SET digest_json = ? WHERE id = ?")
    .bind(JSON.stringify(digest), doc.id).run();
  try {
    const text = [digest.summary, ...digest.decisions].join(" ").slice(0, 1000);
    const emb = await env.AI.run(EMBED_MODEL, { text: [text] }, aiGatewayOptions({ skipCache: true, tag: "embed" })) as { data: number[][] | number[] };
    const data = emb.data;
    const values = Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) ? (data[0] as number[]) : (data as number[]);
    if (!Array.isArray(values) || values.length !== EMBED_DIMS) throw new Error(`digest embedding dims ${Array.isArray(values) ? values.length : "?"} != ${EMBED_DIMS}`);
    await env.VECTOR.upsert([{
      id: digestVectorId(doc.id),
      values,
      metadata: {
        title: doc.title, section: "요약", snippet: digest.summary.slice(0, 220),
        kind: "digest", pool: poolForDoc(doc.kind, doc.owner_id), user_id: vectorUserIdForDoc(doc.owner_id),
      },
    }]);
    return { vectorOk: true };
  } catch (e) {
    return { vectorOk: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- 문서 단위 트리 빌드 (Queue 소비자 진입점) ------------------------------------

/**
 * 한 문서의 트리를 만든다 (멱등).
 * - kind='policy'와 'tacit'은 건너뛴다 (HR 규정은 조문 단위로 이미 깔끔하고,
 *   요약하면 정확한 문구가 뭉개진다. tacit 답도 짧아 트리가 필요 없다).
 * - tree_hash가 본문 해시와 같으면 건너뛴다.
 * - 파일: 결정적 파싱. 전사본: LLM 1회 (digest + 구간).
 * - LLM 실패 시 throw하지 않고 {built:false, reason}를 돌려준다 (fail-open —
 *   검색은 청크·벡터로 정상 동작하고, tree_hash를 남기지 않아 나중에 다시 시도할 수 있다).
 * - 그 밖의 D1 오류는 throw한다 (큐가 재시도하게).
 */
export async function buildTreeForDoc(
  env: TreeEnv,
  docId: string,
): Promise<{ built: boolean; nodes?: number; digestVectorOk?: boolean; reason?: string; relinked?: number }> {
  const doc = await env.DB.prepare("SELECT id, title, kind, content, owner_id, tree_hash FROM documents WHERE id = ?").bind(docId)
    .first<{ id: string; title: string; kind: string; content: string; owner_id: string | null; tree_hash: string | null }>();
  if (!doc) return { built: false, reason: "document not found" };
  if (doc.kind !== "transcript" && doc.kind !== "file") {
    return { built: false, reason: `kind ${doc.kind} skipped` };
  }
  const hash = await treeHash(doc.content);
  if (doc.tree_hash === hash) {
    // 트리는 최신이지만, 재색인으로 chunk가 다시 만들어져 node_id만 비어 있을
    // 수 있다. 기존 노드로 다시 연결만 한다.
    const rows = await env.DB.prepare("SELECT id, doc_id, parent_id, ord, depth, title, summary, chunk_start, chunk_end, source FROM doc_nodes WHERE doc_id = ? ORDER BY ord").bind(docId)
      .all<TreeNode>();
    const linked = await linkChunksToNodes(env, docId, rows.results || []);
    return { built: false, reason: "tree up to date", relinked: linked };
  }
  const chunks = splitMarkdownIntoChunks({ id: doc.id, title: doc.title, body: doc.content });
  if (!chunks.length) return { built: false, reason: "no chunks" };

  if (doc.kind === "file") {
    const nodes = buildFileTree(doc.content, doc.id, doc.title);
    await saveTreeNodes(env, doc.id, nodes);
    await env.DB.prepare("UPDATE documents SET tree_hash = ? WHERE id = ?").bind(hash, doc.id).run();
    return { built: true, nodes: nodes.length };
  }

  // 전사본: LLM 1회. 실패하면 트리 없이 넘어간다 (fail-open).
  // 성공·실패 모두 메타데이터 트레이스를 남긴다 (관측 대상: AI가 들어가는 모든 곳).
  const llmStart = Date.now();
  let result: TranscriptTreeResult;
  try {
    result = await buildTranscriptTree(doc.content, doc.id, doc.title, env.AI);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordMetadataTrace(env, {
      docId: doc.id, operation: "build-transcript-tree", model: LLM_MODEL,
      latencyMs: Date.now() - llmStart, ok: false, error: msg,
    });
    return { built: false, reason: `llm tree failed: ${msg}` };
  }
  await saveTreeNodes(env, doc.id, result.nodes);
  const saved = await saveDigest(env, { id: doc.id, title: doc.title, kind: doc.kind, owner_id: doc.owner_id }, result.digest);
  await env.DB.prepare("UPDATE documents SET tree_hash = ? WHERE id = ?").bind(hash, doc.id).run();
  await recordMetadataTrace(env, {
    docId: doc.id, operation: "build-transcript-tree", model: LLM_MODEL,
    promptTokens: result.usage?.promptTokens, completionTokens: result.usage?.completionTokens,
    latencyMs: Date.now() - llmStart, ok: true,
    segments: Math.max(0, result.nodes.length - 1), digest: true,
  });
  return { built: true, nodes: result.nodes.length, digestVectorOk: saved.vectorOk };
}
