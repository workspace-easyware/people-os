// Word AI 지시 작업 (2026-11-22, Queue 이동). 자연어 지시로 Word 문서를 만들거나(create) 고치는(edit) 일은 Qwen 응답이 1~2분 걸려
// (실측: 생성 56~122초 + Workers AI 3046 timeout 502, 편집 71초) HTTP 요청이 붙잡고 기다리면 타임아웃·502가 난다.
// 그래서 요청은 작업 행(D1 docx_jobs, migration 0043)을 만들고 전용 Queue(people-os-docx-jobs, 바인딩 DOCX_JOBS, type "docx-job")에 넣은 뒤 202로 바로 돌려주고,
// (people-os-pipeline과 나눈 이유: 1~5분짜리 작업이 전사·워크플로우 메시지를 막지 않게 — wrangler.toml 주석 참고)
// Queue 소비자(src/index.ts queue())가 여기 processDocxJob으로 실제 일을 한다. 화면은 GET /api/docx/jobs/:id를 2초마다 물어본다.
// 구조화 입력(정의·ops·replace)은 수십 ms~수 초라 Queue를 타지 않는다 (예전 그대로 201).
//
// 상태: queued → running → done | failed
// 멱등성 (작업 id 기준 — 문서가 두 번 생기지 않게)
// - 새 문서 id(doc_id)를 작업을 만들 때 미리 정한다. 같은 작업이 두 번 돌아도 같은 R2 키에 덮어쓰고 documents는 INSERT OR IGNORE라 문서는 1개다.
// - 소비자는 `UPDATE … SET status='running' WHERE status='queued'`로 작업을 차지한다 (조건부 UPDATE 1문 = 한 소비자만 성공).
//   이미 done/failed면 그냥 ack. running인데 오래됐으면(소비자가 죽음) 다시 차지하고, 문서 행이 이미 있으면 다시 만들지 않고 done으로 맺는다.
// 재시도 정책 (겹치지 않게 층을 나눈다)
// - 계획이 틀림(JSON·검증·자리표시자·편집 적용 실패): runDocxCreate·runDocxEdit 안의 "오류를 알려 주고 1회 재시도" 그대로. 그래도 안 되면 failed (Queue 재시도 없음).
// - AI 호출 자체가 실패(3046 timeout·3040 capacity·시간 초과, code "ai_call")하거나 D1·R2 예외: 작업을 queued로 되돌리고 Queue로 15초 뒤 다시 시도한다.
//   작업당 최대 DOCX_JOB_MAX_ATTEMPTS회, 만든 지 DOCX_JOB_RETRY_WINDOW_MS가 지났으면 더 하지 않고 failed.
// - Queue 자체 재시도(max_retries 3)는 소비자가 죽었을 때의 재전달에만 쓰인다. DLQ로 가도 아래 시간 상한이 작업을 failed로 맺는다.
// - 시간 상한: 만든 지 DOCX_JOB_DEADLINE_MS가 지난 queued·running 작업은 failed로 바꾼다 (상태 조회 때 + 15분 크론).
// 실행 위치 (2026-11-22 직렬 실행 해결): Queue 소비자는 메시지를 실행기 DO(src/docx/job-runner.ts DocJobRunner, 작업당 1개)에 넘기고 바로 ack한다.
// processDocxJob은 그 DO의 알람에서 돌고, 위의 "15초 뒤 다시"·"나중에 다시 본다"는 Queue 지연 재전달 대신 알람을 다시 거는 것으로 바뀌었다 (횟수·시간 기준은 같다).
// 그래서 작업들이 서로 기다리지 않는다. 실행기가 없거나 넘기지 못하면 예전처럼 소비자가 직접 돌린다 (그때는 위 설명 그대로 Queue 재전달).
import { uid } from "../lib";
import { logEvent } from "../obs/log";
import { runDocxCreate } from "./create";
import type { DocxCreateInput, DocxEnv } from "./create";
import { runDocxEdit } from "./edit";
import type { DocxEditEnv, DocxEditWho } from "./edit";

export type DocxJobKind = "create" | "edit";
export type DocxJobStatus = "queued" | "running" | "done" | "failed";
export type DocxJobMessage = { type: "docx-job"; jobId: string; enqueuedAt: string };

export type DocxJobEnv = DocxEnv & DocxEditEnv & { DOCX_JOBS: Queue<DocxJobMessage> };

