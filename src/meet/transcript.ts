// 화상회의 V1+V2 (2026-11-19, video-conference-plan.md 6장): 회의 후 전사 → recordings·문서·PIPELINE 큐, 그리고 15분 크론 정리.
//
// 전사 형식 (문서 확인 2026-11-19, developers.cloudflare.com/realtime/realtimekit/ai/transcription):
//   JSON: [{ startTime, endTime, sentence, peerData: { id, userId, displayName, cpi, joinedAt, leftAt } }, ...]  (cpi = custom_participant_id)
//   CSV : 머리글 없음, "시작ms","peer id","user id","custom participant id","이름","발화"
//   받는 길: meeting.transcript 웹훅의 transcriptDownloadUrl, 또는 GET /sessions/<id>/transcript?format=JSON → data.transcript_download_url.
//   보관: 회의 종료 후 7일.
// custom_participant_id = People OS 사용자 id (join 때 넣었다) → users.name으로 "이름: 발화" 전사본을 만든다.
//
// 멱등: recordings id를 (회의, 세션)으로 정한다 → 웹훅과 크론이 같은 세션을 동시에 가져와도 행 1개.
// 문서 만들기는 recordings.lock_until 잠금(advanceRecording과 같은 방식) 안에서 doc_id가 비어 있을 때만 한다.
import { logEvent } from "../obs/log";
import { pushNotification, type PushEnv } from "../notifications/push";
import { broadcastRoomEvent, postSystemMessage } from "../chat/routes";
import { getMeeting, getSessionTranscriptUrl, listMeetingSessions, rtkConfigured, type RtkEnv, type RtkSession } from "./rtk";

export type MeetEnv = RtkEnv & PushEnv & {
  DB: D1Database;
  FILES: R2Bucket;
  CHAT_ROOM: DurableObjectNamespace;
  ADMIN_SECRET?: string;
};

export type MeetingRow = {
  id: string; room_id: string; rtk_meeting_id: string; title: string; created_by: string; status: string;
  is_coaching: number; started_at: string; ended_at: string | null; transcript_status: string;
  rtk_session_id: string | null; recording_id: string | null;
  transcribe?: number | null; transcript_attempts?: number | null; transcript_error?: string | null;
};

export type MeetHooks = {
  /** index.ts의 finishTranscript — 업로드 녹음 전사 완료 분기와 같은 함수 (문서 생성 + recordings ready + PIPELINE 큐). */
  finishTranscript: (
    env: MeetEnv,
    rec: { id: string; title: string; object_key: string; owner_id: string | null; is_coaching: number | null },
    docTitle: string, docContent: string, transcript: string,
  ) => Promise<string>;
};
let hooks: MeetHooks | null = null;
export function setMeetHooks(h: MeetHooks): void { hooks = h; }

export const TRANSCRIPT_MODEL = "@cf/openai/whisper-large-v3-turbo"; // RealtimeKit 회의 후 전사 모델 (문서)
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const STALE_ACTIVE_MIN = 20;     // 시작 후 이 시간이 지났는데 LIVE 세션이 없으면 끝난 회의로 본다
const TRANSCRIPT_GRACE_MIN = 2;  // 종료 직후에는 전사가 아직 없다
const MAX_ATTEMPTS = 96;         // 15분 × 96 = 24시간 동안 다시 시도
const KEEP_DAYS = 7;             // RealtimeKit 전사 보관 기간

// ---------- 전사 파싱 ----------
export type TranscriptEntry = { start: number; end: number; cpi: string; userId: string; name: string; text: string };

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string { return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""; }

