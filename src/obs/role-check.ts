// XAI 보완 (2026-11-19) — 편향/일관성 축: 역할별 답 비교.
//
// 골든셋의 공용 HR 규정 질문을 역할별로(기본 hr_admin·user 2개) 다시 돌려 답·근거·판정이
// 얼마나 달라지는지 잰다. 공용 규정은 누가 물어도 같은 답이어야 한다.
// 개인 질문(데이터셋 id에 "personal" 또는 항목 태그 "personal")에는 적용하지 않는다 —
// 사람마다 데이터가 달라 답이 달라지는 게 정상이다.
//
// 비용을 줄이는 2단계 비교:
//  1단계 (LLM 추가 호출 없음): 처리 결과(grounded/no_evidence) 일치 + 인용 근거 겹침(Jaccard)
//        + 답 문자 bigram 유사도(Dice, 핵심 결론 일치의 값싼 대용).
//  2단계 (1단계가 의심스러울 때만): 역할별 답에 verdict 판정(Clef 앙상블)을 돌려 판정 일치 확인.
// 하나라도 크게 다르면 inconsistent=true. 결과는 eval_results.role_check_json에만 쓰고
// 기존 통과/실패·judge·verdict에는 영향을 주지 않는다 (추가 축).
import type { AskEnv, AskHooks, AskInput, AskOptions, AskRunResult, Source } from "../ask-pipeline";
import { EST_TOKENS, estimateCallUsd, metaGet } from "./guards";
import { classifyVerdict, type VerdictEngine } from "./verdict";
import type { EvalItem, ObsEnv, Verdict } from "./types";

export const ROLE_CHECK_DEFAULT_ROLES = ["hr_admin", "user"] as const;
/** 옵션: meta.eval_role_check_roles = "hr_admin,user,coach,coachee" 로 4개까지 늘린다. "off"면 끈다. */
export const ROLE_CHECK_ALLOWED_ROLES = ["hr_admin", "user", "coach", "coachee"];
export const META_ROLE_CHECK_ROLES = "eval_role_check_roles";

/** 1단계 임계값 — 이 아래면 "크게 다름". */
export const ROLE_SOURCE_OVERLAP_MIN = 0.5;
/** 답 bigram 유사도: 이 아래면 2단계(verdict) 확인을 돈다. */
export const ROLE_ANSWER_SIM_SUSPECT = 0.35;
/** 답 bigram 유사도: 이 아래면 verdict가 같아도 결론이 크게 다르다고 본다. */
export const ROLE_ANSWER_SIM_MIN = 0.2;

export type RoleRun = {
  role: string;
  eventId: string | null;
  status: string | null;
  sourceIds: string[];
  sourceLabels: string[];
  answer: string | null;
  verdict?: Verdict | null;
  error?: string;
};

export type RoleCheckResult = {
  version: 1;
  roles: string[];
  runs: RoleRun[];
  statusMatch: boolean;
  sourceOverlapMin: number | null;
  answerSimMin: number | null;
  verdictChecked: boolean;
  verdictMatch: boolean | null;
  inconsistent: boolean;
  reasons: string[];
  llmCalls: number;
  costUsd: number;
};

export function roleCheckEligible(datasetId: string, item: EvalItem): boolean {
  if (/personal/i.test(datasetId)) return false;
  if (item.tags.some((t) => /personal/i.test(t))) return false;
  return true;
}

/** meta에서 역할 목록을 읽는다. 없으면 기본 2개, "off"면 빈 배열. 허용 목록 밖 값은 버린다. */
export async function loadRoleCheckRoles(env: Pick<ObsEnv, "DB">): Promise<string[]> {
  const raw = await metaGet(env.DB, META_ROLE_CHECK_ROLES);
  if (raw == null || !raw.trim()) return [...ROLE_CHECK_DEFAULT_ROLES];
  if (raw.trim().toLowerCase() === "off") return [];
  const picked = raw.split(",").map((s) => s.trim()).filter((s) => ROLE_CHECK_ALLOWED_ROLES.includes(s));
  const uniq = [...new Set(picked)];
  return uniq.length >= 2 ? uniq : [...ROLE_CHECK_DEFAULT_ROLES];
}

