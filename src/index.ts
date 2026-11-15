import { Hono } from "hono";
import type { Context } from "hono";
import PptxGenJS from "pptxgenjs";
import { AgentSession } from "./agent-session";
import { splitOggOpus } from "./ogg";
import { coachingTranscript, docOwnerClause, localReflect, localSearchChunks, localSummarize, policies, poolForDoc, poolForKind, sampleTranscript, SHARED_USER_ID, splitMarkdownIntoChunks, splitPolicyIntoChunks, uid, vectorUserIdForDoc } from "./lib";
import type { RagViewer } from "./lib";
import { AI_GATEWAY_ID, aiGatewayOptions } from "./ai-gateway";
import { decodePlainText, detectDocumentFormat, extractHwpxText } from "./parse";
import { generateDigest, getLatestDigest } from "./digest";
// S4 M6-α: /api/ask 파이프라인과 근거 검색 helper·상수는 ask-pipeline.ts로 옮겼다 (동작 불변).
import {
  EMBED_DIMS, EMBED_MODEL, KEYWORD_GATE_MIN, KNOWLEDGE_EPOCH_KEY, LLM_MODEL, SCORE_FLOOR, VECTOR_INDEX_NAME, VECTOR_SEED_ERROR_KEY,
  ensureVectorSeeded, getKnowledgeEpoch, keywordGate, recordGap, resolveSources, responseText, runAsk,
} from "./ask-pipeline";
import type { Source } from "./ask-pipeline";
// S4 M6-β: 관측·평가 하위 앱(M2·M3·M4)과 큐·cron 진입점.
import { tracesApp } from "./obs/routes-traces";
import { datasetsApp } from "./obs/routes-datasets";
import { evalsApp } from "./obs/routes-evals";
import { createTraceSink, mirrorFeedbackScore } from "./obs/trace";
import { processEvalItem, runScheduledEval, sampleJudgeUserTraces } from "./obs/runner";
import { syncGatewayCosts } from "./obs/costs";
import type { EvalItemMessage } from "./obs/types";
// 로그인 (2026-11-15): 인증 API + adminAllowed(이중 게이트용 상수 시간 비교).
import { authApp } from "./auth-routes";
import { adminAllowed, getSessionUser, isAdminRequest } from "./auth";

export { adminAllowed };

export { AgentSession };

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  VECTOR: VectorizeIndex;
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  // S1 Queues 파이프라인: 전사 완료 이벤트를 보내는 producer 바인딩.
  // 큐는 배포 전에 만들어야 한다 (wrangler.toml [[queues]] 참조).
  // S4: 같은 큐에 평가 항목 메시지(eval-item)도 싣는다 — msg.body.type으로 분기.
  PIPELINE: Queue<QueueMessage>;
  // 운영용 경로(/api/debug-ai, /api/seed-vectors) 보호용 시크릿.
  // 코드·wrangler.toml에 넣지 않고 `wrangler secret put ADMIN_SECRET` /
  // Cloudflare 대시보드에서만 설정한다. 미설정 시 운영 경로는 항상 거부된다.
  ADMIN_SECRET?: string;
  // Turnstile (C7): 봇 보호용. SECRET은 코드에 절대 넣지 않고
  // `wrangler secret put TURNSTILE_SECRET` / 대시보드에서만 설정한다.
  // SITEKEY는 공개 값이라 wrangler.toml [vars]에 넣어도 된다.
  // 둘 다 미설정 시 질문 검증은 건너뛴다 (데모 진행용 fail-open).
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  // S4 비용 동기화 (AI Gateway 로그 REST). CF_ACCOUNT_ID는 [vars](비밀 아님),
  // AIG_LOGS_TOKEN은 secret(`wrangler secret put AIG_LOGS_TOKEN`, AI Gateway 읽기 권한만).
  // 미설정이면 동기화가 안내 오류를 내고 비용은 토큰 기반 추정으로만 보인다.
  CF_ACCOUNT_ID?: string;
  AIG_LOGS_TOKEN?: string;
  // 로그인 (2026-11-15): PASSWORD_PEPPER는 비밀번호 해시용, BOOTSTRAP_SECRET은
  // 최초 HR admin 생성용. 둘 다 `wrangler secret put` / 대시보드에서만 설정한다.
  // 미설정 시 비밀번호 연산·부트스트랩은 거부된다 (fail-closed).
  PASSWORD_PEPPER?: string;
  BOOTSTRAP_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

// LLM_MODEL·EMBED_MODEL·SCORE_FLOOR·KEYWORD_GATE_MIN·Vectorize 시딩 키·EMBED_DIMS는
// ask-pipeline.ts에 있다 (S4 M6-α, 설명 주석도 그쪽으로 옮김).
// Plaud 전사본 입력의 Cloudflare판: Workers AI Whisper.
// 처음에는 `@cf/openai/whisper` + `{ audio: number[] }`를 썼으나, Ogg Opus
// 입력에서 호출이 끝나지 않고 조용히 멈췄다 (2분짜리 489KB 클립도 5분 넘게
// 무응답 — 2026-11-13 확인). Cloudflare 공식 튜토리얼(대용량 오디오 청킹)이
// 쓰는 `@cf/openai/whisper-large-v3-turbo` + Base64 문자열 입력으로 바꾼다.
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Plaud와 동일 상한
// 문서 파일 업로드 상한 (C5 Phase 3, 우리 쪽 상한 — toMarkdown 공식 문서에
// 파일 크기 상한이 명시돼 있지 않다). 10MB면 HR 규정·보고서·HWPX 대부분을
// 커버하고, 128MB isolate 메모리에도 여유가 있다.
const MAX_DOC_BYTES = 10 * 1024 * 1024;
// 긴 오디오는 구간 단위로 나눠 전사한다 (사용자 합의: 한 번에 시도 → 안 되면
// 30분 → 그래도 안 되면 15분). 구간 크기는 Cloudflare 공식 청킹 튜토리얼이
// 쓰는 1MB를 따른다: 15분 구간(3.8MB)은 첫 구간 Whisper 호출이 27분 동안
// 안 끝나고 백그라운드 작업이 조용히 죽었다 (2026-11-13 확인). 1.9MB/6분
// mp3와 489KB/2분 ogg 클립은 1분 안에 전사됐다. 시간 상한 15분도 함께 둔다.
const CHUNK_SECONDS = 900;
const CHUNK_BYTES = 1024 * 1024;
// 질문 레이트 리밋 (C7): 세션/IP 기준 분당 20회. 초과 시 429 + 재시도 안내.
// 계획서에 수치가 없어 분당 20회로 잡았다. KV get+put이라 동시 호출에
// 완벽하지 않지만 데모 보호용으로는 충분하다.
const ASK_RATE_LIMIT_PER_MINUTE = 20;
// Turnstile siteverify 엔드포인트 (C7).
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// S1 Queues 파이프라인: 전사 완료 이벤트 → 요약 → 색인.
// 메시지 형식: 소비자가 docId로 D1을 다시 읽으므로 메시지에는 식별자만 싣는다.
// 큐는 at-least-once 전달이라 소비자는 멱등해야 한다 — 요약은 UPDATE로 덮어쓰고
// 색인은 chunks DELETE 후 재삽입 + Vectorize upsert라 다시 돌려도 같은 결과가 나온다.
type PipelineMessage = {
  type: "transcript-pipeline";
  version: 1;
  recordingId: string;
  docId: string;
  title: string;
  enqueuedAt: string;
};
// S4: 큐 메시지 유니온 (전사 파이프라인 | 평가 항목 1건).
type QueueMessage = PipelineMessage | EvalItemMessage;
// S4 평가 cron: 03:00 KST. 07:00 KST 다이제스트 cron(0 22 * * *)과 event.cron으로 구분한다.
const EVAL_CRON = "0 18 * * *";
// trace sink (M2): runAsk가 끝날 때 ask_events + spans/retrievals + R2 원문을 기록한다.
const traceSink = createTraceSink();
const PIPELINE_QUEUE_NAME = "people-os-pipeline";
// 파이프라인 단계 (recordings.pipeline_stage): queued → transcribing →
// queued(전사 완료, 요약 대기) → summarizing → indexing → done / failed.
// failed는 재시도(max_retries) 후에도 안 된 상태 — 전사본은 D1/R2에 그대로 있고
// POST /api/recordings/:id/pipeline-retry로 다시 큐에 넣는다.
type PipelineStage = "queued" | "transcribing" | "summarizing" | "indexing" | "done" | "failed";

// 운영용 경로 보호: /api/debug-ai, /api/seed-vectors는 X-Admin-Secret 헤더가
// ADMIN_SECRET 환경값과 일치할 때만 허용한다. 시크릿이 설정돼 있지 않으면
// 항상 거부한다 (fail-closed). adminAllowed 본체는 src/auth.ts에 있다
// (obs 하위 앱·로그인 이중 게이트와 같은 상수 시간 비교를 쓴다).
// S4: obs 하위 앱(routes-datasets)도 이 함수를 import한다.

// Turnstile 토큰 검증 (C7). 시크릿이 설정돼 있지 않으면 검증을 건너뛰고
// 로그만 남긴다 (데모 진행용 fail-open — 키를 설정하면 검증이 켜진다).
// siteverify 호출 자체가 실패해도 fail-open으로 넘긴다 (일시 장애 시
// 데모가 멈추지 않게). 검증 실패(토큰 없음·위조)만 403으로 막는다.
async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!env.TURNSTILE_SECRET) {
    console.log("[turnstile] skipped: TURNSTILE_SECRET not set (fail-open for demo)");
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, error: "bot check token is required — please retry the question" };
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) form.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const data = await res.json() as { success?: boolean; "error-codes"?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, error: `turnstile verification failed: ${(data["error-codes"] || []).join(",") || "unknown"}` };
  } catch (e) {
    console.log("[turnstile] verify call failed, fail-open:", e instanceof Error ? e.message : String(e));
    return { ok: true, skipped: true, error: "verify service unreachable (fail-open)" };
  }
}

// KV 레이트 리밋 (C7): 세션 기준 60초 슬라이딩 윈도우에
// ASK_RATE_LIMIT_PER_MINUTE회. 고정 분(캘린더 분) 윈도우는 경계를 넘기면
// 카운터가 리셋돼 21번째가 안 걸릴 수 있어 슬라이딩으로 바꿨다 (C5-b 검증).
// KV 실패 시 fail-open (차단하지 않음) — 로컬 Miniflare KV가 없어도
// 질문이 막히지 않게 한다.
async function checkAskRateLimit(env: Env, clientKey: string): Promise<{ allowed: boolean; remaining: number; resetInSec: number }> {
  const key = `rl:ask:${clientKey}`;
  const now = Date.now();
  try {
    const raw = await env.CACHE.get(key);
    const stamps: number[] = raw ? (JSON.parse(raw) as number[]).filter((t) => now - t < 60_000) : [];
    if (stamps.length >= ASK_RATE_LIMIT_PER_MINUTE) {
      const oldest = Math.min(...stamps);
      const resetInSec = Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000));
      return { allowed: false, remaining: 0, resetInSec };
    }
    stamps.push(now);
    await env.CACHE.put(key, JSON.stringify(stamps), { expirationTtl: 120 });
    return { allowed: true, remaining: ASK_RATE_LIMIT_PER_MINUTE - stamps.length, resetInSec: 60 };
  } catch {
    return { allowed: true, remaining: ASK_RATE_LIMIT_PER_MINUTE, resetInSec: 60 };
  }
}

