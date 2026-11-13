// 아침 다이제스트 (C9, Cron Triggers) — src/index.ts에서만 호출되는 순수 모듈.
// 매일 07:00 KST Cron(scheduled 핸들러)이 generateDigest()를 부르면,
// 전날(KST 기준) 문서·리플렉션과 현재 열린 할 일·녹음 현황을 D1에서 모아
// Workers AI로 아침 브리핑 문장을 만들고 digest_runs에 저장한다.
// GET /api/digest는 getLatestDigest()로 최신 저장본을 반환한다.
//
// 수동 트리거 엔드포인트는 만들지 않는다 — ADMIN_SECRET이 없어 관리자 잠금을
// 걸 수 없고, 열어두면 누구나 AI 호출을 유발하기 때문이다.
// AI가 실패하면 템플릿 기반 다이제스트로 폴백한다. 가짜 내용은 만들지
// 않는다 — 데이터가 없으면 "없음"으로 표시한다.
//
// 이 파일은 index.ts를 import하지 않는다 (index.ts가 이 파일을 import하는
// 순환 참조를 피하기 위해 responseText 등 필요한 헬퍼를 자체 포함한다).

// index.ts의 LLM_MODEL과 같은 값. 바꾸지 말 것.
const DIGEST_LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export type DigestEnv = {
  DB: D1Database;
  AI: Ai;
};

export type DigestCounts = {
  documents: number; // 전날(KST) 새 문서 수
  summaries: number; // 그중 요약이 달린 문서 수
  openTasks: number; // 현재 열린 할 일 수
  reflections: number; // 전날(KST) 새 리플렉션 수
  recordingsReady: number; // 전사 준비 완료 녹음 수 (현재)
  recordingsPending: number; // 전사 대기·진행 중 녹음 수 (현재)
};

export type DigestDoc = { id: string; title: string; kind: string; summary: string | null; created_at: string };
export type DigestTask = { id: string; title: string; source: string | null; created_at: string };
export type DigestReflection = { id: string; patterns: string | null; created_at: string };
export type DigestRecording = { id: string; title: string; transcript_status: string; created_at: string };

export type DigestSnapshot = {
  counts: DigestCounts;
  documents: DigestDoc[];
  tasks: DigestTask[];
  reflections: DigestReflection[];
  recordings: DigestRecording[];
};

export type DigestData = {
  runDate: string; // KST YYYY-MM-DD (브리핑이 도착하는 아침 날짜)
  generatedAt: string; // ISO UTC
  engine: "workers-ai" | "template";
  body: string; // 브리핑 본문 (줄바꿈 구분)
} & DigestSnapshot;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 실행 시점 now에 대한 다이제스트 창을 계산한다.
 * runDate = now의 KST 날짜 (브리핑이 도착하는 아침).
 * 창 = [KST 어제 00:00, KST 오늘 00:00) — D1 created_at은 UTC
 * datetime('now')이므로 UTC 시각 문자열("YYYY-MM-DD HH:MM:SS")로 반환한다.
 * 예: now가 11-13 22:00 UTC(Cron 07:00 KST)면 runDate 11-14,
 * 창은 11-12 15:00 UTC ~ 11-13 15:00 UTC (= KST 11-13 하루).
 */
export function digestWindow(now: Date): { runDate: string; windowStart: string; windowEnd: string } {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  const runDate = `${y}-${pad2(m + 1)}-${pad2(d)}`;
  const kstMidnightUtc = Date.UTC(y, m, d) - 9 * 3600 * 1000; // KST 오늘 00:00의 UTC 시각
  const toSql = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  return { runDate, windowStart: toSql(kstMidnightUtc - 24 * 3600 * 1000), windowEnd: toSql(kstMidnightUtc) };
}

// Workers AI가 주는 답은 {response: "..."} 상자 안에 있다. index.ts의
// responseText와 같은 동작 (이 모듈은 index.ts를 import하지 않는다).
function responseText(out: unknown): string {
  if (typeof out === "string") return out;
  const res = (out as { response?: unknown } | null)?.response;
  if (typeof res === "string") return res;
  return JSON.stringify(res ?? out);
}

function emptySnapshot(): DigestSnapshot {
  return {
    counts: { documents: 0, summaries: 0, openTasks: 0, reflections: 0, recordingsReady: 0, recordingsPending: 0 },
    documents: [],
    tasks: [],
    reflections: [],
    recordings: [],
  };
}

