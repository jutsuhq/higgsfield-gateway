import { afterEach, describe, expect, it, vi } from "vitest";
import { Higgsfield, HiggsfieldError, usdToCents } from "../src/higgsfield";
import { imageSize, inspectImage } from "../src/media";
import { nearestAspectRatio } from "../src/models";
import { readerOf, readMp4Info } from "../src/mp4";
import { maxResultBytes, hfConcurrency, resultHosts } from "../src/result";
import { verifyWebhook } from "../src/webhook";
import { jpeg, json, mockFetch, mp4, png } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("usdToCents", () => {
  it("parses decimal strings exactly and rounds up", () => {
    expect(usdToCents("0.10")).toBe(10);
    expect(usdToCents("0.094")).toBe(10);
    expect(usdToCents("2")).toBe(200);
    expect(usdToCents("1.5")).toBe(150);
    expect(usdToCents("1.500")).toBe(150);
  });
});

describe("Higgsfield errors", () => {
  const hf = new Higgsfield("id:secret", "https://api.higgsfield.ai");

  it.each([
    [400, { detail: "Maximum number of concurrent requests (4) has been reached" }, "busy"],
    [429, { detail: "account_queue_full" }, "busy"],
    [400, { detail: "image_urls: too many" }, "invalid"],
    [403, { detail: "Not enough credits" }, "insufficient_funds"],
    [422, { detail: "Idempotency-Key was already used with different request parameters" }, "idempotency_mismatch"],
    [422, { detail: [{ loc: ["body", "prompt"], msg: "too long" }] }, "invalid"],
    [503, { detail: "disabled" }, "unavailable"],
    [500, {}, "server"],
  ])("maps %i %j to %s", async (status, body, kind) => {
    mockFetch(() => json(body, status, { "Retry-After": "7" }));
    const error = await hf.estimate("m", {}).catch((e) => e);
    expect(error).toBeInstanceOf(HiggsfieldError);
    expect(error.kind).toBe(kind);
    if (status === 429) expect(error.retryAfterSeconds).toBe(7);
  });

  it("sends the key, the idempotency key and the webhook on submit", async () => {
    const { calls } = mockFetch(() => json({ request_id: "r" }, 200, { "X-Correlation-ID": "c" }));
    const answer = await hf.submit("a/b", { prompt: "" }, { idempotencyKey: "k", webhookUrl: "https://x/h?a=1", expiresAfterSeconds: 3600 });
    expect(answer).toEqual({ requestId: "r", correlationId: "c" });
    const call = calls[0]!;
    expect(call.url.toString()).toBe("https://api.higgsfield.ai/a/b?hf_webhook=https%3A%2F%2Fx%2Fh%3Fa%3D1");
    expect(call.headers.get("Authorization")).toBe("Key id:secret");
    expect(call.headers.get("Idempotency-Key")).toBe("k");
    expect(call.headers.get("Hf-Expires-After")).toBe("3600");
  });

  it.each([{ status: "queued" }, { request_id: "" }, { request_id: "  " }])(
    "refuses an accepted submit without a request_id: %j",
    async (body) => {
      mockFetch(() => json(body));
      const error = await hf
        .submit("a/b", {}, { idempotencyKey: "k", webhookUrl: "https://x/h", expiresAfterSeconds: 3600 })
        .catch((e) => e);
      expect(error).toBeInstanceOf(HiggsfieldError);
      expect(error.retryable).toBe(false);
    },
  );

  it("reads cancel 202 as canceled and 400 as started", async () => {
    mockFetch(() => new Response(null, { status: 202 }));
    expect(await hf.cancel("r")).toBe("canceled");
    vi.restoreAllMocks();
    mockFetch(() => json({ detail: "Request is already being processed" }, 400));
    expect(await hf.cancel("r")).toBe("started");
  });

  it("normalizes statuses", async () => {
    mockFetch(() => json({ status: "cancelled" }));
    expect((await hf.status("r")).status).toBe("canceled");
    vi.restoreAllMocks();
    mockFetch(() => json({ status: "upscaling" }));
    expect((await hf.status("r")).status).toBe("in_progress");
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_dGVzdC13ZWJob29rLXNlY3JldA==";
  const body = new TextEncoder().encode('{"request_id":"r","status":"completed"}').buffer as ArrayBuffer;

  async function sign(id: string, timestamp: string, data: ArrayBuffer, key = "test-webhook-secret") {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = new Uint8Array([...new TextEncoder().encode(`${id}.${timestamp}.`), ...new Uint8Array(data)]);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, signed))));
  }

  it("accepts a valid signature among several", async () => {
    const sig = await sign("msg_1", "1000", body);
    expect(await verifyWebhook(secret, { id: "msg_1", timestamp: "1000", signature: `v1,AAAA v1,${sig}` }, body, 1100)).toBe(true);
  });

  it("rejects a wrong key, a changed body, an old timestamp and missing headers", async () => {
    const wrong = await sign("msg_1", "1000", body, "other");
    expect(await verifyWebhook(secret, { id: "msg_1", timestamp: "1000", signature: `v1,${wrong}` }, body, 1000)).toBe(false);
    const sig = await sign("msg_1", "1000", body);
    const changed = new TextEncoder().encode("{}").buffer as ArrayBuffer;
    expect(await verifyWebhook(secret, { id: "msg_1", timestamp: "1000", signature: `v1,${sig}` }, changed, 1000)).toBe(false);
    expect(await verifyWebhook(secret, { id: "msg_1", timestamp: "1000", signature: `v1,${sig}` }, body, 1301)).toBe(false);
    expect(await verifyWebhook(secret, { id: null, timestamp: "1000", signature: `v1,${sig}` }, body, 1000)).toBe(false);
  });
});

