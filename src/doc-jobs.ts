// 큰 파일 문서 작업 (2026-11-22, 큰 덱·워크북·문서 Queue 처리). 구조화 문서 작업 — ops·replace로 하는 PPTX·XLSX·DOCX 편집과
// 정의로 하는 DOCX 생성 — 은 보통 수십~수백 ms라 요청 안에서 바로 끝내지만(201), 파일이 크면 CPU 수 초가 걸린다
// (실측: 10만 셀 워크북 4.0초, 문단 5,200개 문서 4.4~4.7초, 이미지 10 MiB 문서 생성 1~3초, PPTX text op 1개당 0.3~0.5초).
// 그런 요청은 여기서 작업 행(D1 doc_jobs, migration 0044)을 만들고 전용 Queue(people-os-doc-jobs, 바인딩 DOC_JOBS, type "doc-job")에 넣은 뒤
// 202로 바로 돌려준다. Queue 소비자(src/index.ts queue())가 processDocJob으로 실제 일을 하고, 화면은 GET /api/doc-jobs/:id를 2초마다 물어본다.
// 어느 요청이 "크다"인지는 src/doc-load.ts가 정한다 (ZIP 중앙 디렉터리의 풀린 XML 크기로 예상 CPU를 계산 → DOC_QUEUE_MS 이상이면 Queue).
//
// Word AI 지시 작업(src/docx/jobs.ts, docx_jobs, people-os-docx-jobs)과 같은 패턴이고, 테이블·큐는 나눴다:
// - 큐: AI 작업은 1개가 1~5분이고 Queue는 배치가 끝난 뒤에만 소비자 수를 늘릴지 본다 (그동안 뒤 메시지는 기다린다).
//   몇 초면 끝나는 CPU 작업이 그 뒤에 줄 서지 않게 큐를 따로 둔다.
// - 테이블: 결과가 문서(documents)일 수도 덱(decks)일 수도 있고, 원본 참조·입력 모양·재시도 기준(AI 실패가 없다)이 다르다.
//
// 상태: queued → running → done | failed
// 멱등성 (작업 id 기준 — 편집본이 두 번 생기지 않게)
// - 결과 id(result_id — 새 문서 id 또는 새 덱 id)를 작업을 만들 때 미리 정한다. 같은 작업이 두 번 돌아도 같은 R2 키에 덮어쓰고 행은 INSERT OR IGNORE다.
// - 소비자는 조건부 UPDATE 1문으로 작업을 차지한다 (queued이거나, running인 채 DOC_JOB_RUNNING_STALE_MS가 지난 것만). 이미 done/failed면 ack만.
// - 다시 차지했을 때 결과 행이 이미 있으면 (앞 시도가 저장 뒤 상태를 못 남기고 죽음) 다시 편집하지 않고 done으로 맺는다 (result.recovered).
// 재시도 정책 (층을 나눈다)
// - 요청이 틀림(없는 셀·못 찾는 글자·상한 초과·원본이 지워짐 등, 실행 함수가 돌려준 4xx·502): 다시 해도 같으므로 바로 failed. Queue 재시도 없음.
// - 일시적인 실패(D1·R2·편집 Worker RPC 예외, 편집 Worker 미연결 503): queued로 되돌리고 10초 뒤 재전달. 작업당 최대 DOC_JOB_MAX_ATTEMPTS회, 만든 지 DOC_JOB_RETRY_WINDOW_MS까지.
// - 소비자가 죽음: Queue 재전달(max_retries 3). running이 오래됐으면 다시 차지, 아니면 60초 뒤 다시 본다.
// - 시간 상한: 만든 지 DOC_JOB_DEADLINE_MS(15분)가 지난 queued·running 작업은 failed (상태 조회 때 + 15분 크론).
import { uid } from "./lib";
import { logEvent } from "./obs/log";
import type { DocLoad, DocLoadKind } from "./doc-load";
import { runPptxEdit } from "./pptx/edit";
import type { PptxEnv, PptxSourceRef, PptxWho } from "./pptx/edit";
import { runXlsxEdit } from "./xlsx/edit";
import { runDocxEdit } from "./docx/edit";
import { runDocxCreate } from "./docx/create";
import type { DocxCreateInput } from "./docx/create";

