// 큰 파일 문서 작업의 "예상 CPU" 계산 (2026-11-22, 큰 덱·워크북·문서 Queue 처리).
// 구조화 문서 작업(ops·정의만 주는 편집·생성)은 보통 수십~수백 ms지만, 파일이 크면 수 초가 걸린다 (실측은 아래).
// 요청을 받자마자 — AI도 편집 Worker도 부르지 않고 — 이 작업이 얼마나 무거울지 가늠해서,
// 가벼우면 예전처럼 바로 201, 무거우면 작업 행 + Queue(src/doc-jobs.ts)로 넘긴다.
//
// 재는 값: OOXML 파일은 ZIP이라 맨 끝의 중앙 디렉터리에 부품마다 "압축을 푼 크기"가 적혀 있다. 압축을 풀지 않고 그 숫자만 읽는다 (CPU 거의 0).
// 파일 크기 자체는 쓸 수 없다 — 문단 5,200개 문서가 37 KB, 10만 셀 워크북이 508 KB로 줄어든다 (같은 글이 반복되면 더 줄어든다).
// 편집 CPU의 대부분은 XML을 읽고 다시 쓰는 일이라 풀린 XML 크기에 비례한다.
//
// 보정 근거 (원격 wrangler tail cpuTime, 각 RESULT.md):
// - DOCX: 문단 17개 133~189 ms / 1,040개 1,235 ms / 5,200개 4,385~4,758 ms (op 수와는 거의 무관)
// - XLSX: 9 ops 작은 워크북 175 ms / 100,003셀(508 KB) 3,975 ms
// - PPTX: 3장 덱 text 2개 682 ms, text 2 + 복제 1 → 1,566 ms. text op는 op마다 덱을 다시 읽고 써서 op 1개에 0.3~0.5초
// - DOCX 생성: 1,910블록 281 ms, 이미지 10 MiB를 넣으면 0.6~3.2초
// 계수는 아래 상수. 라이브에서 다시 잰 값은 files/workflow-verify/docx-large-queue/RESULT.md에 있다.

export type DocLoadKind = "pptx_edit" | "xlsx_edit" | "docx_edit" | "docx_create";

/** 작업 하나의 무게. estMs = 예상 CPU(ms), 나머지는 그 근거 (로그·작업 행에 남긴다). */
export type DocLoad = {
  kind: DocLoadKind;
  estMs: number;
  /** 원본 파일 크기 (생성은 이미지 합계) */
  bytes: number;
  /** 편집: 읽고 다시 쓰는 XML의 풀린 크기 합계. 생성: 0 */
  xmlBytes: number;
  /** PPTX: 슬라이드 수 / DOCX 생성: 블록 수 / 그 밖: 0 */
  units: number;
  ops: number;
};

/** 실행 함수(runXxx)가 "이건 무거우니 Queue로 넘기라"고 돌려주는 값. 원본은 읽었지만 편집·저장은 하지 않았다. */
export type DocDeferred = { ok: true; deferred: true; load: DocLoad };
export type DocDefer = (load: DocLoad) => boolean;

/** 예상 CPU가 이 값 이상이면 Queue로 넘긴다. */
export const DOC_QUEUE_MS = 2000;

// 계수 (ms). MiB = 풀린 XML 1 MiB당. 원격 실측에 맞춘 값이고, 원격 값이 없는 구간(PPTX 큰 덱)은 로컬 workerd 실측에 원격/로컬 비(XLSX에서 1.37배)를 곱했다.
// - DOCX: 원격 문단 5,200개(XML 1.78 MiB) 4,385 ms, 1,040개(0.36 MiB) 약 1,000 ms, 17개 133~189 ms → 150 + 2,400/MiB.
//   로컬에서 문단 수가 2배여도 XML 크기가 같으면 시간이 같았다 (문단 1,040개 0.36 MiB 0.6초 = 문단 2,000개 0.32 MiB 0.5초) — 문단 수가 아니라 XML 크기를 따른다.
// - XLSX: 원격 100,003셀(XML 3.06 MiB) 3,975 ms, 작은 워크북 79~175 ms → 100 + 1,270/MiB.
// - PPTX: 로컬 5장(0.22 MiB) 복제 0.5초·text 1개 0.6초·3개 1.3초, 40장(1.52 MiB) 복제 2.0초·text 1개 2.6초·3개 4.8초.
//   한 번 읽고 쓰기 = 0.25초 + 1.15초/MiB, text op 1개마다 + 0.2초 + 0.6초/MiB → 원격 환산(×1.4). 원격 3장 덱 text 2개 682 ms(식 1,050)·+복제 1,566 ms와 같은 범위.
const DOCX_BASE = 150;
const DOCX_PER_MIB = 2400;
const XLSX_BASE = 100;
const XLSX_PER_MIB = 1270;
const PPTX_BASE = 350;
const PPTX_PER_MIB = 1600; // 덱 XML 1 MiB를 한 번 읽고 쓰는 값
// 라이브 재측정 (2026-11-22, 9장 덱): text 1개 647 ms, text 8개 + 복제 1,867 ms → text op 1개에 약 175 ms. 처음 값 300을 200으로 낮췄다.
const PPTX_PER_TEXT_OP = 200; // text op 1개 = 덱을 한 번 더 읽고 쓴다 (작은 덱의 바닥값)
const PPTX_TEXT_PER_MIB = 800; // text op 1개가 덱 크기에 따라 더 드는 값
const CREATE_BASE = 100;
const CREATE_PER_BLOCK = 0.15;
const CREATE_PER_IMAGE_MIB = 300;