// Whisper는 무음·잡음에 "Thank you very much." 같은 문장을 반복하는 환각을
// 내는 경우가 있다 (무음 wav 테스트에서 확인). 짧은 구절이 절반 이상을 차지하면
// 전사로 보지 않고 pending 처리한다.
function isDegenerateTranscript(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / words.length > 0.5;
}

// Base64 인코딩 (node:buffer 없이 — Worker에서 의존성 없이 동작).
function base64Encode(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : "=";
  }
  return out;
}

async function transcribeAudio(env: Env, bytes: Uint8Array): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    // 90초 넘게 안 끝나면 실패로 친다. Whisper 호출이 조용히 멈추는 경우가
    // 있어 (97분 ogg 15분 구간: 27분 무응답) 타임아웃 없이는 구간이 영원히
    // 멈춘다. 90초로 잡은 이유: fetch 핸들러 자체도 약 2분 뒤에 죽을 수
    // 있어, 타임아웃이 그보다 길면 핸들러가 먼저 죽어 실패 처리가 안 된다.
    // 실패 구간은 건너뛰고 나머지는 이어서 전사한다.
    const out = await Promise.race([
      env.AI.run(WHISPER_MODEL, { audio: base64Encode(bytes) }, aiGatewayOptions({ skipCache: true, tag: "whisper" })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("whisper timed out after 90s")), 90_000)),
    ]);
    const text = (out as { text?: string }).text ?? "";
    if (!text.trim()) return { ok: false, reason: "whisper returned empty text" };
    if (isDegenerateTranscript(text)) return { ok: false, reason: "whisper returned repeated filler text (likely silence/noise)" };
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// S1 파이프라인 단계 기록: failed가 아니면 에러를 비운다.
async function setPipelineStage(env: Env, recordingId: string, stage: PipelineStage, error?: string | null): Promise<void> {
  await env.DB.prepare("UPDATE recordings SET pipeline_stage = ?, pipeline_error = ? WHERE id = ?")
    .bind(stage, stage === "failed" ? (error ?? "pipeline failed") : null, recordingId).run();
}

// S1: 전사 완료 이벤트를 큐에 보낸다. 소비자가 요약 → 색인을 처리한다.
async function enqueuePipeline(env: Env, recordingId: string, docId: string, title: string): Promise<void> {
  const msg: PipelineMessage = {
    type: "transcript-pipeline",
    version: 1,
    recordingId,
    docId,
    title,
    enqueuedAt: new Date().toISOString(),
  };
  await env.PIPELINE.send(msg);
}

