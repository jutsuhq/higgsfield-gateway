// Downloads a finished result into R2 after checking where it comes from and how large it is.
// Shared by the Workflow and the reconcile cron, so a recovered job is delivered like a live one.

import { GatewayError, type Env } from "./env";
import { streamToR2 } from "./media";

export type Delivery = { resultKey: string } | { error: string };

/** Hosts a result may be downloaded from. Required: an unset or placeholder list is a config error. */
export function resultHosts(value: string | undefined): string[] {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length || hosts.some((host) => /[<>]/.test(host))) {
    throw new Error("RESULT_HOSTS must list real result hosts, without a <placeholder>");
  }
  return hosts;
}

/** The size guard is mandatory: `Number(undefined)` is NaN, and `length > NaN` is always false. */
export function maxResultBytes(value: string | undefined): number {
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`MAX_RESULT_BYTES must be a positive integer, got ${value}`);
  }
  return bytes;
}

/** Streams `videoUrl` into R2, refusing redirects, unexpected hosts and oversized results. */
export async function deliverResult(env: Env, jobId: string, videoUrl: string): Promise<Delivery> {
  const url = new URL(videoUrl);
  const hosts = resultHosts(env.RESULT_HOSTS);
  const maxBytes = maxResultBytes(env.MAX_RESULT_BYTES);
  if (url.protocol !== "https:" || !hosts.includes(url.hostname.toLowerCase())) {
    return { error: `unexpected_result_host: ${url.hostname}` };
  }

  // Redirects are refused rather than followed: the allow-list only covers the first hop.
  const res = await fetch(url.toString(), { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) return { error: `result_redirect: ${res.status}` };
  if (!res.ok || !res.body) throw new Error(`result download answered ${res.status}`);
  const declared = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { error: `result_too_large: ${declared} bytes` };

  const resultKey = `out/${jobId}.mp4`;
  if (declared > 0) {
    const { readable, writable } = new FixedLengthStream(declared);
    const [, object] = await Promise.all([
      res.body.pipeTo(writable),
      env.MEDIA.put(resultKey, readable, { httpMetadata: { contentType: "video/mp4" } }),
    ]);
    if (!object) throw new Error("R2 refused the result");
    return { resultKey };
  }

  // No Content-Length: R2 needs a known length, so upload parts while counting the bytes.
  try {
    await streamToR2(env.MEDIA, resultKey, res.body, maxBytes, "video/mp4");
  } catch (e) {
    if (e instanceof GatewayError && /larger than/.test(e.message)) {
      return { error: `result_too_large: over ${maxBytes} bytes` };
    }
    throw e;
  }
  return { resultKey };
}
