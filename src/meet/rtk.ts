// RealtimeKit REST 호출 + 웹훅 서명 검증 (화상회의 V0, 2026-11-19).
// 문서 확인 (2026-11-19, developers.cloudflare.com/realtime/realtimekit):
//   - REST 기준 주소: https://api.cloudflare.com/client/v4/accounts/<account>/realtime/kit/<app>/...  (Authorization: Bearer <API 토큰>)
//   - 회의 생성: POST /meetings {title, transcribe_on_end, ai_config.transcription.language}
//   - 참가자 추가: POST /meetings/<id>/participants {name, preset_name, custom_participant_id} → data.token (클라이언트용 authToken)
//   - 웹훅 서명: 헤더 `rtk-signature` = 원문 본문의 RSA-SHA256(RSASSA-PKCS1-v1_5) 서명 Base64.
//     공개키는 https://api.realtime.cloudflare.com/.well-known/webhooks.json 의 data.publicKey (PEM).
//     파싱한 JSON을 다시 직렬화하지 말고 받은 바이트 그대로 검증한다.
//   - 회의 후 전사: transcribe_on_end만으로 켜진다 (문서에 녹화 필요 언급 없음). 결과는 meeting.transcript 웹훅의 transcriptDownloadUrl,
//     또는 GET /sessions/<session_id>/transcript. 종료 후 7일 보관.
// API 토큰(RTK_API_TOKEN)은 Worker 시크릿에만 있고 브라우저로 나가지 않는다.

export type RtkEnv = {
  CF_ACCOUNT_ID?: string;
  RTK_APP_ID?: string;
  RTK_API_TOKEN?: string;
  /** 호스트·참가자 프리셋 이름 (없으면 기본값). V0에서 GET /api/meet/presets로 실제 이름을 확인한다. */
  RTK_PRESET_HOST?: string;
  RTK_PRESET_PARTICIPANT?: string;
  /** 로컬 검증 전용: REST 기준 주소를 목 서버로 돌린다 (.dev.vars에만 둔다. 원격에는 설정하지 않는다). */
  RTK_DEV_API_ORIGIN?: string;
  /** 로컬 검증 전용: 웹훅 공개키 주소를 목 서버로 돌린다. */
  RTK_DEV_WEBHOOK_KEY_URL?: string;
};

export const DEFAULT_PRESET_HOST = "group_call_host";
export const DEFAULT_PRESET_PARTICIPANT = "group_call_participant";
const WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";

export class RtkError extends Error {
  /** httpStatus: RealtimeKit이 실제로 돌려준 HTTP 상태 (없으면 0). status는 우리 API가 돌려줄 상태다. */
  constructor(public status: number, message: string, public detail?: unknown, public httpStatus = 0) { super(message); }
}

export function rtkConfigured(env: RtkEnv): boolean {
  return !!(env.CF_ACCOUNT_ID && env.RTK_APP_ID && env.RTK_API_TOKEN);
}

function base(env: RtkEnv): string {
  const origin = (env.RTK_DEV_API_ORIGIN || "https://api.cloudflare.com").replace(/\/$/, "");
  return `${origin}/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`;
}

