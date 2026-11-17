// 메일 수신 (2026-11-17): Cloudflare Email Routing(peopleos.site catch-all) → Worker email() 핸들러.
// 순서 (소실 방지):
//   1) 원문을 R2 emails/<id>/raw.eml에 먼저 저장 (이것만 성공해도 메일은 남는다)
//   2) 파싱 → 수신자 로컬 파트로 owner_id 결정 → 스레드 결정
//   3) 첨부를 R2 emails/<id>/att/<attId>에 저장, D1 emails/email_attachments에 기록
//   파싱이 실패하면 envelope·헤더만으로 행을 만들고 parse_error를 남긴다.
// Agentic Inbox의 DO-per-mailbox 대신 공유 D1 + owner_id (개인 RAG와 같은 격리 원칙).
import { uid } from "../lib";
import { EMAIL_DOMAIN } from "./send";
import { extractAddresses, normalizeSubject, parseEmail } from "./mime";

export type EmailEnv = { DB: D1Database; FILES: R2Bucket };

const MAX_BODY_CHARS = 400_000; // D1 행 크기 여유 (원문은 R2에 그대로 있다)
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** 수신 주소 → owner_id. `local(+tag)@peopleos.site`의 local을 사용자 이메일 앞자리와 맞춘다. 0명·여러 명이면 null. */
export async function resolveOwner(env: EmailEnv, rcpt: string): Promise<string | null> {
  const addr = (rcpt || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = addr.slice(at + 1);
  if (domain !== EMAIL_DOMAIN) return null;
  const local = addr.slice(0, at).split("+")[0];
  if (!local) return null;
  const rows = await env.DB.prepare(
    "SELECT id FROM users WHERE status = 'active' AND (lower(email) = ? OR lower(substr(email, 1, instr(email, '@') - 1)) = ?) LIMIT 2",
  ).bind(`${local}@${domain}`, local).all<{ id: string }>();
  const list = rows.results || [];
  return list.length === 1 ? list[0].id : null;
}

/** 스레드 결정: In-Reply-To/References → 같은 owner의 기존 메일 thread_id. 없으면 답장 접두가 있는 제목으로 폴백.
 *  제목 폴백은 Agentic Inbox findThreadBySubject처럼 발신자가 그 스레드 참여자(보낸·받은·참조)일 때만 묶는다 —
 *  "Re: 회의" 같은 흔한 제목의 무관한 메일이 남의 스레드에 붙지 않게. */
export async function resolveThread(
  env: Pick<EmailEnv, "DB">,
  ownerId: string | null,
  refs: string[],
  subject: string,
  fallbackId: string,
  fromAddr = "",
): Promise<{ threadId: string; subjectNorm: string }> {
  const subjectNorm = normalizeSubject(subject);
  const ids = [...new Set(refs.filter(Boolean))].slice(-20);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const row = await env.DB.prepare(
      `SELECT thread_id FROM emails WHERE owner_id IS ? AND message_id IN (${ph}) AND thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 1`,
    ).bind(ownerId, ...ids).first<{ thread_id: string }>();
    if (row?.thread_id) return { threadId: row.thread_id, subjectNorm };
  }
  const isReply = subjectNorm && subjectNorm !== (subject || "").trim().replace(/\s+/g, " ").toLowerCase();
  const sender = extractAddresses(fromAddr)[0] || "";
  if (isReply && sender) {
    const like = "%" + sender.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const row = await env.DB.prepare(
      `SELECT t.thread_id FROM emails t
       WHERE t.owner_id IS ? AND t.subject_norm = ? AND t.thread_id IS NOT NULL AND t.received_at > ?
         AND EXISTS (SELECT 1 FROM emails p WHERE p.thread_id = t.thread_id AND p.owner_id IS t.owner_id
           AND (lower(p.from_addr) LIKE ? ESCAPE '\\' OR lower(p.to_addr) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.cc, '')) LIKE ? ESCAPE '\\'))
       ORDER BY t.received_at DESC LIMIT 1`,
    ).bind(ownerId, subjectNorm, new Date(Date.now() - 30 * 86400_000).toISOString(), like, like, like).first<{ thread_id: string }>();
    if (row?.thread_id) return { threadId: row.thread_id, subjectNorm };
  }
  return { threadId: fallbackId, subjectNorm };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type IngestResult = { id: string; ownerId: string | null; threadId: string; attachments: number; parseError?: string };

/**
 * 원문 1건을 저장한다. email() 핸들러와 관리자 테스트 주입 경로(/api/email/admin/ingest)가 함께 쓴다.
 * envelopeFrom/To는 SMTP envelope (Email Routing이 준 값). 헤더 To와 다를 수 있다(BCC·포워딩).
 */
export async function ingestRawEmail(
  env: EmailEnv,
  raw: Uint8Array,
  envelope: { from: string; to: string },
): Promise<IngestResult> {
  const id = uid("em");
  const rawKey = `emails/${id}/raw.eml`;
  // 1) 원문 먼저. 실패하면 throw — Email Routing이 보낸 쪽에 임시 실패로 알리게 한다.
  await env.FILES.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { envelopeFrom: envelope.from.slice(0, 200), envelopeTo: envelope.to.slice(0, 200) },
  });

  const now = new Date().toISOString();
  const ownerId = await resolveOwner(env, envelope.to).catch(() => null);

  let parsed: ReturnType<typeof parseEmail> | null = null;
  let parseError: string | undefined;
  try {
    parsed = parseEmail(raw);
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  const subject = parsed?.subject || "";
  const messageId = parsed?.messageId || `<${id}@${EMAIL_DOMAIN}>`;
  const refs = parsed ? [...parsed.references, parsed.inReplyTo] : [];
  const { threadId, subjectNorm } = await resolveThread(env, ownerId, refs, subject, id, parsed?.from || envelope.from)
    .catch(() => ({ threadId: id, subjectNorm: normalizeSubject(subject) }));

  // 3) 첨부 → R2. 첨부 하나가 실패해도 나머지와 본문은 저장한다.
  const attRows: { id: string; filename: string; contentType: string; size: number; key: string }[] = [];
  for (const a of parsed?.attachments || []) {
    const attId = uid("ea");
    const key = `emails/${id}/att/${attId}`;
    try {
      await env.FILES.put(key, a.content, {
        httpMetadata: { contentType: a.contentType || "application/octet-stream" },
        customMetadata: { filename: a.filename.slice(0, 200) },
      });
      attRows.push({ id: attId, filename: a.filename.slice(0, 255), contentType: a.contentType, size: a.content.byteLength, key });
    } catch (e) {
      parseError = (parseError ? parseError + "; " : "") + `attachment ${a.filename}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO emails (id, owner_id, direction, from_addr, to_addr, cc, subject, body_text, body_html, received_at,
         message_id, thread_id, subject_norm, is_read, is_starred, labels, raw_r2_key, raw_size, parse_error, created_at)
       VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?)`,
    ).bind(
      id, ownerId,
      (parsed?.from || envelope.from).slice(0, 1000),
      (parsed?.to || envelope.to).slice(0, 2000),
      parsed?.cc ? parsed.cc.slice(0, 2000) : null,
      subject.slice(0, 1000),
      parsed ? parsed.text.slice(0, MAX_BODY_CHARS) : null,
      parsed?.html ? parsed.html.slice(0, MAX_BODY_CHARS) : null,
      now, messageId, threadId, subjectNorm,
      rawKey, raw.byteLength, parseError ?? null, now,
    ),
    ...attRows.map((a) =>
      env.DB.prepare("INSERT INTO email_attachments (id, email_id, filename, content_type, size, r2_key) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(a.id, id, a.filename, a.contentType, a.size, a.key)),
  ];
  await env.DB.batch(stmts);
  return { id, ownerId, threadId, attachments: attRows.length, parseError };
}

/** Worker email() 핸들러 본체. */
export async function handleInboundEmail(message: ForwardableEmailMessage, env: EmailEnv): Promise<void> {
  // 크기 제한 (Agentic Inbox와 같은 25MB): 읽기 전에 거절해 메모리·R2를 쓰지 않는다. 보낸 쪽은 반송을 받는다.
  if (message.rawSize > MAX_RAW_BYTES) {
    console.log("[email] rejected: too large", message.rawSize);
    message.setReject(`Message exceeds ${MAX_RAW_BYTES / 1024 / 1024} MB limit`);
    return;
  }
  const raw = await readAll(message.raw);
  try {
    const r = await ingestRawEmail(env, raw, { from: message.from, to: message.to });
    console.log("[email] stored", JSON.stringify({ id: r.id, owner: r.ownerId ? "user" : "unassigned", att: r.attachments, parseError: r.parseError || null }));
  } catch (e) {
    // R2 원문 저장 전 실패면 throw해 Email Routing이 임시 실패로 처리하게 한다.
    // R2 저장 후 D1만 실패한 경우에도 원문은 emails/<id>/raw.eml에 남아 있다 (로그로 추적).
    console.log("[email] ingest failed:", e instanceof Error ? e.message : String(e), "from", extractAddresses(message.from)[0] || "?");
    throw e;
  }
}
