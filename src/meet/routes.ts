// 화상회의 API (V0 2026-11-19, V1+V2 같은 날 · video-conference-plan.md). index.ts에서 "/api/meet"에 mount한다 (경로는 mount 기준 상대).
//   POST /rooms/:roomId/start   세션 + 방 멤버. 본문 {transcribe?: boolean} (기본 true, 코칭 DM은 항상 true).
//                               진행 중 회의가 있으면 RealtimeKit에 실제로 살아 있는지 확인 후 그대로(200), 죽었으면 ended로 닫고 새로 만든다(201).
//                               새로 만들면 방 소켓에 meeting_started 브로드캐스트 + 다른 멤버에게 알림(NotificationHub 푸시).
//   GET  /rooms/:roomId/active  세션 + 방 멤버 → {meeting | null} (채팅방 카드용)
//   GET  /:id                   세션 + 방 멤버 → {meeting}
//   POST /:id/join              세션 + 방 멤버 → RealtimeKit 참가자 추가 → {token, preset} (토큰은 응답 본문으로만. URL에 싣지 않는다, no-store)
//   POST /:id/end               시작한 사람 또는 coach → status=ended + meeting_ended 브로드캐스트 + RealtimeKit 회의 INACTIVE(재입장 막기, best-effort)
//   POST /webhook               RealtimeKit 웹훅. 세션 없음 — rtk-signature(RSA-SHA256) 검증 실패면 401
//                               meeting.ended → ended + 카드 닫기, meeting.transcript → 전사본 가져오기(V2, src/meet/transcript.ts)
//   GET  /presets · /webhooks   관리자 전용 (hr_admin 세션 또는 X-Admin-Secret). V0 프리셋 이름·웹훅 등록 확인용
// 권한: 회의를 만들고 들어갈 수 있는 사람은 그 채팅방(chat_room_members)의 멤버뿐이다. hr_admin이라도 멤버가 아니면 403.
// 프리셋: 회의를 시작한 사람 또는 coaching_role=coach → 호스트, 그 외 → 참가자.
import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionUser, isAdminRequest, type SessionUser } from "../auth";
import { uid } from "../lib";
import { logEvent } from "../obs/log";
import { pushNotification } from "../notifications/push";
import { broadcastRoomEvent } from "../chat/routes";
import {
  addParticipant, createMeeting, DEFAULT_PRESET_HOST, DEFAULT_PRESET_PARTICIPANT, listPresets, listWebhooks,
  RtkError, setMeetingStatus, verifyWebhookSignature,
} from "./rtk";
import { fetchMeetingTranscripts, ingestSessionTranscript, isMeetingAlive, markMeetingEnded, type MeetEnv, type MeetingRow } from "./transcript";

type Env = MeetEnv;
type C = Context<{ Bindings: Env }>;
export const meetApp = new Hono<{ Bindings: Env }>();

class MeetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

meetApp.onError((e, c) => {
  if (e instanceof MeetError) return c.json({ ok: false, error: e.message }, e.status as 400);
  if (e instanceof RtkError) {
    logEvent("meet.rtk_error", { status: e.status, http_status: e.httpStatus, message: e.message });
    console.error("meet rtk error", e.message, e.detail);
    return c.json({ ok: false, error: e.message, detail: e.detail }, e.status as 502);
  }
  console.error("meet error", e);
  return c.json({ ok: false, error: "화상회의 처리 중 오류가 발생했습니다." }, 500);
});

/** 응답을 막지 않는 뒷일 (waitUntil이 없으면 그냥 기다린다). */
async function background(c: C, p: Promise<unknown>): Promise<void> {
  const safe = p.catch((e) => console.error("meet background failed", e));
  try { c.executionCtx.waitUntil(safe); } catch { await safe; }
}

/** Origin 헤더가 있으면 같은 출처여야 한다 (채팅 라우트와 같은 규칙). 상태를 바꾸는 POST에 쓴다. */
function originOk(c: C): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try { return origin === new URL(c.req.url).origin; } catch { return false; }
}

async function requireUser(c: C, mutating = false): Promise<SessionUser> {
  const me = await getSessionUser(c.env, c.req.header("cookie"));
  if (!me) throw new MeetError(401, "로그인이 필요합니다.");
  if (mutating && !originOk(c)) throw new MeetError(403, "허용되지 않는 요청입니다.");
  return me;
}

async function requireMember(c: C, roomId: string, userId: string): Promise<void> {
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM chat_room_members WHERE room_id = ? AND user_id = ?").bind(roomId, userId).first();
  if (!row) throw new MeetError(403, "이 채팅방의 멤버만 회의에 참여할 수 있습니다.");
}

