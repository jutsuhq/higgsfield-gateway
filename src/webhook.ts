// Standard Webhooks verification (https://www.standardwebhooks.com), as Higgsfield signs deliveries.

const TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * True when one of the `v1,<base64>` signatures is HMAC-SHA256 over `{id}.{timestamp}.{body}`,
 * keyed with the base64-decoded `whsec_` secret, and the timestamp is within 5 minutes of `nowSeconds`.
 */
export async function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  rawBody: ArrayBuffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + rawBody.byteLength);
  signed.set(prefix);
  signed.set(new Uint8Array(rawBody), prefix.length);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));

  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    let given: Uint8Array;
    try {
      given = base64ToBytes(value);
    } catch {
      continue;
    }
    if (given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
