import { safeEqual } from "@/lib/crypto";

/** An unused launch link stops working after this long, so a link left in a log or terminal is not a standing key. */
export const LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Whether a launch token may be used now. The token is minted when the launcher starts this process, so the process start is its
 * issue time. Single use is tracked by the caller; this adds only the expiry.
 */
export function launchTokenUsable(o: { given: string; expected: string | undefined; used: boolean; issuedAt: number; now: number }): boolean {
  if (!o.expected || o.used || !safeEqual(o.given, o.expected)) return false;
  return o.now - o.issuedAt <= LAUNCH_TOKEN_TTL_MS;
}

/** When the launcher minted this process's token: the moment the process started. */
export const processStartedAt = () => Date.now() - process.uptime() * 1000;
