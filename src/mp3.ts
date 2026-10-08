// Minimal MPEG audio (Layer III) frame walker used to estimate how long an MP3
// clip plays. `say` needs the duration to know when one sentence has finished
// in the call before it posts the next one (Recall's output_audio endpoint
// returns as soon as the clip is accepted, not when it finishes playing).
// Walking every frame header works for both CBR and VBR files.

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

interface FrameInfo {
  length: number;
  seconds: number;
}

function parseFrameHeader(buf: Uint8Array, i: number): FrameInfo | null {
  if (i + 4 > buf.length) return null;
  const b1 = buf[i]!;
  const b2 = buf[i + 1]!;
  const b3 = buf[i + 2]!;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const version = (b2 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=v2, 3=v1
  const layer = (b2 >> 1) & 0x03; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIdx = (b3 >> 4) & 0x0f;
  const srIdx = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const isV1 = version === 3;
  const kbps = (isV1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx]!;
  const sampleRate = SAMPLE_RATES[version]![srIdx]!;
  const samples = isV1 ? 1152 : 576;
  const coeff = isV1 ? 144 : 72;
  const length = Math.floor((coeff * kbps * 1000) / sampleRate) + padding;
  if (length < 4) return null;
  return { length, seconds: samples / sampleRate };
}

function id3v2Size(buf: Uint8Array): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // "ID3"
  const size =
    ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = (buf[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** Estimated playback duration of an MP3 (Layer III) buffer, in seconds. 0 if no frames. */
export function mp3DurationSeconds(buf: Uint8Array): number {
  let i = id3v2Size(buf);
  let total = 0;
  while (i < buf.length - 3) {
    const frame = parseFrameHeader(buf, i);
    if (frame) {
      total += frame.seconds;
      i += frame.length;
    } else {
      i += 1; // resync
    }
  }
  return total;
}