// R2 오디오를 구간 단위로 전사해 recordings 행을 ready/pending으로 만든다.
// 진행 위치(done_chunks)와 완료분 텍스트(partial)를 행에 남겨, 여러 호출에
// 나눠 이어갈 수 있다. 배경: waitUntil 백그라운드 작업이 약 2분 뒤에 조용히
// 죽는다 (97분 ogg: 3/24 구간까지만 진행, 2026-11-13 확인). 그래서
// - 업로드 직후 waitUntil은 처음 2구간(60초 예산)까지만 돌리고,
// - 프론트 폴링이 POST /api/recordings/:id/advance로 한 번에 1구간씩 이어간다.
// - 한 구간 Whisper 호출이 150초 넘게 안 끝나면 그 구간은 건너뛰고 다음으로 간다.
// - 동시 실행은 lock_until 잠금으로 막는다 (180초 TTL, 죽은 작업은 다음 호출이 재개).
// 전사본을 지어내지 않는다: 실패 구간은 "[구간 N 전사 실패]" 자리 표시자만 남긴다.
async function advanceRecording(env: Env, recordingId: string, opts: { maxSegments: number; maxMs: number }): Promise<{ status: string; locked?: boolean }> {
  const row = await env.DB.prepare("SELECT id, title, object_key, mime_type, transcript_status, partial, done_chunks, owner_id FROM recordings WHERE id = ?").bind(recordingId)
    .first<{ id: string; title: string; object_key: string; mime_type: string; transcript_status: string; partial: string | null; done_chunks: number | null; owner_id: string | null }>();
  if (!row) return { status: "missing" };
  if (row.transcript_status === "ready") return { status: "ready" };
  if (row.transcript_status === "pending") return { status: "pending" };
  const now = Date.now();
  const lockUntil = now + 180_000;
  const lockRes = await env.DB.prepare("UPDATE recordings SET lock_until = ? WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)").bind(lockUntil, recordingId, now).run();
  if ((((lockRes as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1)) return { status: "processing", locked: true };
  // S1: 구간 전사가 실제로 시작되면 단계를 transcribing으로 남긴다.
  await setPipelineStage(env, recordingId, "transcribing").catch(() => {});
  try {
    const obj = await env.FILES.get(row.object_key);
    if (!obj) {
      await env.DB.prepare("UPDATE recordings SET transcript_status = 'pending', progress = '실패: R2에서 오디오를 찾을 수 없습니다' WHERE id = ?").bind(recordingId).run();
      // 전사가 시작도 못 했으니 파이프라인 단계도 대기로 되돌린다.
      await setPipelineStage(env, recordingId, "queued").catch(() => {});
      return { status: "pending" };
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const isOgg = row.mime_type.includes("ogg") || row.object_key.toLowerCase().endsWith(".ogg");
    let chunks: Uint8Array[] = [bytes];
    if (isOgg) {
      const split = splitOggOpus(bytes, CHUNK_SECONDS, CHUNK_BYTES);
      if (split && split.segments.length > 1) chunks = split.segments;
    }
    let done = row.done_chunks ?? 0;
    let partial = row.partial ?? "";
    const started = Date.now();
    let processed = 0;
    while (done < chunks.length && processed < opts.maxSegments && Date.now() - started < opts.maxMs) {
      await env.DB.prepare("UPDATE recordings SET progress = ? WHERE id = ?")
        .bind(chunks.length > 1 ? `${done + 1}/${chunks.length} 구간 전사 중` : "전사 중", recordingId).run();
      const r = await transcribeAudio(env, chunks[done]);
      if (r.ok) partial += (partial ? "\n" : "") + r.text;
      else partial += (partial ? "\n" : "") + `[구간 ${done + 1} 전사 실패 — 이 부분은 건너뛰었습니다]`;
      done++;
      processed++;
      await env.DB.prepare("UPDATE recordings SET partial = ?, done_chunks = ?, progress = ? WHERE id = ?")
        .bind(partial, done, chunks.length > 1 ? `${done}/${chunks.length} 구간 전사 중` : "전사 중", recordingId).run();
    }
    if (done >= chunks.length) {
      const realText = partial.replace(/\[구간 \d+ 전사 실패[^\]]*\]/g, "").trim();
      if (!realText) {
        await env.DB.prepare("UPDATE recordings SET transcript_status = 'pending', progress = '실패: Whisper가 텍스트를 못 뽑았습니다' WHERE id = ?").bind(recordingId).run();
        // 전사본이 비어 전사가 실패했으니 파이프라인 단계도 대기로 되돌린다.
        await setPipelineStage(env, recordingId, "queued").catch(() => {});
        return { status: "pending" };
      }
      const docId = uid("doc");
      // 개인별 RAG 격리: 전사본 문서는 녹음 행의 소유자를 그대로 복사한다.
      await env.DB.prepare("INSERT INTO documents (id, title, kind, content, r2_key, owner_id) VALUES (?, ?, 'transcript', ?, ?, ?)")
        .bind(docId, row.title.replace(/\.[^.]+$/, ""), partial, row.object_key, row.owner_id ?? null).run();
      await env.DB.prepare("UPDATE recordings SET transcript = ?, transcript_status = 'ready', doc_id = ?, progress = NULL WHERE id = ?")
        .bind(partial, docId, recordingId).run();
      // S1: 전사 완료 → 요약·색인은 큐 소비자에게 넘긴다. enqueue에 실패해도
      // 전사본 자체는 ready로 남기고 파이프라인만 failed로 표시한다
      // (재시도는 POST /api/recordings/:id/pipeline-retry).
      try {
        await enqueuePipeline(env, recordingId, docId, row.title);
        await setPipelineStage(env, recordingId, "queued");
      } catch (e) {
        await setPipelineStage(env, recordingId, "failed", `enqueue failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
      }
      return { status: "ready" };
    }
    return { status: "processing" };
  } finally {
    await env.DB.prepare("UPDATE recordings SET lock_until = NULL WHERE id = ?").bind(recordingId).run().catch(() => {});
  }
}

// Workers AI 응답 → 문자열은 responseText (ask-pipeline.ts). JSON 답은 ```json
// 펜스로 감싸져 오는 경우가 있어 통째로 JSON.parse하면 실패한다. 펜스를 벗긴 뒤
// 첫 {부터 마지막 }까지만 파싱한다.
function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no json object in ai response");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// FlowDesk slides-export.mjs의 officeText와 동일: XML 1.0에서 금지된 문자 제거.
// 요약·액션 텍스트를 그대로 PPTX에 넣으면 깨질 수 있어 먼저 거른다.
function officeText(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

type DeckSection = { heading: string; items: string[] };

// S3 덱 개요 편집: 클라이언트가 보낸 개요를 검증·정리해 DeckSection[]으로.
// - 개요가 없으면 present=false (기존 요약/액션/bullets 경로 그대로).
// - 개요가 들어왔는데 정리 후 남는 슬라이드가 없으면 400 (빈 슬라이드는
//   만들지 않는다). 제목이 빈 슬라이드는 "내용"으로, 빈 불릿은 버린다.
// - 슬라이드 최대 12장, 슬라이드당 불릿 최대 12개, 제목 120자·불릿 500자로 자른다.
type DeckOutlineSlide = { heading?: unknown; bullets?: unknown };
type DeckOutline = { title?: unknown; slides?: unknown };

function normalizeOutline(outline: unknown): { present: boolean; sections: DeckSection[]; title: string } {
  if (outline == null) return { present: false, sections: [], title: "" };
  if (typeof outline !== "object" || Array.isArray(outline)) return { present: true, sections: [], title: "" };
  const o = outline as DeckOutline;
  const title = typeof o.title === "string" ? o.title.trim().slice(0, 120) : "";
  const sections: DeckSection[] = [];
  if (Array.isArray(o.slides)) {
    for (const raw of o.slides.slice(0, 12)) {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const slide = raw as DeckOutlineSlide;
      const heading = (typeof slide.heading === "string" ? slide.heading.trim() : "").slice(0, 120) || "내용";
      const items = (Array.isArray(slide.bullets) ? slide.bullets : [])
        .map((b) => String(b ?? "").trim())
        .filter((b) => b.length > 0)
        .slice(0, 12)
        .map((b) => b.slice(0, 500));
      if (!items.length) continue; // 불릿이 없는 슬라이드는 만들지 않는다
      sections.push({ heading, items });
    }
  }
  return { present: true, sections, title };
}

// Stage 1 덱 생성 — easy-slides 방식: pptxgenjs로 새 덱을 처음부터 만든다.
// 표지(남색) + 섹션별 내용 슬라이드. people-insight 팔레트(#123863/#2d7dde/#14233a).
// Stage 2(보류): FlowDesk식 기존 덱 제자리 편집(jszip 왕복) + R2 버전 관리 — ARCHITECTURE.md 참조.
async function buildDeck(title: string, sections: DeckSection[]): Promise<{ bytes: Uint8Array; slides: number }> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PEOPLE_OS_16_9", width: 13.33, height: 7.5 });
  pptx.layout = "PEOPLE_OS_16_9";
  pptx.author = "일잇 People OS";
  pptx.title = officeText(title);
  pptx.subject = officeText(title);
  pptx.theme = { headFontFace: "Malgun Gothic", bodyFontFace: "Malgun Gothic" };

  // 표지
  const cover = pptx.addSlide();
  cover.background = { color: "123863" };
  cover.addShape("rect", { x: 0.6, y: 0.55, w: 0.9, h: 0.08, fill: { color: "2D7DDE" }, line: { color: "2D7DDE", width: 0 } });
  cover.addText("일잇 PEOPLE OS", { x: 0.6, y: 0.85, w: 8, h: 0.4, fontSize: 14, color: "BFD3EA", bold: true, fontFace: "Malgun Gothic" });
  cover.addText(officeText(title), { x: 0.6, y: 1.5, w: 12.1, h: 2.4, fontSize: 40, color: "FFFFFF", bold: true, fontFace: "Malgun Gothic", valign: "top" });
  cover.addText("회의 요약 초안 · Cloudflare Workers", { x: 0.6, y: 4.1, w: 9, h: 0.5, fontSize: 16, color: "BFD3EA", fontFace: "Malgun Gothic" });
  cover.addText(new Date().toISOString().slice(0, 10), { x: 0.6, y: 6.8, w: 4, h: 0.4, fontSize: 12, color: "8FA8C4", fontFace: "Malgun Gothic" });

  let slides = 1;
  for (const sec of sections) {
    if (!sec.items.length) continue;
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape("rect", { x: 0.6, y: 0.5, w: 0.5, h: 0.09, fill: { color: "2D7DDE" }, line: { color: "2D7DDE", width: 0 } });
    s.addText(officeText(sec.heading), { x: 0.6, y: 0.75, w: 12.1, h: 0.7, fontSize: 28, color: "123863", bold: true, fontFace: "Malgun Gothic" });
    s.addText(
      sec.items.map((it) => ({ text: officeText(it), options: { bullet: { indent: 18 }, paraSpaceAfter: 10, fontSize: 18, color: "14233A", fontFace: "Malgun Gothic" } })),
      { x: 0.6, y: 1.7, w: 12.1, h: 5.1, valign: "top" }
    );
    s.addText("일잇 People OS", { x: 0.6, y: 7.0, w: 4, h: 0.3, fontSize: 11, color: "718096", fontFace: "Malgun Gothic" });
    slides++;
  }
  const out = await pptx.write({ outputType: "uint8array" });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
  return { bytes, slides };
}

async function ensureSchema(db: D1Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'transcript', content TEXT NOT NULL, summary TEXT, actions TEXT, r2_key TEXT, author TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, title TEXT NOT NULL, section TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reflections (id TEXT PRIMARY KEY, session_id TEXT, transcript TEXT NOT NULL, questions TEXT, patterns TEXT, next_questions TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT);
    CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, title TEXT NOT NULL, r2_key TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, slides INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'workers-ai', model TEXT NOT NULL DEFAULT '@cf/openai/whisper', object_key TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0, transcript TEXT, transcript_status TEXT NOT NULL DEFAULT 'pending', doc_id TEXT, progress TEXT, partial TEXT DEFAULT '', done_chunks INTEGER DEFAULT 0, lock_until INTEGER, pipeline_stage TEXT NOT NULL DEFAULT 'queued', pipeline_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, article TEXT NOT NULL, text TEXT NOT NULL, ord INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ask_events (id TEXT PRIMARY KEY, session_id TEXT, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', source_ids TEXT NOT NULL DEFAULT '[]', grounded INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT '', search_engine TEXT NOT NULL DEFAULT '', timings_json TEXT NOT NULL DEFAULT '{}', feedback TEXT, feedback_comment TEXT, feedback_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS knowledge_gaps (id TEXT PRIMARY KEY, question TEXT NOT NULL, asked_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', doc_id TEXT, count INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'no-evidence');
  `);
}

async function ensureSeeded(db: D1Database) {
  await ensureSchema(db);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM policies").first<{ n: number }>();
  if (!count || count.n === 0) {
    for (const p of policies()) {
      await db.prepare("INSERT OR IGNORE INTO policies (id, title, section, body) VALUES (?, ?, ?, ?)").bind(p.id, p.title, p.section, p.body).run();
    }
  }
  // 조문 청킹 (C5): policies와 별개로 세어, 마이그레이션 0006 적용 뒤
  // 이미 정책이 있는 DB에서도 chunk가 채워지게 한다. 멱등.
  const chunkCount = await db.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
  if (!chunkCount || chunkCount.n === 0) {
    for (const p of policies()) {
      for (const ch of splitPolicyIntoChunks(p)) {
        await db.prepare("INSERT OR IGNORE INTO chunks (id, doc_id, article, text, ord) VALUES (?, ?, ?, ?, ?)").bind(ch.id, ch.doc_id, ch.article, ch.text, ch.ord).run();
      }
    }
  }
}

function bindingStatus(env: Env) {
  return {
    d1: !!env.DB,
    kv: !!env.CACHE,
    r2: !!env.FILES,
    vectorize: !!env.VECTOR,
    ai: !!env.AI,
    durable_objects: !!env.AGENT_SESSION,
  };
}

// ---- health ----
app.post("/api/health", async (c) => {
  await ensureSeeded(c.env.DB);
  // 프론트가 로드 때 POST /api/health를 부르므로, 여기서 Vectorize lazy
  // 시딩도 함께 워밍업한다 (첫 질문 전에 인덱스를 채워둔다).
  await ensureVectorSeeded(c.env);
  return c.json({ ok: true, service: "people-os", mode: "live", bindings: bindingStatus(c.env), note: "Workers AI / Vectorize는 로컬에서 폴백으로 동작할 수 있다. wrangler dev --local 기준." });
});
app.get("/api/health", async (c) => {
  await ensureSeeded(c.env.DB);
  await ensureVectorSeeded(c.env);
  return c.json({ ok: true, service: "people-os", mode: "live", bindings: bindingStatus(c.env) });
});

// Vectorize 시딩 상태 (C5 Phase 2, 공개 읽기 전용): 시딩이 안 돼 있으면
// 여기서 직접 시딩을 시도한 뒤 상태를 돌려준다. 비밀·문서 내용은 안 나온다.
app.get("/api/seed-status", async (c) => {
  await ensureSeeded(c.env.DB);
  const seed = await ensureVectorSeeded(c.env);
  const chunks = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
  const errRow = await c.env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(VECTOR_SEED_ERROR_KEY).first<{ value: string }>();
  let lastError: string | null = null;
  if (errRow) {
    try { lastError = (JSON.parse(errRow.value) as { error?: string }).error ?? errRow.value; }
    catch { lastError = errRow.value; }
  }
  return c.json({ ok: true, model: EMBED_MODEL, index: VECTOR_INDEX_NAME, dims: EMBED_DIMS, seeded: seed.seeded, upserted: seed.upserted ?? null, chunks: chunks?.n ?? 0, lastError, error: seed.error ?? null });
});

// ---- documents ----
app.post("/api/documents", async (c) => {
  await ensureSeeded(c.env.DB);
  // 파일 업로드: multipart/form-data (C5 Phase 3 파서 라우팅).
  const ct = c.req.header("content-type") || "";
  if (ct.includes("multipart/form-data")) return handleDocumentFileUpload(c);
  const body = await c.req.json().catch(() => ({})) as { title?: string; content?: string; kind?: string; personal?: boolean };
  if (!body.content || body.content.trim().length < 3) return c.json({ ok: false, error: "content is required" }, 400);
  const id = uid("doc");
  const title = body.title || body.content.slice(0, 40);
  const kind = body.kind || "transcript";
  // 개인별 RAG 격리: 전사본은 기본 개인 소유(세션 사용자, 없으면 공용 NULL),
  // file/tacit은 기본 공용(NULL)이고 body.personal:true일 때만 개인으로 한다.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const ownerId = kind === "transcript" ? (viewer?.id ?? null) : (body.personal === true ? (viewer?.id ?? null) : null);
  const r2Key = `documents/${id}.txt`;
  let r2Stored = false;
  try {
    await c.env.FILES.put(r2Key, body.content);
    r2Stored = true;
  } catch {
    r2Stored = false; // 로컬 Miniflare R2 실패 시 D1에만 저장 (폴백)
  }
  await c.env.DB.prepare("INSERT INTO documents (id, title, kind, content, r2_key, owner_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, title, kind, body.content, r2Stored ? r2Key : null, ownerId).run();
  return c.json({ ok: true, id, title, r2Stored, fallback: !r2Stored ? "d1-only" : null }, 201);
});

// 문서 파일 업로드 (C5 Phase 3 파서 라우팅).
// multipart/form-data의 `file` 필드를 받아 매직 바이트로 형식을 판별하고,
// HWPX는 Worker 안에서 직접, PDF·DOCX·XLSX·이미지는 Workers AI
// toMarkdown()으로 텍스트를 뽑아 indexDocument 경로로 색인한다.
// - 원본은 추출 성공 여부와 관계없이 R2 docs/<id>/source.<ext>에 남긴다.
// - 추출본은 R2 docs/<id>/extracted.md에, D1 content에도 넣어 기존
//   요약·질문·라이브러리 흐름이 그대로 동작하게 한다.
// - 추출 실패 시에도 문서 행은 만든다 (extract_status='failed', 사유를
//   extract_error에). 내용을 지어내지 않고, 실패한 문서는 색인하지 않는다.
// - HWP 5.0 바이너리는 공모전 범위 밖이라 변환하지 않고 안내만 한다.
async function handleDocumentFileUpload(c: Context<{ Bindings: Env }>) {
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: "multipart form-data is required" }, 400);
  const file = form.get("file");
  const isUpload = file !== null && typeof file === "object" && "arrayBuffer" in file && typeof (file as File).size === "number";
  if (!isUpload) return c.json({ ok: false, error: "문서 파일이 필요합니다 (field: file)" }, 400);
  const f = file as File;
  if (f.size <= 0) return c.json({ ok: false, error: "빈 파일입니다" }, 400);
  if (f.size > MAX_DOC_BYTES) return c.json({ ok: false, error: "파일은 10MB 이하만 올릴 수 있습니다" }, 400);

  const id = uid("doc");
  const title = ((form.get("title") as string) || "").trim() || f.name.replace(/\.[^.]+$/, "") || f.name;
  // 개인별 RAG 격리: form의 personal 필드가 "true"이고 로그인돼 있으면 개인 업로드.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const ownerId = (form.get("personal") as string | null) === "true" && viewer ? viewer.id : null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const detected = detectDocumentFormat(bytes);
  const ext = (f.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const sourceKey = `docs/${id}/source.${ext}`;
  let sourceStored = false;
  try {
    await c.env.FILES.put(sourceKey, bytes, { httpMetadata: { contentType: f.type || "application/octet-stream" } });
    sourceStored = true;
  } catch { sourceStored = false; }

  let extracted = "";
  let extractError: string | null = null;
  if (detected.format === "ole") {
    extractError = "HWP 5.0 / 구형 Office 파일은 변환할 수 없습니다. HWPX 또는 PDF로 저장해 올려 주세요.";
  } else if (detected.format === "unknown") {
    extractError = `지원하지 않는 파일 형식입니다 (${detected.detail}). PDF, DOCX, XLSX, HWPX, 이미지, 텍스트 파일을 올려 주세요.`;
  } else if (detected.format === "text") {
    extracted = decodePlainText(bytes);
    if (extracted.trim().length < 3) extractError = "텍스트를 추출하지 못했습니다. 내용이 없는 파일입니다.";
  } else if (detected.format === "hwpx") {
    try {
      extracted = extractHwpxText(detected.zipEntries ?? {});
      if (extracted.trim().length < 3) extractError = "HWPX에서 텍스트를 추출하지 못했습니다. 텍스트가 없는 문서이거나 파일이 손상됐을 수 있습니다.";
    } catch (e) {
      extractError = `HWPX 압축을 풀지 못했습니다: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    }
  } else {
    // pdf / ooxml / image / markup → Workers AI toMarkdown.
    // toMarkdown은 파일명(name)으로 변환기를 고르므로 원본 파일명을 그대로 넘긴다.
    // 게이트웨이 옵션은 S2와 같은 people-os 게이트웨이 (배포 전에 대시보드 생성 필요).
    try {
      const blob = new Blob([bytes.buffer], { type: f.type || "application/octet-stream" });
      const conv = await c.env.AI.toMarkdown({ name: f.name, blob }, { gateway: { id: AI_GATEWAY_ID, skipCache: true } });
      if (conv.format === "markdown" && conv.data.trim().length >= 3) {
        extracted = conv.data;
      } else if (conv.format === "error") {
        extractError = `문서 변환에 실패했습니다: ${conv.error.slice(0, 200)}`;
      } else {
        extractError = "문서 변환 결과가 비어 있습니다. 텍스트가 없는 문서일 수 있습니다.";
      }
    } catch (e) {
      extractError = `문서 변환에 실패했습니다: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    }
  }

  const extractStatus = extractError ? "failed" : "ready";
  const extractedKey = `docs/${id}/extracted.md`;
  let extractedStored = false;
  if (!extractError) {
    try {
      await c.env.FILES.put(extractedKey, extracted, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      extractedStored = true;
    } catch { extractedStored = false; }
  }
  await c.env.DB.prepare("INSERT INTO documents (id, title, kind, content, r2_key, source_r2_key, extract_status, extract_error, owner_id) VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?)")
    .bind(id, title, extracted, !extractError && extractedStored ? extractedKey : null, sourceStored ? sourceKey : null, extractStatus, extractError, ownerId).run();
  let chunks = 0;
  let upserted = 0;
  let indexError: string | undefined;
  if (!extractError && extracted.trim().length >= 3) {
    const indexed = await indexDocument(c.env, { id, title, markdown: extracted, kind: "file", ownerId });
    chunks = indexed.chunks;
    upserted = indexed.upserted;
    indexError = indexed.indexError;
  }
  return c.json({ ok: true, id, title, format: detected.format, extractStatus, extractError, chunks, upserted, indexError: indexError ?? null, r2Stored: extractedStored }, 201);
}

// 문서 요약 공용 함수 — POST /api/documents/:id/summarize와 S1 큐 소비자가 함께 쓴다.
// Workers AI 시도 → 실패 시 추출식 폴백(localSummarize). D1에 저장까지 한다.
// 멱등: 다시 돌려도 같은 행을 덮어쓴다.
async function summarizeDocument(env: Env, docId: string): Promise<{ summary: string[]; actions: string[]; engine: string }> {
  const doc = await env.DB.prepare("SELECT id, title, content FROM documents WHERE id = ?").bind(docId)
    .first<{ id: string; title: string; content: string }>();
  if (!doc) throw new Error("document not found");
  let engine = "local-extractive";
  let summary: string[] = [];
  let actions: string[] = [];
  // 1) Workers AI 시도 (클라우드에서 동작, 로컬에서는 실패할 수 있음)
  try {
    const out = await env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: "다음 회의 전사본을 한국어로 3줄 요약하고 액션 아이템을 뽑아라. JSON으로만 답하라: {\"summary\":[\"...\"],\"actions\":[\"...\"]}" },
        { role: "user", content: doc.content.slice(0, 4000) },
      ],
    }, aiGatewayOptions({ tag: "summary" }));
    const text = responseText(out);
    const parsed = extractJson(text);
    if (Array.isArray(parsed.summary) && parsed.summary.length) {
      summary = parsed.summary.slice(0, 3);
      actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
      engine = "workers-ai";
    } else throw new Error("empty ai summary");
  } catch {
    const fb = localSummarize(doc.content);
    summary = fb.summary;
    actions = fb.actions;
    engine = "local-extractive";
  }
  await env.DB.prepare("UPDATE documents SET summary = ?, actions = ? WHERE id = ?")
    .bind(JSON.stringify(summary), JSON.stringify(actions), docId).run();
  return { summary, actions, engine };
}

app.post("/api/documents/:id/summarize", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const doc = await c.env.DB.prepare("SELECT id, title FROM documents WHERE id = ?").bind(id).first<{ id: string; title: string }>();
  if (!doc) return c.json({ ok: false, error: "document not found" }, 404);
  const r = await summarizeDocument(c.env, id);
  return c.json({ ok: true, id, title: doc.title, summary: r.summary, actions: r.actions, engine: r.engine });
});

// ---- transcribe (음성 전사 입력, Plaud transcribe/route.ts 형태의 Cloudflare판) ----
// multipart/form-data file 필드(최대 25MB) → R2 저장 + HEAD 크기 검증 → Whisper 전사
// → 전사본 있으면 documents 행까지 만들고, 없으면 오디오만 pending으로 저장한다.
// 전사본을 지어내지 않는다.
app.post("/api/transcribe", async (c) => {
  await ensureSeeded(c.env.DB);
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: "multipart form-data is required" }, 400);
  const file = form.get("file");
  const isUpload = file !== null && typeof file === "object" && "arrayBuffer" in file && typeof (file as File).size === "number";
  if (!isUpload) return c.json({ ok: false, error: "audio file is required (field: file)" }, 400);
  const f = file as File;
  const audioExts = ["mp3", "m4a", "wav", "ogg", "webm", "mp4", "flac", "aac", "wma"];
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const isAudio = f.type.startsWith("audio/") || f.type.startsWith("video/") || audioExts.includes(ext);
  if (!isAudio) return c.json({ ok: false, error: "audio file is required" }, 400);
  if (f.size <= 0) return c.json({ ok: false, error: "empty file" }, 400);
  if (f.size > MAX_AUDIO_BYTES) return c.json({ ok: false, error: "file must be 25MB or smaller" }, 400);

  const id = uid("rec");
  const title = f.name.replace(/\.[^.]+$/, "") || f.name;
  const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "audio";
  const objectKey = `recordings/${id}/${safeName}`;
  const bytes = new Uint8Array(await f.arrayBuffer());
  // R2 저장 + HEAD 크기 검증 (Plaud DOT_PLAUD_SYNC.md 패턴: put 직후 HEAD로 검증)
  await c.env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: f.type || "application/octet-stream" } });
  const head = await c.env.FILES.head(objectKey).catch(() => null);
  if (!head || head.size !== f.size) return c.json({ ok: false, error: "r2 verify failed after upload", recordingId: id }, 502);

  // 행을 먼저 만들고 전사는 백그라운드로: 긴 파일은 동기 Whisper 호출이
  // 응답 시간 안에 안 끝나서(97분 ogg, 27분 무응답) 행 자체가 안 남았다.
  // 전사본을 지어내지 않는다 — 행은 'processing'으로 시작한다.
  // 개인별 RAG 격리: 전사본은 업로더의 개인 소유(익명이면 공용 NULL).
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT INTO recordings (id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, doc_id, created_at, owner_id) VALUES (?, ?, 'workers-ai', ?, ?, ?, ?, NULL, 'processing', NULL, ?, ?)")
    .bind(id, f.name, WHISPER_MODEL, objectKey, f.type || "application/octet-stream", f.size, now, viewer?.id ?? null).run();
  c.executionCtx.waitUntil(advanceRecording(c.env, id, { maxSegments: 2, maxMs: 60_000 }));
  return c.json({ ok: true, recordingId: id, title: f.name, transcript: null, transcriptStatus: "processing", r2Verified: true, provider: "workers-ai", model: WHISPER_MODEL }, 201);
});

// 최근 음성 녹음 목록 (전사본 내용은 안 돌려준다 — 목록은 메타데이터만)
// 개인별 RAG 격리: hr_admin은 전체, 그 외는 공용(owner_id NULL) + 본인 것만.
app.get("/api/recordings", async (c) => {
  await ensureSeeded(c.env.DB);
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const isAdmin = viewer?.role === "hr_admin";
  const { clause, params } = docOwnerClause(viewer, "recordings");
  const rows = isAdmin
    ? await c.env.DB.prepare("SELECT id, title, provider, model, mime_type, size, transcript_status, progress, pipeline_stage, pipeline_error, doc_id, owner_id, created_at FROM recordings ORDER BY created_at DESC LIMIT 20").all()
    : await c.env.DB.prepare(`SELECT id, title, provider, model, mime_type, size, transcript_status, progress, pipeline_stage, pipeline_error, doc_id, owner_id, created_at FROM recordings WHERE ${clause} ORDER BY created_at DESC LIMIT 20`).bind(...params).all();
  return c.json({ ok: true, recordings: rows.results || [] });
});

app.get("/api/recordings/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const row = await c.env.DB.prepare("SELECT id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, progress, pipeline_stage, pipeline_error, doc_id, owner_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; provider: string; model: string; object_key: string; mime_type: string; size: number; transcript: string | null; transcript_status: string; progress: string | null; doc_id: string | null; owner_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  // 전사본 텍스트가 응답에 포함되므로 소유자 게이트를 둔다: 소유자가 있는
  // 녹음은 소유자 본인 또는 hr_admin만 볼 수 있다. owner_id NULL은 공용.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (row.owner_id && (!viewer || (viewer.id !== row.owner_id && viewer.role !== "hr_admin"))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  return c.json({ ok: true, recording: row });
});

// 프론트 폴링이 부르는 전사 이어가기: 잠금이 없으면 다음 1구간을 여기서
// 직접 전사한다 (fetch 안에서 1회 Whisper 호출, 약 40~60초). 페이지를
// 열어두는 동안 구간마다 전사가 이어진다 — waitUntil 수명(약 2분)에
// 기대지 않는 경로다. 잠금이 걸려 있으면 현재 행만 돌려준다.
app.post("/api/recordings/:id/advance", async (c) => {
  await ensureSeeded(c.env.DB);
  // 소유자 게이트: 전사본 전체 행을 돌려주므로, 전사 작업을 시작하기 전에 확인한다.
  const ownerRow = await c.env.DB.prepare("SELECT owner_id FROM recordings WHERE id = ?").bind(c.req.param("id")).first<{ owner_id: string | null }>();
  if (!ownerRow) return c.json({ ok: false, error: "recording not found" }, 404);
  const advViewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (ownerRow.owner_id && (!advViewer || (advViewer.id !== ownerRow.owner_id && advViewer.role !== "hr_admin"))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  // advanceRecording이 던져도 행을 돌려준다: 500 HTML이 가면 프론트
  // r.json()이 터져 폴링 루프가 죽는다.
  await advanceRecording(c.env, c.req.param("id"), { maxSegments: 1, maxMs: 120_000 }).catch(() => {});
  const row = await c.env.DB.prepare("SELECT id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, progress, pipeline_stage, pipeline_error, doc_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; provider: string; model: string; object_key: string; mime_type: string; size: number; transcript: string | null; transcript_status: string; progress: string | null; doc_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  return c.json({ ok: true, recording: row });
});

// pending 녹음을 R2 오디오로 다시 전사한다. 전사도 백그라운드로 돌린다.
// ready 행은 건드리지 않고, processing 중인 행은 중복 실행하지 않는다.
// 단, processing이 30분 넘게 멈춰 있으면(백그라운드 작업이 조용히 죽은 경우)
// 다시 시작할 수 있게 한다 — 진행 상황은 chunk마다 progress에 남으므로,
// 30분 동안 진전이 없으면 죽은 것으로 본다. 멈춘 processing 행은 완료분
// (partial/done_chunks)을 유지한 채 이어가고, pending 행은 처음부터 다시 한다.
app.post("/api/recordings/:id/retry", async (c) => {
  await ensureSeeded(c.env.DB);
  const row = await c.env.DB.prepare("SELECT id, title, object_key, transcript, transcript_status, doc_id, owner_id, created_at FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; object_key: string; transcript: string | null; transcript_status: string; doc_id: string | null; owner_id: string | null; created_at: string }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  // 소유자 게이트: 남의 녹음을 다시 전사시키는 것을 막는다.
  const retryViewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (row.owner_id && (!retryViewer || (retryViewer.id !== row.owner_id && retryViewer.role !== "hr_admin"))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  if (row.transcript_status === "ready" && row.transcript) return c.json({ ok: true, recordingId: row.id, transcriptStatus: "ready", transcript: row.transcript, docId: row.doc_id, note: "already ready" });
  if (row.transcript_status === "processing") {
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < 30 * 60 * 1000) return c.json({ ok: true, recordingId: row.id, transcriptStatus: "processing", note: "already processing" });
    // 30분 넘게 멈춰 있음 — 죽은 작업으로 보고 완료분은 유지한 채 이어간다.
  } else {
    // pending 행은 처음부터 다시 한다.
    await c.env.DB.prepare("UPDATE recordings SET partial = '', done_chunks = 0 WHERE id = ?").bind(row.id).run();
  }
  await c.env.DB.prepare("UPDATE recordings SET transcript_status = 'processing', progress = NULL WHERE id = ?").bind(row.id).run();
  c.executionCtx.waitUntil(advanceRecording(c.env, row.id, { maxSegments: 2, maxMs: 60_000 }));
  return c.json({ ok: true, recordingId: row.id, transcriptStatus: "processing" });
});

// S1: 실패한 파이프라인을 다시 큐에 넣는다. 전사가 끝나지 않았거나
// 이미 완료된 파이프라인은 건드리지 않는다. DLQ로 간 메시지도 여기서 복구한다.
app.post("/api/recordings/:id/pipeline-retry", async (c) => {
  await ensureSeeded(c.env.DB);
  const row = await c.env.DB.prepare("SELECT id, title, doc_id, transcript_status, pipeline_stage, owner_id FROM recordings WHERE id = ?").bind(c.req.param("id"))
    .first<{ id: string; title: string; doc_id: string | null; transcript_status: string; pipeline_stage: string | null; owner_id: string | null }>();
  if (!row) return c.json({ ok: false, error: "recording not found" }, 404);
  // 소유자 게이트: 남의 녹음 파이프라인을 다시 돌리는 것을 막는다.
  const pipeViewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (row.owner_id && (!pipeViewer || (pipeViewer.id !== row.owner_id && pipeViewer.role !== "hr_admin"))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  if (row.transcript_status !== "ready" || !row.doc_id) {
    return c.json({ ok: false, error: "transcription is not ready yet" }, 409);
  }
  if (row.pipeline_stage === "done") {
    return c.json({ ok: true, recordingId: row.id, pipelineStage: "done", note: "already done" });
  }
  if (row.pipeline_stage !== "failed") {
    return c.json({ ok: true, recordingId: row.id, pipelineStage: row.pipeline_stage, note: "pipeline already in progress" });
  }
  try {
    await enqueuePipeline(c.env, row.id, row.doc_id, row.title);
    await setPipelineStage(c.env, row.id, "queued");
    return c.json({ ok: true, recordingId: row.id, pipelineStage: "queued" });
  } catch (e) {
    return c.json({ ok: false, error: `enqueue failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});

// Source 타입, resolveSources, ensureVectorSeeded, keywordGate, recordGap,
// getKnowledgeEpoch, d1TextSources는 ask-pipeline.ts로 옮겼다 (S4 M6-α, 동작 불변).

// ---- 지식 공백 큐 (C5-b) ----
// 근거 없는 질문·👎 피드백 질문을 D1 knowledge_gaps에 쌓는다 (recordGap, ask-pipeline.ts).
// 지식 epoch (C5-b 캐시 무효화): 암묵지 게시 때 +1한다 (읽기는 getKnowledgeEpoch, ask-pipeline.ts).
async function bumpKnowledgeEpoch(env: Env): Promise<number> {
  const next = (await getKnowledgeEpoch(env)) + 1;
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(KNOWLEDGE_EPOCH_KEY, String(next)).run();
  return next;
}

// 문서 색인 공용 함수 (C5-b): Markdown 문서를 조문/문단 단위 chunk로 나누고
// D1 chunks에 저장한 뒤 bge-m3으로 임베딩해 Vectorize에 upsert한다.
// 정책 시딩(ensureVectorSeeded)과 동일 형식의 메타데이터를 쓴다.
// AI/Vectorize가 안 되면(로컬 dev) D1 chunk는 남기고 indexError를 돌려준다 —
// 게시 자체는 망가뜨리지 않고, D1 텍스트 폴백 경로는 그 chunk로 답할 수 있다.
async function indexDocument(env: Env, doc: { id: string; title: string; markdown: string; kind?: string; ownerId?: string | null }): Promise<{ chunks: number; upserted: number; indexError?: string }> {
  const chunks = splitMarkdownIntoChunks({ id: doc.id, title: doc.title, body: doc.markdown });
  await env.DB.prepare("DELETE FROM chunks WHERE doc_id = ?").bind(doc.id).run();
  for (const ch of chunks) {
    await env.DB.prepare("INSERT OR REPLACE INTO chunks (id, doc_id, article, text, ord) VALUES (?, ?, ?, ?, ?)").bind(ch.id, ch.doc_id, ch.article, ch.text, ch.ord).run();
  }
  try {
    const texts = chunks.map((ch) => `${doc.title} ${ch.article} ${ch.text}`);
    const emb = await env.AI.run(EMBED_MODEL, { text: texts }, aiGatewayOptions({ skipCache: true, tag: "embed" })) as { data: number[][] | number[] };
    const data = emb.data;
    // Workers AI는 텍스트 1개면 data를 평탄한 number[]로, 여러 개면
    // number[][]로 돌려준다 (ask 핸들러도 같은 정규화를 한다). 1개짜리
    // 문서를 2차원이라고 가정하면 여기서 shape 오류로 upsert가 안 된다.
    const rows = Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) ? (data as number[][]) : [data as number[]];
    if (!Array.isArray(data) || rows.length !== texts.length) throw new Error("unexpected embedding response shape");
    if (rows[0].length !== EMBED_DIMS) throw new Error(`embedding dims ${rows[0].length} != index dims ${EMBED_DIMS}`);
    // Vectorize 메타데이터 kind는 문서의 실제 종류를 쓴다 (C5 Phase 3:
    // 파일 업로드 문서가 'tacit'으로 오표시되지 않게. D1 documents.kind가
    // 출처 배지의 기준이고, 여기는 알 수 없는 id 폴백 경로에서만 쓰인다).
    // 개인별 RAG 격리: user_id는 소유자 id, 없으면 공용 센티넬 "shared".
    // pool도 소유자 기준으로 정한다 (개인 파일 업로드가 "공용"으로 보이지 않게).
    const vectors = chunks.map((ch, i) => ({ id: ch.id, values: rows[i], metadata: { title: doc.title, section: ch.article, snippet: ch.text.slice(0, 220), kind: doc.kind ?? "tacit", pool: poolForDoc(doc.kind, doc.ownerId), user_id: vectorUserIdForDoc(doc.ownerId) } }));
    await env.VECTOR.upsert(vectors);
    return { chunks: chunks.length, upserted: vectors.length };
  } catch (e) {
    return { chunks: chunks.length, upserted: 0, indexError: e instanceof Error ? e.message : String(e) };
  }
}

// 게시 검증 (C5-b): 같은 질문으로 근거 검색을 다시 돌려 암묵지 문서가
// 근거로 잡히는지 확인한다. ask 파이프라인과 같은 순서(Vectorize →
// 키워드 게이트 → resolveSources)로 본다.
// - Vectorize upsert가 바로 안 보일 수 있어, 근거가 아예 없을 때만
//   최대 3회(1초 간격) 재시도한다. 다른 근거가 이미 잡히면 중단한다.
// - Vectorize/AI가 안 되면(로컬 dev) D1 텍스트 검색으로 확인한다 —
//   로컬 ask 경로도 같은 D1 폴백을 쓰므로 검증과 실제 동작이 일치한다.
async function verifyTacitEvidence(
  env: Env,
  question: string,
  docId: string,
  docTitle: string
): Promise<{ resolved: boolean; sources: Array<{ id: string; title: string; section: string; score: number }> }> {
  const chunkRows = await env.DB.prepare("SELECT id, doc_id, article, text, ord FROM chunks WHERE doc_id = ? ORDER BY ord").bind(docId)
    .all<{ id: string; doc_id: string; article: string; text: string; ord: number }>();
  const chunkIds = (chunkRows.results || []).map((r) => r.id);
  const isTacit = (sources: Array<{ id: string }>) => sources.some((s) => chunkIds.includes(s.id));
  const summarize = (sources: Source[]) => sources.map((s) => ({ id: s.id, title: s.title, section: s.section, score: s.score }));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensureVectorSeeded(env);
      const emb = await env.AI.run(EMBED_MODEL, { text: [question] }, aiGatewayOptions({ skipCache: true, tag: "embed" })) as { data: number[][] | number[] };
      const raw = emb.data;
      const values = new Float32Array(Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]));
      // 암묵지는 공용이라 공용 필터로만 조회한다 (남의 개인 chunk가 순위에 끼는 것을 막는다).
      const vec = await env.VECTOR.query(values, { topK: 3, returnMetadata: "all", filter: { user_id: SHARED_USER_ID } });
      const matches = (vec.matches || []).filter((m) => (m.score || 0) >= SCORE_FLOOR);
      const gated = await keywordGate(env, question, matches.map((m) => ({ id: String(m.id), score: m.score || 0, metadata: (m.metadata || {}) as Record<string, unknown> })));
      const sources = await resolveSources(env, question, gated);
      if (isTacit(sources)) return { resolved: true, sources: summarize(sources) };
      // 이 문서 chunk가 근거에 안 잡혔어도 D1으로 직접 확인한다.
      // 오래된 중복 문서의 벡터가 위로 와서 가려지는 섀도잉이 있어도,
      // 이 문서 chunk가 질문과 맞으면 근거가 있는 것이다.
      // ask 경로의 D1 폴백과 같은 ≥2 키워드 하한을 쓴다.
      const docChunks = (chunkRows.results || []).map((ch) => ({ ...ch, title: docTitle }));
      const found = localSearchChunks(question, docChunks).filter((f) => f.score >= KEYWORD_GATE_MIN);
      if (found.length) return { resolved: true, sources: found.map((f) => ({ id: f.id, title: docTitle, section: f.article, score: f.score })) };
      if (sources.length > 0) return { resolved: false, sources: summarize(sources) };
      // 근거가 아예 없을 때만 아래 재시도 루프가 돈다.
    } catch {
      // Vectorize/AI 실패 — D1 텍스트 검색으로 확인한다 (로컬 dev 경로).
      const found = localSearchChunks(question, (chunkRows.results || []).map((ch) => ({ ...ch, title: docTitle }))).filter((f) => f.score >= KEYWORD_GATE_MIN);
      if (found.length) return { resolved: true, sources: found.map((f) => ({ id: f.id, title: docTitle, section: f.article, score: f.score })) };
      return { resolved: false, sources: [] };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { resolved: false, sources: [] };
}

// ---- ask (RAG) ----
app.post("/api/ask", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { question?: string; sessionId?: string; turnstileToken?: string; force?: boolean };
  if (!body.question || body.question.trim().length < 2) return c.json({ ok: false, error: "question is required" }, 400);
  const question = body.question.trim();
  const sessionId = body.sessionId || uid("sess");
  // 처리 시간 측정 (C7): 시작 시각을 runAsk에 넘긴다 (timings.total은 Turnstile·레이트 리밋 포함).
  const t0 = Date.now();

  // C7 봇 보호: Turnstile 토큰 검증 (시크릿 미설정 시 fail-open, 로그만 남김).
  const clientIp = c.req.header("cf-connecting-ip") || undefined;
  const turnstile = await verifyTurnstile(c.env, body.turnstileToken, clientIp);
  if (!turnstile.ok) return c.json({ ok: false, error: turnstile.error || "bot check failed" }, 403);
  // C7 레이트 리밋: 세션/IP 기준 분당 20회. 초과 시 429 + 재시도 안내.
  // 식별자는 세션 우선: cf-connecting-ip는 클라우드 브라우저 등에서 요청마다
  // 바뀔 수 있어 IP 기준이면 카운터가 분산돼 제한이 안 걸린다. 세션이 없을 때만 IP로.
  const rateKey = sessionId || clientIp || "anon";
  const rate = await checkAskRateLimit(c.env, rateKey);
  if (!rate.allowed) {
    return c.json(
      { ok: false, error: `너무 많은 질문입니다. ${rate.resetInSec}초 후에 다시 시도해 주세요.` },
      429,
      { "Retry-After": String(rate.resetInSec) }
    );
  }

  // 캐시 조회 → 세션 문맥 → 근거 검색 → 답 생성 → 세션 저장 → 감사 기록 → 캐시 저장
  // 은 runAsk (src/ask-pipeline.ts, S4 M6-α). force면 캐시를 읽지 않고 AI Gateway 캐시도 건너뛴다.
  // 개인별 RAG 격리: 세션 사용자를 viewer로 넘긴다. 익명이면 viewer null → 공용만 검색.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const r = await runAsk(
    c.env,
    { question, sessionId, startedAt: t0 },
    { readCache: !body.force, gatewaySkipCache: body.force === true, viewer },
    // Hono의 ExecutionContext 타입은 workers-types와 필드가 조금 달라 캐스트한다 (런타임 객체는 같다).
    { traceSink, ctx: c.executionCtx as unknown as ExecutionContext },
  );
  return c.json(r.body);
});

// ---- feedback (C7) ----
// 답변 카드의 👍/👎를 ask_events에 기록한다. 👎는 C5-b에서 지식 공백 큐로
// 연결한다 (지금은 기록만 — 큐 UI는 C5-b에서 만든다).
app.post("/api/feedback", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { eventId?: string; rating?: string; comment?: string };
  if (!body.eventId) return c.json({ ok: false, error: "eventId is required" }, 400);
  if (body.rating !== "up" && body.rating !== "down") return c.json({ ok: false, error: "rating must be 'up' or 'down'" }, 400);
  const row = await c.env.DB.prepare("SELECT id, question FROM ask_events WHERE id = ?").bind(body.eventId).first<{ id: string; question: string }>();
  if (!row) return c.json({ ok: false, error: "event not found" }, 404);
  await c.env.DB.prepare("UPDATE ask_events SET feedback = ?, feedback_comment = ?, feedback_at = datetime('now') WHERE id = ?")
    .bind(body.rating, (body.comment || "").slice(0, 500) || null, body.eventId).run();
  // S4: 👍/👎를 trace_scores(user_feedback)에도 남긴다 (스키마 미적용이면 조용히 건너뜀).
  try { await mirrorFeedbackScore(c.env, body.eventId, body.rating, (body.comment || "").slice(0, 500) || null); }
  catch (e) { console.log("[obs] mirrorFeedbackScore failed:", e instanceof Error ? e.message : String(e)); }
  // C5-b: 👎는 지식 공백 큐에 올린다 (같은 질문의 open 행이 있으면 count만 증가).
  if (body.rating === "down") {
    try { await recordGap(c.env, row.question, "downvote"); }
    catch (e) { console.log("[gaps] recordGap(downvote) failed:", e instanceof Error ? e.message : String(e)); }
  }
  return c.json({
    ok: true,
    eventId: body.eventId,
    rating: body.rating,
    note: body.rating === "down" ? "이 질문은 답변 보완 대상으로 기록되었습니다 (지식 공백 큐에 올렸습니다)." : null,
  });
});