/** 따옴표 CSV 한 덩어리를 행 배열로 (""는 따옴표 하나). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** RealtimeKit 전사 파일(JSON 또는 CSV) → 발화 목록 (시작 시각 순). 알 수 없는 형식이면 빈 배열. */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const t = raw.replace(/^﻿/, "").trim();
  if (!t) return [];
  let out: TranscriptEntry[] = [];
  if (t.startsWith("[") || t.startsWith("{")) {
    let j: unknown;
    try { j = JSON.parse(t); } catch { return []; }
    const list = Array.isArray(j) ? j
      : Array.isArray((j as { data?: unknown })?.data) ? (j as { data: unknown[] }).data
      : Array.isArray((j as { transcript?: unknown })?.transcript) ? (j as { transcript: unknown[] }).transcript : [];
    out = list.map((x) => {
      const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const p = (e.peerData && typeof e.peerData === "object" ? e.peerData : {}) as Record<string, unknown>;
      return {
        start: num(e.startTime ?? e.start_time ?? e.start),
        end: num(e.endTime ?? e.end_time ?? e.end),
        cpi: str(p.cpi ?? p.customParticipantId ?? p.custom_participant_id ?? e.customParticipantId ?? e.custom_participant_id),
        userId: str(p.userId ?? p.user_id ?? e.userId),
        name: str(p.displayName ?? p.name ?? e.displayName ?? e.name),
        text: str(e.sentence ?? e.transcript ?? e.text).trim(),
      };
    });
  } else {
    out = parseCsv(t).filter((r) => r.length >= 6).map((r) => ({
      start: num(r[0]), end: num(r[0]), userId: r[2] ?? "", cpi: r[3] ?? "", name: r[4] ?? "", text: (r.slice(5).join(",") ?? "").trim(),
    }));
  }
  return out.filter((e) => e.text).sort((a, b) => a.start - b.start);
}

/** 발화 목록 → "이름: 발화" 줄. 화자 id(cpi)는 People OS 사용자 이름으로 바꾼다. 같은 화자가 이어 말하면 한 줄로 합친다. */
export function formatTranscript(entries: TranscriptEntry[], names: Map<string, string>): string {
  const lines: { who: string; key: string; text: string }[] = [];
  for (const e of entries) {
    const who = (e.cpi && names.get(e.cpi)) || e.name || "참가자";
    const key = e.cpi || e.userId || e.name;
    const last = lines[lines.length - 1];
    if (last && last.key === key) last.text += " " + e.text;
    else lines.push({ who, key, text: e.text });
  }
  return lines.map((l) => `${l.who}: ${l.text}`).join("\n");
}

async function userNames(env: MeetEnv, ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, 90);
  const m = new Map<string, string>();
  if (!uniq.length) return m;
  const rs = await env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${uniq.map(() => "?").join(",")})`).bind(...uniq).all<{ id: string; name: string | null }>();
  for (const r of rs.results || []) if (r.name) m.set(r.id, r.name);
  return m;
}

// ---------- 소유자·제목 ----------
/** 전사본 소유자 (계획 6장 권장): 회의를 시작한 사람. 코칭 회의면 방의 코치. */
async function transcriptOwner(env: MeetEnv, m: MeetingRow): Promise<string> {
  if (!m.is_coaching) return m.created_by;
  const coach = await env.DB.prepare(
    "SELECT u.id FROM chat_room_members cm JOIN users u ON u.id = cm.user_id WHERE cm.room_id = ? AND u.coaching_role = 'coach' ORDER BY u.id LIMIT 1",
  ).bind(m.room_id).first<{ id: string }>();
  return coach?.id ?? m.created_by;
}

function kstStamp(iso: string | null | undefined): string {
  const d = iso ? new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z") : new Date();
  const k = new Date((isNaN(d.getTime()) ? Date.now() : d.getTime()) + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

function recordingIdFor(meetingId: string, sessionId: string): string {
  const s = (sessionId || "s0").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "s0";
  return `rec_${meetingId}_${s}`;
}

// ---------- 내려받기 ----------
async function download(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`transcript download HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_TRANSCRIPT_BYTES) throw new Error(`transcript too large (${len} bytes)`);
    const text = await res.text();
    if (text.length > MAX_TRANSCRIPT_BYTES) throw new Error("transcript too large");
    return text;
  } finally { clearTimeout(timer); }
}

export type IngestResult = { status: "ready" | "already" | "busy" | "empty" | "off"; recordingId?: string; docId?: string; lines?: number };

/**
 * 세션 1개의 전사 → recordings(ready, provider=realtimekit) + R2 원본 + 문서 + PIPELINE 큐 + meetings.recording_id + 채팅방 안내.
 * 실패하면 던진다 (부르는 쪽이 meetings.transcript_error에 적고 크론이 다시 시도한다).
 */
