// 에이전트 활동 타임라인 (A1, 2026-11-17, presentation-plan.md 3.2·6.2). index.ts에서 "/api/agent"에 mount한다.
//   GET /activity?limit=30   "에이전트가 최근에 한 일"을 한 목록으로 (무엇을 · 언제 · 결과 · 사람 확인 필요 여부)
//
// 읽기 전용. 마이그레이션 없음. 기존 테이블 6개를 각각 읽어 합친다:
//   recordings     녹음 파이프라인 단계      소유자: owner_id (0016)
//   ask_events     질문 처리                 소유자: user_id  (0021)   origin='eval'|'metadata' 행은 제외 (평가는 eval_runs로 본다)
//   emails         메일 답장 초안(ai_draft_at) 소유자: owner_id (0022)
//   knowledge_gaps 지식 공백 기록            소유자: user_id  (0021)
//   digest_runs    아침 다이제스트           소유자 없음 → 시스템 항목, HR 관리자만
//   eval_runs      자기 평가 실행            소유자 없음 → 시스템 항목, HR 관리자만
//
// 소유자 격리 (fail-closed):
//   - 익명 401. 세션 사용자만 (X-Admin-Secret 경로는 받지 않는다 — 사람이 보는 화면용 API다).
//   - 일반 사용자: 소유자 컬럼 = 내 id 인 행만. 소유자 컬럼이 없는 테이블(시스템 항목, 또는 옛 스키마)은 아예 읽지 않는다.
//   - HR 관리자: 전체 + 시스템 항목. 소유자 NULL 행(익명·공용)도 본다.
// 스키마 누락: 테이블·컬럼은 PRAGMA table_info로 먼저 확인하고, 없는 소스는 건너뛰어 skipped에 적는다 (500 아님).
import { Hono } from "hono";
import { getSessionUser, type AuthEnv, type SessionUser } from "../auth";

type Env = Pick<AuthEnv, "DB">;
export const agentActivityApp = new Hono<{ Bindings: Env }>();

export type ActivitySource = "recording" | "ask" | "email_draft" | "knowledge_gap" | "digest" | "eval";
export type ActivityStatus = "ok" | "running" | "warn" | "error";

export type ActivityItem = {
  id: string;                 // "<source>:<row id>"
  source: ActivitySource;
  what: string;               // 무엇을
  at: string;                 // 언제 (ISO 8601 UTC)
  result: string;             // 결과
  status: ActivityStatus;
  needsReview: boolean;       // 사람 확인 필요 여부
  reviewHint: string | null;  // 누가 무엇을 확인하면 되는지
  system: boolean;            // 소유자 없는 시스템 항목 (HR 관리자만)
  tab: string | null;         // 앱에서 열 탭 (index.html switchTab 이름)
  owner: { id: string; name: string } | null; // HR 관리자 응답에만. 소유자 NULL이면 null
};

type Skip = { source: ActivitySource; reason: "no-table" | "no-owner-column" | "error" };

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