// ---- 지식 공백 큐 (C5-b) ----
// 근거 없는 질문·👎 피드백 질문 목록. 최신순. answered/resolved에는
// 게시된 암묵지 문서 제목을 함께 돌려준다 (프론트 링크용).
app.get("/api/gaps", async (c) => {
  await ensureSeeded(c.env.DB);
  const rows = await c.env.DB.prepare(
    "SELECT g.id, g.question, g.asked_at, g.status, g.doc_id, g.count, g.source, d.title AS doc_title FROM knowledge_gaps g LEFT JOIN documents d ON d.id = g.doc_id ORDER BY g.asked_at DESC LIMIT 50"
  ).all<{ id: string; question: string; asked_at: number; status: string; doc_id: string | null; count: number; source: string; doc_title: string | null }>();
  return c.json({ ok: true, gaps: rows.results || [] });
});

// 암묵지 게시 (C5-b): 담당자가 쓴 답을 Markdown 문서(kind='tacit')로
// R2에 저장하고 일반 문서와 같은 색인 경로(청킹 → bge-m3 → Vectorize)로
// 넣는다. 게시와 동시에 지식 epoch를 올려 옛 캐시 답을 무효화하고,
// 같은 질문을 다시 실행해 근거가 잡히면 resolved, 아니면 open으로 되돌린다.
app.post("/api/gaps/:id/publish", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const gap = await c.env.DB.prepare("SELECT id, question, status, doc_id FROM knowledge_gaps WHERE id = ?").bind(id)
    .first<{ id: string; question: string; status: string; doc_id: string | null }>();
  if (!gap) return c.json({ ok: false, error: "gap not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { answer?: string; author?: string };
  if (!body.answer || body.answer.trim().length < 3) return c.json({ ok: false, error: "answer is required" }, 400);
  const author = (body.author || "인사팀").trim().slice(0, 40) || "인사팀";
  const today = new Date().toISOString().slice(0, 10);
  const title = gap.question.replace(/[?？]+$/, "").trim().slice(0, 60) || gap.question.slice(0, 60);
  // 본문 상단에 작성자·작성일·원 질문 메타를 포함한다 (계획서 C5-b 명세).
  const content = `작성자: ${author} · 작성일: ${today}\n원 질문: ${gap.question}\n\n${body.answer.trim()}`;
  // 기존 게시 문서가 있으면 같은 문서에 덮어쓴다 (버전 분산 방지).
  // gap.doc_id가 없어도(👎로 새로 열린 gap) 같은 제목의 암묵지 문서가
  // 있으면 그 문서를 재사용한다 — 같은 질문에 중복 문서가 생기던 문제.
  let docId = gap.doc_id;
  let existing = docId
    ? await c.env.DB.prepare("SELECT id, r2_key FROM documents WHERE id = ?").bind(docId).first<{ id: string; r2_key: string | null }>()
    : null;
  if (!existing) {
    existing = await c.env.DB.prepare("SELECT id, r2_key FROM documents WHERE kind = 'tacit' AND title = ? ORDER BY created_at DESC LIMIT 1").bind(title).first<{ id: string; r2_key: string | null }>();
  }
  if (existing) {
    docId = existing.id;
    const r2Key = existing.r2_key || `documents/${docId}.md`;
    let r2Ok = true;
    try { await c.env.FILES.put(r2Key, content); } catch { r2Ok = false; }
    await c.env.DB.prepare("UPDATE documents SET title = ?, content = ?, author = ?, r2_key = ? WHERE id = ?")
      .bind(title, content, author, r2Ok ? r2Key : null, docId).run();
  } else {
    docId = uid("doc");
    const r2Key = `documents/${docId}.md`;
    let r2Stored = false;
    try { await c.env.FILES.put(r2Key, content); r2Stored = true; } catch { r2Stored = false; }
    await c.env.DB.prepare("INSERT INTO documents (id, title, kind, content, summary, actions, r2_key, author) VALUES (?, ?, 'tacit', ?, NULL, NULL, ?, ?)")
      .bind(docId, title, content, r2Stored ? r2Key : null, author).run();
  }
  // 색인 (D1 chunks 저장 + Vectorize upsert). AI가 안 되면 D1 chunk만 남긴다.
  const indexed = await indexDocument(c.env, { id: docId, title, markdown: content, kind: "tacit" });
  // 캐시 무효화: epoch를 올려 게시 전 캐시 답이 나오지 않게 한다.
  const epoch = await bumpKnowledgeEpoch(c.env);
  await c.env.DB.prepare("UPDATE knowledge_gaps SET status = 'answered', doc_id = ? WHERE id = ?").bind(docId, id).run();
  // 검증: 같은 질문을 다시 실행해 암묵지가 근거로 잡히는지 확인한다.
  const verification = await verifyTacitEvidence(c.env, gap.question, docId, title);
  const status = verification.resolved ? "resolved" : "open";
  await c.env.DB.prepare("UPDATE knowledge_gaps SET status = ? WHERE id = ?").bind(status, id).run();
  return c.json({
    ok: true, gapId: id, status, docId, docTitle: title, author, publishedAt: today,
    epoch, indexed: { chunks: indexed.chunks, upserted: indexed.upserted, indexError: indexed.indexError ?? null },
    verification: { resolved: verification.resolved, sources: verification.sources },
  });
});

// 프론트가 Turnstile 위젯을 그릴 때 필요한 공개 설정. 시크릿은 절대 안 나온다.
app.get("/api/config", async (c) => {
  return c.json({ ok: true, turnstileSitekey: c.env.TURNSTILE_SITEKEY || null, turnstileEnabled: !!c.env.TURNSTILE_SITEKEY });
});

// ---- coaching ----
app.post("/api/coaching/reflect", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { transcript?: string; sessionId?: string };
  const transcript = body.transcript || coachingTranscript();
  if (transcript.trim().length < 10) return c.json({ ok: false, error: "transcript is required" }, 400);
  let engine = "local-rule";
  let out = localReflect(transcript);
  try {
    const ai = await c.env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: "너는 코칭 리플렉션 분석가다. 세션 전사본에서 핵심 질문, 반복 패턴, 다음 세션 질문 3개를 한국어로 뽑아 JSON으로만 답하라: {\"questions\":[],\"patterns\":[],\"next_questions\":[]}" },
        { role: "user", content: transcript.slice(0, 4000) },
      ],
    }, aiGatewayOptions({ tag: "coaching" }));
    const text = responseText(ai);
    const parsed = extractJson(text) as { questions?: unknown; patterns?: unknown; next_questions?: unknown };
    if (Array.isArray(parsed.patterns) && parsed.patterns.length) {
      out = {
        questions: (parsed.questions as string[]) || [],
        patterns: parsed.patterns as string[],
        next_questions: (parsed.next_questions as string[]) || [],
      };
      engine = "workers-ai";
    }
  } catch { /* 로컬 폴백 유지 */ }
  const id = uid("refl");
  await c.env.DB.prepare("INSERT INTO reflections (id, session_id, transcript, questions, patterns, next_questions) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, body.sessionId || null, transcript, JSON.stringify(out.questions), JSON.stringify(out.patterns), JSON.stringify(out.next_questions)).run();
  return c.json({ ok: true, id, ...out, engine });
});

