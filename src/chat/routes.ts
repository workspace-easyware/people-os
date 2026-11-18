// 채팅 API (DO-1a, 2026-11-18). index.ts에서 "/api/chat"에 mount한다 (경로는 mount 기준 상대).
// 1:1 방 + 방 목록(DO-1b) + 그룹채팅(DO-1c, 아래 "그룹채팅" 절). 전부 세션 쿠키 필수 (익명 401).
//   POST /dm/:userId/messages  {body 1~4000자} → 201 {message}. 없는 사용자 404, 자기 자신 400, 본문 오류 400
//   GET  /dm/:userId/messages?before=&limit=  → {messages} (방이 없어도 빈 목록)
//   GET  /dm/:userId/ws        WebSocket 업그레이드 (Worker가 DO에 직접 전달, Origin 검사 포함)
//   GET  /rooms                내 방 목록 (D1 chat_rooms, 최신순). DM은 peer, 그룹은 name (DO-1b)
// 방 = (나, 상대) 두 id의 정렬 키라서, 제3자는 두 사람의 방 주소를 만들 수 없다 — 자기 id가 들어간 방만 열린다.
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, type SessionUser } from "../auth";
import { MAX_BODY_CHARS, LOBBY_KEY } from "./room";
import { uid } from "../lib";

type Env = { DB: D1Database; CHAT_ROOM: DurableObjectNamespace };
export const chatApp = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

// ---- presence·읽음·반응 (2026-11-18) ----
//   GET  /lobby/ws                                   로그인 사용자 1명당 소켓 1개. presence + 새 메시지 알림(chat_msg)
//   GET  /presence                                   지금 접속 중인 사용자 id 목록 {online:[...]}
//   POST /rooms/:roomId/messages/:seq/reactions      {emoji} 토글 (있으면 제거, 없으면 추가) → {reactions, added}
//   GET  /dm|groups/.../messages 응답에 reads[{user_id,last_read_seq}] + 메시지별 reactions[{emoji,count,user_ids}]
//   POST /rooms/:roomId/read 뒤에 방 소켓으로 {type:'read', user_id, last_read_seq} 브로드캐스트
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** 응답을 막지 않는 뒷일 (waitUntil이 없으면 그냥 기다린다). */
async function background(c: C, p: Promise<unknown>): Promise<void> {
  const safe = p.catch((e) => console.error("chat background failed", e));
  try { c.executionCtx.waitUntil(safe); } catch { await safe; }
}

/** 새 메시지를 받는 사람들의 로비 소켓에 알린다 (패널이 닫혀 있어도 배지를 바로 갱신). */
function notifyLobby(env: Env, userIds: string[], roomId: string, seq: number): Promise<unknown> {
  if (!userIds.length) return Promise.resolve();
  return roomStub(env, LOBBY_KEY).fetch(new Request("https://chat-room/lobby/notify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: userIds, room_id: roomId, seq }),
  }));
}

/** 방 DO의 소켓 전부에 이벤트(read·reaction) 브로드캐스트. */
function roomEvent(env: Env, doKey: string, ev: Record<string, unknown>): Promise<unknown> {
  return roomStub(env, doKey).fetch(new Request("https://chat-room/event", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev),
  }));
}

type ReactionAgg = { emoji: string; count: number; user_ids: string[] };
function aggregate(rows: { message_seq: number; emoji: string; user_id: string }[]): Map<number, ReactionAgg[]> {
  const out = new Map<number, ReactionAgg[]>();
  for (const r of rows) {
    const seq = Number(r.message_seq);
    const list = out.get(seq) ?? [];
    let a = list.find((x) => x.emoji === r.emoji);
    if (!a) { a = { emoji: r.emoji, count: 0, user_ids: [] }; list.push(a); }
    a.count++; a.user_ids.push(r.user_id);
    out.set(seq, list);
  }
  for (const list of out.values()) list.sort((x, y) => REACTION_EMOJIS.indexOf(x.emoji) - REACTION_EMOJIS.indexOf(y.emoji));
  return out;
}

