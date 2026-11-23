// MP3(MPEG 오디오) 프레임 분할 — Plaud는 파일마다 형식이 다르다 (10-31 녹음은 Ogg Opus,
// 11-21 녹음은 ID3 태그가 붙은 MP3). 긴 MP3를 Whisper에 통째로 보내면 끝나지 않으므로
// (37MB 한 번 호출 → done_chunks 0에서 무한 반복, 2026-11-23 확인) ogg.ts와 같은 방식으로
// 프레임 경계에서 ~1MB / ~15분 단위로 자른다. 의존성 없는 순수 JS (ffmpeg 없음).
// - 앞쪽 ID3v2 태그는 건너뛴다 (여러 개여도 된다). 끝의 ID3v1/APE 태그는 프레임이 아니므로 버려진다.
// - 프레임 헤더(싱크 11비트 + 버전·레이어·비트레이트·샘플링레이트)로 프레임 길이를 계산한다.
// - 오탐(오디오 데이터 속 우연한 0xFFE 패턴)을 막으려고 "다음 프레임 헤더도 같은 버전·레이어·
//   샘플링레이트로 맞아야" 프레임으로 인정한다 (파일 끝 프레임은 예외).
// - 프레임 바이트는 그대로 잘라 쓴다 (재인코딩 없음). Layer III bit reservoir 때문에 각 구간의
//   첫 프레임 하나는 디코더가 깨끗이 못 풀 수 있지만(약 26ms), 전사에는 영향이 없다.
// 반환 모양은 splitOggOpus와 같다: { segments, durations, totalSeconds } | null (유효 프레임 0개면 null).

export type Mp3Frame = {
  start: number;
  length: number;
  version: number; // 1 = MPEG1, 2 = MPEG2, 25 = MPEG2.5
  layer: number; // 1 | 2 | 3
  sampleRate: number;
  samples: number; // 프레임당 샘플 수
};

// 비트레이트 표 (kbps). 인덱스 0(free format)과 15(bad)는 0으로 두어 무효 처리한다.
const BR_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BR_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BR_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR_V1 = [44100, 48000, 32000];
const SR_V2 = [22050, 24000, 16000];
const SR_V25 = [11025, 12000, 8000];

/** off 위치의 4바이트를 MPEG 오디오 프레임 헤더로 읽는다. 무효면 null. */
export function parseMp3FrameHeader(bytes: Uint8Array, off: number): Mp3Frame | null {
  if (off + 4 > bytes.length) return null;
  const b1 = bytes[off + 1], b2 = bytes[off + 2];
  if (bytes[off] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const verBits = (b1 >> 3) & 0x03; // 00 = 2.5, 01 = 예약, 10 = 2, 11 = 1
  const layerBits = (b1 >> 1) & 0x03; // 01 = III, 10 = II, 11 = I, 00 = 예약
  if (verBits === 0x01 || layerBits === 0x00) return null;
  const version = verBits === 0x03 ? 1 : verBits === 0x02 ? 2 : 25;
  const layer = 4 - layerBits;
  const brIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (srIdx === 0x03) return null;
  const table = version === 1
    ? (layer === 1 ? BR_V1_L1 : layer === 2 ? BR_V1_L2 : BR_V1_L3)
    : (layer === 1 ? BR_V2_L1 : BR_V2_L23);
  const kbps = table[brIdx];
  if (!kbps) return null; // free format(0)·bad(15)
  const sampleRate = (version === 1 ? SR_V1 : version === 2 ? SR_V2 : SR_V25)[srIdx];
  const bitrate = kbps * 1000;
  let length: number;
  let samples: number;
  if (layer === 1) {
    length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samples = 384;
  } else if (layer === 2 || version === 1) {
    length = Math.floor((144 * bitrate) / sampleRate) + padding;
    samples = 1152;
  } else {
    // Layer III, MPEG2/2.5
    length = Math.floor((72 * bitrate) / sampleRate) + padding;
    samples = 576;
  }
  if (length < 4) return null;
  return { start: off, length, version, layer, sampleRate, samples };
}

/** 앞쪽 ID3v2 태그(들)의 끝 오프셋. 태그가 없으면 0. */
export function skipId3v2(bytes: Uint8Array): number {
  let off = 0;
  while (off + 10 <= bytes.length && bytes[off] === 0x49 && bytes[off + 1] === 0x44 && bytes[off + 2] === 0x33) {
    const s6 = bytes[off + 6], s7 = bytes[off + 7], s8 = bytes[off + 8], s9 = bytes[off + 9];
    if ((s6 | s7 | s8 | s9) & 0x80) break; // syncsafe 정수가 아니면 태그가 아니다
    const size = (s6 << 21) | (s7 << 14) | (s8 << 7) | s9;
    const footer = (bytes[off + 5] & 0x10) ? 10 : 0;
    off += 10 + size + footer;
  }
  return Math.min(off, bytes.length);
}

function sameStream(a: Mp3Frame, b: Mp3Frame): boolean {
  return a.version === b.version && a.layer === b.layer && a.sampleRate === b.sampleRate;
}

/** 프레임 목록. 프레임 사이의 쓰레기 바이트는 한 바이트씩 넘기며 다시 동기를 잡는다. */
export function parseMp3Frames(bytes: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let off = skipId3v2(bytes);
  const n = bytes.length;
  while (off + 4 <= n) {
    const f = bytes[off] === 0xff ? parseMp3FrameHeader(bytes, off) : null;
    if (!f || off + f.length > n) { off++; continue; }
    const nextOff = off + f.length;
    if (nextOff + 4 <= n) {
      const next = parseMp3FrameHeader(bytes, nextOff);
      // 다음 헤더가 같은 스트림이면 인정. 다음 자리가 프레임이 아니면(끝의 ID3v1 "TAG"/APE 등)
      // 이미 프레임 사슬 위에 있을 때만 인정한다 — 사슬 밖의 우연한 싱크는 버린다.
      const prev = frames.length ? frames[frames.length - 1] : null;
      const chained = prev !== null && prev.start + prev.length === off && sameStream(prev, f);
      if (!(next && sameStream(f, next)) && !chained) { off++; continue; }
    }
    frames.push(f);
    off = nextOff;
  }
  return frames;
}

export function splitMp3(
  bytes: Uint8Array,
  maxSeconds: number,
  maxBytes = 1024 * 1024
): { segments: Uint8Array[]; durations: number[]; totalSeconds: number } | null {
  const frames = parseMp3Frames(bytes);
  if (frames.length === 0) return null;
  const segments: Uint8Array[] = [];
  const durations: number[] = [];
  let total = 0;
  let segFirst = 0; // 현재 구간 첫 프레임 인덱스
  let segBytes = 0;
  let segSeconds = 0;
  const flush = (lastIdx: number) => {
    const s = frames[segFirst].start;
    const e = frames[lastIdx].start + frames[lastIdx].length;
    segments.push(bytes.subarray(s, e));
    durations.push(segSeconds);
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const sec = f.samples / f.sampleRate;
    // 이 프레임을 더하면 상한을 넘는 경우, 지금까지를 한 구간으로 끊고 이 프레임부터 새 구간.
    if (i > segFirst && (segBytes + f.length > maxBytes || segSeconds + sec > maxSeconds)) {
      flush(i - 1);
      segFirst = i;
      segBytes = 0;
      segSeconds = 0;
    }
    segBytes += f.length;
    segSeconds += sec;
    total += sec;
  }
  flush(frames.length - 1);
  return { segments, durations, totalSeconds: total };
}
