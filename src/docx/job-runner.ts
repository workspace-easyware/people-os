// Word AI 지시 작업 실행기 DO (2026-11-22, 직렬 실행 문제 해결). 인스턴스 1개 = 작업 1개 (idFromName(작업 id)).
//
// 왜 필요한가: Queue 소비자가 작업을 직접 돌리면 작업이 한 번에 하나씩만 돈다 (라이브 실측: 앞 작업 166초가 끝날 때까지 뒤 작업이 queued로 대기).
// 원인은 Queues의 동작이다 — "Queues checks if it should autoscale consumers only after processing an entire batch of messages,
// so it will not autoscale while a batch is being processed" (공식 문서 consumer-concurrency). 배치 1개 = 작업 1개 = 1~5분이라
// 그동안에는 두 번째 소비자가 뜨지 않는다. 배치를 빨리 끝내는 것 말고는 방법이 없다.
// 그래서 소비자는 작업을 여기로 넘기기만 하고(수 ms) 바로 ack한다. 실제 일(processDocxJob — Qwen 호출 1~5분)은 이 DO의 알람에서 돈다.
// 작업마다 DO가 따로라 서로 기다리지 않는다.
//
// 흐름: 소비자 → POST https://runner/start {메시지} → 저장 + 알람(즉시) → alarm()이 processDocxJob 1번 시도
//   - ack: 저장을 비운다 (끝)
//   - retry(일시적인 AI 실패 15초 / 다른 실행이 하고 있음 120초): 그 시간 뒤로 알람을 다시 건다 (예전에는 Queue 지연 재전달)
//   - 예외(상태 갱신 D1 오류): 알람이 실패로 끝나 런타임이 다시 부른다 (지수 백오프, 최대 6회)
// 멱등성·재시도 횟수·15분 상한은 그대로 processDocxJob과 docx_jobs 행이 맡는다 (src/docx/jobs.ts) — 알람이 두 번 불려도 작업은 한 번만 돈다.
// 배포·런타임 재시작으로 알람이 도중에 끊기면 런타임이 알람을 다시 부르고, 그때 작업은 running이라 120초 뒤 다시 보다가 7분이 지나면 다시 차지한다.
// 이 DO가 없거나 start가 실패하면 소비자가 예전처럼 직접 돌린다 (src/index.ts queue()).
import { logEvent } from "../obs/log";
import { processDocxJob } from "./jobs";
import type { DocxJobEnv, DocxJobMessage } from "./jobs";

const KEY = "msg";

export class DocJobRunner {
  state: DurableObjectState;
  env: DocxJobEnv;

  constructor(state: DurableObjectState, env: DocxJobEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/start") return new Response("not found", { status: 404 });
    const msg = await req.json().catch(() => null) as DocxJobMessage | null;
    if (!msg || msg.type !== "docx-job" || typeof msg.jobId !== "string") return new Response("bad message", { status: 400 });
    await this.state.storage.put(KEY, msg);
    // 이미 알람이 걸려 있으면(중복 전달) 그대로 둔다 — 지연 재시도를 앞당기지 않는다.
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now());
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const msg = await this.state.storage.get<DocxJobMessage>(KEY);
    if (!msg) return;
    const r = await processDocxJob(this.env, msg); // 던지면 런타임이 알람을 다시 부른다
    if (r.action === "retry") {
      await this.state.storage.setAlarm(Date.now() + r.delaySeconds * 1000);
      return;
    }
    await this.state.storage.deleteAll();
  }
}

/** Queue 소비자용: 작업을 실행기 DO에 넘긴다. 넘겼으면 true (소비자는 ack), 실행기가 없거나 실패하면 false (소비자가 직접 돌린다). */
export async function handOffDocxJob(env: { DOC_JOB_RUNNER?: DurableObjectNamespace }, msg: DocxJobMessage): Promise<boolean> {
  const ns = env.DOC_JOB_RUNNER;
  if (!ns) return false;
  try {
    const res = await ns.get(ns.idFromName(msg.jobId)).fetch("https://runner/start", { method: "POST", body: JSON.stringify(msg) });
    if (res.ok) return true;
    logEvent("docx.job", { jobId: msg.jobId, event: "handoff_failed", status: res.status });
  } catch (e) {
    logEvent("docx.job", { jobId: msg.jobId, event: "handoff_failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
  }
  return false;
}