async function queryAll<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  try {
    const r = await db.prepare(sql).bind(...params).all();
    return ((r.results || []) as T[]) || [];
  } catch {
    return []; // 테이블이 아직 없거나 조회 실패 시 빈 값 (크론이 죽지 않게)
  }
}

async function queryCount(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  try {
    return (await db.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
  } catch {
    return 0;
  }
}

/** D1에서 다이제스트 재료를 모은다. 각 조회는 개별적으로 실패해도 빈 값으로 둔다. */
async function collectSnapshot(db: D1Database, windowStart: string, windowEnd: string): Promise<DigestSnapshot> {
  const [documents, tasks, reflections, recordings, docCount, summaryCount, openTaskCount, reflectionCount, recStatus] =
    await Promise.all([
      queryAll<DigestDoc>(
        db,
        "SELECT id, title, kind, summary, created_at FROM documents WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 10",
        windowStart, windowEnd
      ),
      queryAll<DigestTask>(
        db,
        "SELECT id, title, source, created_at FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 10"
      ),
      queryAll<DigestReflection>(
        db,
        "SELECT id, patterns, created_at FROM reflections WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5",
        windowStart, windowEnd
      ),
      queryAll<DigestRecording>(
        db,
        "SELECT id, title, transcript_status, created_at FROM recordings WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5",
        windowStart, windowEnd
      ),
      queryCount(
        db,
        "SELECT COUNT(*) AS n FROM documents WHERE created_at >= ? AND created_at < ?",
        windowStart, windowEnd
      ),
      queryCount(
        db,
        "SELECT COUNT(*) AS n FROM documents WHERE created_at >= ? AND created_at < ? AND summary IS NOT NULL AND summary != ''",
        windowStart, windowEnd
      ),
      queryCount(db, "SELECT COUNT(*) AS n FROM tasks WHERE done = 0"),
      queryCount(
        db,
        "SELECT COUNT(*) AS n FROM reflections WHERE created_at >= ? AND created_at < ?",
        windowStart, windowEnd
      ),
      queryAll<{ transcript_status: string; n: number }>(
        db,
        "SELECT transcript_status, COUNT(*) AS n FROM recordings GROUP BY transcript_status"
      ),
    ]);
  let recordingsReady = 0;
  let recordingsPending = 0;
  for (const row of recStatus) {
    if (row.transcript_status === "ready") recordingsReady += row.n;
    else recordingsPending += row.n; // pending + processing 모두 대기 중으로 센다
  }
  return {
    counts: {
      documents: docCount,
      summaries: summaryCount,
      openTasks: openTaskCount,
      reflections: reflectionCount,
      recordingsReady,
      recordingsPending,
    },
    documents,
    tasks,
    reflections,
    recordings,
  };
}

/** 리플렉션 patterns JSON의 첫 항목을 짧게 뽑는다 (없으면 null). */
function firstPattern(reflection: DigestReflection | undefined): string | null {
  if (!reflection?.patterns) return null;
  try {
    const arr = JSON.parse(reflection.patterns) as unknown;
    if (Array.isArray(arr) && typeof arr[0] === "string" && arr[0].trim()) return arr[0].trim().slice(0, 120);
  } catch {
    return null;
  }
  return null;
}

/**
 * 템플릿 기반 다이제스트 — 실제 숫자·제목만으로 만든다. 지어낸 내용 없음.
 * 데이터가 없으면 "없음"으로 표시한다.
 */
export function buildTemplateBody(runDate: string, s: DigestSnapshot): string {
  const c = s.counts;
  const lines: string[] = [`[${runDate} 아침 브리핑]`];
  if (c.documents > 0) {
    const titles = s.documents.map((d) => `「${d.title}」`).join(", ");
    lines.push(`어제 새 문서 ${c.documents}건이 들어왔습니다: ${titles}.`);
    if (c.summaries > 0) lines.push(`그중 요약이 달린 문서는 ${c.summaries}건입니다.`);
  } else {
    lines.push("어제 새로 들어온 문서는 없습니다.");
  }
  if (c.openTasks > 0) {
    const titles = s.tasks.slice(0, 5).map((t) => `「${t.title}」`).join(", ");
    lines.push(`열린 할 일 ${c.openTasks}건: ${titles}${c.openTasks > 5 ? " 외" : ""}.`);
  } else {
    lines.push("열린 할 일이 없습니다.");
  }
  if (c.reflections > 0) {
    const first = firstPattern(s.reflections[0]);
    lines.push(`새 리플렉션 ${c.reflections}건${first ? `: ${first}` : ""}.`);
  } else {
    lines.push("어제 새 리플렉션이 없습니다.");
  }
  if (c.recordingsReady + c.recordingsPending > 0) {
    lines.push(`녹음 전사: 준비 완료 ${c.recordingsReady}건, 대기 중 ${c.recordingsPending}건.`);
  }
  return lines.join("\n");
}

function factsBlock(runDate: string, s: DigestSnapshot): string {
  const c = s.counts;
  const lines: string[] = [`오늘 날짜(KST): ${runDate}`];
  lines.push(
    `전날 새 문서: ${c.documents}건${s.documents.length ? ` (${s.documents.map((d) => d.title).join(", ")})` : ""}`
  );
  lines.push(`그중 요약 완료: ${c.summaries}건`);
  lines.push(`열린 할 일: ${c.openTasks}건${s.tasks.length ? ` (${s.tasks.slice(0, 5).map((t) => t.title).join(", ")})` : ""}`);
  lines.push(`전날 새 리플렉션: ${c.reflections}건`);
  const first = firstPattern(s.reflections[0]);
  if (first) lines.push(`리플렉션 핵심 패턴: ${first}`);
  lines.push(`녹음 전사: 준비 완료 ${c.recordingsReady}건, 대기 중 ${c.recordingsPending}건`);
  return lines.join("\n");
}

/** Workers AI로 브리핑 문장을 만든다. 실패하거나 빈 답이면 throw → 템플릿 폴백. */
async function buildAiBody(env: DigestEnv, runDate: string, s: DigestSnapshot): Promise<string> {
  const out = await env.AI.run(DIGEST_LLM_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "너는 HR·코칭 업무 비서다. 주어진 사실만을 근거로 아침 브리핑을 한국어로 3~5줄로 쓴다. 사실에 없는 내용은 지어내지 말고, 없는 항목은 '없음'이라고 말한다. 문서 제목과 숫자는 그대로 쓴다.",
      },
      { role: "user", content: `아래 사실을 바탕으로 오늘 아침 브리핑을 써줘.\n${factsBlock(runDate, s)}` },
    ],
  });
  const text = responseText(out).trim();
  if (text.length < 10) throw new Error("empty ai digest");
  return text.slice(0, 1500);
}

