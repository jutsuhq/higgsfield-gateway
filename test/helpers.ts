import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { BotEntrypoint, WebEntrypoint } from "../src/rpc";

export const RESULT_URL = "https://results.example.com/u/result.mp4";

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["spend", "jobs", "inputs", "trends", "webhook_events", "clients"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  const { objects } = await env.MEDIA.list();
  if (objects.length) await env.MEDIA.delete(objects.map((o) => o.key));
}

export async function seedClient(
  id: string,
  opts: { dailyCapCents?: number; maxJobCents?: number; maxParallel?: number; models?: Record<string, string[]> } = {},
): Promise<void> {
  await env.DB.prepare("INSERT INTO clients (id, daily_cap_cents, max_job_cents, models, max_parallel) VALUES (?, ?, ?, ?, ?)")
    .bind(
      id,
      opts.dailyCapCents ?? 1000,
      opts.maxJobCents ?? 500,
      JSON.stringify(opts.models ?? { "genjutsu-light/motion-transfer": ["480p", "720p"], "seedance-2.5/reference-to-video": ["480p"] }),
      opts.maxParallel ?? 2,
    )
    .run();
}

/** A trend video and an image input owned by `clientId`. */
export async function seedInputs(clientId: string, seconds = 10): Promise<{ trendId: string; imageId: string }> {
  const trendId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO trends (id, r2_key, seconds, width, height) VALUES (?, ?, ?, 720, 1280)").bind(trendId, `trends/${trendId}.mp4`, seconds),
    env.DB.prepare("INSERT INTO inputs (id, client_id, r2_key, kind) VALUES (?, ?, ?, 'image')").bind(imageId, clientId, `in/${imageId}`),
  ]);
  return { trendId, imageId };
}

export function bot() {
  return new BotEntrypoint(createExecutionContext(), env);
}

export function web() {
  return new WebEntrypoint(createExecutionContext(), env);
}

export async function spend(clientId: string) {
  return env.DB.prepare("SELECT reserved_cents AS reserved, spent_cents AS spent FROM spend WHERE client_id = ?")
    .bind(clientId)
    .first<{ reserved: number; spent: number }>();
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** Answers outbound fetches with the first route that returns a Response, and records every call. */
export function mockFetch(...routes: Route[]) {
  const calls: { method: string; url: URL; headers: Headers; body?: string; redirect: string }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const body = request.body ? await request.text() : undefined;
    calls.push({ method: request.method, url, headers: request.headers, body, redirect: request.redirect });
    for (const route of routes) {
      const answer = await route(url, { ...init, method: request.method, body });
      if (answer) return answer;
    }
    return new Response(`no route for ${request.method} ${url}`, { status: 599 });
  });
  return { calls, spy };
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Higgsfield answering estimate, submit, status and delete for one request. */
export function higgsfield(opts: { usd?: string; status?: unknown; cancel?: number } = {}): Route {
  return (url, init) => {
    if (url.hostname !== "api.higgsfield.ai") return undefined;
    if (url.pathname.startsWith("/estimate/")) return json({ usd: opts.usd ?? "0.50" });
    if (url.pathname.endsWith("/status")) return json(opts.status ?? { status: "completed", video: { url: RESULT_URL } });
    if (url.pathname.endsWith("/cancel")) return new Response(null, { status: opts.cancel ?? 202 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "POST") return json({ status: "queued", request_id: "req-1" }, 200, { "X-Correlation-ID": "corr-1" });
    return undefined;
  };
}

export const resultFile: Route = (url) =>
  url.toString() === RESULT_URL ? new Response(new Uint8Array(1234), { headers: { "Content-Length": "1234" } }) : undefined;

/**
 * A minimal MP4: ftyp, then moov with mvhd and one video track's tkhd. With `mdatBytes`, an mdat of that
 * size comes before moov, as in a file that isn't "fast start".
 */
export function mp4(opts: { seconds: number; width: number; height: number; rotate90?: boolean; mdatBytes?: number }): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]) => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(new TextEncoder().encode(type), 4);
    let at = 8;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(mvhd.buffer).setUint32(16, Math.round(opts.seconds * 1000));
  const tkhd = new Uint8Array(84);
  const t = new DataView(tkhd.buffer);
  const matrix = 24 + 16;
  if (opts.rotate90) {
    t.setInt32(matrix, 0);
    t.setInt32(matrix + 4, 0x10000);
    t.setInt32(matrix + 12, -0x10000);
  } else {
    t.setInt32(matrix, 0x10000);
    t.setInt32(matrix + 16, 0x10000);
  }
  t.setInt32(matrix + 32, 0x40000000);
  t.setUint32(matrix + 36, opts.width << 16);
  t.setUint32(matrix + 40, opts.height << 16);
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isom"));
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd)));
  const mdat = opts.mdatBytes ? box("mdat", new Uint8Array(opts.mdatBytes - 8)) : new Uint8Array(0);
  const out = new Uint8Array(ftyp.length + mdat.length + moov.length);
  out.set(ftyp);
  out.set(mdat, ftyp.length);
  out.set(moov, ftyp.length + mdat.length);
  return out;
}

/** PNG signature and IHDR: enough for the type and the size. */
export function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** SOI, an APP0 segment, then SOF0 with the frame size. */
export function jpeg(width: number, height: number): Uint8Array {
  const out = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
  new DataView(out.buffer).setUint16(13, height);
  new DataView(out.buffer).setUint16(15, width);
  return out;
}
