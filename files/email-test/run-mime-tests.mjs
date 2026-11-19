// MIME 파서 회귀 테스트 — workerd(실제 런타임의 TextDecoder)에서 돌린다.
// 실행: npx wrangler dev --local -c files/email-test/wrangler.toml --port 8799
//       → curl http://127.0.0.1:8799/  (200 = ALL PASS, 500 = 실패 목록)
import { parseEmail, normalizeSubject, decodeWords } from "../../src/email/mime.ts";
import T1 from "./t1.eml";
import T2 from "./t2.eml";

export function runCases() {
  const log = [];
  let fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    log.push(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
  };
  const enc = (s) => new TextEncoder().encode(s);
  const bin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const latin = (bytes) => String.fromCharCode(...bytes);
  const b64 = (bytes) => btoa(latin(bytes));
  const EUCKR_HYUGA = [0xc8, 0xde, 0xb0, 0xa1]; // "휴가"

  // --- 기존 케이스 (직전 세션) ---
  const t1 = parseEmail(enc(T1));
  eq("t1 from (B 인코딩 이름)", t1.from, "홍길동 <hong@example.com>");
  eq("t1 subject", t1.subject, "연차 신청 문의");
  eq("t1 text (EUC-KR QP, 소프트 줄바꿈)", t1.text, "안녕하세요. 연차 3일 신청합니다.");
  eq("t1 html 포함", t1.html.includes("<b>연차 3일</b>"), true);
  eq("t1 첨부 파일명 (RFC 2231)", t1.attachments.map((a) => a.filename), ["휴가신청서.pdf"]);
  eq("t1 messageId", t1.messageId, "<t1-abc@example.com>");

  const t2 = parseEmail(enc(T2));
  eq("t2 inReplyTo", t2.inReplyTo, "<t1-abc@example.com>");
  eq("t2 references", t2.references, ["<t1-abc@example.com>"]);
  eq("t2 스레딩 제목 정규화", normalizeSubject(t2.subject), normalizeSubject(t1.subject));
  eq("t2 8bit utf-8 본문", t2.text, "답장 테스트입니다.");

  // --- 새 엣지 케이스 ---
  // 1) 한글 글자가 두 인코딩 단어에 나뉘어 담긴 제목
  {
    const bytes = enc("휴가 신청");
    eq("분할 인코딩 단어 (UTF-8 B)", decodeWords(`=?UTF-8?B?${b64(bytes.subarray(0, 4))}?= =?UTF-8?B?${b64(bytes.subarray(4))}?=`), "휴가 신청");
    const q = [...enc("휴가")].map((x) => "=" + x.toString(16).toUpperCase()).join("");
    eq("분할 인코딩 단어 (UTF-8 Q)", decodeWords(`=?utf-8?Q?${q.slice(0, 6)}?=\r\n =?utf-8?Q?${q.slice(6)}?=`), "휴가");
    eq("분할 인코딩 단어 (EUC-KR B)",
      decodeWords(`=?ks_c_5601-1987?B?${b64(EUCKR_HYUGA.slice(0, 1))}?= =?ks_c_5601-1987?B?${b64(EUCKR_HYUGA.slice(1))}?=`), "휴가");
    eq("인코딩 단어 + 일반 텍스트 공백 보존", decodeWords(`Re: =?UTF-8?B?${b64(enc("휴가"))}?= 건`), "Re: 휴가 건");
    eq("다른 charset 인접 단어", decodeWords(`=?UTF-8?B?${b64(enc("가"))}?= =?euc-kr?B?${b64(EUCKR_HYUGA)}?=`), "가휴가");
  }
  // 2) cp949 라벨 (TextDecoder 미지원 라벨)
  {
    const p = parseEmail(bin(`Subject: =?cp949?B?${b64(EUCKR_HYUGA)}?=\r\nContent-Type: text/plain; charset=cp949\r\n\r\n` + latin(EUCKR_HYUGA)));
    eq("cp949 제목", p.subject, "휴가");
    eq("cp949 본문", p.text, "휴가");
  }
  // 3) 8비트 원문 헤더/파일명
  {
    const p = parseEmail(bin(
      "Subject: " + latin(EUCKR_HYUGA) + "\r\n" +
      'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
      "--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n" +
      '--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="' + latin(enc("휴가.pdf")) + '"\r\n\r\nX\r\n' +
      '--B\r\nContent-Type: application/pdf; name="' + latin(EUCKR_HYUGA) + '.pdf"\r\n\r\nY\r\n' +
      "--B--\r\n"));
    eq("8비트 EUC-KR 제목", p.subject, "휴가");
    eq("8비트 파일명 (UTF-8 / EUC-KR)", p.attachments.map((a) => a.filename), ["휴가.pdf", "휴가.pdf"]);
  }
  // 4) 인코딩 단어 파일명
  {
    const p = parseEmail(enc(
      'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
      `--B\r\nContent-Type: application/pdf; name="=?UTF-8?B?${b64(enc("휴가신청서.pdf"))}?="\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\nSlZCRVJp\r\n` +
      "--B--\r\n"));
    eq("인코딩 단어 파일명", p.attachments[0].filename, "휴가신청서.pdf");
  }
  // 5) 바깥 boundary가 안쪽 boundary의 접두사
  {
    const p = parseEmail(enc(
      'Content-Type: multipart/mixed; boundary="b1"\r\n\r\n' +
      '--b1\r\nContent-Type: multipart/alternative; boundary="b1_alt"\r\n\r\n' +
      "--b1_alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n본문 텍스트\r\n" +
      "--b1_alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>본문</p>\r\n" +
      "--b1_alt--\r\n" +
      '--b1\r\nContent-Type: text/csv; name="a.csv"\r\n\r\nx,y\r\n' +
      "--b1--\r\nepilogue\r\n"));
    eq("접두사 boundary: text", p.text, "본문 텍스트");
    eq("접두사 boundary: html", p.html, "<p>본문</p>");
    eq("접두사 boundary: 첨부", p.attachments.map((a) => [a.filename, latin(a.content)]), [["a.csv", "x,y"]]);
  }
  // 6) 헤더 없는 파트, 종료 구분선 누락, 구분선 뒤 공백, QP 소프트 줄바꿈 뒤 공백
  {
    const p = parseEmail(enc(
      "Content-Type: multipart/mixed; boundary=XYZ\r\n\r\n" +
      "--XYZ  \r\n\r\nplain part\r\n" +
      "--XYZ\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nab=  \r\ncd\r\n"));
    eq("헤더 없는 파트 + 종료선 누락 + QP 공백", p.text, "plain part\n\nabcd");
  }
  // 7) Content-Disposition 없이 Content-ID만 있는 이미지 → inline
  {
    const a = parseEmail(enc(
      'Content-Type: multipart/related; boundary="R"\r\n\r\n' +
      '--R\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src="cid:img1">\r\n' +
      "--R\r\nContent-Type: image/png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n" +
      "--R--\r\n")).attachments[0];
    eq("CID 이미지 inline", [a.contentId, a.inline], ["img1", true]);
  }

  // --- Agentic Inbox/postal-mime 비교에서 나온 케이스 (2026-11-17) ---
  // 8) format=flowed (delsp=yes / no) + space-stuffing + 서명 구분선
  {
    const p = parseEmail(enc("Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\r\n\r\n긴 문장이 \r\n이어집니다.\r\n>인용 \r\n>계속\r\n From 줄\r\n"));
    eq("flowed delsp=yes", p.text, "긴 문장이이어집니다.\n> 인용계속\nFrom 줄");
    const q = parseEmail(enc('Content-Type: text/plain; charset="utf-8"; format="flowed"\r\n\r\nHello \r\nworld\r\n-- \r\nsig\r\n'));
    eq("flowed delsp=no + 서명", q.text, "Hello world\n-- \nsig");
    const r = parseEmail(enc("Content-Type: text/plain; charset=utf-8\r\n\r\nkeep \r\nlines\r\n"));
    eq("flowed 아닌 본문은 그대로", r.text, "keep \r\nlines");
  }
  // 9) charset 없는(또는 us-ascii) 8비트 EUC-KR 본문
  {
    const p = parseEmail(bin("Content-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + latin(EUCKR_HYUGA)));
    eq("charset 없는 EUC-KR 본문", p.text, "휴가");
    const q = parseEmail(bin("Content-Type: text/plain; charset=us-ascii\r\n\r\n" + latin(enc("휴가"))));
    eq("us-ascii 라벨의 UTF-8 본문", q.text, "휴가");
  }
  // 10) 첨부 파일명 제어문자·경로 구분자 정리
  {
    const p = parseEmail(enc('Content-Type: multipart/mixed; boundary="C"\r\n\r\n--C\r\nContent-Type: text/plain\r\n\r\nb\r\n' +
      '--C\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="../../etc/pa\tss.txt"\r\n\r\nZ\r\n--C--\r\n'));
    eq("파일명 정리", p.attachments[0].filename, ".._.._etc_pa_ss.txt");
  }

  log.push(fail ? `\n${fail} FAILED` : "\nALL PASS");
  return { fail, out: log.join("\n") };
}

export default {
  fetch() {
    const { fail, out } = runCases();
    return new Response(out + "\n", { status: fail ? 500 : 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