describe("MP4 and input checks", () => {
  const info = (bytes: Uint8Array) => readMp4Info(readerOf(bytes), bytes.length);

  it("reads duration and size, applying rotation", async () => {
    expect(await info(mp4({ seconds: 10.5, width: 720, height: 1280 }))).toEqual({ seconds: 10.5, width: 720, height: 1280 });
    expect(await info(mp4({ seconds: 4, width: 1920, height: 1080, rotate90: true }))).toEqual({ seconds: 4, width: 1080, height: 1920 });
    expect(await info(mp4({ seconds: 6, width: 720, height: 1280, mdatBytes: 4096 }))).toEqual({ seconds: 6, width: 720, height: 1280 });
    expect(await info(new Uint8Array(64))).toBeNull();
  });

  it("reads image sizes from their headers", () => {
    expect(imageSize(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1080, 1920), "image/jpeg")).toEqual({ width: 1080, height: 1920 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0x90, 0x01]);
    expect(imageSize(gif, "image/gif")).toEqual({ width: 300, height: 400 });
  });

  it("checks the declared type and the minimum size", () => {
    expect(inspectImage(png(400, 300), "image/png")).toEqual({ contentType: "image/png", width: 400, height: 300 });
    expect(() => inspectImage(png(400, 300), "image/jpeg")).toThrow("invalid_input");
    expect(() => inspectImage(png(400, 299), "image/png")).toThrow("at least 300 px");
    expect(() => inspectImage(mp4({ seconds: 8, width: 720, height: 1280 }), "video/mp4")).toThrow("invalid_input");
  });

  it("picks the nearest aspect ratio", () => {
    expect(nearestAspectRatio(720, 1280)).toBe("9:16");
    expect(nearestAspectRatio(1920, 1080)).toBe("16:9");
    expect(nearestAspectRatio(1000, 1000)).toBe("1:1");
    expect(nearestAspectRatio(2560, 1080)).toBe("21:9");
  });

  it("gives up on headers with too many boxes or segments", async () => {
    // 1001 empty boxes before moov: each one would cost a range read without the cap.
    const file = mp4({ seconds: 2, width: 720, height: 1280 });
    const boxes = new Uint8Array(8 * 1001 + file.length);
    const view = new DataView(boxes.buffer);
    for (let at = 0; at < 8 * 1001; at += 8) {
      view.setUint32(at, 8);
      boxes.set(new TextEncoder().encode("free"), at + 4);
    }
    boxes.set(file, 8 * 1001);
    expect(await info(boxes)).toBeNull();

    // 1000 APP0 segments, then a valid SOF0 the cap never reaches.
    const at = 2 + 4 * 1000;
    const segments = new Uint8Array(at + 9);
    segments.set([0xff, 0xd8]);
    for (let start = 2; start < at; start += 4) segments.set([0xff, 0xe0, 0x00, 0x02], start);
    segments.set([0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38], at);
    expect(imageSize(segments, "image/jpeg")).toBeNull();
  });
});

describe("result settings", () => {
  it("requires a result host list and a positive size cap", () => {
    expect(resultHosts("cdn.example.com, CDN.example.net")).toEqual(["cdn.example.com", "cdn.example.net"]);
    expect(() => resultHosts("")).toThrow("RESULT_HOSTS");
    expect(() => resultHosts(undefined)).toThrow("RESULT_HOSTS");
    expect(() => resultHosts("<your-result-cdn-host>")).toThrow("RESULT_HOSTS");
    expect(maxResultBytes("1024")).toBe(1024);
    expect(() => maxResultBytes(undefined)).toThrow("MAX_RESULT_BYTES");
    expect(() => maxResultBytes("0")).toThrow("MAX_RESULT_BYTES");
    expect(() => maxResultBytes("abc")).toThrow("MAX_RESULT_BYTES");
  });

  it("requires a positive concurrency limit", () => {
    expect(hfConcurrency("2")).toBe(2);
    expect(() => hfConcurrency(undefined)).toThrow("HF_CONCURRENCY");
    expect(() => hfConcurrency("0")).toThrow("HF_CONCURRENCY");
    expect(() => hfConcurrency("-1")).toThrow("HF_CONCURRENCY");
    expect(() => hfConcurrency("1.5")).toThrow("HF_CONCURRENCY");
  });
});
