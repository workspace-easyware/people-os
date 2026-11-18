// DO-1a 채팅방 DO (2026-11-18). 방 1개 = DO 인스턴스 1개 (idFromName(방 키)).
// 1:1 방 키는 `chat:dm:<a>:<b>` (두 id 정렬). DO는 역할(코치/직원)을 보지 않는다 — 방 키의 두 id만 본다.
// WebSocket Hibernation(state.acceptWebSocket)으로 연결을 받고, 송신은 REST(POST /messages)만 받는다.
// 이 DO의 내부 라우트는 Worker(src/chat/routes.ts)만 부른다 — 외부에 직접 노출하지 않는다. 인증·존재 확인은 Worker 몫.
// 요청 헤더: x-chat-user(요청자), x-chat-members(1:1 방의 두 id, 쉼표 구분). DO는 Worker가 보낸 값이라고 믿되,
// members 표가 채워져 있으면 요청자가 멤버인지 한 번 더 본다 (방어선).

export const MAX_MESSAGES = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_BODY_CHARS = 4000;

export interface ChatMessage {
  seq: number;
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: string;
}

// ---- 채팅 presence·읽음·반응 (2026-11-18) ----
// 접속 표시(presence)는 "앱을 열어 둔 사용자"를 뜻한다. 방 목록에서도 녹색 점을 보여야 하므로 방별 DO가 아니라
// 같은 ChatRoom 클래스의 전역 인스턴스 하나(idFromName(LOBBY_KEY))가 맡는다 — 로그인 사용자마다 로비 소켓 1개.
// 접속 상태는 메모리에 따로 두지 않고 매번 Hibernation 소켓(getWebSockets + 태그 = user_id)에서 계산한다.
// → 휴면 후 깨어나도(메모리 Map이 비어도) 살아 있는 소켓 목록이 그대로 남아 presence가 유지된다.
// 클라이언트는 25초마다 "ping"을 보낸다 — setWebSocketAutoResponse가 DO를 깨우지 않고 "pong"으로 답하며 시각을 남긴다.
// 마지막 ping이 STALE_MS보다 오래된 소켓(끊겼는데 close가 안 온 유령)은 접속 중으로 세지 않는다.
// 방 인스턴스는 Worker가 /event로 넘긴 읽음(read)·반응(reaction) 이벤트를 방 소켓 전부에 브로드캐스트한다.
export const LOBBY_KEY = "chat:lobby";
const STALE_MS = 90_000;

type LobbyAttachment = { user_id: string; lobby: true; at: number };