/** DO 메시지 응답에 읽음 위치(reads)와 메시지별 반응을 붙인다. D1 실패(예: 0031 미적용)는 붙이지 않고 그대로 돌려준다. */
async function withReadsAndReactions(db: D1Database, roomId: string, res: Response): Promise<Response> {
  const text = await res.text();
  const plain = () => new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  if (!res.ok) return plain();
  let j: { messages?: { seq: number; reactions?: ReactionAgg[] }[]; reads?: unknown };
  try { j = JSON.parse(text); } catch { return plain(); }
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  try {
    const rs = await db.prepare("SELECT user_id, last_read_seq FROM chat_room_members WHERE room_id = ?").bind(roomId).all<{ user_id: string; last_read_seq: number }>();
    j.reads = (rs.results || []).map((r) => ({ user_id: r.user_id, last_read_seq: Number(r.last_read_seq) || 0 }));
  } catch (e) { console.error("chat reads failed", e); }
  if (msgs.length) {
    try {
      const lo = Math.min(...msgs.map((m) => m.seq)), hi = Math.max(...msgs.map((m) => m.seq));
      const rr = await db.prepare("SELECT message_seq, emoji, user_id FROM chat_reactions WHERE room_id = ? AND message_seq BETWEEN ? AND ? ORDER BY created_at, user_id")
        .bind(roomId, lo, hi).all<{ message_seq: number; emoji: string; user_id: string }>();
      const agg = aggregate(rr.results || []);
      for (const m of msgs) m.reactions = agg.get(m.seq) ?? [];
    } catch (e) { console.error("chat reactions failed", e); }
  }
  return Response.json(j, { status: res.status });
}

export function dmRoomKey(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `chat:dm:${x}:${y}`;
}

class ChatError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 426, message: string) { super(message); }
}

/** Origin 헤더가 있으면 같은 출처여야 한다 (없으면 통과 — auth-routes의 originOk와 같은 규칙). POST와 WS 업그레이드에 쓴다. */
function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try { return origin === new URL(c.req.url).origin; } catch { return false; }
}

async function requireUser(c: C, mutating = false): Promise<SessionUser> {
  const u = await getSessionUser(c.env as never, c.req.header("cookie"));
  if (!u) throw new ChatError(401, "로그인이 필요합니다.");
  if (mutating && !originOk(c)) throw new ChatError(403, "허용되지 않는 요청입니다.");
  return u;
}

/** DM 방을 D1 목록에 upsert (없으면 방+멤버 2명 생성, 있으면 updated_at만). 실패는 로그만 — 응답을 막지 않는다. */
async function upsertDmRoom(db: D1Database, me: string, other: string): Promise<void> {
  try {
    const id = dmRoomKey(me, other);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO chat_rooms(id, type, name, creator_id, created_at, updated_at) VALUES (?, 'dm', NULL, ?, ?, ?)").bind(id, me, now, now),
      db.prepare("INSERT OR IGNORE INTO chat_room_members(room_id, user_id, joined_at) VALUES (?, ?, ?)").bind(id, me, now),
      db.prepare("INSERT OR IGNORE INTO chat_room_members(room_id, user_id, joined_at) VALUES (?, ?, ?)").bind(id, other, now),
      db.prepare("UPDATE chat_rooms SET updated_at = ? WHERE id = ?").bind(now, id),
    ]);
  } catch (e) {
    console.error("chat room upsert failed", e);
  }
}

function roomStub(env: Env, key: string) {
  return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(key));
}

export function groupRoomKey(roomId: string): string {
  return `chat:group:${roomId}`;
}

/** DO 요청 (멤버 목록을 헤더로 직접 지정 — 그룹은 D1 멤버십이 기준). */
function memberRequest(me: SessionUser, memberIds: string[], path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-chat-user", me.id);
  headers.set("x-chat-members", [...memberIds].sort().join(","));
  return new Request(`https://chat-room${path}`, { ...init, headers });
}

/** 방의 최신 seq (DO GET /messages?limit=1 재사용). 메시지가 없으면 0. 실패하면 throw. */
async function latestSeq(env: Env, key: string, me: SessionUser, memberIds: string[]): Promise<number> {
  const res = await roomStub(env, key).fetch(memberRequest(me, memberIds, "/messages?limit=1"));
  if (!res.ok) throw new Error(`latest seq: DO ${res.status}`);
  const j = await res.json<{ messages?: { seq: number }[] }>();
  return Number(j.messages?.[j.messages.length - 1]?.seq ?? 0);
}

function doRequest(me: SessionUser, other: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-chat-user", me.id);
  headers.set("x-chat-members", [me.id, other].sort().join(","));
  return new Request(`https://chat-room${path}`, { ...init, headers });
}

