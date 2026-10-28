// Reads duration and display size from an MP4's moov box, so uploads need no ffmpeg.

export interface Mp4Info {
  seconds: number;
  /** As displayed: a 90° or 270° rotation in the track matrix swaps width and height. */
  width: number;
  height: number;
}

/** Reads `length` bytes at `offset`; lets the parser work on a stored file through range reads. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** moov holds sample tables, a few hundred KB for a 30 s clip; anything far larger isn't a clip we take. */
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
/** Each top-level box costs a range read; a crafted 200 MB file of 8-byte boxes would cost millions. */
const MAX_BOXES = 1000;

/**
 * Walks the top-level boxes with one small read each, then reads moov alone. A file with moov at
 * the end (not "fast start") costs a few extra reads, never a full download.
 */
export async function readMp4Info(read: RangeReader, size: number): Promise<Mp4Info | null> {
  for (let at = 0, boxes = 0; at + 8 <= size; boxes++) {
    if (boxes === MAX_BOXES) return null;
    const head = await read(at, Math.min(16, size - at));
    const box = boxHeader(new DataView(head.buffer, head.byteOffset, head.byteLength), 0, size - at);
    if (!box) return null;
    if (box.type === "moov") {
      if (box.size - box.header > MAX_MOOV_BYTES) return null;
      return parseMoov(await read(at + box.header, box.size - box.header));
    }
    at += box.size;
  }
  return null;
}

/** `readMp4Info` over bytes already in memory. */
export function readerOf(bytes: Uint8Array): RangeReader {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

function parseMoov(moov: Uint8Array): Mp4Info | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const end = view.byteLength;

  const mvhd = findBox(view, 0, end, "mvhd");
  if (!mvhd || mvhd.start + 32 > mvhd.end) return null;
  const v1 = view.getUint8(mvhd.start) === 1;
  const timescale = view.getUint32(mvhd.start + (v1 ? 20 : 12));
  const duration = v1 ? Number(view.getBigUint64(mvhd.start + 24)) : view.getUint32(mvhd.start + 16);
  if (!timescale) return null;

  for (let at = 0; ; ) {
    const trak = findBox(view, at, end, "trak");
    if (!trak) return null;
    at = trak.end;
    const tkhd = findBox(view, trak.start, trak.end, "tkhd");
    if (!tkhd) continue;
    const base = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 36 : 24) + 16;
    if (base + 44 > tkhd.end) continue;
    const width = view.getUint32(base + 36) >>> 16;
    const height = view.getUint32(base + 40) >>> 16;
    if (!width || !height) continue; // audio track
    const a = view.getInt32(base);
    const b = view.getInt32(base + 4);
    const rotated = a === 0 && Math.abs(b) === 0x10000;
    return {
      seconds: duration / timescale,
      width: rotated ? height : width,
      height: rotated ? width : height,
    };
  }
}

/** The first box of `type` in [from, to), as the range of its payload. */
function findBox(view: DataView, from: number, to: number, type: string) {
  for (let at = from; at + 8 <= to; ) {
    const box = boxHeader(view, at, to - at);
    if (!box) return null;
    if (box.type === type) return { start: at + box.header, end: at + box.size };
    at += box.size;
  }
  return null;
}

/** Size, header length and type of the box at `at`; `room` is how many bytes are left in its parent. */
function boxHeader(view: DataView, at: number, room: number) {
  let size = view.getUint32(at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > view.byteLength) return null;
    size = Number(view.getBigUint64(at + 8));
    header = 16;
  } else if (size === 0) {
    size = room;
  }
  if (size < header || size > room) return null;
  const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
  return { size, header, type };
}
