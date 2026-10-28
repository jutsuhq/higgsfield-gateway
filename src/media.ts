import { AwsClient } from "aws4fetch";
import type { Env } from "./env";
import { GatewayError } from "./env";
import { readMp4Info, type Mp4Info } from "./mp4";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** The only documented minimum is 300 px a side (Kling's image inputs); smaller images make poor references anyway. */
const MIN_IMAGE_SIDE = 300;
/** A crafted file can hold millions of JPEG segments; a real one needs a handful. */
const MAX_JPEG_SEGMENTS = 1000;
/** R2 needs every part but the last to be the same size, and at least 5 MiB. */
const PART_BYTES = 5 * 1024 * 1024;
/** Long enough to cover the submit retries and the replays of an uncertain submit. */
const PRESIGN_SECONDS = 4 * 60 * 60;

export function declaredType(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]!.trim();
}

/** Checks an image in memory: its magic bytes against the declared type, its size and its dimensions. */
export function inspectImage(bytes: Uint8Array, declared: string): { contentType: string; width: number; height: number } {
  const sniffed = sniff(bytes);
  if (!sniffed || sniffed === "video/mp4" || sniffed !== declared) {
    throw new GatewayError("invalid_input", "the file is not the declared JPEG, PNG, WebP or GIF");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new GatewayError("invalid_input", "images are limited to 10 MB");
  const size = imageSize(bytes, sniffed);
  if (!size) throw new GatewayError("invalid_input", "the image has no readable dimensions");
  if (Math.min(size.width, size.height) < MIN_IMAGE_SIDE) {
    throw new GatewayError("invalid_input", `images need at least ${MIN_IMAGE_SIDE} px on each side`);
  }
  return { contentType: sniffed, ...size };
}

/** Reads the length and display size of an MP4 already stored in R2, with range reads only. */
export async function inspectStoredVideo(bucket: R2Bucket, key: string, size: number): Promise<Mp4Info> {
  const read = async (offset: number, length: number) => {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new Error(`${key} vanished while being read`);
    return new Uint8Array(await object.arrayBuffer());
  };
  if (sniff(await read(0, Math.min(16, size))) !== "video/mp4") {
    throw new GatewayError("invalid_input", "the file is not an MP4");
  }
  const info = await readMp4Info(read, size);
  if (!info) throw new GatewayError("invalid_input", "the MP4 has no readable duration or video track");
  return info;
}

/**
 * Streams `stream` into R2 as a multipart upload, holding one 5 MiB part in memory at a time.
 * Returns the size; aborts the upload and throws when the stream is empty or over `maxBytes`.
 */
export async function streamToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentType: string,
): Promise<number> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
  const parts: R2UploadedPart[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;
  const flush = async (bytes: number) => {
    const part = concat(pending, bytes);
    const rest = concat(pending, pendingBytes).subarray(bytes);
    parts.push(await upload.uploadPart(parts.length + 1, part));
    pending = rest.byteLength ? [rest] : [];
    pendingBytes = rest.byteLength;
  };
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new GatewayError("invalid_input", `the file is larger than ${maxBytes / 1024 / 1024} MB`);
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      while (pendingBytes >= PART_BYTES) await flush(PART_BYTES);
    }
    if (size === 0) throw new GatewayError("invalid_input", "the file is empty");
    if (pendingBytes) await flush(pendingBytes);
    await upload.complete(parts);
    return size;
  } catch (e) {
    await upload.abort();
    throw e;
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= length) break;
    const take = chunk.subarray(0, length - at);
    out.set(take, at);
    at += take.byteLength;
  }
  return out;
}

function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") return "video/mp4";
  return null;
}

/** Pixel size from the image header: PNG IHDR, GIF screen descriptor, WebP VP8/VP8L/VP8X, JPEG SOFn. */
export function imageSize(b: Uint8Array, type: string): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const has = (n: number) => b.byteLength >= n;
  switch (type) {
    case "image/png":
      return has(24) ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case "image/gif":
      return has(10) ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
    case "image/webp": {
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === "VP8 " && has(30)) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L" && has(25)) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X" && has(30)) {
        const u24 = (at: number) => view.getUint16(at, true) | (view.getUint8(at + 2) << 16);
        return { width: u24(24) + 1, height: u24(27) + 1 };
      }
      return null;
    }
    case "image/jpeg": {
      for (let at = 2, segments = 0; at + 9 <= b.byteLength; segments++) {
        if (segments === MAX_JPEG_SEGMENTS) return null;
        if (b[at] !== 0xff) return null;
        const marker = b[at + 1]!;
        // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        }
        at += 2 + view.getUint16(at + 2);
      }
      return null;
    }
    default:
      return null;
  }
}

/** A GET URL for one object, signed with the read-only R2 key and valid for 4 hours. */
export async function presign(env: Env, r2Key: string): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${r2Key}`);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_SECONDS));
  const signed = await client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}