// ---- home (작업 공간 대시보드) ----
app.get("/api/home", async (c) => {
  await ensureSeeded(c.env.DB);
  // 목록 조회는 RAG 검색과 다르다: hr_admin은 관리자 탭에서 전체 문서를 본다.
  // (RAG 검색에서는 hr_admin도 본인 개인 문서만 본다 — vectorUserFilter 참조.)
  // 일반 사용자·익명은 공용 + 본인 것만 본다. 문서 카운트도 같은 범위로 센다.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const isAdmin = viewer?.role === "hr_admin";
  const { clause: docClause, params: docParams } = docOwnerClause(viewer, "documents");
  const count = async (sql: string, params: unknown[] = []) => (await c.env.DB.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
  const docWhere = isAdmin ? "" : ` WHERE ${docClause}`;
  const documents = await count(`SELECT COUNT(*) AS n FROM documents${docWhere}`, isAdmin ? [] : docParams);
  const summaries = await count(`SELECT COUNT(*) AS n FROM documents WHERE summary IS NOT NULL AND summary != ''${isAdmin ? "" : ` AND ${docClause}`}`, isAdmin ? [] : docParams);
  const openTasks = await count("SELECT COUNT(*) AS n FROM tasks WHERE done = 0");
  const reflections = await count("SELECT COUNT(*) AS n FROM reflections");
  const recentDocuments = isAdmin
    ? (await c.env.DB.prepare("SELECT id, title, kind, created_at FROM documents ORDER BY created_at DESC LIMIT 5").all()).results || []
    : (await c.env.DB.prepare(`SELECT id, title, kind, created_at FROM documents WHERE ${docClause} ORDER BY created_at DESC LIMIT 5`).bind(...docParams).all()).results || [];
  const tasks = (await c.env.DB.prepare("SELECT id, title, source, created_at FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 5").all()).results || [];
  const recentReflections = (await c.env.DB.prepare("SELECT id, patterns, created_at FROM reflections ORDER BY created_at DESC LIMIT 3").all()).results || [];
  return c.json({ ok: true, counts: { documents, summaries, openTasks, reflections }, recentDocuments, openTasks: tasks, recentReflections });
});

// ---- tasks (할 일 체크리스트) ----
app.get("/api/tasks", async (c) => {
  await ensureSeeded(c.env.DB);
  const rows = await c.env.DB.prepare("SELECT id, title, source, done, created_at, done_at FROM tasks ORDER BY done ASC, created_at DESC").all();
  return c.json({ ok: true, tasks: rows.results || [] });
});

app.post("/api/tasks", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { title?: string; source?: string };
  if (!body.title || body.title.trim().length < 1) return c.json({ ok: false, error: "title is required" }, 400);
  const id = uid("task");
  await c.env.DB.prepare("INSERT INTO tasks (id, title, source) VALUES (?, ?, ?)").bind(id, body.title.trim().slice(0, 200), body.source || null).run();
  return c.json({ ok: true, id, title: body.title.trim().slice(0, 200), source: body.source || null }, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { done?: boolean };
  const row = await c.env.DB.prepare("SELECT done FROM tasks WHERE id = ?").bind(id).first<{ done: number }>();
  if (!row) return c.json({ ok: false, error: "task not found" }, 404);
  const done = typeof body.done === "boolean" ? (body.done ? 1 : 0) : (row.done ? 0 : 1);
  await c.env.DB.prepare("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?").bind(done, done ? new Date().toISOString() : null, id).run();
  return c.json({ ok: true, id, done: done === 1 });
});

app.delete("/api/tasks/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ ok: false, error: "task not found" }, 404);
  return c.json({ ok: true, id });
});

