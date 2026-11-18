// 워크플로우 공용 타입 (WF-1, 2026-11-18). WF-2(노드)·WF-3(엔진)이 import한다.

/** index.ts의 Env와 구조적으로 호환되는 바인딩 집합 (index.ts의 Env는 export되지 않아 여기서 미러링). */
export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  VECTOR: VectorizeIndex;
  AI: Ai;
  AGENT_SESSION: DurableObjectNamespace;
  /** WF-6 에이전트 루프 DO (WorkflowAgent). id = idFromName(`agent:<runId>:<stepIndex>`). */
  WORKFLOW_AGENT: DurableObjectNamespace;
  /** DO-2 알림 허브 (선택 — 없으면 푸시는 건너뛰고 폴링이 폴백). */
  NOTIFICATION_HUB?: DurableObjectNamespace;
  ASSETS: Fetcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PIPELINE: Queue<any>;
  ADMIN_SECRET?: string;
  PASSWORD_PEPPER?: string;
  BOOTSTRAP_SECRET?: string;
  RESEND_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  AIG_LOGS_TOKEN?: string;
};

export const NODE_TYPES = ['ask_rag','ask_personal','transcribe','summarize','reflect_coach','reflect_coachee','draft_pptx','email_draft','send_email','create_task','llm','create_calendar_event','agent','condition','webhook'] as const;
export type NodeType = typeof NODE_TYPES[number];
/** 레지스트리에서 실행되는 도구 노드. agent 자신은 도구가 아니다 — 엔진이 루프를 몬다 (WF-6). */
export type ToolNodeType = Exclude<NodeType, 'agent'>;
/** condition(WF-7)은 레지스트리에서 실행되는 노드지만 흐름 제어용이라 에이전트의 도구 목록에서는 뺀다 (에이전트는 스스로 판단한다). */
export const TOOL_NODE_TYPES: ToolNodeType[] = NODE_TYPES.filter((t): t is ToolNodeType => t !== 'agent' && t !== 'condition');
/** agent 노드가 config.tools를 생략했을 때 쓸 수 있는 도구: 외부로 나가는 send_email·webhook(WF-9)을 뺀 나머지. 둘은 tools에 명시해야만 쓸 수 있다. */
export const AGENT_DEFAULT_TOOLS: ToolNodeType[] = TOOL_NODE_TYPES.filter((t) => t !== 'send_email' && t !== 'webhook');
export const AGENT_MAX_STEPS = 10;
export const AGENT_GOAL_MAX = 2000;
/** agent 노드 config (WF-6). */
export interface AgentConfig { goal: string; tools?: ToolNodeType[]; maxSteps?: number; }
/** 승인 없이 실행하면 안 되는 노드 */
/** webhook(WF-9)도 외부 행동이라 승인 필수 — 엔진 게이트·에이전트 게이트가 이 목록을 그대로 쓴다. */
export const APPROVAL_REQUIRED_NODES: NodeType[] = ['send_email', 'webhook'];

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused'] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * 정의 v2 (WF-7): 단계에 `next` 간선을 둘 수 있다. 정의의 `version`은 1로 유지한다 — v1 정의(next 없음)는 "next가 없는 v2"로 읽는다
 * (읽기 시 변환, 저장된 JSON·D1 스키마는 그대로).
 * - 일반·agent 단계: `next?: string | null` — 다음 단계 id. 생략하면 배열의 다음 단계. `null`이면 "여기서 종료" (WF-10).
 * - condition 단계: `next?: { true: string | null; false: string | null }` — 출력의 branch로 고른다. 생략하면 배열의 다음 단계(분기 없음).
 *   두 키는 항상 다 있어야 하고, 값이 `null`인 쪽 분기는 거기서 run이 끝난다 (WF-10 종료 표식).
 * 정의는 DAG여야 한다 (사이클 금지) — 각 단계는 run당 최대 1번 실행된다 → WF-3의 (runId, stepIndex) claim이 그대로 맞다.
 * 루프는 만들지 않는다: 반복이 필요하면 스케줄(WF-8)을 쓴다.
 */