export type DocJobKind = DocLoadKind;
export type DocJobStatus = "queued" | "running" | "done" | "failed";
export type DocJobMessage = { type: "doc-job"; jobId: string; enqueuedAt: string };
export type DocJobEnv = PptxEnv & { DOC_JOBS?: Queue<DocJobMessage> };

/** 일시적인 실패로 다시 시도하는 횟수 상한 (첫 시도 포함) */
export const DOC_JOB_MAX_ATTEMPTS = 3;
/** 만든 지 이 시간이 지나면 다시 시도하지 않는다 */
export const DOC_JOB_RETRY_WINDOW_MS = 6 * 60 * 1000;
/** running인 채 이 시간이 지나면 소비자가 죽은 것으로 보고 다른 전달이 다시 차지한다 (작업 1번은 CPU 30초 한도 안이라 길어야 1분) */
export const DOC_JOB_RUNNING_STALE_MS = 3 * 60 * 1000;
/** 만든 지 이 시간이 지난 queued·running 작업은 failed로 맺는다 */
export const DOC_JOB_DEADLINE_MS = 15 * 60 * 1000;
/** 한 사람이 동시에 돌릴 수 있는 작업 수 */
export const DOC_JOB_MAX_ACTIVE = 3;
/** 끝난 작업 행을 지우는 시점 (입력에 사용자가 쓴 글이 들어 있어 오래 두지 않는다) */
export const DOC_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 작업 행에 넣는 입력(JSON) 글자 수 상한. 넘으면 Queue로 보내지 않고 예전처럼 요청 안에서 처리한다 (D1 한 행 2 MB 한도) */
export const DOC_JOB_MAX_INPUT_CHARS = 400_000;
const RETRY_DELAY_S = 10;
const BUSY_DELAY_S = 60;

export const DOC_JOB_TIMEOUT_ERROR = "작업이 15분 안에 끝나지 않아 멈췄습니다. 잠시 뒤 다시 시도해 주세요.";
const INTERNAL_ERROR = "파일을 처리하는 중 오류가 나서 끝내지 못했습니다 (여러 번 다시 시도했습니다). 잠시 뒤 다시 시도해 주세요.";

export type DocJobInput =
  | { kind: "pptx_edit"; ref: PptxSourceRef; who: PptxWho; ops?: unknown; replace?: unknown; title: string; adminRead: boolean }
  | { kind: "xlsx_edit"; docId: string; who: PptxWho; ops?: unknown; replace?: unknown; title: string; adminRead: boolean }
  | { kind: "docx_edit"; docId: string; who: PptxWho; ops?: unknown; replace?: unknown; title: string; adminRead: boolean }
  | { kind: "docx_create"; def: unknown; title: string; options: DocxCreateInput["options"]; imageAdmin: boolean };

type JobRow = {
  id: string; kind: string; status: string; owner_id: string | null; result_id: string; source_ref: string | null;
  input_json: string; result_json: string | null; error: string | null; error_status: number | null; attempts: number; est_ms: number | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};

const nowIso = () => new Date().toISOString();
const sourceRefOf = (input: DocJobInput): string | null =>
  input.kind === "pptx_edit" ? `${input.ref.kind}:${input.ref.id}` : input.kind === "docx_create" ? null : `doc:${input.docId}`;

/** 이 입력을 작업 행에 담을 수 있는지 (너무 크면 Queue로 보내지 않는다). Queue 바인딩이 없을 때도 false. */
export function docJobFits(env: DocJobEnv, input: DocJobInput): boolean {
  if (!env.DOC_JOBS) return false;
  try { return JSON.stringify(input).length <= DOC_JOB_MAX_INPUT_CHARS; } catch { return false; }
}

export type DocJobTicket = { id: string; kind: DocJobKind; status: "queued"; statusUrl: string; pollMs: number; heavy: true; estMs: number };