/** 작업 1개가 AI 호출 실패·예외로 다시 시도되는 횟수 상한 (첫 시도 포함) */
export const DOCX_JOB_MAX_ATTEMPTS = 3;
/** 만든 지 이 시간이 지나면 다시 시도하지 않는다 (마지막 시도 최대 약 5분 + 이 값 < 시간 상한) */
export const DOCX_JOB_RETRY_WINDOW_MS = 6 * 60 * 1000;
/** running인 채 이 시간이 지나면 소비자가 죽은 것으로 보고 다른 전달이 다시 차지한다 (한 시도 최대: AI 2회 × 150초 + 생성) */
export const DOCX_JOB_RUNNING_STALE_MS = 7 * 60 * 1000;
/** 만든 지 이 시간이 지난 queued·running 작업은 failed로 맺는다 */
export const DOCX_JOB_DEADLINE_MS = 15 * 60 * 1000;
/** 한 사람이 동시에 돌릴 수 있는 작업 수 */
export const DOCX_JOB_MAX_ACTIVE = 3;
/** 끝난 작업 행을 지우는 시점 (지시 글이 들어 있어 오래 두지 않는다) */
export const DOCX_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_S = 15;
const BUSY_DELAY_S = 120;

export const DOCX_JOB_TIMEOUT_ERROR = "AI 작업이 15분 안에 끝나지 않아 멈췄습니다. 잠시 뒤 다시 시도해 주세요.";
const AI_BUSY_ERROR = "AI가 응답하지 않아 문서를 만들지 못했습니다 (여러 번 다시 시도했습니다). 잠시 뒤 다시 시도해 주세요.";
const INTERNAL_ERROR = "문서를 저장하는 중 오류가 나서 끝내지 못했습니다. 잠시 뒤 다시 시도해 주세요.";

type CreateJobInput = { kind: "create"; instruction: string; title: string; options: DocxCreateInput["options"]; imageAdmin: boolean };
type EditJobInput = { kind: "edit"; instruction: string; title: string; who: DocxEditWho; adminRead: boolean };
export type DocxJobInput = CreateJobInput | EditJobInput;

type JobRow = {
  id: string; kind: string; status: string; owner_id: string | null; doc_id: string; source_doc_id: string | null;
  input_json: string; result_json: string | null; error: string | null; error_status: number | null; attempts: number;
  created_at: string; started_at: string | null; finished_at: string | null;
};

const nowIso = () => new Date().toISOString();