export async function ingestSessionTranscript(env: MeetEnv, m: MeetingRow, sessionId: string, downloadUrl: string, source: "webhook" | "cron"): Promise<IngestResult> {
  if (!hooks) throw new Error("meet hooks not set");
  if (m.transcribe === 0) return { status: "off" };
  const recId = recordingIdFor(m.id, sessionId);
  const existing = await env.DB.prepare("SELECT id, doc_id FROM recordings WHERE id = ?").bind(recId).first<{ id: string; doc_id: string | null }>();
  if (existing?.doc_id) return { status: "already", recordingId: recId, docId: existing.doc_id };

  const raw = await download(downloadUrl);
  const entries = parseTranscript(raw);
  if (!entries.length) {
    await env.DB.prepare("UPDATE meetings SET transcript_status = 'empty', transcript_error = NULL WHERE id = ? AND transcript_status != 'ready'").bind(m.id).run();
    logEvent("meet.transcript_empty", { meeting_id: m.id, source });
    return { status: "empty" };
  }
  const names = await userNames(env, entries.map((e) => e.cpi));
  const transcript = formatTranscript(entries, names);
  const speakers = [...new Set(entries.map((e) => (e.cpi && names.get(e.cpi)) || e.name || "참가자"))];

  // 원본 JSON은 R2 meetings/<회의 id>/transcript.json (같은 회의의 두 번째 세션부터는 transcript-<세션>.json).
  let objectKey = `meetings/${m.id}/transcript.json`;
  if (!existing) {
    const taken = await env.DB.prepare("SELECT 1 AS x FROM recordings WHERE object_key = ? AND id != ?").bind(objectKey, recId).first();
    if (taken) objectKey = `meetings/${m.id}/transcript-${recId.slice(-12)}.json`;
  } else {
    const r = await env.DB.prepare("SELECT object_key FROM recordings WHERE id = ?").bind(recId).first<{ object_key: string }>();
    if (r?.object_key) objectKey = r.object_key;
  }
  await env.FILES.put(objectKey, raw, { httpMetadata: { contentType: raw.trim().startsWith("[") || raw.trim().startsWith("{") ? "application/json" : "text/csv" } });

  const ownerId = await transcriptOwner(env, m);
  const when = kstStamp(m.started_at);
  const recTitle = `${m.title} ${when}`.slice(0, 200);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO recordings (id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, doc_id, created_at, owner_id, is_coaching) VALUES (?, ?, 'realtimekit', ?, ?, 'application/json', ?, NULL, 'processing', NULL, ?, ?, ?)",
  ).bind(recId, recTitle, TRANSCRIPT_MODEL, objectKey, raw.length, new Date().toISOString(), ownerId, m.is_coaching ? 1 : 0).run();
  const lastEnd = Math.max(...entries.map((e) => e.end || e.start));
  const firstStart = Math.min(...entries.map((e) => e.start));
  if (lastEnd > firstStart) {
    await env.DB.prepare("UPDATE recordings SET duration_ms = ? WHERE id = ?").bind(Math.round(lastEnd - firstStart), recId).run().catch(() => {}); // 0036 이전 DB면 건너뛴다
  }

  // 문서 만들기는 한 번만: 잠금 + doc_id 비어 있을 때.
  const now = Date.now();
  const lock = await env.DB.prepare("UPDATE recordings SET lock_until = ? WHERE id = ? AND doc_id IS NULL AND (lock_until IS NULL OR lock_until < ?)").bind(now + 180_000, recId, now).run();
  if ((lock.meta?.changes ?? 0) !== 1) return { status: "busy", recordingId: recId };

  const docTitle = recTitle;
  const header = [
    `# ${docTitle}`,
    "",
    `영상 통화 (RealtimeKit) · 시작 ${when} · 참석: ${speakers.join(", ")}${m.is_coaching ? " · 코칭" : ""} · 전사: Whisper Large v3 Turbo (화자별)`,
    "",
    "## 전사",
    "",
    "",
  ].join("\n");
  let docId: string;
  try {
    docId = await hooks.finishTranscript(env, { id: recId, title: recTitle, object_key: objectKey, owner_id: ownerId, is_coaching: m.is_coaching ? 1 : 0 }, docTitle, header + transcript, transcript);
  } finally {
    await env.DB.prepare("UPDATE recordings SET lock_until = NULL WHERE id = ?").bind(recId).run().catch(() => {});
  }
  await env.DB.prepare("UPDATE meetings SET recording_id = ?, transcript_status = 'ready', transcript_error = NULL, rtk_session_id = COALESCE(rtk_session_id, ?) WHERE id = ?")
    .bind(recId, sessionId || null, m.id).run();
  logEvent("meet.transcript_ready", { meeting_id: m.id, recording_id: recId, doc_id: docId, lines: transcript.split("\n").length, speakers: speakers.length, source });

  // 채팅방 안내 + 소유자 알림. 실패해도 전사본은 이미 들어갔다.
  const owner = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(ownerId).first<{ name: string }>();
  try {
    await postSystemMessage(env, m.room_id, `📝 영상 통화 전사본이 준비됐습니다 — "${docTitle}". ${owner?.name ?? "회의를 시작한 사람"}님의 녹음전사 목록에 저장됐고, 요약·색인은 잠시 뒤 끝납니다.`);
  } catch (e) { console.error("meet transcript chat message failed", e); }
  try {
    const nid = `meettr_${recId}`;
    const title = `영상 통화 전사본 준비됨: ${m.title}`.slice(0, 300);
    const created = new Date().toISOString();
    const r = await env.DB.prepare("INSERT OR IGNORE INTO notifications(id,user_id,type,ref_type,ref_id,title,body,link,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(nid, ownerId, "MEETING_TRANSCRIPT", "recording", recId, title, docTitle, "/#upload", created).run();
    if ((r.meta?.changes ?? 0) === 1) await pushNotification(env, ownerId, { id: nid, type: "MEETING_TRANSCRIPT", title, body: docTitle, link: "/#upload", created_at: created });
  } catch (e) { console.error("meet transcript notification failed", e); }
  return { status: "ready", recordingId: recId, docId, lines: transcript.split("\n").length };
}