export class ChatRoom {
  state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    this.ensureSchema();
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch { /* 로컬 런타임 미지원 시 무시 */ }
  }

  // ---------- 로비 (presence + 새 메시지 알림) ----------
  private lobbyAtt(ws: WebSocket): LobbyAttachment | null {
    try {
      const a = ws.deserializeAttachment() as LobbyAttachment | null;
      return a && a.lobby && typeof a.user_id === "string" && a.user_id ? a : null;
    } catch { return null; }
  }

  /** 소켓이 살아 있는지: OPEN 상태 + (최근 ping 또는 최근 접속). */
  private alive(ws: WebSocket, now: number): boolean {
    if (ws.readyState !== 1) return false;
    const a = this.lobbyAtt(ws);
    if (!a) return false;
    let last = a.at;
    try {
      const t = this.state.getWebSocketAutoResponseTimestamp(ws);
      if (t && t.getTime() > last) last = t.getTime();
    } catch { /* 미지원 */ }
    return now - last < STALE_MS;
  }

  /** 지금 접속 중인 사용자 id (except 소켓 제외). */
  private onlineUsers(except?: WebSocket): Set<string> {
    const now = Date.now();
    const s = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      if (!this.alive(ws, now)) continue;
      const a = this.lobbyAtt(ws);
      if (a) s.add(a.user_id);
    }
    return s;
  }

  private lobbyBroadcast(payload: string, except?: WebSocket) {
    for (const ws of this.state.getWebSockets()) {
      if (ws === except || ws.readyState !== 1 || !this.lobbyAtt(ws)) continue;
      try { ws.send(payload); } catch { /* 끊긴 연결 무시 */ }
    }
  }

  private snapshot(ws: WebSocket) {
    try { ws.send(JSON.stringify({ type: "presence_snapshot", online: [...this.onlineUsers()] })); } catch { /* 끊김 */ }
  }

  /** 소켓이 닫혔을 때: 그 사용자의 다른 소켓이 없으면 오프라인 브로드캐스트. */
  private lobbyGone(ws: WebSocket) {
    const a = this.lobbyAtt(ws);
    if (!a) return;
    if (!this.onlineUsers(ws).has(a.user_id)) this.lobbyBroadcast(JSON.stringify({ type: "presence", user_id: a.user_id, online: false }), ws);
  }

  private ensureSchema() {
    const sql = this.state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS members (
      user_id TEXT PRIMARY KEY,
      joined_at TEXT NOT NULL
    )`);
  }

  private memberIds(): string[] {
    return this.state.storage.sql.exec("SELECT user_id FROM members ORDER BY user_id").toArray().map((r) => String(r.user_id));
  }

  /** members 표를 통째로 교체 (그룹채팅 DO-1c가 D1 멤버를 동기화할 때 쓴다. DO-1a는 1:1 seed에만 쓴다). */
  private syncMembers(ids: string[]) {
    const sql = this.state.storage.sql;
    const now = new Date().toISOString();
    const clean = [...new Set(ids.filter((x) => typeof x === "string" && x))];
    this.state.storage.transactionSync(() => {
      sql.exec("DELETE FROM members");
      for (const id of clean) sql.exec("INSERT INTO members(user_id, joined_at) VALUES (?, ?)", id, now);
    });
  }

  /** 요청자가 방 멤버인지. members가 비어 있으면(아직 seed 전) 헤더의 1:1 멤버 목록으로 본다. */
  private isMember(req: Request): boolean {
    const user = req.headers.get("x-chat-user") ?? "";
    if (!user) return false;
    const ids = this.memberIds();
    if (ids.length) return ids.includes(user);
    const hdr = (req.headers.get("x-chat-members") ?? "").split(",").filter(Boolean);
    return hdr.includes(user);
  }

  /** 1:1 방은 첫 쓰기 때 헤더의 두 id로 members를 seed한다. */
  private seedFromHeader(req: Request) {
    if (this.memberIds().length) return;
    const hdr = (req.headers.get("x-chat-members") ?? "").split(",").filter(Boolean);
    if (hdr.length) this.syncMembers(hdr);
  }

  private rowToMsg(r: Record<string, unknown>): ChatMessage {
    return { seq: Number(r.seq), sender_id: String(r.sender_id), sender_name: String(r.sender_name), body: String(r.body), created_at: String(r.created_at) };
  }

  private append(senderId: string, senderName: string, body: string): ChatMessage {
    const sql = this.state.storage.sql;
    const createdAt = new Date().toISOString();
    let msg!: ChatMessage;
    this.state.storage.transactionSync(() => {
      const max = sql.exec("SELECT MAX(seq) AS m FROM messages").one().m;
      const seq = (typeof max === "number" ? max : 0) + 1;
      sql.exec("INSERT INTO messages(seq, sender_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)", seq, senderId, senderName, body, createdAt);
      sql.exec("DELETE FROM messages WHERE seq <= ?", seq - MAX_MESSAGES); // 최근 200개만 유지
      msg = { seq, sender_id: senderId, sender_name: senderName, body, created_at: createdAt };
    });
    return msg;
  }

  private broadcast(msg: ChatMessage) {
    const payload = JSON.stringify({ type: "message", ...msg });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch { /* 끊긴 연결은 무시 — 다음 접속 때 REST로 읽는다 */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---- 로비 (LOBBY_KEY 인스턴스만 쓴다. Worker가 세션 인증 뒤 x-chat-user를 붙여 부른다) ----
    if (path === "/lobby/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 426 });
      const user = req.headers.get("x-chat-user") ?? "";
      if (!user) return new Response("forbidden", { status: 403 });
      const wasOnline = this.onlineUsers().has(user);
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server, [user]); // 태그 = user_id → getWebSockets(user)로 그 사용자 소켓만 고른다
      server.serializeAttachment({ user_id: user, lobby: true, at: Date.now() } satisfies LobbyAttachment);
      if (!wasOnline) this.lobbyBroadcast(JSON.stringify({ type: "presence", user_id: user, online: true }), server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/lobby/online" && req.method === "GET") {
      return Response.json({ online: [...this.onlineUsers()] });
    }
    if (path === "/lobby/notify" && req.method === "POST") {
      // 새 메시지 알림: 받는 사람들의 로비 소켓에 {type:'chat_msg', room_id, seq}. 저장하지 않는다 (놓치면 30초 폴링이 맞춘다).
      let b: { user_ids?: unknown; room_id?: unknown; seq?: unknown };
      try { b = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      if (!Array.isArray(b.user_ids) || typeof b.room_id !== "string") return Response.json({ error: "invalid" }, { status: 400 });
      const payload = JSON.stringify({ type: "chat_msg", room_id: b.room_id, seq: typeof b.seq === "number" ? b.seq : 0 });
      let delivered = 0;
      for (const uidv of new Set(b.user_ids.filter((x): x is string => typeof x === "string" && !!x))) {
        for (const ws of this.state.getWebSockets(uidv)) {
          if (ws.readyState !== 1) continue;
          try { ws.send(payload); delivered++; } catch { /* 끊김 */ }
        }
      }
      return Response.json({ ok: true, delivered });
    }

    // ---- 방 이벤트 브로드캐스트 (읽음·반응). Worker가 D1 갱신 뒤에 부른다 ----
    if (path === "/event" && req.method === "POST") {
      let ev: Record<string, unknown>;
      try { ev = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      if (!ev || (ev.type !== "read" && ev.type !== "reaction")) return Response.json({ error: "invalid event" }, { status: 400 });
      const payload = JSON.stringify(ev);
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(payload); } catch { /* 끊김 */ }
      }
      return Response.json({ ok: true });
    }

    if (path === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 426 });
      if (!this.isMember(req)) return new Response("not found", { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      // 소켓에 사용자 id를 붙인다 (Hibernation 표준 방식 — 휴면 후에도 유지). 멤버 제거 시 이 id로 소켓을 닫는다 (DO-1c).
      server.serializeAttachment({ user_id: req.headers.get("x-chat-user") ?? "" });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/messages" && req.method === "POST") {
      if (!this.isMember(req)) return Response.json({ error: "not found" }, { status: 404 });
      let b: { sender_id?: unknown; sender_name?: unknown; body?: unknown };
      try { b = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      if (typeof b.sender_id !== "string" || !b.sender_id || typeof b.sender_name !== "string" || typeof b.body !== "string" || !b.body || b.body.length > MAX_BODY_CHARS) {
        return Response.json({ error: "invalid message" }, { status: 400 });
      }
      this.seedFromHeader(req);
      const msg = this.append(b.sender_id, b.sender_name, b.body);
      this.broadcast(msg);
      return Response.json({ message: msg }, { status: 201 });
    }

    if (path === "/messages" && req.method === "GET") {
      if (!this.isMember(req)) return Response.json({ error: "not found" }, { status: 404 });
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw !== null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
      const limRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limRaw) ? Math.floor(limRaw) : DEFAULT_LIMIT));
      const sql = this.state.storage.sql;
      const rows = (before === null
        ? sql.exec("SELECT * FROM messages ORDER BY seq DESC LIMIT ?", limit)
        : sql.exec("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?", before, limit)
      ).toArray();
      // 응답은 오래된 것 → 최신 순 (화면에 그대로 붙이기 쉽게)
      return Response.json({ messages: rows.map((r) => this.rowToMsg(r)).reverse() });
    }

    if (path === "/members" && req.method === "GET") {
      return Response.json({ members: this.memberIds() });
    }

    if (path === "/sync-members" && req.method === "POST") {
      // DO-1c용 자리. Worker 라우트만 부른다 (DO는 Worker가 보낸 요청이라고 믿는다).
      let b: { members?: { user_id?: unknown }[] };
      try { b = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      if (!Array.isArray(b.members)) return Response.json({ error: "invalid members" }, { status: 400 });
      this.syncMembers(b.members.map((m) => String(m?.user_id ?? "")));
      // 더 이상 멤버가 아닌 사용자의 WebSocket은 닫는다 (사용자를 알 수 없는 소켓도 확인할 수 없으니 닫는다).
      const ids = new Set(this.memberIds());
      let closed = 0;
      for (const ws of this.state.getWebSockets()) {
        let uid = "";
        try { uid = String((ws.deserializeAttachment() as { user_id?: string } | null)?.user_id ?? ""); } catch { /* 첨부 없음 */ }
        if (uid && ids.has(uid)) continue;
        try { ws.close(4403, "removed from room"); closed++; } catch { /* 이미 닫힘 */ }
      }
      return Response.json({ members: this.memberIds(), closed });
    }

    return new Response("not found", { status: 404 });
  }

  // 방 소켓: 클라이언트가 보내는 것은 받지 않는다 (송신은 REST만). 로비 소켓: {type:'hello'}에 접속자 목록으로 답한다.
  // ("ping"은 auto-response가 DO를 깨우지 않고 처리한다. 미지원 런타임이면 여기로 와서 "pong"으로 답한다.)
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (message === "ping") { try { ws.send("pong"); } catch { /* 끊김 */ } return; }
    const a = this.lobbyAtt(ws);
    if (!a) return;
    // 소켓이 말을 했다 = 살아 있다. 접속 시각을 갱신해 유령 판정에서 빠지게 한다.
    try { ws.serializeAttachment({ ...a, at: Date.now() }); } catch { /* 무시 */ }
    let m: { type?: unknown } | null = null;
    try { m = JSON.parse(message); } catch { return; }
    if (m && m.type === "hello") this.snapshot(ws);
  }
  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    this.lobbyGone(ws);
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "closed"); } catch { /* 이미 닫힘 */ }
  }
  webSocketError(ws: WebSocket, _error: unknown): void {
    this.lobbyGone(ws);
  }
}
