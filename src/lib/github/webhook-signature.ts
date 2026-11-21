import { createHmac, timingSafeEqual } from "node:crypto";

/** The largest webhook body accepted. GitHub's own cap is 25 MB, but every event this deployment subscribes to is far smaller. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * `X-Hub-Signature-256` is `sha256=` plus the hex HMAC-SHA256 of the RAW body under the webhook secret. Missing, malformed or wrong-length
 * values are refused without comparing; otherwise the two 32-byte digests are compared in constant time. The hex digits may be either
 * case (the same digest, GitHub sends lower case); the `sha256=` prefix must be exact.
 */
export function verifyWebhookSignature(secret: string, raw: Uint8Array, header: string | null): boolean {
  if (!header) return false;
  const m = SIGNATURE.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1], "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type CappedBody = { ok: true; body: Buffer } | { ok: false };

/**
 * Reads the request body without ever holding more than `max` bytes: a declared `Content-Length` over the cap is refused before reading
 * (and a malformed one is ignored: the stream decides), and the stream itself is cut off as soon as it passes the cap, whatever it declared.
 */
export async function readBodyCapped(req: Request, max = WEBHOOK_MAX_BYTES): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > max) return { ok: false };
  if (!req.body) return { ok: true, body: Buffer.alloc(0) };
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}
