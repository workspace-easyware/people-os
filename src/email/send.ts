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

/** 사용자 이메일 앞자리 → 발신 로컬 파트 (영숫자·.-_만). */
export function localPartFor(email: string): string {
  const lp = (email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9._\-]/g, "");
  return lp || "noreply";
}
