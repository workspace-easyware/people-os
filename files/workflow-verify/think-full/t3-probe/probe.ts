// T3 사전 확인 (2026-11-20): compatibility_date 2025-07-18 + nodejs_compat에서 하위 에이전트(facet)가 되는지.
// ctx.facets / ctx.exports 유무와 subAgent() 왕복 1회만 본다. 시험 뒤 Worker는 지운다.
import { Agent, getAgentByName } from "agents";

export class ProbeChild extends Agent<Record<string, never>> {
  async ping(): Promise<string> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO t (v) VALUES (?)", String(Date.now()));
    const n = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM t").one().n;
    return `child ok, rows=${n}`;
  }
}

export class ProbeParent extends Agent<Record<string, never>> {
  async probe(): Promise<Record<string, unknown>> {
    const c = this.ctx as unknown as { facets?: unknown; exports?: Record<string, unknown> };
    const out: Record<string, unknown> = {
      facets: typeof c.facets,
      exports: typeof c.exports,
      exportKeys: c.exports ? Object.keys(c.exports) : null,
    };
    try {
      const child = await this.subAgent(ProbeChild, "probe-child-1");
      out.child = await (child as unknown as { ping(): Promise<string> }).ping();
    } catch (e) {
      out.childError = String(e).slice(0, 400);
    }
    return out;
  }
}

export default {
  async fetch(req: Request, env: { PARENT: DurableObjectNamespace<ProbeParent>; OPEN_UNTIL?: string }) {
    if (env.OPEN_UNTIL && !(Date.now() < Number(env.OPEN_UNTIL))) return new Response("closed", { status: 403 });
    const stub = await getAgentByName(env.PARENT, "probe-parent");
    return Response.json(await stub.probe());
  },
};