async function loadMeeting(c: C, id: string): Promise<MeetingRow> {
  const m = await c.env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<MeetingRow>();
  if (!m) throw new MeetError(404, "회의를 찾을 수 없습니다.");
  return m;
}

function activeMeeting(c: C, roomId: string): Promise<MeetingRow | null> {
  return c.env.DB.prepare("SELECT * FROM meetings WHERE room_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(roomId).first<MeetingRow>();
}

function publicMeeting(m: MeetingRow) {
  return {
    id: m.id, room_id: m.room_id, title: m.title, created_by: m.created_by, status: m.status,
    is_coaching: !!m.is_coaching, transcribe: m.transcribe !== 0, started_at: m.started_at, ended_at: m.ended_at,
    transcript_status: m.transcript_status, recording_id: m.recording_id ?? null,
  };
}

/** 방 제목·코칭 여부·멤버. DM: 두 사람 이름, 코치↔코칭 대상이면 is_coaching. 그룹: 방 이름. */
async function roomInfo(c: C, roomId: string): Promise<{ title: string; isCoaching: boolean; memberIds: string[] }> {
  const room = await c.env.DB.prepare("SELECT type, name FROM chat_rooms WHERE id = ?").bind(roomId).first<{ type: string; name: string | null }>();
  if (!room) throw new MeetError(404, "채팅방을 찾을 수 없습니다.");
  const ms = (await c.env.DB.prepare(
    "SELECT u.id, u.name, u.coaching_role FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.name",
  ).bind(roomId).all<{ id: string; name: string; coaching_role: string | null }>()).results || [];
  const roles = ms.map((x) => (x.coaching_role === "coach" ? "coach" : "coachee"));
  const isCoaching = room.type === "dm" && ms.length === 2 && roles.includes("coach") && roles.includes("coachee");
  const title = (room.type === "group" && room.name) ? room.name : ms.map((x) => x.name).join(" · ") || "영상 통화";
  return { title: `${title} 영상 통화`.slice(0, 120), isCoaching, memberIds: ms.map((x) => x.id) };
}

/** 새 회의 알림: 시작한 사람을 뺀 방 멤버에게 notifications 행 + NotificationHub 푸시 (방을 열지 않은 사람도 받는다). */
async function notifyStarted(env: Env, m: MeetingRow, starter: SessionUser, memberIds: string[]): Promise<void> {
  const title = `${starter.name}님이 영상 통화를 시작했습니다`.slice(0, 300);
  const link = `/meet?m=${encodeURIComponent(m.id)}`;
  const created = new Date().toISOString();
  for (const uidv of memberIds.filter((x) => x !== starter.id)) {
    const id = `meet_${m.id}_${uidv}`.slice(0, 120);
    try {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO notifications(id,user_id,type,ref_type,ref_id,title,body,link,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(id, uidv, "MEETING_STARTED", "meeting", m.id, title, m.title, link, created).run();
      if ((r.meta?.changes ?? 0) === 1) await pushNotification(env, uidv, { id, type: "MEETING_STARTED", title, body: m.title, link, created_at: created });
    } catch (e) { console.error("meet notify failed", e); }
  }
}

// ---- 웹훅 (세션 없음, 서명으로만 검증) — /:id 경로보다 먼저 등록 ----
meetApp.post("/webhook", async (c) => {
  const raw = await c.req.arrayBuffer();
  const sig = c.req.header("rtk-signature");
  let valid = false;
  try { valid = await verifyWebhookSignature(c.env, raw, sig); } catch (e) {
    console.error("meet webhook key error", e);
    return c.json({ ok: false, error: "서명 검증 키를 가져오지 못했습니다." }, 503); // 5xx → RealtimeKit이 재시도할 수 있게
  }
  if (!valid) {
    logEvent("meet.webhook_rejected", { has_signature: !!sig });
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }
  let ev: { event?: string; meeting?: { id?: string; sessionId?: string; status?: string; endedAt?: string }; reason?: string; transcriptDownloadUrl?: string };
  try { ev = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
  const rtkId = ev.meeting?.id ?? "";
  const sessionId = ev.meeting?.sessionId ?? null;
  // 내용(전사 링크 등)은 로그에 싣지 않는다 — 식별자·상태만.
  logEvent("meet.webhook", { type: ev.event ?? "", rtk_meeting_id: rtkId, session_id: sessionId ?? "", reason: ev.reason ?? "" });
  if (!rtkId) return c.json({ ok: true });
  // 같은 RealtimeKit 회의에 행은 보통 1개다 (start가 회의마다 새로 만든다). 가장 최근 행을 쓴다.
  const m = await c.env.DB.prepare("SELECT * FROM meetings WHERE rtk_meeting_id = ? ORDER BY started_at DESC LIMIT 1").bind(rtkId).first<MeetingRow>();
  if (!m) return c.json({ ok: true, ignored: "unknown meeting" });
  if (ev.event === "meeting.ended") {
    await markMeetingEnded(c.env, m, { sessionId, endedAt: ev.meeting?.endedAt ?? null, reason: ev.reason || "webhook" });
    if (sessionId) await c.env.DB.prepare("UPDATE meetings SET rtk_session_id = COALESCE(rtk_session_id, ?) WHERE id = ?").bind(sessionId, m.id).run();
  } else if (ev.event === "meeting.transcript") {
    await c.env.DB.prepare(
      "UPDATE meetings SET transcript_status = CASE WHEN transcript_status IN ('ready', 'off') THEN transcript_status ELSE 'available' END, rtk_session_id = COALESCE(rtk_session_id, ?) WHERE id = ?",
    ).bind(sessionId, m.id).run();
    // 전사 결과가 오면 회의는 끝난 것이다 (meeting.ended 웹훅을 놓쳤어도 닫는다).
    await markMeetingEnded(c.env, m, { sessionId, endedAt: ev.meeting?.endedAt ?? null, reason: "transcript" });
    const url = typeof ev.transcriptDownloadUrl === "string" ? ev.transcriptDownloadUrl : "";
    const fresh = await loadMeeting(c, m.id);
    // 웹훅에는 빨리 답하고 내려받기·문서 만들기는 뒤에서 한다. 실패하면 오류만 적고 15분 크론이 REST로 다시 가져온다.
    const job = (url
      ? ingestSessionTranscript(c.env, fresh, sessionId ?? "", url, "webhook")
      : fetchMeetingTranscripts(c.env, fresh, "webhook")
    ).catch(async (e) => {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error("meet transcript ingest failed", m.id, msg);
      logEvent("meet.transcript_failed", { meeting_id: m.id, source: "webhook", error: msg });
      await c.env.DB.prepare("UPDATE meetings SET transcript_error = ? WHERE id = ?").bind(msg, m.id).run().catch(() => {});
    });
    await background(c, job);
  } else if (ev.event === "meeting.started" && sessionId) {
    await c.env.DB.prepare("UPDATE meetings SET rtk_session_id = ? WHERE id = ? AND status = 'active'").bind(sessionId, m.id).run();
  }
  return c.json({ ok: true });
});

// ---- 관리자: 프리셋·웹훅 확인 (V0) ----
async function requireAdmin(c: C): Promise<void> {
  if (!(await isAdminRequest(c.env, c.req.header("cookie"), c.req.header("x-admin-secret")))) throw new MeetError(403, "관리자만 볼 수 있습니다.");
}
meetApp.get("/presets", async (c) => {
  await requireAdmin(c);
  return c.json({ ok: true, configured: { host: c.env.RTK_PRESET_HOST || DEFAULT_PRESET_HOST, participant: c.env.RTK_PRESET_PARTICIPANT || DEFAULT_PRESET_PARTICIPANT }, presets: await listPresets(c.env) });
});
meetApp.get("/webhooks", async (c) => {
  await requireAdmin(c);
  return c.json({ ok: true, webhooks: await listWebhooks(c.env) });
});

// ---- 채팅방 기준 ----
meetApp.post("/rooms/:roomId/start", async (c) => {
  const me = await requireUser(c, true);
  const roomId = c.req.param("roomId");
  await requireMember(c, roomId, me.id);
  let body: { transcribe?: unknown } = {};
  try { body = await c.req.json(); } catch { /* 본문 없음 = 기본값 */ }
  const existing = await activeMeeting(c, roomId);
  // V1 오래된 회의 정리: DB에는 active인데 RealtimeKit에 회의가 없거나 INACTIVE면 join이 502가 된다 → 닫고 새로 만든다.
  if (existing && (await isMeetingAlive(c.env, existing))) return c.json({ ok: true, created: false, meeting: publicMeeting(existing) });
  const info = await roomInfo(c, roomId);
  // 사용자 결정(9장 4번): 코칭 1:1 방은 항상 전사, 그 외는 시작할 때 고른다(기본 켜짐).
  const transcribe = info.isCoaching ? true : body.transcribe !== false;
  const rtk = await createMeeting(c.env, info.title, transcribe);
  if (!rtk?.id) throw new RtkError(502, "RealtimeKit 회의 id가 응답에 없습니다");
  const id = uid("meet");
  try {
    await c.env.DB.prepare(
      "INSERT INTO meetings (id, room_id, rtk_meeting_id, title, created_by, is_coaching, transcribe, transcript_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, roomId, rtk.id, info.title, me.id, info.isCoaching ? 1 : 0, transcribe ? 1 : 0, transcribe ? "none" : "off").run();
  } catch (e) {
    // 동시에 두 사람이 시작을 눌렀다 — 부분 고유 인덱스에 걸리면 먼저 만들어진 회의를 돌려준다.
    const winner = await activeMeeting(c, roomId);
    if (winner) return c.json({ ok: true, created: false, meeting: publicMeeting(winner) });
    throw e;
  }
  const m = await loadMeeting(c, id);
  logEvent("meet.start", { meeting_id: id, room_id: roomId, is_coaching: info.isCoaching, transcribe, replaced: existing?.id ?? "" });
  const pub = publicMeeting(m);
  await background(c, Promise.all([
    broadcastRoomEvent(c.env, roomId, { type: "meeting_started", meeting: pub, started_by: { id: me.id, name: me.name } })
      .then((ok) => logEvent("meet.card_broadcast", { meeting_id: id, type: "meeting_started", ok })),
    notifyStarted(c.env, m, me, info.memberIds),
  ]));
  return c.json({ ok: true, created: true, meeting: pub }, 201);
});

meetApp.get("/rooms/:roomId/active", async (c) => {
  const me = await requireUser(c);
  const roomId = c.req.param("roomId");
  await requireMember(c, roomId, me.id);
  const m = await activeMeeting(c, roomId);
  return c.json({ ok: true, meeting: m ? publicMeeting(m) : null });
});

// ---- 회의 기준 ----
meetApp.get("/:id", async (c) => {
  const me = await requireUser(c);
  const m = await loadMeeting(c, c.req.param("id"));
  await requireMember(c, m.room_id, me.id);
  return c.json({ ok: true, meeting: publicMeeting(m), can_end: m.created_by === me.id || me.coaching_role === "coach" });
});

meetApp.post("/:id/join", async (c) => {
  const me = await requireUser(c, true);
  const m = await loadMeeting(c, c.req.param("id"));
  await requireMember(c, m.room_id, me.id);
  if (m.status !== "active") throw new MeetError(409, "이미 끝난 회의입니다.");
  const isHost = m.created_by === me.id || me.coaching_role === "coach";
  const preset = isHost ? (c.env.RTK_PRESET_HOST || DEFAULT_PRESET_HOST) : (c.env.RTK_PRESET_PARTICIPANT || DEFAULT_PRESET_PARTICIPANT);
  let p;
  try {
    p = await addParticipant(c.env, m.rtk_meeting_id, { name: me.name, preset_name: preset, custom_participant_id: me.id });
  } catch (e) {
    // RealtimeKit에서 회의가 사라졌다(404) → 행을 닫고 410으로 알려 화면이 "다시 시작"을 안내하게 한다.
    if (e instanceof RtkError && e.httpStatus === 404) {
      await markMeetingEnded(c.env, m, { reason: "rtk_missing" });
      throw new MeetError(410, "이 회의는 더 이상 없습니다. 채팅방에서 영상 통화를 다시 시작해 주세요.");
    }
    throw e;
  }
  logEvent("meet.join", { meeting_id: m.id, user_id: me.id, preset });
  c.header("cache-control", "no-store");
  return c.json({ ok: true, token: p.token, preset, role: isHost ? "host" : "participant", meeting: publicMeeting(m), me: { id: me.id, name: me.name } });
});

meetApp.post("/:id/end", async (c) => {
  const me = await requireUser(c, true);
  const m = await loadMeeting(c, c.req.param("id"));
  await requireMember(c, m.room_id, me.id);
  if (m.created_by !== me.id && me.coaching_role !== "coach") throw new MeetError(403, "회의를 시작한 사람 또는 코치만 종료할 수 있습니다.");
  const changed = await markMeetingEnded(c.env, m, { reason: "ended_by_user" });
  // RealtimeKit 쪽은 INACTIVE로 바꿔 아무도 다시 못 들어가게 한다. 실패해도 우리 쪽 종료는 그대로다.
  if (changed) await background(c, setMeetingStatus(c.env, m.rtk_meeting_id, "INACTIVE"));
  logEvent("meet.end", { meeting_id: m.id, user_id: me.id, changed });
  return c.json({ ok: true, meeting: publicMeeting(await loadMeeting(c, m.id)) });
});
