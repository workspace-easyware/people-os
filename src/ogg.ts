// Ogg Opus 페이지 분할 — 긴 Plaud 녹음(예: 97분 ogg)을 Whisper가 한 번에
// 처리하지 못해 구간 단위로 나눈다. 서버(Worker)에서 ffmpeg 없이 순수 JS로
// Ogg 페이지를 파싱해 페이지 경계에서만 자른다. 구간 길이는 호출자가 정한다
// (현재 15분: 30분 구간은 첫 구간 Whisper 호출이 44분 동안 안 끝나고
// 백그라운드 작업이 조용히 죽었다 — 2026-11-13 확인).
// - 헤더 페이지(OpusHead/OpusTags, bos 플래그)는 모든 구간 앞에 붙인다.
// - 패킷이 페이지 경계를 넘어 이어지는 곳에서는 자르지 않는다
//   (마지막 세그먼트 길이가 255면 패킷 계속 중).
// - 페이지 바이트는 그대로 복사하므로 CRC를 다시 계산할 필요가 없다.
// - Opus granule position은 48kHz 샘플 수다: 구간 길이 = granule / 48000.

export type OggPage = {
  start: number;
  end: number;
  dataStart: number; // 첫 세그먼트 데이터 시작 오프셋
  granule: bigint; // -1n = 이 페이지에서 완성된 패킷 없음
  headerType: number;
  packetContinues: boolean; // 마지막 세그먼트 길이가 255
};

export function parseOggPages(bytes: Uint8Array): OggPage[] | null {
  const pages: OggPage[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 27 <= bytes.length) {
    if (bytes[off] !== 0x4f || bytes[off + 1] !== 0x67 || bytes[off + 2] !== 0x67 || bytes[off + 3] !== 0x53) return null;
    const headerType = bytes[off + 5];
    const granule = view.getBigInt64(off + 6, true);
    const nSegs = bytes[off + 26];
    if (off + 27 + nSegs > bytes.length) return null;
    let dataLen = 0;
    let lastSeg = 0;
    for (let i = 0; i < nSegs; i++) {
      lastSeg = bytes[off + 27 + i];
      dataLen += lastSeg;
    }
    const end = off + 27 + nSegs + dataLen;
    if (end > bytes.length) return null;
    pages.push({ start: off, end, dataStart: off + 27 + nSegs, granule, headerType, packetContinues: nSegs > 0 && lastSeg === 255 });
    off = end;
  }
  if (pages.length === 0) return null;
  if (off !== bytes.length) return null; // 뒤에 남은 쓰레기 바이트
  return pages;
}

export function oggDurationSeconds(bytes: Uint8Array): number | null {
  const pages = parseOggPages(bytes);
  if (!pages) return null;
  let last = -1n;
  for (const p of pages) if (p.granule >= 0n) last = p.granule;
  if (last < 0n) return null;
  return Number(last) / 48000;
}

function assemble(bytes: Uint8Array, headerBytes: Uint8Array, pages: OggPage[], from: number, to: number): Uint8Array {
  let len = headerBytes.length;
  for (let j = from; j <= to; j++) len += pages[j].end - pages[j].start;
  const seg = new Uint8Array(len);
  seg.set(headerBytes, 0);
  let w = headerBytes.length;
  for (let j = from; j <= to; j++) {
    seg.set(bytes.subarray(pages[j].start, pages[j].end), w);
    w += pages[j].end - pages[j].start;
  }
  return seg;
}

export function splitOggOpus(
  bytes: Uint8Array,
  maxSeconds: number,
  maxBytes = 1024 * 1024
): { segments: Uint8Array[]; durations: number[]; totalSeconds: number } | null {
  const pages = parseOggPages(bytes);
  if (!pages) return null;
  // 헤더 페이지: 첫 오디오 페이지 이전의 granule 0 페이지들. Plaud 파일은
  // OpusHead 다음에 "PLAUD.AI" 벤더 페이지가 끼어 있고 OpusTags가 세 번째에
  // 오므로, bos 플래그나 매직 문자열만으로는 헤더를 다 못 잡는다.
  // 헤더 페이지는 granule이 0이고, 첫 오디오 페이지부터 granule이 증가한다.
  const first = pages[0];
  const firstHead = String.fromCharCode(...bytes.subarray(first.dataStart, Math.min(first.dataStart + 8, first.end)));
  if (!firstHead.startsWith("OpusHead")) return null;
  let headerEnd = 0;
  while (headerEnd < pages.length && pages[headerEnd].granule === 0n) headerEnd++;
  if (headerEnd === 0) return null; // 헤더 페이지의 granule이 0이 아닌 비정상 파일 — 쪼개지 않고 통째로 전사한다 (pages[-1] 예외 방지)
  const headerBytes = bytes.slice(0, pages[headerEnd - 1].end);
  const audio = pages.slice(headerEnd);
  if (audio.length === 0) return null;

  // granule은 파일 안 절대 시각이다. 전체 길이도 구간 길이도 "현재 granule -
  // 기준 granule"로 재야 한다. 잘라낸 파일(원본 중간 부분)은 첫 granule이 0이
  // 아니라서, 0을 기준으로 재면 시간 상한이 첫 페이지에서 바로 걸린다.
  // 기준 granule = 첫 오디오 페이지의 granule.
  const baseGranule = audio.length > 0 && audio[0].granule >= 0n ? audio[0].granule : 0n;
  let total = 0;
  {
    let last = -1n;
    for (const p of pages) if (p.granule >= 0n) last = p.granule;
    total = last >= 0n ? Number(last - baseGranule) / 48000 : 0;
  }

  const segments: Uint8Array[] = [];
  const durations: number[] = [];
  let segStart = 0;
  let segStartGranule = baseGranule;
  let segBytes = headerBytes.length;
  let lastKnownGranule = baseGranule;
  for (let i = 0; i < audio.length; i++) {
    const p = audio[i];
    if (p.granule >= 0n) lastKnownGranule = p.granule;
    segBytes += p.end - p.start;
    if (p.granule < 0n) continue;
    const segSeconds = Number(p.granule - segStartGranule) / 48000;
    const isLast = i === audio.length - 1;
    // 바이트 상한(기본 1MB)이나 시간 상한 중 먼저 도달하면 자른다.
    // 단, 패킷이 이어지는 페이지에서는 자르지 않는다.
    if (((segBytes >= maxBytes || segSeconds >= maxSeconds) && !p.packetContinues) || isLast) {
      segments.push(assemble(bytes, headerBytes, audio, segStart, i));
      durations.push(segSeconds);
      segStart = i + 1;
      segStartGranule = p.granule;
      segBytes = headerBytes.length;
    }
  }
  if (segStart < audio.length) {
    // 마지막 페이지들의 granule이 -1이라 위 루프에서 안 잘린 경우
    segments.push(assemble(bytes, headerBytes, audio, segStart, audio.length - 1));
    durations.push(Number(lastKnownGranule - segStartGranule) / 48000);
  }
  return { segments, durations, totalSeconds: total };
}
