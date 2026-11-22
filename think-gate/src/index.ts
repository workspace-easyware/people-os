// T0 관문 전용 Worker — Think 0.23.0이 People OS 조건에서 도는지 확인한다.
// 운영 코드가 아니다. T1에서 운영 Worker에 넣을 ThinkAgent의 뼈대 참고용.
import { Think } from "@cloudflare/think";
import type {
  ChatRecoveryContext,
  ChatResponseResult,
  PrepareStepContext,
  StepConfig,
  StepContext,
  ThinkSubmissionInspection,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { getAgentByName } from "agents";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

interface Env {
  AI: Ai;
  ThinkAgent: DurableObjectNamespace<ThinkAgent>;
  GATE_OPEN_UNTIL: string;
  BUILD: string;
}

const MODELS: Record<string, string> = {
  qwen: "@cf/qwen/qwen3.8-27b",
  kimi: "@cf/moonshotai/kimi-k2.6",
};

type Cfg = {
  model: string;
  maxSteps: number;
  timeLimitMs: number; // 0 = 없음
  forceCount: number; // 앞의 N스텝은 count_step 호출을 강제 (10스텝 턴을 결정적으로 만들기 위함)
  sleepMs: number; // count_step이 쉬는 시간
  activeTools: string[];
};

const DEFAULT_CFG: Cfg = {
  model: MODELS.qwen,
  maxSteps: 10,
  timeLimitMs: 0,
  forceCount: 0,
  sleepMs: 0,
  activeTools: ["ask_rag", "create_task", "email_draft"],
};

// 부작용 도구: 승인 없이는 실행하면 안 되는 것.
const SIDE_EFFECT_TOOLS = new Set(["send_email"]);

const SYSTEM = [
  "너는 People OS의 업무 에이전트다. 사용자의 요청에 가장 맞는 도구를 골라 호출하고, 결과를 받은 뒤 한국어로 짧게 답한다.",
  "- 사내 규정·제도·문서에 대한 질문: ask_rag",
  "- 할 일(태스크) 등록: create_task",
  "- 메일 초안 작성(보내지 않음): email_draft",
  "- 메일 실제 발송: send_email",
  "- 숫자 세기 요청: count_step",
].join("\n");

export class ThinkAgent extends Think<Env> {
  private blocked = false;
  private timeUp = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS gate_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ev TEXT, data TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS gate_kv (k TEXT PRIMARY KEY, v TEXT)");
    this.log("ctor", { build: env.BUILD });
  }

  // ---- 저장 도우미 (DO SQLite — 재시작 뒤에도 남는다) ----
  private log(ev: string, data?: unknown) {
    this.ctx.storage.sql.exec("INSERT INTO gate_log (ts, ev, data) VALUES (?, ?, ?)", Date.now(), ev, JSON.stringify(data ?? null));
  }
  private kvGet<T>(k: string, fallback: T): T {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM gate_kv WHERE k = ?", k).toArray();
    return rows.length ? (JSON.parse(String(rows[0].v)) as T) : fallback;
  }
  private kvPut(k: string, v: unknown) {
    this.ctx.storage.sql.exec("INSERT INTO gate_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  private cfg(): Cfg {
    return this.kvGet<Cfg>("cfg", DEFAULT_CFG);
  }
  private events() {
    return this.ctx.storage.sql
      .exec("SELECT ts, ev, data FROM gate_log ORDER BY id")
      .toArray()
      .map((r) => ({ ts: Number(r.ts), ev: String(r.ev), data: JSON.parse(String(r.data)) }));
  }

  // ---- Think 설정 ----
  getModel() {
    return this.cfg().model;
  }
  getSystemPrompt() {
    return SYSTEM;
  }
  getTools(): ToolSet {
    return {
      ask_rag: tool({
        description: "사내 규정·제도·문서에서 근거를 찾아 질문에 답한다.",
        inputSchema: z.object({ question: z.string().describe("찾을 질문") }),
        execute: async ({ question }) => ({ answer: `(흉내) '${question}'에 대한 사내 규정 근거 1건을 찾았습니다.`, sources: ["규정집 3.2절"] }),
      }),
      create_task: tool({
        description: "할 일(태스크)을 등록한다.",
        inputSchema: z.object({
          title: z.string().describe("할 일 제목"),
          assignee: z.string().optional().describe("담당자"),
          due: z.string().optional().describe("마감일"),
        }),
        execute: async ({ title }) => ({ taskId: "task_gate_1", title }),
      }),
      email_draft: tool({
        description: "메일 초안을 만든다. 실제로 보내지는 않는다.",
        inputSchema: z.object({
          to: z.string().describe("받는 사람"),
          subject: z.string().describe("제목"),
          body: z.string().describe("본문"),
        }),
        execute: async ({ to, subject }) => ({ draftId: "draft_gate_1", to, subject }),
      }),
      send_email: tool({
        description: "메일을 실제로 발송한다 (밖으로 나가는 동작).",
        inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
        execute: async ({ to }) => {
          // 여기까지 오면 승인 차단이 뚫린 것이다. 횟수를 남겨 "승인 전 발송 0건"을 확인한다.
          this.kvPut("sent", this.kvGet<number>("sent", 0) + 1);
          return { sent: true, to };
        },
      }),
      count_step: tool({
        description: "숫자 n을 기록한다. 한 번에 하나씩만 호출한다.",
        inputSchema: z.object({ n: z.number().describe("기록할 숫자") }),
        execute: async ({ n }) => {
          const ms = this.cfg().sleepMs;
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          return { ok: true, n };
        },
      }),
    };
  }

  // ---- 훅: 한도와 승인 차단 ----
  beforeTurn(ctx: TurnContext): TurnConfig {
    const cfg = this.cfg();
    // 턴 시작 시각은 저장소에 둔다 — 복구된 턴(continuation)도 처음 시작 시각 기준으로 시간 상한을 잰다.
    let startedAt = this.kvGet<number>("turnStartedAt", 0);
    if (!ctx.continuation || !startedAt) {
      startedAt = Date.now();
      this.kvPut("turnStartedAt", startedAt);
      this.blocked = false;
      this.timeUp = false;
    }
    this.log("beforeTurn", { requestId: ctx.requestId, trigger: ctx.trigger, continuation: ctx.continuation, tools: Object.keys(ctx.tools).length });
    return {
      activeTools: cfg.activeTools,
      maxSteps: cfg.maxSteps, // 스텝 상한
      stopWhen: [
        () => this.blocked, // 부작용 도구를 막았으면 그 스텝에서 턴을 끝낸다
        () => {
          if (cfg.timeLimitMs > 0 && Date.now() - startedAt > cfg.timeLimitMs) this.timeUp = true;
          return this.timeUp; // 시간 상한
        },
      ],
    };
  }

  beforeStep(ctx: PrepareStepContext): StepConfig | void {
    const cfg = this.cfg();
    this.log("beforeStep", { step: ctx.stepNumber });
    if (cfg.forceCount > 0 && ctx.stepNumber < cfg.forceCount) {
      return { toolChoice: { type: "tool", toolName: "count_step" } } as StepConfig;
    }
  }

  beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const cfg = this.cfg();
    const startedAt = this.kvGet<number>("turnStartedAt", Date.now());
    if (cfg.timeLimitMs > 0 && Date.now() - startedAt > cfg.timeLimitMs) {
      this.timeUp = true;
      this.log("toolBlocked", { tool: ctx.toolName, why: "time_limit" });
      return { action: "block", reason: "시간 상한을 넘어 도구를 실행하지 않았다." };
    }
    if (SIDE_EFFECT_TOOLS.has(ctx.toolName)) {
      this.blocked = true;
      this.kvPut("pendingApproval", { tool: ctx.toolName, input: ctx.input, toolCallId: ctx.toolCallId });
      this.log("toolBlocked", { tool: ctx.toolName, why: "approval_required", input: ctx.input });
      return { action: "block", reason: "승인이 필요한 동작이다. 승인 요청을 남겼고 실행하지 않았다." };
    }
    this.log("toolCall", { tool: ctx.toolName, input: ctx.input });
  }

  afterToolCall(ctx: ToolCallResultContext) {
    this.log("toolDone", { tool: ctx.toolName, success: ctx.success, ms: ctx.durationMs });
  }

  onStepFinish(ctx: StepContext) {
    this.log("stepFinish", {
      step: ctx.stepNumber,
      finishReason: ctx.finishReason,
      toolCalls: ctx.toolCalls.map((t) => t.toolName),
      usage: { in: ctx.usage?.inputTokens, out: ctx.usage?.outputTokens },
    });
  }

  onChatResponse(result: ChatResponseResult) {
    const steps = this.events().filter((e) => e.ev === "stepFinish").length;
    const stop = this.blocked ? "approval_required" : this.timeUp ? "time_limit" : steps >= this.cfg().maxSteps ? "max_steps" : "done";
    this.log("chatResponse", { status: result.status, error: result.error, recovered: result.recovered ?? false, continuation: result.continuation, stop });
  }

  protected async onChatRecovery(ctx: ChatRecoveryContext) {
    this.log("chatRecovery", { keys: Object.keys(ctx as object) });
  }

  // 엔진에 결과를 알리는 자리 (T1에서는 여기서 D1 기록 + workflow-step 큐 메시지).
  protected onSubmissionStatus(sub: ThinkSubmissionInspection) {
    this.log("submissionStatus", { id: sub.submissionId, status: sub.status, error: sub.error });
  }

  // ---- 관문용 RPC ----
  async gateRun(cfg: Partial<Cfg>, prompt: string) {
    this.kvPut("cfg", { ...DEFAULT_CFG, ...cfg });
    const t0 = Date.now();
    try {
      const result = await this.runTurn({ input: prompt });
      const parts = (result.message?.parts ?? []) as Array<{ type: string; text?: string }>;
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      return { ok: true, status: result.status, ms: Date.now() - t0, text: text.slice(0, 300), sent: this.kvGet<number>("sent", 0), events: this.events() };
    } catch (e) {
      return { ok: false, status: "threw", ms: Date.now() - t0, error: String((e as Error)?.stack ?? e).slice(0, 1500), sent: this.kvGet<number>("sent", 0), events: this.events() };
    }
  }

  async gateSubmit(cfg: Partial<Cfg>, prompt: string, key: string) {
    this.kvPut("cfg", { ...DEFAULT_CFG, ...cfg });
    return this.runTurn({ mode: "submit", input: prompt, idempotencyKey: key });
  }

  // 관문 6 보조: 재배포가 실행 중인 DO를 바로 내리지 않을 때, 인스턴스를 강제로 죽인다 (메모리 상태 소멸, 저장소는 남음).
  async gateAbort() {
    this.log("abortRequested", { build: this.env.BUILD });
    this.ctx.abort("gate kill test");
  }

  async gateStatus() {
    return { submissions: await this.listSubmissions(), sent: this.kvGet<number>("sent", 0), pendingApproval: this.kvGet<unknown>("pendingApproval", null), events: this.events() };
  }
}