/** 작업을 만들고 Queue에 넣는다. 동시 작업 상한을 넘으면 429, Queue에 못 넣으면 503 (작업은 failed로 남긴다). */
export async function enqueueDocxJob(
  env: DocxJobEnv, ownerId: string | null, input: DocxJobInput, sourceDocId: string | null,
): Promise<{ ok: true; job: { id: string; kind: DocxJobKind; status: "queued"; statusUrl: string; pollMs: number } } | { ok: false; status: 429 | 503; error: string; code: string }> {
  const active = await env.DB.prepare(`SELECT COUNT(*) AS n FROM docx_jobs WHERE owner_id ${ownerId === null ? "IS NULL" : "= ?"} AND status IN ('queued','running') AND created_at > ?`)
    .bind(...(ownerId === null ? [] : [ownerId]), new Date(Date.now() - DOCX_JOB_DEADLINE_MS).toISOString()).first<{ n: number }>();
  if ((active?.n ?? 0) >= DOCX_JOB_MAX_ACTIVE) {
    return { ok: false, status: 429, error: `AI가 만들고 있는 문서가 이미 ${DOCX_JOB_MAX_ACTIVE}개 있습니다. 끝난 뒤에 다시 시도해 주세요.`, code: "too_many_jobs" };
  }
  const id = uid("dxjob");
  const t = nowIso();
  await env.DB.prepare("INSERT INTO docx_jobs (id, kind, status, owner_id, doc_id, source_doc_id, input_json, attempts, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?)")
    .bind(id, input.kind, ownerId, uid("doc"), sourceDocId, JSON.stringify(input), t).run();
  try {
    await env.DOCX_JOBS.send({ type: "docx-job", jobId: id, enqueuedAt: t } satisfies DocxJobMessage);
  } catch (e) {
    const error = "작업을 대기열에 넣지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    await env.DB.prepare("UPDATE docx_jobs SET status = 'failed', error = ?, error_status = 503, finished_at = ? WHERE id = ?").bind(error, nowIso(), id).run();
    logEvent("docx.job", { jobId: id, kind: input.kind, event: "enqueue_failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    return { ok: false, status: 503, error, code: "queue_unavailable" };
  }
  logEvent("docx.job", { jobId: id, kind: input.kind, event: "queued" });
  return { ok: true, job: { id, kind: input.kind, status: "queued", statusUrl: `/api/docx/jobs/${id}`, pollMs: 2000 } };
}

/** 시간 상한을 넘긴 작업을 failed로 맺는다 (id를 주면 그 작업만). 바꾼 행 수를 돌려준다. */
async function expireDocxJobs(env: { DB: D1Database }, id?: string): Promise<number> {
  const cut = new Date(Date.now() - DOCX_JOB_DEADLINE_MS).toISOString();
  const r = await env.DB.prepare(`UPDATE docx_jobs SET status = 'failed', error = ?, error_status = 504, finished_at = ? WHERE status IN ('queued','running') AND created_at < ?${id ? " AND id = ?" : ""}`)
    .bind(DOCX_JOB_TIMEOUT_ERROR, nowIso(), cut, ...(id ? [id] : [])).run();
  return r.meta?.changes ?? 0;
}

/** 15분 크론: 시간 상한을 넘긴 작업을 failed로, 7일 지난 작업 행은 지운다. */
export async function sweepDocxJobs(env: { DB: D1Database }): Promise<{ expired: number; deleted: number }> {
  const expired = await expireDocxJobs(env);
  const del = await env.DB.prepare("DELETE FROM docx_jobs WHERE created_at < ?").bind(new Date(Date.now() - DOCX_JOB_RETENTION_MS).toISOString()).run();
  const deleted = del.meta?.changes ?? 0;
  if (expired || deleted) logEvent("docx.job", { event: "sweep", expired, deleted });
  return { expired, deleted };
}

/**
 * 작업 상태 (화면 폴링용). 본인 작업만 보인다 (ownerId가 null인 운영 비밀 호출은 소유자 없는 작업만, admin은 전부) — 그 밖은 null(404).
 * done이면 result(동기 경로의 201 응답과 같은 모양)를 함께 준다.
 */
export async function getDocxJob(env: { DB: D1Database }, id: string, viewer: { ownerId: string | null; admin: boolean }) {
  let row = await env.DB.prepare("SELECT * FROM docx_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) return null;
  if (!viewer.admin && row.owner_id !== viewer.ownerId) return null;
  if ((row.status === "queued" || row.status === "running") && Date.parse(row.created_at) < Date.now() - DOCX_JOB_DEADLINE_MS) {
    await expireDocxJobs(env, id);
    row = await env.DB.prepare("SELECT * FROM docx_jobs WHERE id = ?").bind(id).first<JobRow>();
    if (!row) return null;
  }
  const end = row.finished_at ? Date.parse(row.finished_at) : Date.now();
  let result: unknown = null;
  if (row.status === "done" && row.result_json) { try { result = JSON.parse(row.result_json); } catch { result = null; } }
  return {
    job: {
      id: row.id, kind: row.kind as DocxJobKind, status: row.status as DocxJobStatus, attempts: row.attempts,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, elapsedMs: Math.max(0, end - Date.parse(row.created_at)),
      ...(row.status === "done" ? { docId: row.doc_id } : {}),
      ...(row.status === "failed" ? { error: row.error || "알 수 없는 오류로 끝내지 못했습니다.", errorStatus: row.error_status } : {}),
      // 앞선 시도가 일시적으로 실패해 다시 시도하는(또는 그 차례를 기다리는) 중 — 화면이 "다시 시도하는 중"으로 보여 준다
      ...((row.status === "queued" && row.attempts >= 1) || (row.status === "running" && row.attempts > 1) ? { retrying: true } : {}),
    },
    ...(result ? { result } : {}),
  };
}

/** D1 한 행에 넣을 결과: 너무 크면 변경 목록·로그를 줄인다 (문서 자체는 R2에 있다). */
function resultJson(r: Record<string, unknown>): string {
  let s = JSON.stringify(r);
  if (s.length > 400_000) s = JSON.stringify({ ...r, diff: Array.isArray(r.diff) ? r.diff.slice(0, 20) : r.diff, log: [], resultTrimmed: true });
  if (s.length > 400_000) s = JSON.stringify({ ok: true, doc: r.doc, source: r.source, planned: r.planned, planAttempts: r.planAttempts, resultTrimmed: true });
  return s;
}

export type DocxJobOutcome = { action: "ack" } | { action: "retry"; delaySeconds: number };

/**
 * Queue 메시지 1개 = 작업 1번 시도. 예외를 던지지 않으려 하고(상태 갱신 D1 오류만 던진다 → Queue 재시도), ack할지 다시 받을지를 돌려준다.
 */
export async function processDocxJob(env: DocxJobEnv, msg: DocxJobMessage): Promise<DocxJobOutcome> {
  const id = msg.jobId;
  const now = Date.now();
  // 차지하기: queued이거나, running인 채 오래된(소비자가 죽은) 작업만. 조건부 UPDATE라 동시에 온 전달 중 하나만 성공한다.
  const claim = await env.DB.prepare("UPDATE docx_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND (status = 'queued' OR (status = 'running' AND started_at < ?))")
    .bind(new Date(now).toISOString(), id, new Date(now - DOCX_JOB_RUNNING_STALE_MS).toISOString()).run();
  const job = await env.DB.prepare("SELECT * FROM docx_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return { action: "ack" }; // 지워진 작업
  if (!(claim.meta?.changes ?? 0)) {
    if (job.status === "done" || job.status === "failed") return { action: "ack" }; // 이미 끝남 (중복 전달)
    logEvent("docx.job", { jobId: id, kind: job.kind, event: "busy", status: job.status });
    return { action: "retry", delaySeconds: BUSY_DELAY_S }; // 다른 전달이 하고 있다 — 나중에 다시 본다 (그때 끝났으면 ack, 죽었으면 차지)
  }

  const finishDone = async (result: Record<string, unknown>) => {
    // done은 시간 상한이 먼저 failed로 바꾼 뒤에도 덮어쓴다 (문서가 실제로 있으니 done이 맞다)
    await env.DB.prepare("UPDATE docx_jobs SET status = 'done', result_json = ?, error = NULL, error_status = NULL, finished_at = ? WHERE id = ? AND status != 'done'")
      .bind(resultJson(result), nowIso(), id).run();
    logEvent("docx.job", { jobId: id, kind: job.kind, event: "done", attempts: job.attempts, ms: Date.now() - Date.parse(job.created_at), runMs: Date.now() - now, docId: job.doc_id });
  };
  const finishFailed = async (error: string, status: number, code?: string) => {
    await env.DB.prepare("UPDATE docx_jobs SET status = 'failed', error = ?, error_status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(error.slice(0, 1000), status, nowIso(), id).run();
    logEvent("docx.job", { jobId: id, kind: job.kind, event: "failed", attempts: job.attempts, ms: Date.now() - Date.parse(job.created_at), runMs: Date.now() - now, status, code: code ?? null, error: error.slice(0, 200) });
  };
  /** 일시적인 실패: 횟수·시간이 남았으면 queued로 되돌리고 Queue로 다시 받는다. 아니면 failed. */
  const retryOrFail = async (userError: string, status: number, code: string, detail: string): Promise<DocxJobOutcome> => {
    const canRetry = job.attempts < DOCX_JOB_MAX_ATTEMPTS && Date.now() - Date.parse(job.created_at) < DOCX_JOB_RETRY_WINDOW_MS;
    if (!canRetry) { await finishFailed(userError, status, code); return { action: "ack" }; }
    await env.DB.prepare("UPDATE docx_jobs SET status = 'queued', error = ? WHERE id = ? AND status = 'running'").bind(detail.slice(0, 1000), id).run();
    logEvent("docx.job", { jobId: id, kind: job.kind, event: "retry", attempts: job.attempts, code, error: detail.slice(0, 200) });
    return { action: "retry", delaySeconds: RETRY_DELAY_S };
  };

  try {
    // 앞선 시도가 문서를 저장한 뒤 상태를 못 남기고 죽었으면 다시 만들지 않는다.
    const existing = await env.DB.prepare("SELECT id, title, source_r2_key AS key FROM documents WHERE id = ?").bind(job.doc_id).first<{ id: string; title: string; key: string | null }>();
    if (existing) {
      const head = existing.key ? await env.FILES.head(existing.key) : null;
      await finishDone({
        ok: true, recovered: true, planned: true,
        doc: { id: existing.id, title: existing.title, url: `/api/documents/${existing.id}/download`, bytes: head?.size ?? 0, r2Key: existing.key },
      });
      return { action: "ack" };
    }
    let input: DocxJobInput;
    try { input = JSON.parse(job.input_json) as DocxJobInput; } catch { await finishFailed("작업 입력을 읽지 못했습니다.", 500, "internal"); return { action: "ack" }; }

    const r = input.kind === "edit"
      ? await runDocxEdit(env, input.who, job.source_doc_id || "", { instruction: input.instruction, title: input.title, ownerId: job.owner_id, adminRead: input.adminRead, newDocId: job.doc_id })
      : await runDocxCreate(env, { instruction: input.instruction, title: input.title, ownerId: job.owner_id, options: input.options, imageAdmin: input.imageAdmin, docId: job.doc_id });
    if (r.ok) { await finishDone(r as unknown as Record<string, unknown>); return { action: "ack" }; }
    if (r.code === "ai_call") return await retryOrFail(AI_BUSY_ERROR, 502, "ai_call", r.error);
    await finishFailed(r.error, r.status, r.code);
    return { action: "ack" };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return await retryOrFail(INTERNAL_ERROR, 500, "internal", detail);
  }
}