// ---- deck (PPTX 초안, easy-slides식 신규 생성) ----
app.post("/api/deck", async (c) => {
  await ensureSeeded(c.env.DB);
  const body = await c.req.json().catch(() => ({})) as { title?: string; summary?: string[]; actions?: string[]; bullets?: string[]; source?: string; outline?: unknown };
  // S3: 개요가 오면 개요를 우선으로 쓴다 (고친 문구가 그대로 .pptx에 들어감).
  // 개요가 없으면 기존 요약/액션/bullets 경로 그대로.
  const outline = normalizeOutline(body.outline);
  let title = (body.title || "People OS 요약").slice(0, 120);
  let sections: DeckSection[] = [];
  if (outline.present) {
    if (!outline.sections.length) return c.json({ ok: false, error: "outline is empty: add at least one bullet" }, 400);
    if (outline.title) title = outline.title;
    sections = outline.sections;
  } else {
    if (Array.isArray(body.summary) && body.summary.length) sections.push({ heading: "요약", items: body.summary.slice(0, 6).map(String) });
    if (Array.isArray(body.actions) && body.actions.length) sections.push({ heading: "액션", items: body.actions.slice(0, 8).map(String) });
    if (!sections.length && Array.isArray(body.bullets) && body.bullets.length) sections.push({ heading: "내용", items: body.bullets.slice(0, 10).map(String) });
    if (!sections.length) return c.json({ ok: false, error: "summary, actions or bullets is required" }, 400);
  }
  const { bytes, slides } = await buildDeck(title, sections);
  const id = uid("deck");
  const r2Key = `decks/${id}.pptx`;
  await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: PPTX_MIME } });
  // 개인별 RAG 격리: 덱은 만든 사람의 개인 소유(익명이면 공용 NULL).
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  await c.env.DB.prepare("INSERT INTO decks (id, title, r2_key, bytes, slides, owner_id) VALUES (?, ?, ?, ?, ?, ?)").bind(id, title, r2Key, bytes.length, slides, viewer?.id ?? null).run();
  return c.json({ ok: true, id, title, url: `/api/deck/${id}`, bytes: bytes.length, slides, source: body.source || null, outline: outline.present }, 201);
});