export type StepNext = string | null | { true: string | null; false: string | null };
export interface WorkflowStepDef { id: string; type: NodeType; name: string; config: Record<string, unknown>; requiresApproval?: boolean; next?: StepNext; }
export interface WorkflowDefinition { version: 1; steps: WorkflowStepDef[]; }
export interface NodeContext { env: Env; user: { id: string; email: string; role: string; coaching_role?: string }; runId: string; workflowId: string; stepIndex: number; input: Record<string, unknown>; stepOutputs: Record<string, unknown>; /** 승인 게이트(WF-4)를 통과한 실행이면 true. send_email은 이 값이 true일 때만 실행된다 (WF-2 추가). */ approved?: boolean; }
export interface NodeResult { status: 'succeeded' | 'failed' | 'waiting_approval'; output?: unknown; error?: string; }
/** 큐 메시지 1개 = 워크플로우 단계 1개 (WF-3). index.ts QueueMessage 유니온에 들어간다. */
export type WorkflowStepMessage = {
  type: "workflow-step"; runId: string; stepIndex: number; approved?: boolean; enqueuedAt: string;
  /** agent 단계 전용 (WF-6): 이 메시지가 진행할 턴 번호(0부터). DO가 이 번호로 중복 전달을 가드한다. 다른 단계 메시지에는 없다. */
  agentTurn?: number;
};
/** turn은 agent 단계 전용 (WF-6): 한 agent 단계 안에서 승인이 여러 번 필요할 수 있어 알림 id를 턴별로 나눈다. */
export interface ApprovalRequest { runId: string; workflowId: string; stepIndex: number; nodeType: NodeType; nodeName: string; summary: string; turn?: number; }

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * 문자열 안의 {{경로}}를 치환한다. vars 예: { input: {...}, steps: { s1: { output: {...} } } }.
 * - {{input.docId}} → vars.input.docId, {{steps.s1.output.summary}} → vars.steps.s1.output.summary (중첩 경로 지원)
 * - 없는 경로는 빈 문자열, 에러 없음. 객체·배열은 재귀 치환. 표현식({{a + b}})은 지원하지 않는다 — 치환만.
 * - 값이 객체/배열이면 JSON 문자열로, null/undefined는 빈 문자열로 넣는다.
 */
export function resolveVars(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([A-Za-z0-9_$][\w$-]*(?:\.[\w$-]+)*)\s*\}\}/g, (_m, path: string) => {
      const v = lookup(vars, path);
      if (v === undefined || v === null) return "";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => resolveVars(t, vars));
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) out[k] = resolveVars(v, vars);
    return out;
  }
  return template;
}

/**
 * 정의 검증. version===1, steps 1~50개, step마다 id(문자열·중복 금지)·type(NODE_TYPES)·name(빈 문자열 금지)·config(객체).
 * 결정: APPROVAL_REQUIRED_NODES(send_email)는 requiresApproval이 없으면 true로 "강제"한다 (에러 아님).
 * 명시적으로 false를 넣은 경우는 우회 시도이므로 에러로 거부한다.
 */