/** D1/SQLite 시각 문자열("YYYY-MM-DD HH:MM:SS", UTC) · ISO 문자열 · 밀리초 숫자를 ISO로. 해석 불가면 "". */
export function toIso(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString() : "";
  const s = String(v).trim();
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const d = new Date(sqlite);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function clip(s: unknown, n = 60): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function columnsOf(db: D1Database, table: string): Promise<Set<string>> {
  // 테이블 이름은 이 파일의 상수만 들어온다 (사용자 입력 아님).
  const r = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((r.results ?? []).map((x) => x.name));
}

type Viewer = { user: SessionUser; admin: boolean };

/**
 * 소스 하나를 읽는 공통 틀. 테이블이 없으면 no-table, 일반 사용자인데 소유자 컬럼이 없으면
 * no-owner-column(읽지 않음). systemOnly 소스는 일반 사용자에게 호출조차 하지 않는다.
 * 반환하는 where/binds는 소유자 조건만 담는다 — 각 소스가 자기 조건을 AND로 붙인다.
 */
async function prepareSource(
  db: D1Database,
  v: Viewer,
  source: ActivitySource,
  table: string,
  ownerCol: string | null,
  skipped: Skip[],
): Promise<{ cols: Set<string>; ownerWhere: string; binds: unknown[]; ownerSelect: string } | null> {
  const cols = await columnsOf(db, table);
  if (cols.size === 0) { skipped.push({ source, reason: "no-table" }); return null; }
  const hasOwner = ownerCol !== null && cols.has(ownerCol);
  if (!v.admin) {
    if (!hasOwner) { skipped.push({ source, reason: "no-owner-column" }); return null; }
    return { cols, ownerWhere: `${ownerCol} = ?`, binds: [v.user.id], ownerSelect: `${ownerCol} AS owner_id` };
  }
  return { cols, ownerWhere: "1 = 1", binds: [], ownerSelect: hasOwner ? `${ownerCol} AS owner_id` : "NULL AS owner_id" };
}

type Raw = Omit<ActivityItem, "owner"> & { ownerId: string | null; ts: number };

function raw(item: Omit<Raw, "ts">): Raw {
  const ts = item.at ? Date.parse(item.at) : 0;
  return { ...item, ts: Number.isNaN(ts) ? 0 : ts };
}

const STAGE_LABEL: Record<string, string> = {
  queued: "대기", transcribing: "전사 중", summarizing: "요약 중", indexing: "색인 중", done: "완료", failed: "실패",
};

async function readRecordings(db: D1Database, v: Viewer, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const p = await prepareSource(db, v, "recording", "recordings", "owner_id", skipped);
  if (!p) return [];
  const stage = p.cols.has("pipeline_stage") ? "pipeline_stage" : "NULL";
  const err = p.cols.has("pipeline_error") ? "pipeline_error" : "NULL";
  const r = await db.prepare(
    `SELECT id, title, transcript_status, ${stage} AS stage, ${err} AS err, created_at, ${p.ownerSelect}
       FROM recordings WHERE ${p.ownerWhere} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...p.binds, limit).all<{ id: string; title: string; transcript_status: string; stage: string | null; err: string | null; created_at: string; owner_id: string | null }>();
  return (r.results ?? []).map((x) => {
    const stage = x.stage ?? (x.transcript_status === "ready" ? "done" : "transcribing");
    const failed = stage === "failed";
    const done = stage === "done";
    return raw({
      id: `recording:${x.id}`, source: "recording",
      what: `녹음 "${clip(x.title, 40)}" 전사 → 요약 → 색인`,
      at: toIso(x.created_at),
      result: failed ? `실패${x.err ? ": " + clip(x.err, 60) : ""} (전사본은 보존됨)` : done ? "전사·요약·색인 완료" : `진행 중 — ${STAGE_LABEL[stage] ?? stage}`,
      status: failed ? "error" : done ? "ok" : "running",
      needsReview: failed,
      reviewHint: failed ? "녹음 목록에서 파이프라인 재시도" : null,
      system: false, tab: "upload", ownerId: x.owner_id ?? null,
    });
  });
}

async function readAsks(db: D1Database, v: Viewer, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const p = await prepareSource(db, v, "ask", "ask_events", "user_id", skipped);
  if (!p) return [];
  // 평가·메타데이터 호출은 사람의 질문이 아니다. 평가는 eval_runs 항목으로 따로 보인다.
  const originWhere = p.cols.has("origin") ? " AND (origin IS NULL OR origin IN ('user','personal'))" : "";
  const status = p.cols.has("status") ? "status" : "NULL";
  const origin = p.cols.has("origin") ? "origin" : "NULL";
  const r = await db.prepare(
    `SELECT id, question, grounded, ${status} AS status, ${origin} AS origin, feedback, created_at, ${p.ownerSelect}
       FROM ask_events WHERE ${p.ownerWhere}${originWhere} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...p.binds, limit).all<{ id: string; question: string; grounded: number; status: string | null; origin: string | null; feedback: string | null; created_at: string; owner_id: string | null }>();
  return (r.results ?? []).map((x) => {
    const st = x.status ?? (x.grounded ? "grounded" : "no_evidence");
    const down = x.feedback === "down";
    const result = st === "error" ? "답변 실패" : st === "grounded" ? "근거 있는 답변" : "근거 없음 — 지식 공백으로 기록";
    const needsReview = st !== "grounded" || down;
    return raw({
      id: `ask:${x.id}`, source: "ask",
      what: `질문 처리: "${clip(x.question, 50)}"`,
      at: toIso(x.created_at),
      result: result + (down ? " · 👎 피드백" : x.feedback === "up" ? " · 👍 피드백" : ""),
      status: st === "error" ? "error" : needsReview ? "warn" : "ok",
      needsReview,
      reviewHint: needsReview ? "HR이 지식 공백 큐에서 답을 게시" : null,
      system: false, tab: x.origin === "personal" ? "personal" : "ask", ownerId: x.owner_id ?? null,
    });
  });
}

async function readEmailDrafts(db: D1Database, v: Viewer, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const p = await prepareSource(db, v, "email_draft", "emails", "owner_id", skipped);
  if (!p) return [];
  if (!p.cols.has("ai_draft_at")) { skipped.push({ source: "email_draft", reason: "no-table" }); return []; }
  // 초안 이후 같은 스레드·같은 소유자로 보낸 메일이 있으면 사람이 처리한 것으로 본다.
  const sent = p.cols.has("thread_id")
    ? `EXISTS (SELECT 1 FROM emails o WHERE o.direction = 'out' AND o.thread_id = e.thread_id AND o.owner_id IS e.owner_id AND o.received_at >= e.ai_draft_at)`
    : "0";
  const r = await db.prepare(
    `SELECT e.id, e.subject, e.ai_draft_at, ${sent} AS sent, e.owner_id AS owner_id
       FROM emails e WHERE ${v.admin ? "1 = 1" : "e.owner_id = ?"} AND e.ai_draft_at IS NOT NULL
      ORDER BY e.ai_draft_at DESC LIMIT ?`,
  ).bind(...p.binds, limit).all<{ id: string; subject: string; ai_draft_at: string; sent: number; owner_id: string | null }>();
  return (r.results ?? []).map((x) => raw({
    id: `email_draft:${x.id}`, source: "email_draft",
    what: `메일 답장 초안 작성: "${clip(x.subject || "(제목 없음)", 40)}"`,
    at: toIso(x.ai_draft_at),
    result: x.sent ? "초안 저장 → 사람이 답장 발송함" : "초안 저장됨 (발송하지 않음)",
    status: x.sent ? "ok" : "warn",
    needsReview: !x.sent,
    reviewHint: x.sent ? null : "메일함에서 초안을 확인하고 직접 발송",
    system: false, tab: "email", ownerId: x.owner_id ?? null,
  }));
}

async function readGaps(db: D1Database, v: Viewer, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const p = await prepareSource(db, v, "knowledge_gap", "knowledge_gaps", "user_id", skipped);
  if (!p) return [];
  const r = await db.prepare(
    `SELECT id, question, asked_at, status, count, source, ${p.ownerSelect}
       FROM knowledge_gaps WHERE ${p.ownerWhere} ORDER BY asked_at DESC LIMIT ?`,
  ).bind(...p.binds, limit).all<{ id: string; question: string; asked_at: number; status: string; count: number; source: string; owner_id: string | null }>();
  return (r.results ?? []).map((x) => {
    const resolved = x.status === "resolved";
    const answered = x.status === "answered";
    return raw({
      id: `knowledge_gap:${x.id}`, source: "knowledge_gap",
      what: `지식 공백 기록: "${clip(x.question, 50)}"${x.count > 1 ? ` (${x.count}회)` : ""}`,
      at: toIso(x.asked_at),
      result: resolved ? "답 게시 → 재검증 통과" : answered ? "답 게시됨 — 재검증 대기" : `HR 답변 대기 (${x.source === "downvote" ? "👎 피드백" : "근거 없음"})`,
      status: resolved ? "ok" : "warn",
      needsReview: !resolved,
      reviewHint: resolved ? null : answered ? "같은 질문 재실행으로 검증" : "HR이 암묵지로 답을 게시",
      system: false, tab: v.admin ? "obs" : "ask", ownerId: x.owner_id ?? null,
    });
  });
}

async function readDigests(db: D1Database, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const cols = await columnsOf(db, "digest_runs");
  if (cols.size === 0) { skipped.push({ source: "digest", reason: "no-table" }); return []; }
  const r = await db.prepare(
    "SELECT run_date, generated_at, engine FROM digest_runs ORDER BY generated_at DESC LIMIT ?",
  ).bind(limit).all<{ run_date: string; generated_at: string; engine: string }>();
  return (r.results ?? []).map((x) => raw({
    id: `digest:${x.run_date}`, source: "digest",
    what: `아침 다이제스트 생성 (${x.run_date})`,
    at: toIso(x.generated_at),
    result: x.engine === "workers-ai" ? "AI 브리핑 작성" : "AI 실패 → 템플릿 브리핑으로 대체",
    status: x.engine === "workers-ai" ? "ok" : "warn",
    needsReview: false, reviewHint: null,
    system: true, tab: "home", ownerId: null,
  }));
}

async function readEvals(db: D1Database, limit: number, skipped: Skip[]): Promise<Raw[]> {
  const cols = await columnsOf(db, "eval_runs");
  if (cols.size === 0) { skipped.push({ source: "eval", reason: "no-table" }); return []; }
  const r = await db.prepare(
    `SELECT id, trigger, status, items_total, items_done, pass_rate, error,
            COALESCE(finished_at, started_at, created_at) AS at
       FROM eval_runs ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all<{ id: string; trigger: string; status: string; items_total: number; items_done: number; pass_rate: number | null; error: string | null; at: string }>();
  const TRIGGER: Record<string, string> = { cron: "정기", manual: "수동", regression: "회귀" };
  return (r.results ?? []).map((x) => {
    const bad = x.status === "failed" || x.status === "partial" || x.status === "aborted";
    const running = x.status === "queued" || x.status === "running";
    const rate = x.pass_rate === null || x.pass_rate === undefined ? "" : ` · 통과율 ${Math.round(x.pass_rate * 100)}%`;
    const result = x.status === "done" ? `완료 ${x.items_done}/${x.items_total}${rate}`
      : x.status === "skipped" ? "건너뜀 (변경 없음)"
      : running ? `진행 중 ${x.items_done}/${x.items_total}`
      : `${x.status === "partial" ? "일부 실패" : x.status === "aborted" ? "중단" : "실패"} ${x.items_done}/${x.items_total}${rate}`;
    return raw({
      id: `eval:${x.id}`, source: "eval",
      what: `자기 평가 실행 (${TRIGGER[x.trigger] ?? x.trigger})`,
      at: toIso(x.at),
      result,
      status: bad ? "error" : running ? "running" : "ok",
      needsReview: bad,
      reviewHint: bad ? "관측·평가 탭에서 실패 항목 확인" : null,
      system: true, tab: "obs", ownerId: null,
    });
  });
}

/** 소스 하나가 실패해도 나머지는 돌려준다. 실패 메시지는 응답에 넣지 않는다 (서버 로그만). */
async function guarded(source: ActivitySource, skipped: Skip[], fn: () => Promise<Raw[]>): Promise<Raw[]> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`agent activity: ${source} skipped: ${msg}`);
    skipped.push({ source, reason: /no such table|no such column/i.test(msg) ? "no-table" : "error" });
    return [];
  }
}

export async function collectActivity(db: D1Database, user: SessionUser, limit: number) {
  const v: Viewer = { user, admin: user.role === "hr_admin" };
  const skipped: Skip[] = [];
  const parts = await Promise.all([
    guarded("recording", skipped, () => readRecordings(db, v, limit, skipped)),
    guarded("ask", skipped, () => readAsks(db, v, limit, skipped)),
    guarded("email_draft", skipped, () => readEmailDrafts(db, v, limit, skipped)),
    guarded("knowledge_gap", skipped, () => readGaps(db, v, limit, skipped)),
    // 시스템 항목: 일반 사용자에게는 읽지도 않는다.
    v.admin ? guarded("digest", skipped, () => readDigests(db, limit, skipped)) : Promise.resolve([]),
    v.admin ? guarded("eval", skipped, () => readEvals(db, limit, skipped)) : Promise.resolve([]),
  ]);
  const merged = parts.flat().sort((a, b) => b.ts - a.ts).slice(0, limit);

  // 소유자 이름은 HR 관리자 응답에만 붙인다.
  const names = new Map<string, string>();
  if (v.admin) {
    const ids = [...new Set(merged.map((x) => x.ownerId).filter((x): x is string => !!x))];
    if (ids.length) {
      try {
        const r = await db.prepare(`SELECT id, name, email FROM users WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids).all<{ id: string; name: string; email: string }>();
        for (const u of r.results ?? []) names.set(u.id, u.name || u.email);
      } catch { /* 이름 없이 진행 */ }
    }
  }
  const items: ActivityItem[] = merged.map(({ ownerId, ts: _ts, ...rest }) => ({
    ...rest,
    owner: v.admin && ownerId ? { id: ownerId, name: names.get(ownerId) ?? "알 수 없음" } : null,
  }));
  const needsReview = items.filter((x) => x.needsReview).length;
  return { scope: v.admin ? "all" : "mine", items, needsReview, skipped };
}

agentActivityApp.get("/activity", async (c) => {
  const user = await getSessionUser(c.env, c.req.header("cookie"));
  if (!user) return c.json({ ok: false, error: "로그인이 필요합니다." }, 401);
  const n = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
  const out = await collectActivity(c.env.DB, user, limit);
  return c.json({ ok: true, ...out }, 200, { "cache-control": "no-store" });
});
