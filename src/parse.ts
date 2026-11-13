// C5 Phase 3: 업로드 문서 파서 라우팅.
// 형식 판별은 확장자가 아니라 앞부분 바이트(매직 바이트)로 한다 (계획서 C5).
// 순수 함수만 모아 두어 Node에서도 단위 테스트할 수 있다.
// - HWPX는 Worker 안에서 zip을 풀어 section XML에서 텍스트를 뽑는다
//   (toMarkdown은 HWPX를 지원하지 않는다 — 공식 지원 형식 목록 확인).
// - PDF·DOCX·XLSX·이미지는 Workers AI toMarkdown()으로 변환한다.
// - HWP 5.0 바이너리(OLE2)는 공모전 범위 밖이라 변환하지 않는다.
import { unzipSync } from "fflate";

export type DocFormat = "pdf" | "ooxml" | "hwpx" | "ole" | "image" | "markup" | "text" | "unknown";

export interface DetectedFormat {
  format: DocFormat;
  /** 사람이 읽는 판별 근거 (에러·로그용) */
  detail: string;
  /** zip일 때만: 푼 엔트리. HWPX 판별·추출에서 재사용해 두 번 풀지 않는다. */
  zipEntries?: Record<string, Uint8Array>;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE2 복합 문서
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06]; // PK\x05\x06 (빈 zip)
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]; // GIF8
const BMP_MAGIC = [0x42, 0x4d]; // BM
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]; // WEBP (offset 8)

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/**
 * 앞부분 바이트로 문서 형식을 판별한다. 확장자는 보지 않는다.
 * zip은 한 번만 풀어 엔트리 목록으로 HWPX/OOXML을 가린다 (추출에서 재사용).
 */
export function detectDocumentFormat(bytes: Uint8Array): DetectedFormat {
  if (bytes.length === 0) return { format: "unknown", detail: "빈 파일입니다" };
  if (startsWith(bytes, PDF_MAGIC)) return { format: "pdf", detail: "PDF (%PDF 매직 바이트)" };
  if (startsWith(bytes, OLE_MAGIC)) return { format: "ole", detail: "OLE2 복합 문서 (HWP 5.0 / 구형 Office)" };
  if (
    startsWith(bytes, JPEG_MAGIC) ||
    startsWith(bytes, PNG_MAGIC) ||
    startsWith(bytes, GIF_MAGIC) ||
    startsWith(bytes, BMP_MAGIC) ||
    (startsWith(bytes, RIFF_MAGIC) && bytes.length >= 12 && startsWith(bytes.subarray(8), WEBP_MAGIC))
  ) {
    return { format: "image", detail: "이미지 (매직 바이트)" };
  }
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, ZIP_EMPTY_MAGIC)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      return { format: "unknown", detail: "zip 파일이 손상돼 풀 수 없습니다" };
    }
    const names = Object.keys(entries);
    const mime = entries["mimetype"];
    if (mime) {
      const mimeText = new TextDecoder("utf-8").decode(mime).trim();
      if (mimeText === "application/hwp+zip") {
        return { format: "hwpx", detail: "HWPX (mimetype=application/hwp+zip)", zipEntries: entries };
      }
    }
    // mimetype이 없어도 content.hpf + section XML이 있으면 HWPX로 본다 (방어적).
    const hasHpf = names.some((n) => n.toLowerCase() === "contents/content.hpf");
    const hasSection = names.some((n) => /^Contents\/section\d+\.xml$/i.test(n));
    if (hasHpf && hasSection) {
      return { format: "hwpx", detail: "HWPX (Contents/content.hpf + section XML)", zipEntries: entries };
    }
    if (names.some((n) => n === "[Content_Types].xml")) {
      return { format: "ooxml", detail: "Office Open XML ([Content_Types].xml)", zipEntries: entries };
    }
    return { format: "unknown", detail: "지원하지 않는 zip 파일입니다 (HWPX·DOCX·XLSX가 아닙니다)" };
  }
  // 텍스트 계열: UTF-8로 디코딩되면 텍스트, 아니면 판별 불가.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { format: "unknown", detail: "파일 형식을 판별할 수 없습니다" };
  }
  if (text.includes("\0")) return { format: "unknown", detail: "파일 형식을 판별할 수 없습니다" };
  const head = text.replace(/^\uFEFF/, "").trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<html")) {
    return { format: "markup", detail: "XML/HTML/SVG 문서" };
  }
  return { format: "text", detail: "텍스트 (UTF-8)" };
}

/** UTF-8 텍스트 디코딩 (BOM 제거). detectDocumentFormat이 text로 판별한 파일에만 쓴다. */
export function decodePlainText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

/** XML 엔티티 디코딩 (&amp; &lt; &gt; &quot; &apos; &#...; &#x...;). */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const cp = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
    }
  });
}

/**
 * HWPX에서 텍스트를 추출한다. detectDocumentFormat이 돌려준 zipEntries를 받는다.
 * - `Contents/sectionN.xml`을 숫자 순서대로 읽는다 (머리말·꼬리말은 제외, 본문만).
 * - 문단은 `</hp:p>` 기준, 표 셀은 `</hp:tc>` 기준으로 나눈다. 셀 안 텍스트는
 *   공백으로 잇는다. 텍스트 런은 `<hp:t>` 내용만 모은다 (제N조 마커는
 *   hp:t 안의 평문이라 그대로 살아남아 조문 단위 청킹이 된다).
 * - XML 파서는 Workers에 없어 정규식으로 뽑는다. hp:t는 PCDATA만 담으므로 안전하다.
 */
export function extractHwpxText(entries: Record<string, Uint8Array>): string {
  const sectionNames = Object.keys(entries)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/section(\d+)\.xml$/i)?.[1] ?? "0", 10);
      const nb = parseInt(b.match(/section(\d+)\.xml$/i)?.[1] ?? "0", 10);
      return na - nb;
    });
  const paras: string[] = [];
  for (const name of sectionNames) {
    const xml = new TextDecoder("utf-8").decode(entries[name]);
    for (const pChunk of xml.split(/<\/hp:p>/i)) {
      const cellTexts = pChunk
        .split(/<\/hp:tc>/i)
        .map((cell) => {
          const runs = [...cell.matchAll(/<hp:t[^>]*>([^<]*)<\/hp:t>/gi)].map((m) => decodeXmlEntities(m[1]));
          return runs.join("");
        })
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (cellTexts.length) paras.push(cellTexts.join(" "));
    }
  }
  return paras.join("\n\n");
}