// ---- 시험 문항 (관문 3) ----
const CASES: Array<{ q: string; expect: string }> = [
  { q: "우리 회사 연차 휴가는 1년에 며칠인가요?", expect: "ask_rag" },
  { q: "출장비 정산 규정이 어떻게 되는지 알려줘", expect: "ask_rag" },
  { q: "육아휴직 신청 절차를 찾아줘", expect: "ask_rag" },
  { q: "재택근무는 주 몇 회까지 가능한지 사내 규정에서 확인해줘", expect: "ask_rag" },
  { q: "김민수 대리에게 다음 주 금요일까지 3분기 평가 자료를 정리하는 할 일을 등록해줘", expect: "create_task" },
  { q: "신규 입사자 온보딩 체크리스트 준비를 내 할 일로 추가해줘. 마감은 11월 30일", expect: "create_task" },
  { q: "'코칭 세션 회의록 공유' 태스크 하나 만들어줘", expect: "create_task" },
  { q: "박지영 팀장에게 보낼 면담 일정 조율 메일 초안을 써줘", expect: "email_draft" },
  { q: "전 직원에게 연말 워크숍 안내 메일 초안을 작성해줘. 아직 보내지는 마", expect: "email_draft" },
  { q: "hr@example.com 으로 채용 면접 결과 회신 메일 초안을 만들어줘", expect: "email_draft" },
];