app.get("/api/deck/:id", async (c) => {
  await ensureSeeded(c.env.DB);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id, title, r2_key, bytes, owner_id FROM decks WHERE id = ?").bind(id).first<{ id: string; title: string; r2_key: string; bytes: number; owner_id: string | null }>();
  if (!row) return c.json({ ok: false, error: "deck not found" }, 404);
  // R2 다운로드 게이트: 소유자가 있는 덱은 소유자 본인 또는 hr_admin만 받을 수 있다.
  // owner_id NULL은 공용이라 누구나 받을 수 있다.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (row.owner_id && (!viewer || (viewer.id !== row.owner_id && viewer.role !== "hr_admin"))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) return c.json({ ok: false, error: "deck file not found" }, 404);
  // Content-Disposition의 filename은 ASCII만 허용된다 (Fetch 명세).
  // 한글 제목은 RFC 5987 filename*에 UTF-8 인코딩으로 싣고, filename은 ASCII 폴백.
  const safe = row.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "deck";
  const encoded = encodeURIComponent(`${row.title}.pptx`);
  return new Response(obj.body, {
    headers: {
      "Content-Type": PPTX_MIME,
      "Content-Length": String(row.bytes),
      "Content-Disposition": `attachment; filename="${safe}.pptx"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
});

// ---- library ----
app.get("/api/library", async (c) => {
  await ensureSeeded(c.env.DB);
  // 목록 조회는 RAG 검색과 다르다: hr_admin은 관리자 탭에서 전체 문서를 본다.
  // (RAG 검색에서는 hr_admin도 본인 개인 문서만 본다.) 일반 사용자·익명은 공용 + 본인 것만.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  const isAdmin = viewer?.role === "hr_admin";
  const { clause, params } = docOwnerClause(viewer, "documents");
  const docs = isAdmin
    ? await c.env.DB.prepare("SELECT id, title, kind, summary, actions, created_at, extract_status, extract_error FROM documents ORDER BY created_at DESC LIMIT 20").all()
    : await c.env.DB.prepare(`SELECT id, title, kind, summary, actions, created_at, extract_status, extract_error FROM documents WHERE ${clause} ORDER BY created_at DESC LIMIT 20`).bind(...params).all();
  const pols = await c.env.DB.prepare("SELECT id, title, section FROM policies ORDER BY id").all();
  const refls = await c.env.DB.prepare("SELECT id, session_id, patterns, next_questions, created_at FROM reflections ORDER BY created_at DESC LIMIT 10").all();
  return c.json({ ok: true, documents: docs.results || [], policies: pols.results || [], reflections: refls.results || [] });
});

// 디버그용: 임베딩·Vectorize 조회·LLM 호출을 직접 돌려 원인을 확인한다.
// 운영용 경로 — X-Admin-Secret 헤더 + ADMIN_SECRET 없이는 401 (C6 잠금).
app.get("/api/debug-ai", async (c) => {
  if (!adminAllowed(c.env, c.req.header("x-admin-secret"))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const out: Record<string, unknown> = {};
  out.vectorSeed = await ensureVectorSeeded(c.env);
  try {
    const emb = await c.env.AI.run(EMBED_MODEL, { text: ["출장비 청구"] }, aiGatewayOptions({ skipCache: true, tag: "debug" })) as { data: number[][] | number[] };
    const raw = emb.data;
    const vals = Array.isArray(raw[0]) ? (raw[0] as number[]) : (raw as number[]);
    out.embed = { ok: true, dims: vals.length };
    try {
      const vec = await c.env.VECTOR.query(new Float32Array(vals), { topK: 3, returnMetadata: "all" });
      out.vectorize = { ok: true, matches: (vec.matches || []).map((m) => ({ id: String(m.id), score: m.score })) };
    } catch (e) {
      out.vectorize = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } catch (e) {
    out.embed = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // LLM 후보를 순서대로 시도해 바인딩에서 실제로 되는 모델을 확인한다.
  const llmCandidates = [LLM_MODEL, "@cf/meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
  const llmResults: Array<Record<string, unknown>> = [];
  for (const model of llmCandidates) {
    try {
      const res = await c.env.AI.run(model, { messages: [{ role: "user", content: "한 줄로 답해: 2+2는?" }] }, aiGatewayOptions({ skipCache: true, tag: "debug" }));
      const text = responseText(res);
      llmResults.push({ model, ok: true, text: text.slice(0, 200) });
    } catch (e) {
      llmResults.push({ model, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.llm = llmResults;
  return c.json({ ok: true, ...out });
});

app.get("/api/seed", async (c) => {
  await ensureSeeded(c.env.DB);
  return c.json({ ok: true, sampleTranscript: sampleTranscript(), coachingTranscript: coachingTranscript(), policies: policies() });
});

// 규정 7건을 조문 단위로 임베딩해 Vectorize 인덱스에 넣는다 (관리자 강제 재시딩).
// 평소에는 ask/health가 lazy 시딩으로 알아서 채우므로 이 경로는 정책이
// 바뀌었을 때 다시 임베딩하는 용도다. 새 인덱스(people-os-index-m3)는
// 처음부터 chunk id만 들어가서 구 정책 단위 벡터를 지울 일이 없다.
// 운영용 경로 — X-Admin-Secret 헤더 + ADMIN_SECRET 없이는 401 (C6 잠금).
app.get("/api/seed-vectors", async (c) => {
  if (!adminAllowed(c.env, c.req.header("x-admin-secret"))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await ensureSeeded(c.env.DB);
  const r = await ensureVectorSeeded(c.env, { force: true });
  return c.json({ ok: r.seeded, upserted: r.upserted ?? 0, total: r.upserted ?? 0, deletedOld: 0, model: EMBED_MODEL, index: VECTOR_INDEX_NAME, dims: r.dims ?? null, errors: r.error ? [r.error] : [] });
});

// 개인별 RAG 격리 재색인 (모듈 C): D1 chunks 전부를 문서 소유자와 함께 읽어
// bge-m3으로 다시 임베딩하고 Vectorize에 upsert한다. chunks에 documents를
// LEFT JOIN하므로 정책 chunk(documents 행 없음)는 owner NULL → 공용 "shared"가 된다.
// upsert는 같은 id에 멱등이라 재실행해도 안전하다 — 중간에 끊겨도 다시 돌리면 된다.
// 관리자 전용: 이중 게이트(isAdminRequest — hr_admin 세션 또는 X-Admin-Secret).
// 쿼리 파라미터 limit(기본 500, 최대 2000)·offset(기본 0)으로 나눠서 돌릴 수 있다.
app.post("/api/admin/reindex", async (c) => {
  if (!(await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret")))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await ensureSeeded(c.env.DB);
  const limit = Math.max(1, Math.min(2000, Number(c.req.query("limit") ?? 500) || 500));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const rows = await c.env.DB.prepare(
    "SELECT c.id, c.doc_id, c.article, c.text, COALESCE(p.title, d.title, c.doc_id) AS title, d.kind, d.owner_id FROM chunks c LEFT JOIN documents d ON d.id = c.doc_id LEFT JOIN policies p ON p.id = c.doc_id ORDER BY c.doc_id, c.ord LIMIT ? OFFSET ?"
  ).bind(limit, offset).all<{ id: string; doc_id: string; article: string; text: string; title: string | null; kind: string | null; owner_id: string | null }>();
  const list = rows.results || [];
  const errors: string[] = [];
  let upserted = 0;
  const BATCH = 20; // 임베딩 배치 크기: 20개씩 Workers AI 호출
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    try {
      const texts = batch.map((ch) => `${ch.title ?? ch.doc_id} ${ch.article} ${ch.text}`);
      const emb = await c.env.AI.run(EMBED_MODEL, { text: texts }, aiGatewayOptions({ skipCache: true, tag: "embed" })) as { data: number[][] | number[] };
      const data = emb.data;
      // Workers AI는 텍스트 1개면 data를 평탄한 number[]로, 여러 개면
      // number[][]로 돌려준다 (indexDocument와 같은 정규화).
      const embRows = Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) ? (data as number[][]) : [data as number[]];
      if (!Array.isArray(data) || embRows.length !== texts.length) throw new Error("unexpected embedding response shape");
      if (embRows[0].length !== EMBED_DIMS) throw new Error(`embedding dims ${embRows[0].length} != index dims ${EMBED_DIMS}`);
      const vectors = batch.map((ch, j) => {
        const kind = ch.kind ?? "policy"; // 정책 chunk는 documents 행이 없어 kind 없음
        return {
          id: ch.id,
          values: embRows[j],
          metadata: { title: ch.title ?? ch.doc_id, section: ch.article, snippet: ch.text.slice(0, 220), kind, pool: poolForDoc(kind, ch.owner_id), user_id: vectorUserIdForDoc(ch.owner_id) },
        };
      });
      await c.env.VECTOR.upsert(vectors);
      upserted += vectors.length;
    } catch (e) {
      // 배치 하나가 실패해도 나머지는 계속 진행하고, 사유를 errors에 남긴다.
      errors.push(`batch ${i}-${Math.min(i + BATCH, list.length)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 전체 실패(처리할 chunk가 있는데 하나도 안 올라감)면 ok:false.
  const ok = list.length === 0 || upserted > 0;
  await c.env.DB.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .bind("vector_reindexed_v2", JSON.stringify({ upserted, at: new Date().toISOString() })).run();
  return c.json({ ok, upserted, total, chunks: list.length, errors });
});

// ---- digest (아침 다이제스트, C9) ----
app.get("/api/digest", async (c) => {
  const digest = await getLatestDigest(c.env);
  if (!digest) return c.json({ ok: true, digest: null, message: "아직 생성된 다이제스트가 없습니다. 매일 07:00에 생성됩니다." });
  return c.json({ ok: true, digest });
});

// ---- 로그인 (2026-11-15, /api/bootstrap · /api/auth/* · /api/admin/users) ----
// 하위 앱 경로는 마운트 지점 기준 상대다. 관리자 경로는 hr_admin 세션 또는
// X-Admin-Secret 이중 게이트로 막는다 (auth.ts isAdminRequest).
app.route("/api", authApp);

// ---- S4 관측·평가 (/api/obs/*) ----
// 하위 앱 경로는 마운트 지점 기준 상대다 (§8). 세 앱 모두 스키마 가드(503)를 갖고 있고,
// 관리자 경로는 각 앱이 X-Admin-Secret ↔ ADMIN_SECRET으로 막는다 (fail-closed).
// 캐치올(app.all("*")) 앞에 둬야 한다.
app.route("/api/obs", tracesApp);
app.route("/api/obs", datasetsApp);
app.route("/api/obs", evalsApp);

// 프론트는 [assets] 바인딩이 서빙한다. / 가 없으면 index.html로.
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "unknown api route" }, 404);
  try {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
  } catch { /* assets 없으면 아래 폴백 */ }
  return c.html("<h1>People OS</h1><p>Frontend asset not found. Run wrangler dev with public/ present.</p>", 404);
});