/** 상대 id 검증: 자기 자신 400, 없는(활성 아닌) 사용자 404. */
async function resolvePeer(c: C, me: SessionUser): Promise<string> {
  const other = c.req.param("userId") ?? "";
  if (other === me.id) throw new ChatError(400, "자기 자신과는 대화할 수 없습니다.");
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(other).first<{ id: string }>();
  if (!row) throw new ChatError(404, "사용자를 찾을 수 없습니다.");
  return other;
}

chatApp.onError((e, c) => {
  if (e instanceof ChatError) return c.json({ error: e.message }, e.status as 400);
  console.error("chat error", e);
  return c.json({ error: "서버 오류" }, 500);
});

chatApp.post("/dm/:userId/messages", async (c) => {
  const me = await requireUser(c, true);
  const other = await resolvePeer(c, me);
  let b: { body?: unknown } = {};
  try { b = await c.req.json(); } catch { throw new ChatError(400, "본문이 올바르지 않습니다."); }
  const body = typeof b.body === "string" ? b.body : "";
  if (!body.trim() || body.length > MAX_BODY_CHARS) throw new ChatError(400, `메시지는 1~${MAX_BODY_CHARS}자여야 합니다.`);
  const key = dmRoomKey(me.id, other);
  const res = await roomStub(c.env, key).fetch(doRequest(me, other, "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender_id: me.id, sender_name: me.name, body }),
  }));
  const text = await res.text();
  if (res.status === 201) {
    await upsertDmRoom(c.env.DB, me.id, other); // DO 저장 성공 뒤에만 D1 (D1이 실패해도 메시지는 이미 갔다)
    let seq = 0;
    try { seq = Number((JSON.parse(text) as { message?: { seq?: number } }).message?.seq ?? 0); } catch { /* seq 0 */ }
    // 보낸 사람은 자기 메시지까지 읽은 것으로 친다 (DM 미읽음에 자기 글이 세지지 않게 — 그룹과 같은 규칙)
    try { await c.env.DB.prepare("UPDATE chat_room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?").bind(seq, key, me.id).run(); }
    catch (e) { console.error("chat dm read-self failed", e); }
    await background(c, notifyLobby(c.env, [other], key, seq));
  }
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
});

chatApp.get("/dm/:userId/messages", async (c) => {
  const me = await requireUser(c);
  const other = await resolvePeer(c, me);
  const qs = new URLSearchParams();
  for (const k of ["before", "limit"]) { const v = c.req.query(k); if (v !== undefined) qs.set(k, v); }
  const key = dmRoomKey(me.id, other);
  const res = await roomStub(c.env, key).fetch(doRequest(me, other, `/messages?${qs}`));
  return withReadsAndReactions(c.env.DB, key, res);
});

/** 로비 WebSocket — presence + 새 메시지 알림. 로그인 사용자면 누구나 (내 id로만 붙는다). */
chatApp.get("/lobby/ws", async (c) => {
  const me = await requireUser(c);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new ChatError(426, "WebSocket 업그레이드가 필요합니다.");
  if (!originOk(c)) throw new ChatError(403, "허용되지 않는 요청입니다.");
  return roomStub(c.env, LOBBY_KEY).fetch(new Request("https://chat-room/lobby/ws", { headers: { upgrade: "websocket", "x-chat-user": me.id } }));
});

chatApp.get("/presence", async (c) => {
  await requireUser(c);
  const res = await roomStub(c.env, LOBBY_KEY).fetch(new Request("https://chat-room/lobby/online"));
  const j = await res.json<{ online?: string[] }>();
  return c.json({ ok: true, online: Array.isArray(j.online) ? j.online : [] });
});

