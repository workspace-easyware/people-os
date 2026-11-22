// Think T1 로컬 하네스 (2026-11-20). 운영 코드를 그대로 import한다 — 여기서 고치는 것은 시험용 서브클래스뿐이다.
// - HarnessThinkAgent: 운영 ThinkAgent에 (i) 대본대로 도구를 부르는 모의 모델, (ii) 줄인 한도, (iii) 노드 실행 계수·모의 실행만 덧씌운다.
//   훅·한도 판정·승인 차단·결과 전달 코드는 운영 클래스 것이 그대로 돈다.
// - queue(): 운영 엔진 processWorkflowStep을 그대로 부른다 (run별로 AGENT_RUNTIME을 legacy로 덮어쓸 수 있다).
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getAgentByName } from "agents";
import { z } from "zod";
import type { ThinkModel } from "@cloudflare/think";
import { ThinkAgent, buildNodeTools, nodeInputSchema, thinkAgentName, type ThinkLimits, type ThinkStartInput } from "../../../../src/workflow/think-agent";
import { processWorkflowStep, resumeWorkflowRun, stepMessage } from "../../../../src/workflow/engine";
import { NODE_REGISTRY } from "../../../../src/workflow/nodes";
import { advanceAgentTurn } from "../../../../src/workflow/agent";
import { APPROVAL_REQUIRED_NODES, NODE_TYPES, TOOL_NODE_TYPES, type Env, type NodeContext, type NodeResult, type NodeType, type ToolNodeType, type WorkflowStepMessage } from "../../../../src/workflow/types";
export { WorkflowAgent } from "../../../../src/workflow/agent-do";

type ScriptItem = { tool: string; input: Record<string, unknown> } | { text: string };
interface HCfg {
  script?: ScriptItem[]; // 없으면 실제 모델(Qwen)
  cycle?: boolean;
  mockNodes?: boolean;
  toolSleepMs?: number;
  limits?: Partial<ThinkLimits>;
}

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

export class HarnessThinkAgent extends ThinkAgent {
  private hcfg(): HCfg { return this.kvGet<HCfg>("h_cfg", {}); }
  async hConfigure(cfg: HCfg) { this.kvPut("h_cfg", cfg); return { ok: true }; }

  getModel(): ThinkModel {
    const cfg = this.hcfg();
    if (!cfg.script?.length) return super.getModel();
    const script = cfg.script;
    return new MockLanguageModelV4({
      doStream: async () => {
        const i = this.kvGet<number>("h_calls", 0);
        this.kvPut("h_calls", i + 1);
        const item = cfg.cycle ? script[i % script.length] : script[Math.min(i, script.length - 1)];
        const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
        if ("tool" in item) {
          chunks.push({ type: "tool-call", toolCallId: `call_${i}_${Date.now()}`, toolName: item.tool, input: JSON.stringify({ ...item.input, ...(item.tool === "create_task" ? { title: `${String(item.input.title ?? "할 일")} #${i}` } : {}) }) });
          chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE });
        } else {
          chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: item.text }, { type: "text-end", id: "t" });
          chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE });
        }
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 5 }) } as never;
      },
    }) as unknown as ThinkModel;
  }

  protected limits(): ThinkLimits {
    return { ...super.limits(), ...(this.hcfg().limits ?? {}) };
  }

  protected async execNode(type: NodeType, ctx: NodeContext, args: Record<string, unknown>): Promise<NodeResult> {
    const cfg = this.hcfg();
    const log = this.kvGet<Array<{ tool: string; approved: boolean; at: number }>>("h_exec", []);
    log.push({ tool: type, approved: ctx.approved === true, at: Date.now() });
    this.kvPut("h_exec", log);
    if (cfg.toolSleepMs) await new Promise((r) => setTimeout(r, cfg.toolSleepMs));
    if (!cfg.mockNodes) return super.execNode(type, ctx, args);
    // 모의 노드: 부작용 노드는 실제 노드와 같은 규칙(approved가 아니면 waiting_approval)을 따른다.
    if ((APPROVAL_REQUIRED_NODES as string[]).includes(type) && ctx.approved !== true) return { status: "waiting_approval", output: { mock: true } };
    if ((APPROVAL_REQUIRED_NODES as string[]).includes(type)) this.kvPut("h_sent", this.kvGet<number>("h_sent", 0) + 1); // 실제 "발송" 횟수
    return { status: "succeeded", output: { mock: true, tool: type, args } };
  }

  /** 원격 시험 Worker(D1·큐 없음)에서는 결과 전달을 건너뛴다. 로컬(DB 있음)은 운영 deliver 그대로. */
  async deliver(p: { submissionId: string; attempt: number }): Promise<void> {
    if (!this.env.DB) { this.log("deliverSkipped", { submissionId: p.submissionId, reason: "no DB binding (remote harness)" }); return; }
    return super.deliver(p);
  }

  async hState() {
    return { ...(await this.inspect()), h_calls: this.kvGet("h_calls", 0), h_exec: this.kvGet("h_exec", []), h_sent: this.kvGet("h_sent", 0), h_cfg: this.hcfg() };
  }
  async hAbort() {
    this.log("abortRequested");
    this.ctx.abort("t1 harness kill");
  }
}