// S1 큐 소비자: 전사 완료 메시지 1건 → 요약 → 색인.
// - 이미 done이면 중복 전달이므로 건너뛴다.
// - 문서가 없으면 재시도해도 소용없으니 failed로 남기고 ack한다 (throw 안 함).
// - 요약·색인 실패는 throw해 큐가 재시도하게 한다. max_retries를 넘기면
//   DLQ로 가고 행은 failed + 마지막 에러로 남는다 (전사본은 D1/R2에 그대로).
// - 요약·색인은 멱등이라 중복 전달·재시도해도 같은 결과가 나온다.
async function processPipelineMessage(env: Env, msg: PipelineMessage): Promise<void> {
  if (!msg || msg.type !== "transcript-pipeline" || !msg.recordingId || !msg.docId) return;
  const rec = await env.DB.prepare("SELECT id, title, doc_id, transcript_status, pipeline_stage FROM recordings WHERE id = ?").bind(msg.recordingId)
    .first<{ id: string; title: string; doc_id: string | null; transcript_status: string; pipeline_stage: string | null }>();
  if (!rec || !rec.doc_id) {
    if (rec) await setPipelineStage(env, rec.id, "failed", "pipeline: transcript document not found").catch(() => {});
    return;
  }
  if (rec.pipeline_stage === "done") return;
  try {
    await setPipelineStage(env, rec.id, "summarizing");
    await summarizeDocument(env, rec.doc_id);
    await setPipelineStage(env, rec.id, "indexing");
    const doc = await env.DB.prepare("SELECT title, content, kind, owner_id FROM documents WHERE id = ?").bind(rec.doc_id)
      .first<{ title: string; content: string; kind: string; owner_id: string | null }>();
    if (!doc) throw new Error("document not found");
    const indexed = await indexDocument(env, { id: rec.doc_id, title: doc.title, markdown: doc.content, kind: doc.kind, ownerId: doc.owner_id });
    if (indexed.indexError) throw new Error(`index failed: ${indexed.indexError}`);
    await setPipelineStage(env, rec.id, "done");
  } catch (e) {
    await setPipelineStage(env, rec.id, "failed", e instanceof Error ? e.message : String(e)).catch(() => {});
    throw e;
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // S4: 03:00 KST cron → 비용 동기화 → 표본 판정 → 평가 실행(가드: eval_enabled,
    // config_hash 같고 7일 안 지났으면 skipped) + 정체 실행 청소. 그 밖은 07:00 다이제스트.
    if (event.cron === EVAL_CRON) {
      ctx.waitUntil(runEvalCron(env, ctx));
      return;
    }
    ctx.waitUntil(generateDigest(env, new Date(event.scheduledTime)));
  },
  // S1 큐 소비자: 메시지마다 ack/retry를 직접 정한다. 한 건이 실패해도
  // 같은 배치의 다른 메시지는 정상 처리한다. throw 대신 msg.retry()를 써서
  // 재시도 횟수를 넘기면 플랫폼이 DLQ로 옮기게 한다.
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as { type?: string } | null;
        if (body && body.type === "eval-item") {
          // S4: 평가 항목 1건 (M4). 멱등 — 재전달돼도 eval_results는 1행. throw하면 재시도.
          await processEvalItem(env, msg.body as EvalItemMessage, { runAsk, traceSink, ctx });
        } else {
          // 기존 전사 파이프라인 (S1) — 그대로.
          await processPipelineMessage(env, msg.body as PipelineMessage);
        }
        msg.ack();
      } catch (e) {
        console.log(`[pipeline] message ${msg.id} failed (attempt ${msg.attempts}):`, e instanceof Error ? e.message : String(e));
        msg.retry();
      }
    }
  },
};

// S4 03:00 KST cron 본체. 단계마다 실패를 따로 잡아 다음 단계가 돌게 한다.
// 비용 동기화는 AIG_LOGS_TOKEN이 없으면 안내 오류만 내고 끝난다 (앱 정상).
// 평가 가드(eval_enabled=0 거부, config_hash 같고 7일 안 지났으면 skipped,
// 60분 넘은 running 청소)는 runScheduledEval(M4) 안에 있다.
async function runEvalCron(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const sync = await syncGatewayCosts(env);
    console.log("[cron:eval] cost sync:", JSON.stringify(sync));
  } catch (e) { console.log("[cron:eval] cost sync failed:", e instanceof Error ? e.message : String(e)); }
  try {
    const sample = await sampleJudgeUserTraces(env);
    console.log("[cron:eval] sample judge:", JSON.stringify(sample));
  } catch (e) { console.log("[cron:eval] sample judge failed:", e instanceof Error ? e.message : String(e)); }
  try {
    const run = await runScheduledEval(env, { runAsk, traceSink, ctx });
    console.log("[cron:eval] scheduled eval:", JSON.stringify(run));
  } catch (e) { console.log("[cron:eval] scheduled eval failed:", e instanceof Error ? e.message : String(e)); }
}
