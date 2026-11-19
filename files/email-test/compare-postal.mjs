// 우리 mime.ts vs postal-mime 2.6.1 비교 (판단 근거용, 배포 안 함).
// 실행: npm install --no-save postal-mime@2.6.1
//       npx wrangler dev --local -c files/email-test/wrangler-compare.toml --port 8798 → curl 127.0.0.1:8798/
import PostalMime from "postal-mime";
import { parseEmail } from "../../src/email/mime.ts";
import T1 from "./t1.eml";
import T2 from "./t2.eml";

const enc = (s) => new TextEncoder().encode(s);
const bin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin = (bytes) => String.fromCharCode(...bytes);
const b64 = (bytes) => btoa(latin(bytes));
const EUCKR = [0xc8, 0xde, 0xb0, 0xa1]; // "휴가"

const cases = {
  t1: enc(T1),
  t2: enc(T2),
  splitB: enc(`Subject: =?UTF-8?B?${b64(enc("휴가 신청").subarray(0, 4))}?= =?UTF-8?B?${b64(enc("휴가 신청").subarray(4))}?=\r\n\r\nx`),
  splitEucKr: enc(`Subject: =?ks_c_5601-1987?B?${b64(EUCKR.slice(0, 1))}?= =?ks_c_5601-1987?B?${b64(EUCKR.slice(1))}?=\r\n\r\nx`),
  cp949: bin(`Subject: =?cp949?B?${b64(EUCKR)}?=\r\nContent-Type: text/plain; charset=cp949\r\n\r\n` + latin(EUCKR)),
  eightBitHeaders: bin("Subject: " + latin(EUCKR) + "\r\n" + 'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
    "--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n" +
    '--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="' + latin(enc("휴가.pdf")) + '"\r\n\r\nX\r\n' +
    '--B\r\nContent-Type: application/pdf; name="' + latin(EUCKR) + '.pdf"\r\n\r\nY\r\n--B--\r\n'),
  prefixBoundary: enc('Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: multipart/alternative; boundary="b1_alt"\r\n\r\n' +
    "--b1_alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n본문 텍스트\r\n--b1_alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>본문</p>\r\n" +
    '--b1_alt--\r\n--b1\r\nContent-Type: text/csv; name="a.csv"\r\n\r\nx,y\r\n--b1--\r\nepilogue\r\n'),
  missingClose: enc("Content-Type: multipart/mixed; boundary=XYZ\r\n\r\n--XYZ  \r\n\r\nplain part\r\n" +
    "--XYZ\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nab=  \r\ncd\r\n"),
  // --- 추가 엣지 ---
  flowed: enc("Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\r\n\r\n긴 문장이 \r\n이어집니다.\r\n>인용 \r\n>계속\r\n From 줄\r\n"),
  eucKrNoCharset: bin("Subject: x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + latin(EUCKR)),
  rfc822: enc('Content-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n전달합니다\r\n' +
    "--M\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: text/plain\r\n\r\ninner body\r\n--M--\r\n"),
  ctrlFilename: enc('Content-Type: multipart/mixed; boundary="C"\r\n\r\n--C\r\nContent-Type: text/plain\r\n\r\nb\r\n' +
    '--C\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="../../etc/pa\tss.txt"\r\n\r\nZ\r\n--C--\r\n'),
};

const short = (s) => (typeof s === "string" ? s.slice(0, 80) : s);
async function run() {
const out = [];
const console = { log: (s) => out.push(s) };
for (const [name, raw] of Object.entries(cases)) {
  const ours = parseEmail(raw);
  const pm = await PostalMime.parse(raw);
  const row = {
    subject: [ours.subject, pm.subject],
    text: [short(ours.text), short((pm.text || "").trim())],
    html: [short(ours.html), short((pm.html || "").trim())],
    atts: [ours.attachments.map((a) => `${a.filename}|${a.contentType}|${a.inline ? "inline" : "att"}`),
      pm.attachments.map((a) => `${a.filename}|${a.mimeType}|${a.disposition}`)],
  };
  console.log(`\n== ${name}`);
  for (const [k, [a, b]] of Object.entries(row)) {
    const same = JSON.stringify(a) === JSON.stringify(b);
    console.log(`  ${same ? "  " : "≠ "}${k}: ours=${JSON.stringify(a)}${same ? "" : `  postal=${JSON.stringify(b)}`}`);
  }
}
return out.join("\n");
}

export default {
  async fetch() {
    return new Response((await run()) + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