/** 작업을 만들고 Queue에 넣는다. 동시 작업 상한을 넘으면 429, Queue에 못 넣으면 503 (작업은 failed로 남긴다). */
export async function enqueueDocJob(
  env: DocJobEnv, ownerId: string | null, input: DocJobInput, load: DocLoad,
): Promise<{ ok: true; job: DocJobTicket } | { ok: false; status: 429 | 503; error: string; code: string }> {
  const queueDown = { ok: false as const, status: 503 as const, error: "작업을 대기열에 넣지 못했습니다. 잠시 뒤 다시 시도해 주세요.", code: "queue_unavailable" };
  if (!env.DOC_JOBS) return queueDown;
  const active = await env.DB.prepare(`SELECT COUNT(*) AS n FROM doc_jobs WHERE owner_id ${ownerId === null ? "IS NULL" : "= ?"} AND status IN ('queued','running') AND created_at > ?`)
    .bind(...(ownerId === null ? [] : [ownerId]), new Date(Date.now() - DOC_JOB_DEADLINE_MS).toISOString()).first<{ n: number }>();
  if ((active?.n ?? 0) >= DOC_JOB_MAX_ACTIVE) {
    return { ok: false, status: 429, error: `처리 중인 큰 파일 작업이 이미 ${DOC_JOB_MAX_ACTIVE}개 있습니다. 끝난 뒤에 다시 시도해 주세요.`, code: "too_many_jobs" };
  }
  const id = uid("docjob");
  const t = nowIso();
  await env.DB.prepare("INSERT INTO doc_jobs (id, kind, status, owner_id, result_id, source_ref, input_json, attempts, est_ms, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?)")
    .bind(id, input.kind, ownerId, uid(input.kind === "pptx_edit" ? "deck" : "doc"), sourceRefOf(input), JSON.stringify(input), load.estMs, t).run();
  try {
    await env.DOC_JOBS.send({ type: "doc-job", jobId: id, enqueuedAt: t } satisfies DocJobMessage);
  } catch (e) {
    await env.DB.prepare("UPDATE doc_jobs SET status = 'failed', error = ?, error_status = 503, finished_at = ? WHERE id = ?").bind(queueDown.error, nowIso(), id).run();
    logEvent("doc.job", { jobId: id, kind: input.kind, event: "enqueue_failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    return queueDown;
  }
  logEvent("doc.job", { jobId: id, kind: input.kind, event: "queued", estMs: load.estMs, bytes: load.bytes, xmlBytes: load.xmlBytes, units: load.units, ops: load.ops });
  return { ok: true, job: { id, kind: input.kind, status: "queued", statusUrl: `/api/doc-jobs/${id}`, pollMs: 2000, heavy: true, estMs: load.estMs } };
}

/** 시간 상한을 넘긴 작업을 failed로 맺는다 (id를 주면 그 작업만). 바꾼 행 수를 돌려준다. */
async function expireDocJobs(env: { DB: D1Database }, id?: string): Promise<number> {
  const cut = new Date(Date.now() - DOC_JOB_DEADLINE_MS).toISOString();
  const r = await env.DB.prepare(`UPDATE doc_jobs SET status = 'failed', error = ?, error_status = 504, finished_at = ? WHERE status IN ('queued','running') AND created_at < ?${id ? " AND id = ?" : ""}`)
    .bind(DOC_JOB_TIMEOUT_ERROR, nowIso(), cut, ...(id ? [id] : [])).run();
  return r.meta?.changes ?? 0;
}

/** 15분 크론: 시간 상한을 넘긴 작업을 failed로, 7일 지난 작업 행은 지운다. */
export async function sweepDocJobs(env: { DB: D1Database }): Promise<{ expired: number; deleted: number }> {
  const expired = await expireDocJobs(env);
  const del = await env.DB.prepare("DELETE FROM doc_jobs WHERE created_at < ?").bind(new Date(Date.now() - DOC_JOB_RETENTION_MS).toISOString()).run();
  const deleted = del.meta?.changes ?? 0;
  if (expired || deleted) logEvent("doc.job", { event: "sweep", expired, deleted });
  return { expired, deleted };
}

/**
 * 작업 상태 (화면 폴링용). 본인 작업만 보인다 (ownerId가 null인 운영 비밀 호출은 소유자 없는 작업만, admin은 전부) — 그 밖은 null(404).
 * done이면 result(동기 경로의 201 응답과 같은 모양)를 함께 준다.
 */
export async function getDocJob(env: { DB: D1Database }, id: string, viewer: { ownerId: string | null; admin: boolean }) {
  let row = await env.DB.prepare("SELECT * FROM doc_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) return null;
  if (!viewer.admin && row.owner_id !== viewer.ownerId) return null;
  if ((row.status === "queued" || row.status === "running") && Date.parse(row.created_at) < Date.now() - DOC_JOB_DEADLINE_MS) {
    await expireDocJobs(env, id);
    row = await env.DB.prepare("SELECT * FROM doc_jobs WHERE id = ?").bind(id).first<JobRow>();
    if (!row) return null;
  }
  const end = row.finished_at ? Date.parse(row.finished_at) : Date.now();
  let result: unknown = null;
  if (row.status === "done" && row.result_json) { try { result = JSON.parse(row.result_json); } catch { result = null; } }
  return {
    job: {
      id: row.id, kind: row.kind as DocJobKind, status: row.status as DocJobStatus, attempts: row.attempts, heavy: true as const, estMs: row.est_ms,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, elapsedMs: Math.max(0, end - Date.parse(row.created_at)),
      ...(row.status === "done" ? { resultId: row.result_id } : {}),
      ...(row.status === "failed" ? { error: row.error || "알 수 없는 오류로 끝내지 못했습니다.", errorStatus: row.error_status } : {}),
      ...((row.status === "queued" && row.attempts >= 1) || (row.status === "running" && row.attempts > 1) ? { retrying: true } : {}),
    },
    ...(result ? { result } : {}),
  };
}

/** D1 한 행에 넣을 결과: 너무 크면 변경 목록·로그를 줄인다 (파일 자체는 R2에 있다). */
function resultJson(r: Record<string, unknown>): string {
  let s = JSON.stringify(r);
  if (s.length > 400_000) s = JSON.stringify({ ...r, diff: Array.isArray(r.diff) ? r.diff.slice(0, 20) : r.diff, log: [], resultTrimmed: true });
  if (s.length > 400_000) s = JSON.stringify({ ok: true, doc: r.doc, deck: r.deck, source: r.source, planned: false, resultTrimmed: true });
  return s;
}

/** 앞선 시도가 이미 저장한 결과가 있으면 그 정보를 돌려준다 (없으면 null). */
async function existingResult(env: DocJobEnv, job: JobRow): Promise<Record<string, unknown> | null> {
  if (job.kind === "pptx_edit") {
    const d = await env.DB.prepare("SELECT id, title, r2_key AS key, bytes, slides FROM decks WHERE id = ?").bind(job.result_id)
      .first<{ id: string; title: string; key: string; bytes: number; slides: number }>();
    return d ? { ok: true, recovered: true, planned: false, deck: { id: d.id, title: d.title, url: `/api/deck/${d.id}`, bytes: d.bytes, slides: d.slides, r2Key: d.key } } : null;
  }
  const d = await env.DB.prepare("SELECT id, title, source_r2_key AS key FROM documents WHERE id = ?").bind(job.result_id).first<{ id: string; title: string; key: string | null }>();
  if (!d) return null;
  const head = d.key ? await env.FILES.head(d.key) : null;
  return { ok: true, recovered: true, planned: false, doc: { id: d.id, title: d.title, url: `/api/documents/${d.id}/download`, bytes: head?.size ?? 0, r2Key: d.key } };
}

type RunResult = { ok: true } | { ok: false; status: number; error: string; code?: string };

async function runJob(env: DocJobEnv, job: JobRow, input: DocJobInput): Promise<RunResult> {
  const ownerId = job.owner_id;
  switch (input.kind) {
    case "pptx_edit":
      return runPptxEdit(env, input.who, input.ref, { ops: input.ops, replace: input.replace, title: input.title, ownerId, adminRead: input.adminRead, newDeckId: job.result_id });
    case "xlsx_edit":
      return runXlsxEdit(env, input.who, input.docId, { ops: input.ops, replace: input.replace, title: input.title, ownerId, adminRead: input.adminRead, newDocId: job.result_id });
    case "docx_edit":
      return runDocxEdit(env, input.who, input.docId, { ops: input.ops, replace: input.replace, title: input.title, ownerId, adminRead: input.adminRead, newDocId: job.result_id });
    case "docx_create":
      return runDocxCreate(env, { def: input.def, title: input.title, ownerId, options: input.options, imageAdmin: input.imageAdmin, docId: job.result_id });
  }
}

export type DocJobOutcome = { action: "ack" } | { action: "retry"; delaySeconds: number };

/** Queue 메시지 1개 = 작업 1번 시도. 예외를 던지지 않으려 하고(상태 갱신 D1 오류만 던진다 → Queue 재시도), ack할지 다시 받을지를 돌려준다. */
export async function processDocJob(env: DocJobEnv, msg: DocJobMessage): Promise<DocJobOutcome> {
  const id = msg.jobId;
  const now = Date.now();
  const claim = await env.DB.prepare("UPDATE doc_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND (status = 'queued' OR (status = 'running' AND started_at < ?))")
    .bind(new Date(now).toISOString(), id, new Date(now - DOC_JOB_RUNNING_STALE_MS).toISOString()).run();
  const job = await env.DB.prepare("SELECT * FROM doc_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) return { action: "ack" }; // 지워진 작업
  if (!(claim.meta?.changes ?? 0)) {
    if (job.status === "done" || job.status === "failed") return { action: "ack" }; // 이미 끝남 (중복 전달)
    logEvent("doc.job", { jobId: id, kind: job.kind, event: "busy", status: job.status });
    return { action: "retry", delaySeconds: BUSY_DELAY_S }; // 다른 전달이 하고 있다 — 나중에 다시 본다
  }
  const base = () => ({ jobId: id, kind: job.kind, attempts: job.attempts, estMs: job.est_ms, waitMs: now - Date.parse(job.created_at), runMs: Date.now() - now });

  const finishDone = async (result: Record<string, unknown>) => {
    // done은 시간 상한이 먼저 failed로 바꾼 뒤에도 덮어쓴다 (파일이 실제로 있으니 done이 맞다)
    await env.DB.prepare("UPDATE doc_jobs SET status = 'done', result_json = ?, error = NULL, error_status = NULL, finished_at = ? WHERE id = ? AND status != 'done'")
      .bind(resultJson(result), nowIso(), id).run();
    logEvent("doc.job", { ...base(), event: "done", resultId: job.result_id, recovered: result.recovered === true });
  };
  const finishFailed = async (error: string, status: number, code?: string) => {
    await env.DB.prepare("UPDATE doc_jobs SET status = 'failed', error = ?, error_status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(error.slice(0, 1000), status, nowIso(), id).run();
    logEvent("doc.job", { ...base(), event: "failed", status, code: code ?? null, error: error.slice(0, 200) });
  };
  const retryOrFail = async (status: number, code: string, detail: string): Promise<DocJobOutcome> => {
    const canRetry = job.attempts < DOC_JOB_MAX_ATTEMPTS && Date.now() - Date.parse(job.created_at) < DOC_JOB_RETRY_WINDOW_MS;
    if (!canRetry) { await finishFailed(INTERNAL_ERROR, status, code); return { action: "ack" }; }
    await env.DB.prepare("UPDATE doc_jobs SET status = 'queued', error = ? WHERE id = ? AND status = 'running'").bind(detail.slice(0, 1000), id).run();
    logEvent("doc.job", { ...base(), event: "retry", code, error: detail.slice(0, 200) });
    return { action: "retry", delaySeconds: RETRY_DELAY_S };
  };

  try {
    const existing = await existingResult(env, job);
    if (existing) { await finishDone(existing); return { action: "ack" }; }
    let input: DocJobInput;
    try { input = JSON.parse(job.input_json) as DocJobInput; } catch { await finishFailed("작업 입력을 읽지 못했습니다.", 500, "internal"); return { action: "ack" }; }
    const r = await runJob(env, job, input);
    if (r.ok) { await finishDone(r as unknown as Record<string, unknown>); return { action: "ack" }; }
    if (r.status === 503) return await retryOrFail(503, "editor_unavailable", r.error);
    await finishFailed(r.error, r.status, r.code);
    return { action: "ack" };
  } catch (e) {
    return await retryOrFail(500, "internal", e instanceof Error ? e.message : String(e));
  }
}
