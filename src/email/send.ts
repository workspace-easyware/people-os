// 메일 발송 (2026-11-17): Resend HTTP API.
// Workers는 SMTP(25번)를 쓸 수 없어 HTTP API로만 보낸다. 키는 env.RESEND_API_KEY(시크릿)에서만 읽는다.
// 키가 없으면 ResendNotConfigured를 던진다 — 라우트가 503 "Resend 미설정"으로 바꾼다 (fail-closed).

export const EMAIL_DOMAIN = "peopleos.site";
const RESEND_URL = "https://api.resend.com/emails";

export class ResendNotConfigured extends Error {
  constructor() { super("Resend 미설정: RESEND_API_KEY 시크릿이 없습니다."); }
}

export type SendInput = {
  from: string; // "이름 <local@peopleos.site>" 또는 "local@peopleos.site"
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>; // In-Reply-To / References (답장 스레딩)
};

export type SendResult = { id: string };

export async function sendEmail(env: { RESEND_API_KEY?: string }, input: SendInput): Promise<SendResult> {
  if (!env.RESEND_API_KEY) throw new ResendNotConfigured();
  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
  };
  if (input.cc && input.cc.length) body.cc = input.cc;
  if (input.html) body.html = input.html;
  if (input.replyTo) body.reply_to = input.replyTo;
  if (input.headers && Object.keys(input.headers).length) body.headers = input.headers;
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const textOut = await res.text();
  let json: { id?: string; message?: string; name?: string } = {};
  try { json = JSON.parse(textOut); } catch { /* 비JSON 오류 본문 */ }
  if (!res.ok || !json.id) {
    throw new Error(`Resend 발송 실패 (${res.status}): ${json.message || json.name || textOut.slice(0, 200)}`);
  }
  return { id: json.id };
}

// 보안점검(2026-11-22) Medium: 사용자 1명이 24시간 동안 보낼 수 있는 메일 수 (메일함 발송 + 워크플로우 send_email 합산).
// 이전에는 상한이 없어 계정 하나(또는 탈취된 세션)가 회사 도메인으로 메일을 무제한 보낼 수 있었다.
// 보낸 메일은 두 경로 모두 emails(direction='out', owner_id)에 남으므로 그 행 수로 센다. 일정 알림·결재 알림(시스템 발신)은 세지 않는다.
export const DAILY_SEND_LIMIT = 200;

/** 하루 발송 상한을 넘었으면 true. 세는 쿼리가 실패하면 보내지 않는다 (fail-closed). */
export async function dailySendLimitReached(db: D1Database, ownerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM emails WHERE owner_id = ? AND direction = 'out' AND created_at > ?")
    .bind(ownerId, since).first<{ n: number }>();
  return (row?.n ?? 0) >= DAILY_SEND_LIMIT;
}

/** 사용자 이메일 앞자리 → 발신 로컬 파트 (영숫자·.-_만). */
export function localPartFor(email: string): string {
  const lp = (email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9._\-]/g, "");
  return lp || "noreply";
}
