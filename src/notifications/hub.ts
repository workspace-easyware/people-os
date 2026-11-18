// DO-2 알림 허브 DO (2026-11-18). 사용자 1명 = DO 인스턴스 1개 (idFromName('user:<userId>')).
// 알림을 저장하지 않는다 — 저장은 D1 notifications 테이블이 한다. 연결이 없으면 푸시는 그냥 버려지고, 다음 폴링이 보여준다.
// WebSocket Hibernation(state.acceptWebSocket)으로 연결을 받는다. 서버→클라이언트 메시지는 1종:
//   {type:'notify', notification:{id,type,title,body,link,created_at}}
// 이 DO의 내부 라우트(/ws, /push)는 Worker만 부른다 — 인증은 Worker(src/notifications/routes.ts)가 세션 쿠키로 끝낸 뒤다.
// DO 인스턴스가 사용자별이라 다른 사용자의 연결로는 알림이 갈 수 없다 (격리는 DO 주소가 보장한다).

export interface HubNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
}

function clean(raw: unknown): HubNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.type !== "string" || typeof r.title !== "string" || typeof r.created_at !== "string") return null;
  return {
    id: r.id,
    type: r.type,
    title: r.title.slice(0, 300),
    body: typeof r.body === "string" ? r.body.slice(0, 2000) : null,
    link: typeof r.link === "string" ? r.link : null,
    created_at: r.created_at,
  };
}

export class NotificationHub {
  state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    if (path === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 426 });
      const user = req.headers.get("x-ntf-user") ?? "";
      if (!user) return new Response("forbidden", { status: 403 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ user_id: user });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/push" && req.method === "POST") {
      let raw: unknown;
      try { raw = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      const n = clean(raw);
      if (!n) return Response.json({ error: "invalid notification" }, { status: 400 });
      const payload = JSON.stringify({ type: "notify", notification: n });
      let delivered = 0;
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(payload); delivered++; } catch { /* 끊긴 연결은 무시 — 폴링이 보여준다 */ }
      }
      return Response.json({ ok: true, delivered });
    }

    return new Response("not found", { status: 404 });
  }

  // 클라이언트→서버 메시지는 받지 않는다.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}
  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "closed"); } catch { /* 이미 닫힘 */ }
  }
  webSocketError(_ws: WebSocket, _error: unknown): void {}
}