const MIB = 1024 * 1024;

/**
 * ZIP 중앙 디렉터리에서 부품 이름 → 압축을 푼 크기. ZIP이 아니거나 깨졌으면 null.
 * (ZIP64는 보지 않는다 — 편집 상한이 20 MiB라 해당 없음. 여기 적힌 크기는 파일이 주장하는 값이라 속일 수 있지만,
 *  속여서 얻는 것은 "바로 편집"뿐이고 그 길은 편집 Worker의 상한이 그대로 막는다.)
 */
export function zipSizes(u8: Uint8Array): Map<string, number> | null {
  const n = u8.byteLength;
  if (n < 22) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, n);
  let eocd = -1;
  for (let i = n - 22, stop = Math.max(0, n - 22 - 65535); i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map<string, number>();
  const td = new TextDecoder();
  for (let k = 0; k < count && off + 46 <= n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const usize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    if (off + 46 + nameLen > n) break;
    out.set(td.decode(u8.subarray(off + 46, off + 46 + nameLen)), usize);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out.size ? out : null;
}

function sumOf(sizes: Map<string, number> | null, pick: (name: string) => boolean): number {
  let s = 0;
  if (sizes) for (const [name, size] of sizes) if (pick(name)) s += size;
  return s;
}

/** DOCX 편집: word/ 아래 본문·머리글·바닥글·각주 XML. */
export function docxEditLoad(bytes: Uint8Array, ops: number): DocLoad {
  const xmlBytes = sumOf(zipSizes(bytes), (f) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f));
  return { kind: "docx_edit", estMs: Math.round(DOCX_BASE + (xmlBytes / MIB) * DOCX_PER_MIB), bytes: bytes.byteLength, xmlBytes, units: 0, ops };
}

/** XLSX 편집: 시트 XML + 공유 문자열. */
export function xlsxEditLoad(bytes: Uint8Array, ops: number): DocLoad {
  const xmlBytes = sumOf(zipSizes(bytes), (f) => /^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml)$/.test(f));
  return { kind: "xlsx_edit", estMs: Math.round(XLSX_BASE + (xmlBytes / MIB) * XLSX_PER_MIB), bytes: bytes.byteLength, xmlBytes, units: 0, ops };
}

/**
 * PPTX 편집: ppt/ 아래 XML 전체 (슬라이드·레이아웃·마스터·차트·노트). rereads = 덱을 더 읽고 쓰는 횟수
 * (text op 수 — text op는 op마다 다시 읽고 쓴다. replace 경로는 inspect 2번 + 교체 1번이라 2).
 */
export function pptxEditLoad(bytes: Uint8Array, ops: number, rereads: number): DocLoad {
  const sizes = zipSizes(bytes);
  const xmlBytes = sumOf(sizes, (f) => /^ppt\/.*\.(xml|rels)$/.test(f));
  const slides = sizes ? [...sizes.keys()].filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length : 0;
  const mib = xmlBytes / MIB;
  const estMs = Math.round(PPTX_BASE + mib * PPTX_PER_MIB + Math.max(0, rereads) * (PPTX_PER_TEXT_OP + mib * PPTX_TEXT_PER_MIB));
  return { kind: "pptx_edit", estMs, bytes: bytes.byteLength, xmlBytes, units: slides, ops };
}

/** DOCX 새로 만들기 (구조화 정의): 블록 수 + 넣는 이미지 합계. */
export function docxCreateLoad(blocks: number, imageBytes: number): DocLoad {
  return { kind: "docx_create", estMs: Math.round(CREATE_BASE + blocks * CREATE_PER_BLOCK + (imageBytes / MIB) * CREATE_PER_IMAGE_MIB), bytes: imageBytes, xmlBytes: 0, units: blocks, ops: 0 };
}

/** 기본 판정: 예상 CPU가 DOC_QUEUE_MS 이상이면 Queue. */
export const shouldQueueDoc: DocDefer = (load) => load.estMs >= DOC_QUEUE_MS;
