// Durable Object: 에이전트 세션 — 대화 기억을 유지한다.
// 로컬에서는 Miniflare가 이 클래스를 에뮬레이션한다. index.ts는 DO 호출이
// 실패하면 D1 sessions 테이블로 폴백한다.
export class AgentSession {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/message") {
      const body = (await request.json().catch(() => ({}))) as {
        role?: string;
        content?: string;
      };
      const history = ((await this.state.storage.get("history")) as Array<{ role: string; content: string }>) || [];
      history.push({ role: body.role || "user", content: body.content || "" });
      await this.state.storage.put("history", history.slice(-20));
      return Response.json({ ok: true, turns: history.length });
    }
    if (request.method === "GET" && url.pathname === "/history") {
      const history = ((await this.state.storage.get("history")) as Array<{ role: string; content: string }>) || [];
      return Response.json({ ok: true, history });
    }
    return Response.json({ ok: false, error: "unknown DO route" }, { status: 404 });
  }
}