/** 내 방 목록. DM 행은 peer(id·이름·이메일·코칭 역할), 그룹 행은 name. 메시지를 보낸 적 없는 방은 행이 없어 안 나온다. */
chatApp.get("/rooms", async (c) => {
  const me = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.type, r.name, r.updated_at, m.last_read_seq, pu.id AS peer_id, pu.name AS peer_name, pu.email AS peer_email, pu.coaching_role AS peer_coaching_role
     FROM chat_room_members m
     JOIN chat_rooms r ON r.id = m.room_id
     LEFT JOIN chat_room_members pm ON pm.room_id = r.id AND pm.user_id != m.user_id AND r.type = 'dm'
     LEFT JOIN users pu ON pu.id = pm.user_id
     WHERE m.user_id = ?
     ORDER BY r.updated_at DESC, r.id LIMIT 200`,
  ).bind(me.id).all<Record<string, string | number | null>>();
  const list = rows.results || [];
  // 그룹·DM 모두 unread (2026-11-18 presence·읽음 작업부터 DM도 센다). 방마다 DO에서 최신 seq를 읽는다.
  const groupIds = list.filter((r) => r.type === "group").map((r) => String(r.id));
  const membersByRoom = new Map<string, string[]>();
  if (groupIds.length) {
    const ms = await c.env.DB.prepare(
      `SELECT m.room_id, m.user_id FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id
       WHERE r.type = 'group' AND m.room_id IN (SELECT room_id FROM chat_room_members WHERE user_id = ?)`,
    ).bind(me.id).all<{ room_id: string; user_id: string }>();
    for (const x of ms.results || []) { const a = membersByRoom.get(x.room_id) ?? []; a.push(x.user_id); membersByRoom.set(x.room_id, a); }
  }
  const unreadOf = async (r: Record<string, string | number | null>): Promise<number> => {
    try {
      const id = String(r.id);
      const latest = r.type === "dm"
        ? await latestSeq(c.env, id, me, [me.id, String(r.peer_id ?? "")].filter(Boolean)) // DM: D1 id = DO 방 키
        : await latestSeq(c.env, groupRoomKey(id), me, membersByRoom.get(id) ?? [me.id]);
      return Math.max(0, latest - Number(r.last_read_seq ?? 0));
    } catch (e) {
      console.error("chat unread failed", e);
      return 0;
    }
  };
  const rooms = await Promise.all(list.map(async (r) => r.type === "dm"
    ? { id: r.id, type: "dm", updated_at: r.updated_at, unread: await unreadOf(r), peer: { id: r.peer_id, name: r.peer_name, email: r.peer_email, coaching_role: r.peer_coaching_role === "coach" ? "coach" : "coachee" } }
    : { id: r.id, type: "group", updated_at: r.updated_at, name: r.name, unread: await unreadOf(r) }));
  return c.json({ ok: true, rooms });
});

chatApp.get("/dm/:userId/ws", async (c) => {
  const me = await requireUser(c);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new ChatError(426, "WebSocket 업그레이드가 필요합니다.");
  if (!originOk(c)) throw new ChatError(403, "허용되지 않는 요청입니다.");
  const other = await resolvePeer(c, me);
  // Hono 헬퍼가 아니라 Worker가 DO stub에 직접 업그레이드 요청을 전달한다.
  return roomStub(c.env, dmRoomKey(me.id, other)).fetch(doRequest(me, other, "/ws", { headers: { upgrade: "websocket" } }));
});

// ====================== 그룹채팅 (DO-1c, 2026-11-18) ======================
// 방 id = uid("chatg"), DO 방 키 = `chat:group:<id>`. 멤버십의 기준은 D1 chat_room_members (DO members 표는 sync-members로 따라간다).
//   POST   /groups                              {name? 1~100자 (없으면 멤버 이름을 ", "로 이어 자동 지정), member_ids[]} → 201 {room(+members)}
//   PATCH  /groups/:roomId                      {name 1~100자} 멤버면 누구나 (비멤버 404) → {room:{id,type,name,updated_at}}
//   GET    /groups/:roomId/members              멤버만 (비멤버 404)
//   POST   /groups/:roomId/members              {user_id} 생성자·hr_admin만 (403). 없는 사용자 404. 이미 멤버면 200 그대로
//   DELETE /groups/:roomId/members/:userId      생성자·hr_admin·본인(나가기). 생성자가 나가려면 body {transfer_to} 필요 (없으면 400)
//   POST   /groups/:roomId/messages · GET /groups/:roomId/messages · GET /groups/:roomId/ws   (멤버만)
//   POST   /rooms/:roomId/read                  {seq?} last_read_seq = MAX(기존, seq) — DM 방에도 쓸 수 있다
// 비멤버는 존재 여부를 알 수 없게 404. hr_admin은 멤버 관리(추가·제거)만 멤버가 아니어도 할 수 있다 (조회·메시지·WS는 멤버만).
const MAX_GROUP_MEMBERS = 100;
const MAX_NAME_CHARS = 100;

type MemberInfo = { id: string; name: string; email: string; coaching_role: "coach" | "coachee"; joined_at: string; is_creator: boolean };

async function readJson(c: C): Promise<Record<string, unknown>> {
  try {
    const j = await c.req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch { return {}; }
}

async function groupMeta(db: D1Database, roomId: string): Promise<{ id: string; name: string | null; creator_id: string; created_at: string; updated_at: string } | null> {
  return db.prepare("SELECT id, name, creator_id, created_at, updated_at FROM chat_rooms WHERE id = ? AND type = 'group'").bind(roomId).first();
}

async function groupMembers(db: D1Database, roomId: string, creatorId: string): Promise<MemberInfo[]> {
  const rs = await db.prepare(
    `SELECT m.user_id, m.joined_at, u.name, u.email, u.coaching_role FROM chat_room_members m
     LEFT JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.joined_at, m.user_id`,
  ).bind(roomId).all<{ user_id: string; joined_at: string; name: string | null; email: string | null; coaching_role: string | null }>();
  return (rs.results || []).map((r) => ({ id: r.user_id, name: r.name ?? "", email: r.email ?? "", coaching_role: r.coaching_role === "coach" ? "coach" : "coachee", joined_at: r.joined_at, is_creator: r.user_id === creatorId }));
}

/** DO members 표를 D1과 맞춘다. 실패해도 던지지 않는다 (D1이 기준 — 메시지·WS 경로가 404를 만나면 다시 맞춘다). */
async function syncDoMembers(env: Env, me: SessionUser, roomId: string, memberIds: string[]): Promise<boolean> {
  try {
    const res = await roomStub(env, groupRoomKey(roomId)).fetch(memberRequest(me, memberIds, "/sync-members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ members: memberIds.map((user_id) => ({ user_id })) }),
    }));
    if (!res.ok) throw new Error(`sync-members ${res.status}`);
    return true;
  } catch (e) {
    console.error("chat sync-members failed", e);
    return false;
  }
}

/** 호출자가 멤버인 그룹 방을 불러온다 (아니면 404). 멤버 id 목록 포함. */
async function requireGroupMember(c: C, me: SessionUser, roomId: string) {
  const room = await groupMeta(c.env.DB, roomId);
  if (!room) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const isMem = await c.env.DB.prepare("SELECT 1 AS x FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, me.id).first();
  if (!isMem) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const ids = ((await c.env.DB.prepare("SELECT user_id FROM chat_room_members WHERE room_id = ?").bind(roomId).all<{ user_id: string }>()).results || []).map((r) => r.user_id);
  return { room, memberIds: ids };
}

/** 그룹 DO 호출. D1에서 멤버로 확인된 사용자인데 DO가 404면(동기화 누락) members를 다시 맞추고 한 번 더 시도한다. */
async function groupFetch(env: Env, me: SessionUser, roomId: string, memberIds: string[], build: () => Request): Promise<Response> {
  const stub = roomStub(env, groupRoomKey(roomId));
  let res = await stub.fetch(build());
  if (res.status === 404 && (await syncDoMembers(env, me, roomId, memberIds))) res = await stub.fetch(build());
  return res;
}

chatApp.post("/groups", async (c) => {
  const me = await requireUser(c, true);
  const b = await readJson(c);
  const rawName = b.name == null ? "" : b.name;
  if (typeof rawName !== "string") throw new ChatError(400, `방 이름은 1~${MAX_NAME_CHARS}자여야 합니다.`);
  let name = rawName.trim();
  if (name.length > MAX_NAME_CHARS) throw new ChatError(400, `방 이름은 1~${MAX_NAME_CHARS}자여야 합니다.`);
  if (!Array.isArray(b.member_ids) || b.member_ids.length < 1 || b.member_ids.some((x) => typeof x !== "string" || !x)) throw new ChatError(400, "멤버를 1명 이상 지정해 주세요.");
  const others = [...new Set(b.member_ids as string[])].filter((x) => x !== me.id);
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new ChatError(400, `멤버는 최대 ${MAX_GROUP_MEMBERS}명입니다.`);
  if (others.length) {
    const rs = await c.env.DB.prepare(`SELECT id FROM users WHERE status = 'active' AND id IN (${others.map(() => "?").join(",")})`).bind(...others).all<{ id: string }>();
    if ((rs.results || []).length !== others.length) throw new ChatError(400, "존재하지 않거나 비활성인 사용자가 포함되어 있습니다.");
  }
  const id = uid("chatg");
  const now = new Date().toISOString();
  const all = [me.id, ...others];
  if (!name) {
    // 이름 미지정: 생성자 먼저, 그다음 member_ids 순서로 멤버 이름을 ", "로 이어 붙인다. 100자 초과분은 그냥 자른다.
    const rs = await c.env.DB.prepare(`SELECT id, name, email FROM users WHERE id IN (${all.map(() => "?").join(",")})`).bind(...all).all<{ id: string; name: string | null; email: string | null }>();
    const byId = new Map((rs.results || []).map((r) => [r.id, (r.name || "").trim() || r.email || ""]));
    name = all.map((u) => byId.get(u) || "").filter(Boolean).join(", ").slice(0, MAX_NAME_CHARS).trim() || "그룹";
  }
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO chat_rooms(id, type, name, creator_id, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)").bind(id, name, me.id, now, now),
    ...all.map((u) => c.env.DB.prepare("INSERT INTO chat_room_members(room_id, user_id, joined_at) VALUES (?, ?, ?)").bind(id, u, now)),
  ]);
  await syncDoMembers(c.env, me, id, all);
  const members = await groupMembers(c.env.DB, id, me.id);
  return c.json({ ok: true, room: { id, type: "group", name, creator_id: me.id, created_at: now, updated_at: now, members } }, 201);
});

// 이름 변경: 멤버면 누구나 (표시용 라벨 — 방은 id로 관리). DO에는 방 이름이 없어 D1만 갱신한다.
chatApp.patch("/groups/:roomId", async (c) => {
  const me = await requireUser(c, true);
  const { room } = await requireGroupMember(c, me, c.req.param("roomId"));
  const b = await readJson(c);
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS) throw new ChatError(400, `방 이름은 1~${MAX_NAME_CHARS}자여야 합니다.`);
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE chat_rooms SET name = ?, updated_at = ? WHERE id = ? AND type = 'group'").bind(name, now, room.id).run();
  return c.json({ ok: true, room: { id: room.id, type: "group", name, updated_at: now } });
});

chatApp.get("/groups/:roomId/members", async (c) => {
  const me = await requireUser(c);
  const { room } = await requireGroupMember(c, me, c.req.param("roomId"));
  return c.json({ ok: true, creator_id: room.creator_id, members: await groupMembers(c.env.DB, room.id, room.creator_id) });
});

/** 멤버 관리 권한: 방 생성자 또는 hr_admin. 비멤버 일반 사용자는 방이 있는지도 모르게 404. */
async function requireManager(c: C, me: SessionUser, roomId: string, allowSelf = false) {
  const room = await groupMeta(c.env.DB, roomId);
  if (!room) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const isMem = !!(await c.env.DB.prepare("SELECT 1 AS x FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, me.id).first());
  const admin = me.role === "hr_admin";
  if (!isMem && !admin) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const manager = admin || room.creator_id === me.id;
  if (!manager && !(allowSelf && isMem)) throw new ChatError(403, "방 생성자만 멤버를 관리할 수 있습니다.");
  return { room, manager };
}

chatApp.post("/groups/:roomId/members", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  const { room } = await requireManager(c, me, roomId);
  const b = await readJson(c);
  const target = typeof b.user_id === "string" ? b.user_id : "";
  if (!target) throw new ChatError(400, "user_id가 필요합니다.");
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(target).first();
  if (!u) throw new ChatError(404, "사용자를 찾을 수 없습니다.");
  const existing = await c.env.DB.prepare("SELECT 1 AS x FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, target).first();
  if (!existing) {
    const cnt = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chat_room_members WHERE room_id = ?").bind(roomId).first<{ n: number }>();
    if ((cnt?.n ?? 0) >= MAX_GROUP_MEMBERS) throw new ChatError(400, `멤버는 최대 ${MAX_GROUP_MEMBERS}명입니다.`);
    // OR IGNORE: 동시에 두 번 추가돼도 중복 행이 생기지 않는다.
    await c.env.DB.prepare("INSERT OR IGNORE INTO chat_room_members(room_id, user_id, joined_at) VALUES (?, ?, ?)").bind(roomId, target, new Date().toISOString()).run();
  }
  const members = await groupMembers(c.env.DB, roomId, room.creator_id);
  if (!existing) await syncDoMembers(c.env, me, roomId, members.map((m) => m.id));
  return c.json({ ok: true, already_member: !!existing, member: members.find((m) => m.id === target) });
});

chatApp.delete("/groups/:roomId/members/:userId", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  const target = c.req.param("userId");
  const { room } = await requireManager(c, me, roomId, target === me.id);
  const members = await groupMembers(c.env.DB, roomId, room.creator_id);
  if (!members.some((m) => m.id === target)) throw new ChatError(404, "멤버를 찾을 수 없습니다.");
  const b = await readJson(c);
  const stmts: D1PreparedStatement[] = [];
  let roomDeleted = false;
  let creatorId = room.creator_id;
  if (target === room.creator_id) {
    if (members.length === 1) {
      roomDeleted = true; // 마지막 1명 — 방 삭제 (DO 메시지는 방 키로 남지만 접근 경로가 없다)
    } else {
      const to = typeof b.transfer_to === "string" ? b.transfer_to : "";
      if (!to) throw new ChatError(400, "생성자를 넘긴 뒤에 나갈 수 있습니다. transfer_to에 새 생성자를 지정해 주세요.");
      if (to === target || !members.some((m) => m.id === to)) throw new ChatError(400, "transfer_to는 방의 다른 멤버여야 합니다.");
      creatorId = to;
      stmts.push(c.env.DB.prepare("UPDATE chat_rooms SET creator_id = ? WHERE id = ?").bind(to, roomId));
    }
  }
  if (roomDeleted) {
    stmts.push(c.env.DB.prepare("DELETE FROM chat_room_members WHERE room_id = ?").bind(roomId), c.env.DB.prepare("DELETE FROM chat_rooms WHERE id = ?").bind(roomId));
  } else {
    stmts.push(c.env.DB.prepare("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, target));
  }
  await c.env.DB.batch(stmts);
  // 제거된 멤버(방이 지워졌다면 전원)의 WebSocket은 DO가 닫는다.
  await syncDoMembers(c.env, me, roomId, roomDeleted ? [] : members.filter((m) => m.id !== target).map((m) => m.id));
  return c.json({ ok: true, removed: target, room_deleted: roomDeleted, creator_id: roomDeleted ? null : creatorId });
});

chatApp.post("/groups/:roomId/messages", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  const { memberIds } = await requireGroupMember(c, me, roomId); // 보내기 전에 D1 멤버십 확인
  const b = await readJson(c);
  const body = typeof b.body === "string" ? b.body : "";
  if (!body.trim() || body.length > MAX_BODY_CHARS) throw new ChatError(400, `메시지는 1~${MAX_BODY_CHARS}자여야 합니다.`);
  const payload = JSON.stringify({ sender_id: me.id, sender_name: me.name, body });
  const res = await groupFetch(c.env, me, roomId, memberIds, () => memberRequest(me, memberIds, "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: payload }));
  const text = await res.text();
  if (res.status === 201) {
    try {
      // 보낸 사람은 자기 메시지까지 읽은 것으로 친다 (자기 글이 미읽음으로 세지지 않게). D1 실패는 로그만.
      let seq = 0;
      try { seq = Number((JSON.parse(text) as { message?: { seq?: number } }).message?.seq ?? 0); } catch { /* 본문 파싱 실패 — seq 0 */ }
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE chat_rooms SET updated_at = ? WHERE id = ?").bind(new Date().toISOString(), roomId),
        c.env.DB.prepare("UPDATE chat_room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?").bind(seq, roomId, me.id),
      ]);
      await background(c, notifyLobby(c.env, memberIds.filter((x) => x !== me.id), roomId, seq));
    } catch (e) { console.error("chat group updated_at failed", e); }
  }
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
});

chatApp.get("/groups/:roomId/messages", async (c) => {
  const me = await requireUser(c);
  const roomId = c.req.param("roomId");
  const { memberIds } = await requireGroupMember(c, me, roomId);
  const qs = new URLSearchParams();
  for (const k of ["before", "limit"]) { const v = c.req.query(k); if (v !== undefined) qs.set(k, v); }
  const res = await groupFetch(c.env, me, roomId, memberIds, () => memberRequest(me, memberIds, `/messages?${qs}`));
  return withReadsAndReactions(c.env.DB, roomId, res);
});

chatApp.get("/groups/:roomId/ws", async (c) => {
  const me = await requireUser(c);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new ChatError(426, "WebSocket 업그레이드가 필요합니다.");
  if (!originOk(c)) throw new ChatError(403, "허용되지 않는 요청입니다.");
  const roomId = c.req.param("roomId");
  const { memberIds } = await requireGroupMember(c, me, roomId);
  return groupFetch(c.env, me, roomId, memberIds, () => memberRequest(me, memberIds, "/ws", { headers: { upgrade: "websocket" } }));
});

/** 읽음 확인 (그룹·DM 공통). last_read_seq는 뒤로 가지 않고, 방의 최신 seq를 넘지 않는다. */
chatApp.post("/rooms/:roomId/read", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  const room = await c.env.DB.prepare(
    "SELECT r.id, r.type, m.last_read_seq FROM chat_rooms r JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ?",
  ).bind(me.id, roomId).first<{ id: string; type: string; last_read_seq: number }>();
  if (!room) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const b = await readJson(c);
  if (b.seq !== undefined && (typeof b.seq !== "number" || !Number.isInteger(b.seq) || b.seq < 0)) throw new ChatError(400, "seq는 0 이상의 정수여야 합니다.");
  const memberIds = ((await c.env.DB.prepare("SELECT user_id FROM chat_room_members WHERE room_id = ?").bind(roomId).all<{ user_id: string }>()).results || []).map((r) => r.user_id);
  const key = room.type === "group" ? groupRoomKey(roomId) : roomId;
  const latest = await latestSeq(c.env, key, me, memberIds); // DO 실패 → onError 500 (읽음 표시를 잘못 올리지 않는다)
  const want = Math.min(typeof b.seq === "number" ? b.seq : latest, latest);
  await c.env.DB.prepare("UPDATE chat_room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?").bind(want, roomId, me.id).run();
  const now = await c.env.DB.prepare("SELECT last_read_seq FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, me.id).first<{ last_read_seq: number }>();
  const lastRead = Number(now?.last_read_seq ?? 0);
  // 방에 있는 다른 멤버 화면의 "1"을 지우도록 읽음 위치를 브로드캐스트 (실패해도 응답은 그대로)
  if (lastRead > Number(room.last_read_seq ?? 0)) await background(c, roomEvent(c.env, key, { type: "read", user_id: me.id, last_read_seq: lastRead }));
  return c.json({ ok: true, last_read_seq: lastRead, latest_seq: latest, unread: Math.max(0, latest - lastRead) });
});

/** 반응 토글 (그룹·DM 공통, 멤버만). 같은 사람·같은 이모지를 다시 누르면 취소. 변경 뒤 방 소켓으로 그 메시지의 반응 전체를 브로드캐스트. */
chatApp.post("/rooms/:roomId/messages/:seq/reactions", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  const seqRaw = c.req.param("seq");
  if (!/^\d{1,9}$/.test(seqRaw) || Number(seqRaw) < 1) throw new ChatError(400, "seq는 1 이상의 정수여야 합니다.");
  const seq = Number(seqRaw);
  const b = await readJson(c);
  const emoji = typeof b.emoji === "string" ? b.emoji : "";
  if (!REACTION_EMOJIS.includes(emoji)) throw new ChatError(400, "지원하지 않는 반응입니다.");
  const room = await c.env.DB.prepare(
    "SELECT r.id, r.type FROM chat_rooms r JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ?",
  ).bind(me.id, roomId).first<{ id: string; type: string }>();
  if (!room) throw new ChatError(404, "방을 찾을 수 없습니다.");
  const memberIds = ((await c.env.DB.prepare("SELECT user_id FROM chat_room_members WHERE room_id = ?").bind(roomId).all<{ user_id: string }>()).results || []).map((r) => r.user_id);
  const key = room.type === "group" ? groupRoomKey(roomId) : roomId;
  const latest = await latestSeq(c.env, key, me, memberIds);
  if (seq > latest) throw new ChatError(404, "메시지를 찾을 수 없습니다.");
  const del = await c.env.DB.prepare("DELETE FROM chat_reactions WHERE room_id = ? AND message_seq = ? AND user_id = ? AND emoji = ?").bind(roomId, seq, me.id, emoji).run();
  const added = !del.meta.changes;
  if (added) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO chat_reactions(room_id, message_seq, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(roomId, seq, me.id, emoji, new Date().toISOString()).run();
  }
  const rr = await c.env.DB.prepare("SELECT message_seq, emoji, user_id FROM chat_reactions WHERE room_id = ? AND message_seq = ? ORDER BY created_at, user_id")
    .bind(roomId, seq).all<{ message_seq: number; emoji: string; user_id: string }>();
  const reactions = aggregate(rr.results || []).get(seq) ?? [];
  await background(c, roomEvent(c.env, key, { type: "reaction", seq, reactions }));
  return c.json({ ok: true, seq, added, reactions });
});