/** 항목 1건당 역할 축 사전 비용 추정 (역할별 ask + 최악의 경우 역할별 verdict). */
export function estimateRoleCheckUsd(roleCount: number): number {
  return roleCount * (estimateCallUsd(EST_TOKENS.ask.in, EST_TOKENS.ask.out) + estimateCallUsd(EST_TOKENS.verdict.in, EST_TOKENS.verdict.out));
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/\s+/g, "").replace(/[.,!?·:;"'()\[\]{}<>~\-—…]/g, "");
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

/** 문자 bigram Dice 계수 (0~1). 둘 다 비면 1. */
export function answerSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  let na = 0, nb = 0, inter = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  if (!na && !nb) return 1;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return (2 * inter) / (na + nb);
}

type RunAskFn = (env: AskEnv, input: AskInput, opts?: AskOptions, hooks?: AskHooks) => Promise<AskRunResult>;

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * 역할별 비교를 돈다. 던지지 않는다 — 실패한 역할은 error로 남기고 비교에서 뺀다.
 * 비교 기준은 첫 번째 역할(기본 hr_admin)이다.
 */
export async function runRoleCheck(
  env: AskEnv & { AI: unknown },
  args: { item: EvalItem; runId: string; roles: string[]; promptVersionId?: string; verdictEngine: VerdictEngine },
  deps: { runAsk: RunAskFn; hooks: AskHooks },
): Promise<RoleCheckResult> {
  const { item, runId, roles } = args;
  const runs: RoleRun[] = [];
  const sourcesByRole = new Map<string, Source[]>();
  let llmCalls = 0;
  let costUsd = 0;
  // 순서대로 돈다 — Workers AI 분당 한도 보호 (항목 간 간격과 같은 이유).
  for (const role of roles) {
    const run: RoleRun = { role, eventId: null, status: null, sourceIds: [], sourceLabels: [], answer: null };
    try {
      const res = await deps.runAsk(
        env,
        { question: item.question, sessionId: `eval:${runId}:${item.id}:role:${role}`, startedAt: Date.now() },
        {
          origin: "eval", evalRunId: runId, recordGap: false, readCache: false, writeCache: false, persistSession: false,
          gatewaySkipCache: true, pool: "shared",
          // 합성 조회자: 공용 풀(pool shared)은 owner_id IS NULL만 보므로 id는 검색 범위에 영향이 없다.
          viewer: { id: `eval-role:${role}`, role },
          ...(args.promptVersionId ? { promptVersionId: args.promptVersionId } : {}),
        },
        deps.hooks,
      );
      if (res.cached) run.error = "ask_cached";
      else {
        const b = res.body;
        run.eventId = b.eventId;
        run.status = res.trace.status;
        run.sourceIds = b.sources.map((s) => s.id);
        run.sourceLabels = b.sources.map((s) => `${s.title}${s.section ? ` › ${s.section}` : ""}`);
        run.answer = b.answer;
        sourcesByRole.set(role, b.sources);
        // traceSink가 없으면 runAsk는 ask_events 기본 컬럼만 쓴다 — 평가 행으로 표시해 사용자 목록에 섞이지 않게 한다 (evaluateItem과 같은 처리).
        if (!deps.hooks.traceSink) {
          try {
            await env.DB.prepare("UPDATE ask_events SET origin = 'eval', eval_run_id = ?, status = ? WHERE id = ?").bind(runId, res.trace.status, b.eventId).run();
          } catch { /* 표시 실패는 비교에 영향 없음 */ }
        }
        if (b.engine === "workers-ai") {
          llmCalls++;
          costUsd += estimateCallUsd(res.trace.usage?.promptTokens ?? EST_TOKENS.ask.in, res.trace.usage?.completionTokens ?? EST_TOKENS.ask.out);
        }
      }
    } catch (e) {
      run.error = `ask_failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
    runs.push(run);
  }

  const ok = runs.filter((r) => !r.error);
  const reasons: string[] = [];
  const ref = ok[0];
  let statusMatch = true;
  let overlapMin: number | null = null;
  let simMin: number | null = null;
  if (ok.length >= 2 && ref) {
    for (const r of ok.slice(1)) {
      if (r.status !== ref.status) statusMatch = false;
      const ov = jaccard(ref.sourceIds, r.sourceIds);
      const sim = answerSimilarity(ref.answer ?? "", r.answer ?? "");
      overlapMin = overlapMin == null ? ov : Math.min(overlapMin, ov);
      simMin = simMin == null ? sim : Math.min(simMin, sim);
    }
  }
  if (!statusMatch) reasons.push("처리 결과(근거 있음/없음)가 역할마다 다름");
  if (overlapMin != null && overlapMin < ROLE_SOURCE_OVERLAP_MIN) reasons.push(`인용 근거 겹침 낮음 (${round(overlapMin)})`);

  // 2단계: 1단계가 의심스러우면 역할별 답에 verdict를 돌려 판정을 비교한다.
  const suspect = !statusMatch || (overlapMin != null && overlapMin < ROLE_SOURCE_OVERLAP_MIN) || (simMin != null && simMin < ROLE_ANSWER_SIM_SUSPECT);
  let verdictChecked = false;
  let verdictMatch: boolean | null = null;
  if (suspect && ok.length >= 2) {
    verdictChecked = true;
    for (const r of ok) {
      if (r.status !== "grounded") { r.verdict = null; continue; } // 근거 없음 답은 판정 대상이 아니다 (평가 규칙과 같음)
      const src = sourcesByRole.get(r.role) ?? [];
      const v = await classifyVerdict(env, { question: item.question, answer: r.answer ?? "", evidence: src.map((s) => ({ title: s.title, section: s.section, snippet: s.snippet })) }, args.verdictEngine);
      llmCalls++;
      costUsd += estimateCallUsd(EST_TOKENS.verdict.in, EST_TOKENS.verdict.out);
      r.verdict = v.ok ? v.verdict : null;
      if (!v.ok) r.error = `verdict_failed: ${v.error}`;
    }
    const vs = ok.filter((r) => r.status === "grounded" && r.verdict).map((r) => r.verdict);
    verdictMatch = vs.length >= 2 ? vs.every((v) => v === vs[0]) : null;
    if (verdictMatch === false) reasons.push("판정(verdict)이 역할마다 다름");
  }
  if (simMin != null && simMin < ROLE_ANSWER_SIM_MIN) reasons.push(`답 결론 유사도 낮음 (${round(simMin)})`);
  if (ok.length < 2) reasons.push(`비교 불가 — 성공한 역할 ${ok.length}개`);

  const inconsistent = ok.length >= 2 && (
    !statusMatch
    || (overlapMin != null && overlapMin < ROLE_SOURCE_OVERLAP_MIN)
    || verdictMatch === false
    || (simMin != null && simMin < ROLE_ANSWER_SIM_MIN)
  );
  return {
    version: 1, roles, runs: runs.map((r) => ({ ...r, answer: r.answer ? r.answer.slice(0, 1500) : r.answer })),
    statusMatch, sourceOverlapMin: overlapMin == null ? null : round(overlapMin), answerSimMin: simMin == null ? null : round(simMin),
    verdictChecked, verdictMatch, inconsistent, reasons, llmCalls, costUsd,
  };
}