/** 회의를 ended로 바꾸고 방에 meeting_ended를 알린다 (이미 ended면 아무것도 안 함). 바뀌었으면 true. */
export async function markMeetingEnded(env: MeetEnv, m: MeetingRow, opts: { sessionId?: string | null; endedAt?: string | null; reason: string }): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, ?, datetime('now')), rtk_session_id = COALESCE(?, rtk_session_id), transcript_status = CASE WHEN transcribe = 0 THEN 'off' ELSE transcript_status END WHERE id = ? AND status = 'active'",
  ).bind(opts.endedAt ? sqlTime(opts.endedAt) : null, opts.sessionId ?? null, m.id).run();
  const changed = (r.meta?.changes ?? 0) === 1;
  if (changed) {
    logEvent("meet.ended", { meeting_id: m.id, reason: opts.reason });
    try {
      const ok = await broadcastRoomEvent(env, m.room_id, { type: "meeting_ended", meeting_id: m.id, reason: opts.reason });
      logEvent("meet.card_broadcast", { meeting_id: m.id, type: "meeting_ended", ok });
    } catch (e) { console.error("meet ended broadcast failed", e); }
  }
  return changed;
}

/** ISO → SQLite datetime('now')와 같은 "YYYY-MM-DD HH:MM:SS" (비교·정렬이 섞이지 않게). */
function sqlTime(iso: string): string | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------- 15분 크론 ----------
/**
 * (1) 오래된 active 회의 정리: 시작 후 20분이 지났는데 RealtimeKit에 LIVE 세션이 없거나 회의가 없거나 INACTIVE면 ended.
 * (2) 웹훅 누락 대비: 끝났는데 전사가 안 붙은 회의(7일 안)를 세션별로 다시 조회해 가져온다.
 * RealtimeKit 미설정이면 아무것도 하지 않는다. 회의마다 실패를 따로 잡는다.
 */