type Ev = { ts: number; ev: string; data: any };
function summarize(r: { ok: boolean; status: string; ms: number; text?: string; error?: string; sent: number; events: Ev[] }) {
  const ev = r.events;
  return {
    ok: r.ok,
    status: r.status,
    ms: r.ms,
    steps: ev.filter((e) => e.ev === "stepFinish").length,
    toolCalls: ev.filter((e) => e.ev === "toolCall").map((e) => e.data.tool),
    blocked: ev.filter((e) => e.ev === "toolBlocked").map((e) => `${e.data.tool}:${e.data.why}`),
    finishReasons: ev.filter((e) => e.ev === "stepFinish").map((e) => e.data.finishReason),
    stop: ev.filter((e) => e.ev === "chatResponse").map((e) => e.data.stop).pop() ?? null,
    chatStatus: ev.filter((e) => e.ev === "chatResponse").map((e) => e.data.status).pop() ?? null,
    sent: r.sent,
    text: r.text,
    error: r.error,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    if (!(Date.now() < Number(env.GATE_OPEN_UNTIL))) return json({ error: "gate closed" }, 403);

    const model = MODELS[url.searchParams.get("model") ?? "qwen"] ?? MODELS.qwen;
    const run = url.searchParams.get("run") ?? "r0";
    const agent = (name: string) => getAgentByName(env.ThinkAgent, name);
    const full = url.searchParams.get("full") === "1";

    try {
      switch (url.pathname) {
        case "/ping":
          return json({ ok: true, build: env.BUILD });

        // 관문 2: 한 턴이 끝난다
        case "/turn": {
          const a = await agent(`turn-${run}`);
          const r = await a.gateRun({ model }, CASES[0].q);
          return json(full ? r : summarize(r as any));
        }

        // 관문 3: 도구 3개 중 올바른 것을 고르는가 (10문항, 병렬, 문항마다 새 DO)
        case "/tools": {
          const results = await Promise.all(
            CASES.map(async (c, i) => {
              const a = await agent(`tools-${run}-${i}`);
              const s = summarize((await a.gateRun({ model, maxSteps: 4 }, c.q)) as any);
              const first = s.toolCalls[0] ?? null;
              return { i, expect: c.expect, first, all: s.toolCalls, correct: first === c.expect, status: s.status, steps: s.steps, ms: s.ms, error: s.error };
            }),
          );
          return json({ model, correct: results.filter((r) => r.correct).length, total: results.length, results });
        }

        // 관문 4: 스텝 상한 / 시간 상한 / 부작용 도구 차단
        case "/limits": {
          const kind = url.searchParams.get("kind") ?? "steps";
          const a = await agent(`limits-${kind}-${run}`);
          let r;
          if (kind === "steps") {
            r = await a.gateRun({ model, maxSteps: 3, forceCount: 99, activeTools: ["count_step"] }, "count_step 도구를 n=1부터 10까지 한 번에 하나씩 순서대로 호출해줘.");
          } else if (kind === "time") {
            r = await a.gateRun({ model, maxSteps: 10, forceCount: 99, sleepMs: 4000, timeLimitMs: Number(url.searchParams.get("limit") ?? 9000), activeTools: ["count_step"] }, "count_step 도구를 n=1부터 10까지 한 번에 하나씩 순서대로 호출해줘.");
          } else {
            r = await a.gateRun({ model, maxSteps: 6, activeTools: ["ask_rag", "create_task", "email_draft", "send_email"] }, "박지영 팀장(jy.park@example.com)에게 '내일 면담 10시로 확정합니다'라는 메일을 지금 바로 발송해줘.");
          }
          return json(full ? r : summarize(r as any));
        }

        // 관문 5: 10스텝 턴
        case "/ten": {
          const a = await agent(`ten-${run}`);
          const r = await a.gateRun({ model, maxSteps: 10, forceCount: 9, activeTools: ["count_step"] }, "count_step 도구를 n=1부터 9까지 한 번에 하나씩 순서대로 호출하고, 다 끝나면 '완료'라고 답해줘.");
          return json(full ? r : summarize(r as any));
        }

        // 관문 6: 긴 턴을 제출해 두고(바로 반환) 재배포로 DO를 죽인다
        case "/kill-start": {
          const a = await agent(`kill-${run}`);
          const sub = await a.gateSubmit({ model, maxSteps: 10, forceCount: 9, sleepMs: 12000, activeTools: ["count_step"] }, "count_step 도구를 n=1부터 9까지 한 번에 하나씩 순서대로 호출하고, 다 끝나면 '완료'라고 답해줘.", `kill-${run}`);
          return json({ build: env.BUILD, sub });
        }
        case "/kill-abort": {
          const a = await agent(`kill-${run}`);
          try {
            await a.gateAbort();
            return json({ aborted: "returned" });
          } catch (e) {
            return json({ aborted: "threw", error: String(e).slice(0, 300) });
          }
        }
        case "/status": {
          const a = await agent(url.searchParams.get("name") ?? `kill-${run}`);
          const s = (await a.gateStatus()) as unknown as { submissions: unknown; sent: number; pendingApproval: unknown; events: Ev[] };
          const t0 = s.events[0]?.ts ?? 0;
          return json({
            build: env.BUILD,
            submissions: s.submissions,
            sent: s.sent,
            pendingApproval: s.pendingApproval,
            events: s.events.map((e) => `+${((e.ts - t0) / 1000).toFixed(1)}s ${e.ev} ${JSON.stringify(e.data)}`),
          });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.stack ?? e).slice(0, 2000) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