// ---------------------------------------------------------------------------

const USER = { id: "u_t1h", email: "t1h@example.com", role: "user", name: "T1 하네스" };

function job(runId: string, over: Partial<ThinkStartInput> = {}): ThinkStartInput {
  return {
    runId, workflowId: "wf_t1h", stepIndex: 0, stepName: "에이전트", user: USER, input: {}, stepOutputs: {},
    goal: "시험 목표", tools: ["create_task"], maxSteps: 10, gatedAll: false, llmBudget: 30, activeSinceMs: Date.now(), ...over,
  };
}

async function waitOutcome(a: { hState(): Promise<Record<string, unknown>> }, timeoutMs: number, wantSid?: string) {
  const t0 = Date.now();
  let s = await a.hState();
  while (Date.now() - t0 < timeoutMs) {
    const o = s.outcome as { submissionId?: string } | null;
    if (o && (!wantSid || o.submissionId === wantSid) && (!wantSid ? o.submissionId === s.currentSubmission : true)) break;
    await new Promise((r) => setTimeout(r, 1000));
    s = await a.hState();
  }
  return { ms: Date.now() - t0, ...s };
}

function brief(s: Record<string, unknown>) {
  const turns = (s.turns as Array<Record<string, unknown>>) ?? [];
  const o = s.outcome as { status?: string; result?: Record<string, unknown> } | null;
  return {
    ms: s.ms, outcome: o?.status ?? null, stoppedReason: o?.result?.stoppedReason ?? null, final: typeof o?.result?.final === "string" ? String(o.result.final).slice(0, 200) : undefined,
    pendingTool: o?.status === "approval" ? o.result?.tool : undefined,
    steps: s.steps, modelCalls: s.modelCalls, llmCalls: s.llmCalls, stop: s.stop,
    turns: turns.map((t) => `${t.turn}:${t.action}${t.tool ? `:${t.tool}` : ""}${t.observation ? ` obs=${String(t.observation).slice(0, 60)}` : ""}`),
    exec: (s.h_exec as Array<{ tool: string; approved: boolean }> | undefined)?.map((e) => `${e.tool}${e.approved ? "(approved)" : ""}`),
    sent: s.h_sent,
    submissions: (s.submissions as Array<{ submissionId: string; status: string; requestId?: string }> | undefined)?.map((x) => `${x.submissionId}=${x.status}`),
    recovery: ((s.events as Array<{ ev: string; data: Record<string, unknown> }>) ?? []).filter((e) => e.ev === "chatRecovery" || (e.ev === "beforeTurn" && e.data.continuation)).map((e) => `${e.ev}:${JSON.stringify(e.data)}`),
  };
}

const ALT: ScriptItem[] = [{ tool: "create_task", input: { title: "교대 A" } }, { tool: "create_calendar_event", input: { title: "교대 B", start: "2026-11-21T09:00:00+09:00" } }];

async function seedRun(env: Env, runId: string, steps: unknown[], mode: "think" | "legacy") {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, role, status, created_at) VALUES (?,?,?,?, 'active', ?)").bind(USER.id, USER.email, USER.name, USER.role, now).run();
  const wfId = `wf_${runId}`;
  await env.DB.prepare("INSERT INTO workflows (id, owner_id, name, status, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(wfId, USER.id, `T1 하네스 ${mode}`, "active", JSON.stringify({ version: 1, steps }), now, now).run();
  await env.DB.prepare("INSERT INTO workflow_runs (id, workflow_id, owner_id, status, input_json, current_step, started_at) VALUES (?,?,?,'queued','{}',0,?)")
    .bind(runId, wfId, USER.id, now).run();
  await env.CACHE.put(`mode:${runId}`, mode);
}