/**
 * 다이제스트 1건을 생성해 digest_runs에 저장하고 반환한다.
 * scheduled 핸들러에서 `generateDigest(env, new Date(event.scheduledTime))`
 * 형태로 부른다. 같은 KST 날짜에 다시 실행되면 INSERT OR REPLACE로
 * 같은 행을 덮어써 멱등하게 동작한다.
 * D1 저장이 실패하면(마이그레이션 미적용 등) 에러를 그대로 던져
 * 크론 실패가 Worker 로그에 남게 한다 — 조용히 넘어가지 않는다.
 */
export async function generateDigest(env: DigestEnv, now: Date = new Date()): Promise<DigestData> {
  const { runDate, windowStart, windowEnd } = digestWindow(now);
  const snapshot = await collectSnapshot(env.DB, windowStart, windowEnd);
  let engine: "workers-ai" | "template" = "template";
  let body: string;
  try {
    body = await buildAiBody(env, runDate, snapshot);
    engine = "workers-ai";
  } catch {
    body = buildTemplateBody(runDate, snapshot);
  }
  const generatedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO digest_runs (run_date, generated_at, engine, body, data_json) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(runDate, generatedAt, engine, body, JSON.stringify(snapshot))
    .run();
  return { runDate, generatedAt, engine, body, ...snapshot };
}

/** 저장된 최신 다이제스트를 반환한다. 없으면 null (GET /api/digest용). */
export async function getLatestDigest(env: DigestEnv): Promise<DigestData | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT run_date, generated_at, engine, body, data_json FROM digest_runs ORDER BY run_date DESC LIMIT 1"
    ).first<{ run_date: string; generated_at: string; engine: string; body: string; data_json: string }>();
    if (!row) return null;
    let snapshot: DigestSnapshot = emptySnapshot();
    try {
      snapshot = JSON.parse(row.data_json) as DigestSnapshot;
    } catch {
      snapshot = emptySnapshot();
    }
    return {
      runDate: row.run_date,
      generatedAt: row.generated_at,
      engine: row.engine === "workers-ai" ? "workers-ai" : "template",
      body: row.body,
      ...snapshot,
    };
  } catch {
    return null;
  }
}