export function validateDefinition(def: unknown): { ok: true; def: WorkflowDefinition } | { ok: false; error: string } {
  if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, error: "워크플로우 정의는 객체여야 합니다." };
  const d = def as Record<string, unknown>;
  if (d.version !== 1) return { ok: false, error: "정의의 version은 1이어야 합니다." };
  if (!Array.isArray(d.steps) || d.steps.length < 1 || d.steps.length > 50) {
    return { ok: false, error: "단계(steps)는 1~50개의 배열이어야 합니다." };
  }
  const seen = new Set<string>();
  const steps: WorkflowStepDef[] = [];
  for (let i = 0; i < d.steps.length; i++) {
    const s = d.steps[i] as Record<string, unknown> | null;
    const at = `steps[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, error: `${at}는 객체여야 합니다.` };
    if (typeof s.id !== "string" || !s.id.trim()) return { ok: false, error: `${at}.id는 비어 있지 않은 문자열이어야 합니다.` };
    if (seen.has(s.id)) return { ok: false, error: `${at}.id가 중복되었습니다: ${s.id}` };
    seen.add(s.id);
    if (typeof s.type !== "string" || !(NODE_TYPES as readonly string[]).includes(s.type)) {
      return { ok: false, error: `${at}.type이 올바르지 않습니다: ${String(s.type)}` };
    }
    if (typeof s.name !== "string" || !s.name.trim()) return { ok: false, error: `${at}.name은 비어 있지 않은 문자열이어야 합니다.` };
    if (!s.config || typeof s.config !== "object" || Array.isArray(s.config)) return { ok: false, error: `${at}.config는 객체여야 합니다.` };
    if (s.requiresApproval !== undefined && typeof s.requiresApproval !== "boolean") {
      return { ok: false, error: `${at}.requiresApproval은 boolean이어야 합니다.` };
    }
    const type = s.type as NodeType;
    let requiresApproval = s.requiresApproval as boolean | undefined;
    if (APPROVAL_REQUIRED_NODES.includes(type)) {
      if (requiresApproval === false) return { ok: false, error: `${at}: ${type} 노드는 승인을 끌 수 없습니다.` };
      requiresApproval = true;
    }
    if (type === 'webhook') {
      const err = validateWebhookConfig(s.config as Record<string, unknown>);
      if (err) return { ok: false, error: `${at}.config: ${err}` };
    }
    if (type === 'agent') {
      // 에이전트 자체는 승인 게이트를 우회하지 않는다: false로 끄는 것은 send_email과 같은 원칙으로 거부한다.
      // (true면 에이전트가 고르는 "모든" 도구 실행이 승인을 받는다. 생략하면 APPROVAL_REQUIRED_NODES만 승인을 받는다.)
      if (requiresApproval === false) return { ok: false, error: `${at}: agent 노드는 승인을 끌 수 없습니다.` };
      const err = validateAgentConfig(s.config as Record<string, unknown>);
      if (err) return { ok: false, error: `${at}.config: ${err}` };
    }
    const step: WorkflowStepDef = { id: s.id, type, name: s.name, config: s.config as Record<string, unknown> };
    if (requiresApproval !== undefined) step.requiresApproval = requiresApproval;
    if (s.next !== undefined) {
      if (type === 'condition') {
        const n = s.next as Record<string, unknown> | null;
        // 두 키 모두 있어야 한다. 값은 단계 id(비어 있지 않은 문자열) 또는 null(그 분기는 종료, WF-10).
        const okBranch = (v: unknown) => v === null || (typeof v === 'string' && !!v);
        if (!n || typeof n !== 'object' || Array.isArray(n) || !('true' in n) || !('false' in n) || !okBranch(n.true) || !okBranch(n.false)) {
          return { ok: false, error: `${at}.next: condition 단계의 next는 { "true", "false" } 키가 둘 다 필요합니다 (값은 단계id, 또는 그 분기를 끝내려면 null).` };
        }
        step.next = { true: n.true as string | null, false: n.false as string | null };
      } else {
        // null = 여기서 종료 (WF-10). 그 밖에는 다음 단계 id.
        if (s.next !== null && (typeof s.next !== 'string' || !s.next)) return { ok: false, error: `${at}.next는 다음 단계 id(문자열) 또는 null(종료)이어야 합니다.` };
        step.next = s.next as string | null;
      }
    }
    steps.push(step);
  }
  // 간선 검증 (WF-7): 없는 단계 → 순환 참조 순서로 본다.
  for (let i = 0; i < steps.length; i++) {
    for (const target of explicitTargets(steps[i])) {
      if (!seen.has(target)) return { ok: false, error: `steps[${i}].next가 없는 단계를 가리킵니다: ${target}` };
    }
  }
  const cyc = findCycle(steps);
  if (cyc) return { ok: false, error: `순환 참조: ${cyc}` };
  return { ok: true, def: { version: 1, steps } };
}

/** 단계의 명시 간선 대상 id들 (next가 없거나 null인 쪽은 빠진다 — null은 종료, WF-10). */
function explicitTargets(step: WorkflowStepDef): string[] {
  const n = step.next;
  if (n === undefined || n === null) return [];
  if (typeof n === 'string') return [n];
  return [n.true, n.false].filter((x): x is string => typeof x === 'string');
}

/** 단계의 후속 인덱스들. next가 없으면 배열의 다음 단계(암묵 간선)이고 마지막 단계는 후속이 없다. next가 null(또는 분기 값 null)이면 그쪽은 후속 없음(종료). */
function successors(steps: WorkflowStepDef[], i: number): number[] {
  if (steps[i].next === undefined) return i + 1 < steps.length ? [i + 1] : [];
  return explicitTargets(steps[i]).map((id) => steps.findIndex((s) => s.id === id)).filter((x) => x >= 0);
}

/** 사이클 탐색(DFS 색칠). 암묵 간선(배열 순서)도 간선으로 센다. 있으면 "a → b → a" 경로 문자열, 없으면 null. */
function findCycle(steps: WorkflowStepDef[]): string | null {
  const color: number[] = new Array(steps.length).fill(0); // 0 미방문, 1 방문 중, 2 완료
  const stack: number[] = [];
  const visit = (i: number): string | null => {
    color[i] = 1; stack.push(i);
    for (const j of successors(steps, i)) {
      if (color[j] === 1) return [...stack.slice(stack.indexOf(j)), j].map((k) => steps[k].id).join(' → ');
      if (color[j] === 0) { const r = visit(j); if (r) return r; }
    }
    stack.pop(); color[i] = 2;
    return null;
  };
  for (let i = 0; i < steps.length; i++) if (color[i] === 0) { const r = visit(i); if (r) return r; }
  return null;
}

export type NextStep = { kind: 'next'; index: number } | { kind: 'end' } | { kind: 'error'; error: string };

/**
 * 성공한 단계 다음에 갈 단계를 정한다 (엔진용, WF-7).
 * - next가 문자열: 그 id의 인덱스 (없으면 error "없는 단계").
 * - condition + next {true,false}: 출력의 branch로 고른다 (branch가 없거나 true/false가 아니면 error).
 * - next가 없으면 stepIndex + 1, 배열 끝이면 end.
 * - next가 null이거나 condition에서 고른 branch 값이 null이면 end (WF-10 종료 표식 — 배열 끝에 도달한 것과 같다).
 */
export function resolveNextStep(def: WorkflowDefinition, stepIndex: number, output: unknown): NextStep {
  const step = def.steps[stepIndex];
  const n = step?.next;
  if (n === undefined) return stepIndex + 1 < def.steps.length ? { kind: 'next', index: stepIndex + 1 } : { kind: 'end' };
  if (n === null) return { kind: 'end' };
  let id: string;
  if (typeof n === 'string') id = n;
  else {
    const branch = output && typeof output === 'object' ? (output as Record<string, unknown>).branch : undefined;
    if (branch !== 'true' && branch !== 'false') return { kind: 'error', error: `조건 결과(branch)가 없습니다: ${step.id}` };
    const picked = n[branch];
    if (picked === null) return { kind: 'end' };
    id = picked;
  }
  const index = def.steps.findIndex((s) => s.id === id);
  return index >= 0 ? { kind: 'next', index } : { kind: 'error', error: `없는 단계: ${id}` };
}

export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * webhook 노드 config 검증 (WF-9). 저장 시점 검사만 한다 — SSRF 검사는 URL에 {{변수}}가 들어갈 수 있어 실행 시점(nodes.ts)에 한다.
 * 문제가 없으면 null.
 */
export function validateWebhookConfig(cfg: Record<string, unknown>): string | null {
  if (typeof cfg.url !== 'string' || !cfg.url.trim()) return 'url은 비어 있지 않은 문자열이어야 합니다.';
  if (cfg.method !== undefined && (typeof cfg.method !== 'string' || !(WEBHOOK_METHODS as readonly string[]).includes(cfg.method))) {
    return `method는 ${WEBHOOK_METHODS.join(' | ')} 중 하나여야 합니다.`;
  }
  if (cfg.headers !== undefined) {
    const h = cfg.headers;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return 'headers는 객체여야 합니다.';
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v !== 'string') return `headers 값은 문자열이어야 합니다: ${k}`;
    }
  }
  if (cfg.body !== undefined) {
    try { JSON.stringify(cfg.body); } catch { return 'body는 JSON으로 직렬화할 수 있어야 합니다.'; }
  }
  return null;
}

/** agent 노드 config 검증 (WF-6). 문제가 없으면 null. */
export function validateAgentConfig(cfg: Record<string, unknown>): string | null {
  if (typeof cfg.goal !== 'string' || !cfg.goal.trim()) return 'goal은 비어 있지 않은 문자열이어야 합니다.';
  if (cfg.goal.length > AGENT_GOAL_MAX) return `goal은 ${AGENT_GOAL_MAX}자 이하여야 합니다.`;
  if (cfg.tools !== undefined) {
    if (!Array.isArray(cfg.tools) || cfg.tools.length < 1) return 'tools는 1개 이상의 노드 타입 배열이어야 합니다.';
    for (const t of cfg.tools) {
      if (typeof t !== 'string' || !(TOOL_NODE_TYPES as readonly string[]).includes(t)) return `tools에 쓸 수 없는 도구가 있습니다: ${String(t)}`;
    }
    if (new Set(cfg.tools).size !== cfg.tools.length) return 'tools에 중복된 도구가 있습니다.';
  }
  if (cfg.maxSteps !== undefined) {
    if (typeof cfg.maxSteps !== 'number' || !Number.isInteger(cfg.maxSteps) || cfg.maxSteps < 1 || cfg.maxSteps > AGENT_MAX_STEPS) {
      return `maxSteps는 1~${AGENT_MAX_STEPS} 정수여야 합니다.`;
    }
  }
  return null;
}

/** config에서 실제로 쓸 목표·도구·최대 턴 (기본값 적용, 잘못된 값은 걸러낸다 — 저장 전 검증은 validateAgentConfig). */
export function agentSettings(cfg: Record<string, unknown>): { goal: string; tools: ToolNodeType[]; maxSteps: number } {
  const picked = Array.isArray(cfg.tools)
    ? (cfg.tools as unknown[]).filter((t): t is ToolNodeType => typeof t === 'string' && (TOOL_NODE_TYPES as readonly string[]).includes(t))
    : [];
  const m = typeof cfg.maxSteps === 'number' && Number.isInteger(cfg.maxSteps) ? cfg.maxSteps : AGENT_MAX_STEPS;
  return {
    goal: String(cfg.goal ?? '').slice(0, AGENT_GOAL_MAX),
    tools: picked.length ? [...new Set(picked)] : AGENT_DEFAULT_TOOLS,
    maxSteps: Math.min(Math.max(m, 1), AGENT_MAX_STEPS),
  };
}