async function call<T>(env: RtkEnv, method: string, path: string, body?: unknown): Promise<T> {
  if (!rtkConfigured(env)) throw new RtkError(503, "RealtimeKit 미설정 (CF_ACCOUNT_ID·RTK_APP_ID·RTK_API_TOKEN)");
  const res = await fetch(base(env) + path, {
    method,
    headers: { authorization: `Bearer ${env.RTK_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let j: { success?: boolean; data?: unknown; errors?: unknown; error?: unknown } = {};
  try { j = JSON.parse(text); } catch { /* 본문이 JSON이 아님 */ }
  if (!res.ok || j.success === false) {
    // 오류 본문에는 토큰이 없다 (요청 헤더는 응답에 실리지 않는다). 앞부분만 남긴다.
    throw new RtkError(502,
      `RealtimeKit ${method} ${path.split("/")[1] ?? ""} 실패 (HTTP ${res.status})`,
      j.errors ?? j.error ?? text.slice(0, 300), res.status);
  }
  return j.data as T;
}

export type RtkMeeting = { id: string; title?: string; status?: string; created_at?: string };

/** 회의 생성. transcribe면 회의 후 한국어 전사를 켠다 (녹화는 켜지 않는다). */
export function createMeeting(env: RtkEnv, title: string, transcribe = true): Promise<RtkMeeting> {
  return call<RtkMeeting>(env, "POST", "/meetings", {
    title,
    transcribe_on_end: transcribe,
    ...(transcribe ? { ai_config: { transcription: { language: "ko" } } } : {}),
  });
}

/** 회의 조회 (V1 오래된 회의 정리). 없으면(404) null. status: ACTIVE | INACTIVE (INACTIVE면 아무도 못 들어간다). */
export async function getMeeting(env: RtkEnv, rtkMeetingId: string): Promise<RtkMeeting | null> {
  try {
    return await call<RtkMeeting>(env, "GET", `/meetings/${encodeURIComponent(rtkMeetingId)}`);
  } catch (e) {
    if (e instanceof RtkError && e.httpStatus === 404) return null;
    throw e;
  }
}

/** 회의를 INACTIVE로 (종료 후 재입장 막기). PATCH /meetings/<id> {status} — API 레퍼런스 확인(2026-11-19). */
export function setMeetingStatus(env: RtkEnv, rtkMeetingId: string, status: "ACTIVE" | "INACTIVE"): Promise<unknown> {
  return call<unknown>(env, "PATCH", `/meetings/${encodeURIComponent(rtkMeetingId)}`, { status });
}

export type RtkSession = { id: string; associated_id?: string; status?: string; started_at?: string; ended_at?: string; created_at?: string };

/** 회의(associated_id)의 세션 목록. 모두 나갔다 다시 들어오면 세션이 여러 개다. status: LIVE | ENDED. */
export async function listMeetingSessions(env: RtkEnv, rtkMeetingId: string): Promise<RtkSession[]> {
  const d = await call<{ sessions?: RtkSession[] }>(env, "GET", `/sessions?associated_id=${encodeURIComponent(rtkMeetingId)}&per_page=50&sort_by=createdAt&sort_order=ASC`);
  return Array.isArray(d?.sessions) ? d.sessions : [];
}

/** 세션 전사 내려받기 주소 (JSON 형식). 아직 없으면(404) null. 응답: {sessionId, transcript_download_url, transcript_download_url_expiry}. */
export async function getSessionTranscriptUrl(env: RtkEnv, sessionId: string): Promise<string | null> {
  try {
    const d = await call<{ transcript_download_url?: string }>(env, "GET", `/sessions/${encodeURIComponent(sessionId)}/transcript?format=JSON`);
    return typeof d?.transcript_download_url === "string" && d.transcript_download_url ? d.transcript_download_url : null;
  } catch (e) {
    if (e instanceof RtkError && e.httpStatus === 404) return null;
    throw e;
  }
}

export type RtkParticipant = { id: string; token: string; preset_name: string; custom_participant_id: string; name?: string };

/** 참가자 추가 → 클라이언트 authToken. custom_participant_id = People OS 사용자 id (전사 화자 복원용). */
export async function addParticipant(
  env: RtkEnv, rtkMeetingId: string, p: { name: string; preset_name: string; custom_participant_id: string },
): Promise<RtkParticipant> {
  const d = await call<RtkParticipant>(env, "POST", `/meetings/${encodeURIComponent(rtkMeetingId)}/participants`, p);
  if (!d || typeof d.token !== "string" || !d.token) throw new RtkError(502, "RealtimeKit 참가 토큰이 응답에 없습니다");
  return d;
}

/** 앱의 프리셋 목록 (V0 프리셋 이름 확인용). */
export function listPresets(env: RtkEnv): Promise<unknown> {
  return call<unknown>(env, "GET", "/presets");
}

/** 등록된 웹훅 목록 (V0 확인용). */
export function listWebhooks(env: RtkEnv): Promise<unknown> {
  return call<unknown>(env, "GET", "/webhooks");
}

// ---- 웹훅 서명 검증 ----
let cachedKey: { url: string; key: CryptoKey; at: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function webhookKey(env: RtkEnv, force = false): Promise<CryptoKey> {
  const url = env.RTK_DEV_WEBHOOK_KEY_URL || WEBHOOK_KEY_URL;
  if (!force && cachedKey && cachedKey.url === url && Date.now() - cachedKey.at < KEY_TTL_MS) return cachedKey.key;
  const res = await fetch(url);
  if (!res.ok) throw new RtkError(502, `웹훅 공개키를 가져오지 못했습니다 (HTTP ${res.status})`);
  const j = await res.json<{ data?: { publicKey?: string } }>();
  const pem = j?.data?.publicKey;
  if (!pem) throw new RtkError(502, "웹훅 공개키 응답에 data.publicKey가 없습니다");
  const der = b64ToBytes(pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, ""));
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  cachedKey = { url, key, at: Date.now() };
  return key;
}

/** 원문 본문 바이트와 rtk-signature 헤더로 서명을 검증한다.
 *  키가 바뀌었을 수 있으니 실패하면 키를 새로 받아 한 번 재시도한다 — 단, 캐시가 5분 이상 됐을 때만 (위조 요청으로 키 재조회를 남발시키지 않게). */
export async function verifyWebhookSignature(env: RtkEnv, raw: ArrayBuffer, signature: string | undefined | null): Promise<boolean> {
  if (!signature) return false;
  let sig: Uint8Array;
  try { sig = b64ToBytes(signature); } catch { return false; }
  const alg = { name: "RSASSA-PKCS1-v1_5" };
  if (await crypto.subtle.verify(alg, await webhookKey(env), sig, raw)) return true;
  if (cachedKey && Date.now() - cachedKey.at < 5 * 60 * 1000) return false;
  return crypto.subtle.verify(alg, await webhookKey(env, true), sig, raw);
}