async function runState(env: Env, runId: string) {
  const run = await env.DB.prepare("SELECT status, current_step, error, output_json FROM workflow_runs WHERE id=?").bind(runId).first();
  const { results: steps } = await env.DB.prepare("SELECT step_index, node_type, status, input_json, substr(output_json,1,400) AS out, error FROM workflow_run_steps WHERE run_id=? ORDER BY step_index").bind(runId).all();
  const agentRow = await env.DB.prepare("SELECT runtime, submission_id, status, consumed_submission, steps, llm_calls FROM workflow_agent_steps WHERE run_id=?").bind(runId).first();
  const { results: notes } = await env.DB.prepare("SELECT id, type FROM notifications WHERE ref_id=?").bind(runId).all();
  const { results: tasks } = await env.DB.prepare("SELECT id, title FROM tasks WHERE source=?").bind(`workflow:wf_${runId}`).all();
  return { run, steps, agentRow, notifications: notes, tasks };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const q = (k: string, d = "") => url.searchParams.get(k) ?? d;
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    // 원격 시험 Worker의 시험 창 (T0 게이트와 같은 방식). 로컬은 OPEN_UNTIL이 없어 항상 열린다.
    const openUntil = (env as unknown as { OPEN_UNTIL?: string }).OPEN_UNTIL;
    if (openUntil !== undefined && !(Date.now() < Number(openUntil))) return json({ error: "closed" }, 403);
    const run = q("run", String(Date.now()));
    const agent = async (name: string) => (await getAgentByName(env.ThinkAgent as unknown as DurableObjectNamespace<HarnessThinkAgent>, name)) as unknown as HarnessThinkAgent;
    try {
      switch (url.pathname) {
        // 항목 3: 도구 변환
        case "/tools": {
          const tools = buildNodeTools(async () => null);
          const rows = (Object.keys(NODE_REGISTRY) as ToolNodeType[]).map((n) => {
            const js = z.toJSONSchema(nodeInputSchema(n)) as { properties?: Record<string, unknown>; required?: string[] };
            const keys = Object.keys(js.properties ?? {});
            const t = tools[n] as { description?: string; inputSchema?: unknown; execute?: unknown };
            return {
              node: n, descKept: !!t?.description?.includes(NODE_REGISTRY[n].description), keysKept: JSON.stringify(keys) === JSON.stringify(NODE_REGISTRY[n].inputKeys),
              keys, required: js.required ?? [], hasExecute: typeof t?.execute === "function", agentActive: (TOOL_NODE_TYPES as string[]).includes(n),
            };
          });
          const pass = rows.every((r) => r.descKept && r.keysKept && r.hasExecute);
          return json({ pass, nodeTypes: NODE_TYPES.length, registry: rows.length, converted: Object.keys(tools).length, notConverted: NODE_TYPES.filter((t) => !(t in tools)), agentActivatable: rows.filter((r) => r.agentActive).length, rows });
        }

        // 항목 2: 실제 모델(Qwen) 한 턴 — DO 생성 → startStep(submit) → 완료
        case "/turn": {
          const a = await agent(`h-turn-${run}`);
          await a.hConfigure({});
          const sub = await a.startStep(job(`h-turn-${run}`, { goal: "'T1 하네스 점검'이라는 할 일을 하나 만들고, 만든 결과를 한 줄로 알려줘.", tools: ["create_task"], maxSteps: 4 }));
          const s = await waitOutcome(a, Number(q("timeout", "150000")));
          return json({ sub, ...brief(s), full: q("full") ? s : undefined });
        }

        // 항목 4: 부작용 도구 차단 → 승인 → 한 번만 실행
        case "/block": {
          const tool = q("tool", "send_email");
          const a = await agent(`h-block-${tool}-${run}`);
          const input = tool === "send_email" ? { to: "jy.park@example.com", subject: "면담 확정", body: "내일 10시로 확정합니다." } : { url: "https://example.com/hook", method: "POST", body: { a: 1 } };
          await a.hConfigure({ mockNodes: true, script: [{ tool, input }, { tool, input }, { text: "발송까지 마쳤습니다." }] });
          const sub = await a.startStep(job(`h-block-${tool}-${run}`, { tools: ["create_task", tool as ToolNodeType], maxSteps: 6 }));
          const blocked = await waitOutcome(a, 20000);
          const before = brief(blocked);
          const r1 = await a.resumeApproved({ activeSinceMs: Date.now() });
          const r2 = await a.resumeApproved({ activeSinceMs: Date.now() }); // 같은 승인이 두 번 와도 한 번만
          const after = await waitOutcome(a, 20000, r1.submissionId);
          return json({ sub, beforeApproval: before, resume1: r1, resume2: r2, afterApproval: brief(after) });
        }

        // 항목 5: 한도 (저장소 누적값 기준)
        case "/limits": {
          const kind = q("kind", "steps");
          const a = await agent(`h-lim-${kind}-${run}`);
          const name = `h-lim-${kind}-${run}`;
          if (kind === "steps") {
            await a.hConfigure({ mockNodes: true, cycle: true, script: ALT });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10 }));
          } else if (kind === "llm") {
            // run 앞 단계가 LLM 26회를 썼다고 보고 예산 4만 준다 → 4번째 모델 호출 뒤 멈춤
            await a.hConfigure({ mockNodes: true, cycle: true, script: ALT });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10, llmBudget: 4 }));
          } else if (kind === "agentcap") {
            await a.hConfigure({ mockNodes: true, cycle: true, script: ALT, limits: { agentLlmCap: 3 } });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10 }));
          } else if (kind === "time") {
            await a.hConfigure({ mockNodes: true, cycle: true, script: ALT, toolSleepMs: 2000, limits: { timeoutMs: 5000 } });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10 }));
          } else if (kind === "repeat") {
            await a.hConfigure({ mockNodes: true, cycle: true, script: [{ tool: "create_task", input: { title: "반복" } }] });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10 }));
          } else if (kind === "resume") {
            // 턴을 넘어선 누적: 2스텝째에 승인 차단 → 승인 재개(새 턴, stepNumber 0부터) → 합계 4에서 멈춰야 한다 (턴별로 세면 2+4=6).
            await a.hConfigure({ mockNodes: true, script: [ALT[0], { tool: "send_email", input: { to: "a@example.com", subject: "s", body: "b" } }, ALT[1], ALT[0], ALT[1], ALT[0], ALT[1], { text: "끝" }] });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event", "send_email"], maxSteps: 4 }));
            const first = brief(await waitOutcome(a, 20000));
            const r = await a.resumeApproved({ activeSinceMs: Date.now() });
            const after = await waitOutcome(a, 30000, r.submissionId);
            return json({ kind, first, resume: r, after: brief(after) });
          } else if (kind === "kill") {
            // 실행 중 강제 종료 → 복구 턴. 스텝 상한 10이 누적으로 지켜지는지 (T0 k3는 12스텝).
            await a.hConfigure({ mockNodes: true, cycle: true, script: ALT, toolSleepMs: 2500 });
            await a.startStep(job(name, { tools: ["create_task", "create_calendar_event"], maxSteps: 10 }));
            await new Promise((r) => setTimeout(r, Number(q("killAt", "8000"))));
            let killed = "returned";
            try { await a.hAbort(); } catch (e) { killed = `threw: ${String(e).slice(0, 120)}`; }
            const b = await agent(name);
            const s = await waitOutcome(b, Number(q("timeout", "120000")));
            return json({ kind, killed, ...brief(s) });
          }
          const s = await waitOutcome(a, 60000);
          return json({ kind, ...brief(s) });
        }

        // 항목 6 보조 (원격): legacy 런타임(agent.ts advanceAgentTurn + WorkflowAgent DO)을 실제 모델로 끝까지.
        // D1·큐가 없으므로 엔진 훅(complete/fail/pause/requeue/release)을 메모리로 받아 "큐 메시지 1개 = 1턴"을 이 요청 안에서 돈다.
        case "/legacy-direct": {
          const runId = `wr_t1r_legacy_${run}`;
          const events: string[] = [];
          let done: { kind: string; data?: unknown } | null = null;
          let nextTurn: number | undefined;
          const hooks = {
            async complete(output: unknown) { done = { kind: "complete", data: output }; },
            async fail(error: string) { done = { kind: "fail", data: error }; },
            async pause(p: unknown) { done = { kind: "pause", data: p }; },
            async requeue(n: number) { nextTurn = n; events.push(`requeue ${n}`); },
            async release() { events.push("release"); },
          };
          const step = { id: "a1", type: "agent" as const, name: "에이전트", config: { goal: "llm 도구로 '좋은 아침입니다'를 영어로 번역하게 하고, 번역 결과를 한 줄로 알려줘.", tools: ["llm"], maxSteps: 4 } };
          const ctx: NodeContext = { env, user: USER, runId, workflowId: "wf_t1r", stepIndex: 0, input: {}, stepOutputs: {}, approved: false };
          const t0 = Date.now();
          for (let i = 0; i < 8 && !done; i++) {
            const turn = nextTurn ?? 0;
            nextTurn = undefined;
            events.push(`turn ${turn} @${Date.now() - t0}ms`);
            await advanceAgentTurn(env, { step, msg: { type: "workflow-step", runId, stepIndex: 0, enqueuedAt: new Date().toISOString(), ...(turn ? { agentTurn: turn } : {}) }, approved: false, ctx, activeSinceMs: t0 }, hooks);
            if (nextTurn === undefined && !done) break;
          }
          const d = done as { kind: string; data?: { final?: string; turns?: Array<Record<string, unknown>>; stoppedReason?: string } } | null;
          return json({
            runId, ms: Date.now() - t0, result: d?.kind ?? "none", stoppedReason: d?.data?.stoppedReason ?? null,
            final: typeof d?.data === "object" ? String(d?.data?.final ?? "").slice(0, 300) : d?.data,
            turns: (d?.data?.turns ?? []).map((t) => `${t.turn}:${t.action}${t.tool ? `:${t.tool}` : ""}${t.observation ? ` obs=${String(t.observation).slice(0, 80)}` : ""}`),
            events,
          });
        }

        // 항목 2 (원격): 실제 모델로 Think 한 턴. 도구는 D1이 필요 없는 llm.
        case "/turn-remote": {
          const a = await agent(`r-turn-${run}`);
          await a.hConfigure({});
          const sub = await a.startStep(job(`r-turn-${run}`, { goal: "llm 도구로 '좋은 아침입니다'를 영어로 번역하게 하고, 번역 결과를 한 줄로 알려줘.", tools: ["llm", "create_task"], maxSteps: 4 }));
          const s = await waitOutcome(a, Number(q("timeout", "150000")));
          return json({ sub, ...brief(s), events: q("full") ? (s as Record<string, unknown>).events : undefined });
        }

        case "/state": {
          const a = await agent(q("name"));
          return json(brief({ ms: 0, ...(await a.hState()) }));
        }

        // 항목 6: 엔진 연결 — agent 노드 워크플로를 큐 엔진으로 끝까지
        case "/engine": {
          const mode = q("mode", "think") as "think" | "legacy" | "think-approval";
          const runId = `wr_t1h_${mode}_${run}`;
          const goal = mode === "legacy" || q("real") ? "'T1 엔진 점검'이라는 할 일을 하나 만들고 결과를 한 줄로 알려줘." : "시험 목표";
          const tools = mode === "think-approval" ? ["create_task", "send_email"] : ["create_task"];
          await seedRun(env, runId, [
            { id: "a1", type: "agent", name: "에이전트", config: { goal, tools, maxSteps: 4 } },
            { id: "t2", type: "create_task", name: "후속 할 일", config: { title: "후속: {{steps.a1.output.final}}" } },
          ], mode === "legacy" ? "legacy" : "think");
          if (mode !== "legacy") {
            const a = await agent(thinkAgentName(runId, 0));
            const script: ScriptItem[] = mode === "think-approval"
              ? [{ tool: "create_task", input: { title: "엔진 승인 시험" } }, { tool: "send_email", input: { to: "jy.park@example.com", subject: "확정", body: "확정합니다." } }, { text: "할 일을 만들고 메일을 보냈습니다." }]
              : [{ tool: "create_task", input: { title: "엔진 시험" } }, { text: "할 일을 만들었습니다." }];
            await a.hConfigure(q("real") ? {} : { mockNodes: mode === "think-approval", script });
          }
          await env.PIPELINE.send(stepMessage(runId, 0));
          return json({ runId, mode });
        }
        case "/run": {
          const runId = q("id");
          const st = await runState(env, runId);
          let think: unknown;
          if (st.agentRow) think = brief({ ms: 0, ...(await (await agent(thinkAgentName(runId, 0))).hState()) });
          return json({ ...st, think });
        }
        case "/approve": {
          return json(await resumeWorkflowRun(env, q("id")));
        }
        case "/dup-first": {
          // 첫 메시지 중복 전달: 같은 키 → accepted:false
          await env.PIPELINE.send(stepMessage(q("id"), 0));
          return json({ ok: true });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.stack ?? e).slice(0, 3000) }, 500);
    }
  },

  async queue(batch: MessageBatch<WorkflowStepMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        if (body?.type === "workflow-step") {
          const mode = await env.CACHE.get(`mode:${body.runId}`);
          const e2 = mode === "legacy" ? ({ ...env, AGENT_RUNTIME: "legacy" } as Env) : env;
          console.log(`[t1h] step ${body.runId}#${body.stepIndex} turn=${body.agentTurn ?? "-"} approved=${body.approved ?? false} think=${body.thinkSubmissionId ?? "-"}`);
          await processWorkflowStep(e2, body);
        }
        msg.ack();
      } catch (e) {
        console.log(`[t1h] message failed: ${String(e).slice(0, 300)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkflowStepMessage>;
