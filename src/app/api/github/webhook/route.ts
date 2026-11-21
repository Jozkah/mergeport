import { createHash } from "node:crypto";
import { clientIp } from "@/lib/auth/hosted-config";
import { take } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { githubAppConfig } from "@/lib/github/app-config";
import { processDelivery } from "@/lib/github/webhook-events";
import { WEBHOOK_MAX_BYTES, readBodyCapped, verifyWebhookSignature } from "@/lib/github/webhook-signature";
import { isHosted } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub's webhook for the deployment's App (docs/github-app.md, "Webhooks"). No cookie, no session, no Origin: the HMAC signature is the
 * only credential, and `src/proxy.ts` exempts exactly this path (POST, hosted) from the browser Origin rule for that reason.
 *
 * Order, each step before the next: hosted and configured (else 404); a declared size over 1 MiB (413); the body read with a hard
 * 1 MiB cap (413); the signature over the RAW body (401). Only then are headers checked, the JSON parsed and the database used for
 * anything but the abuse counters. The handler queues jobs or flips a state and answers; it never calls GitHub.
 */

const RATE_PER_MINUTE = 600;
const BAD_SIGNATURES_PER_MINUTE = 30;
const EVENT = /^[a-z][a-z_]{0,49}$/;
const DELIVERY = /^[A-Za-z0-9-]{8,64}$/;

const reply = (status: number, body: string) => new Response(JSON.stringify({ result: body }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Counter keys carry a hash of the client address, never the address. A missing address (no trusted proxy header) shares one bucket. */
const bucket = (kind: string, req: Request) => `ghwh:${kind}:${createHash("sha256").update(clientIp(req) ?? "unknown").digest("hex").slice(0, 24)}`;

export async function POST(req: Request) {
  const config = githubAppConfig();
  if (!isHosted() || !config) return new Response("Not found", { status: 404 });

  const read = await readBodyCapped(req, WEBHOOK_MAX_BYTES);
  if (!read.ok) return reply(413, "too large");

  if (!verifyWebhookSignature(config.webhookSecret, read.body, req.headers.get("x-hub-signature-256"))) {
    // Only an abuse counter is touched: no installation, repository or delivery row is read or written for an unsigned request.
    const within = await take(db, bucket("bad", req), BAD_SIGNATURES_PER_MINUTE, 60_000).catch(() => true);
    return within ? reply(401, "invalid signature") : reply(429, "slow down");
  }
  if (!(await take(db, bucket("ip", req), RATE_PER_MINUTE, 60_000))) return reply(429, "slow down");

  const event = req.headers.get("x-github-event");
  const delivery = req.headers.get("x-github-delivery");
  if (!event || !EVENT.test(event) || !delivery || !DELIVERY.test(delivery)) return reply(400, "missing or malformed headers");
  if (event === "ping") return reply(200, "pong");

  let payload: unknown;
  try {
    payload = JSON.parse(read.body.toString("utf8"));
  } catch {
    return reply(400, "invalid json");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return reply(400, "invalid json");

  try {
    const r = await processDelivery(db, { deliveryId: delivery, event, payload: payload as Record<string, unknown> });
    switch (r.kind) {
      case "ignored":
        return reply(202, "ignored");
      case "bad-payload":
        return reply(400, "unusable payload");
      case "unknown-installation":
        return reply(200, "unknown installation");
      case "duplicate":
        return reply(200, "duplicate");
      case "accepted":
        return reply(200, "ok");
    }
  } catch (e) {
    // The transaction rolled back (no delivery row), so redelivering the same id from GitHub's "Recent deliveries" works.
    console.error("[github webhook] handler failed:", e instanceof Error ? e.message : "unknown error");
    return reply(500, "failed");
  }
}