export async function sweepMeetings(env: MeetEnv): Promise<{ ended: number; ingested: number; checked: number; errors: number }> {
  const out = { ended: 0, ingested: 0, checked: 0, errors: 0 };
  if (!rtkConfigured(env)) return out;
  let actives: MeetingRow[] = [];
  try {
    actives = (await env.DB.prepare(
      `SELECT * FROM meetings WHERE status = 'active' AND started_at < datetime('now', '-${STALE_ACTIVE_MIN} minutes') ORDER BY started_at LIMIT 20`,
    ).all<MeetingRow>()).results || [];
  } catch (e) { console.error("[meet] sweep: meetings table?", e instanceof Error ? e.message : String(e)); return out; }
  for (const m of actives) {
    try {
      const rtk = await getMeeting(env, m.rtk_meeting_id);
      let sessions: RtkSession[] = [];
      if (rtk) sessions = await listMeetingSessions(env, m.rtk_meeting_id);
      if (rtk && rtk.status !== "INACTIVE" && sessions.some((s) => s.status === "LIVE")) continue;
      const last = sessions[sessions.length - 1];
      if (await markMeetingEnded(env, m, { sessionId: last?.id ?? null, endedAt: last?.ended_at ?? null, reason: !rtk ? "rtk_missing" : rtk.status === "INACTIVE" ? "rtk_inactive" : "no_live_session" })) out.ended++;
    } catch (e) { out.errors++; console.error("[meet] sweep active", m.id, e instanceof Error ? e.message : String(e)); }
  }

  const pending = (await env.DB.prepare(
    `SELECT * FROM meetings WHERE status = 'ended' AND transcribe = 1 AND transcript_status IN ('none', 'available')
       AND ended_at > datetime('now', '-${KEEP_DAYS} days') AND ended_at < datetime('now', '-${TRANSCRIPT_GRACE_MIN} minutes')
       AND transcript_attempts < ${MAX_ATTEMPTS} ORDER BY ended_at LIMIT 10`,
  ).all<MeetingRow>()).results || [];
  for (const m of pending) {
    out.checked++;
    try {
      const r = await fetchMeetingTranscripts(env, m, "cron");
      out.ingested += r.ingested;
      if (r.ingested === 0 && r.status !== "empty") {
        await env.DB.prepare("UPDATE meetings SET transcript_attempts = transcript_attempts + 1, transcript_error = ?, transcript_status = CASE WHEN transcript_attempts + 1 >= ? THEN 'failed' ELSE transcript_status END WHERE id = ?")
          .bind(r.note, MAX_ATTEMPTS, m.id).run();
      }
    } catch (e) {
      out.errors++;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await env.DB.prepare("UPDATE meetings SET transcript_attempts = transcript_attempts + 1, transcript_error = ?, transcript_status = CASE WHEN transcript_attempts + 1 >= ? THEN 'failed' ELSE transcript_status END WHERE id = ?")
        .bind(msg, MAX_ATTEMPTS, m.id).run().catch(() => {});
      console.error("[meet] sweep transcript", m.id, msg);
    }
  }
  if (out.ended || out.ingested || out.errors) logEvent("meet.sweep", out);
  return out;
}

/** 회의의 끝난 세션마다 전사를 REST로 조회해 가져온다 (웹훅 없이). */
export async function fetchMeetingTranscripts(env: MeetEnv, m: MeetingRow, source: "webhook" | "cron"): Promise<{ ingested: number; status: string; note: string }> {
  let sessions: RtkSession[] = [];
  try { sessions = (await listMeetingSessions(env, m.rtk_meeting_id)).filter((s) => s.status !== "LIVE"); }
  catch (e) { if (!m.rtk_session_id) throw e; }
  if (!sessions.length && m.rtk_session_id) sessions = [{ id: m.rtk_session_id }];
  if (!sessions.length) {
    // 아무도 들어오지 않은 회의 — 전사할 것이 없다. 종료 1시간 뒤에 empty로 닫는다.
    const old = await env.DB.prepare("SELECT 1 AS x FROM meetings WHERE id = ? AND ended_at < datetime('now', '-60 minutes')").bind(m.id).first();
    if (old) { await env.DB.prepare("UPDATE meetings SET transcript_status = 'empty' WHERE id = ?").bind(m.id).run(); return { ingested: 0, status: "empty", note: "no sessions" }; }
    return { ingested: 0, status: "waiting", note: "no sessions yet" };
  }
  let ingested = 0, empty = 0, waiting = 0;
  for (const s of sessions) {
    const url = await getSessionTranscriptUrl(env, s.id);
    if (!url) { waiting++; continue; }
    const r = await ingestSessionTranscript(env, m, s.id, url, source);
    if (r.status === "ready" || r.status === "already") ingested++;
    else if (r.status === "empty") empty++;
  }
  if (!ingested && empty && !waiting) return { ingested: 0, status: "empty", note: "empty transcript" };
  return { ingested, status: ingested ? "ready" : "waiting", note: waiting ? `transcript not ready (${waiting} session)` : "" };
}

/** start가 기존 active 회의를 돌려주기 전에: RealtimeKit에 실제로 있고 INACTIVE가 아닌지 확인한다.
 *  없으면 그 행을 ended로 바꾸고 false (새로 만들어야 함). RealtimeKit 조회 자체가 실패하면 판단하지 않고 true. */
export async function isMeetingAlive(env: MeetEnv, m: MeetingRow): Promise<boolean> {
  let rtk;
  try { rtk = await getMeeting(env, m.rtk_meeting_id); }
  catch (e) { console.error("meet alive check failed", e instanceof Error ? e.message : String(e)); return true; }
  if (rtk && rtk.status !== "INACTIVE") return true;
  await markMeetingEnded(env, m, { reason: rtk ? "rtk_inactive" : "rtk_missing" });
  return false;
}
