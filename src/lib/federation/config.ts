import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isHosted } from "@/lib/public-url";

/**
 * Operator-level federation settings (environment), read on every call so the tests and a restart see the current value.
 *
 *  - MERGEPORT_FEDERATION=off|allowlist|any (default off) is the CEILING: a workspace can only be more restrictive.
 *  - MERGEPORT_FEDERATION_ALLOWLIST: comma separated origins, used when the ceiling is `allowlist`.
 *  - MERGEPORT_FEDERATION_ALLOW_INSECURE=1: http and loopback targets, for development and tests only. Ignored in production.
 *  - MERGEPORT_ENCRYPTION_KEY: 32 bytes as 64 hex characters or base64. Required when federation is on (it encrypts peer tokens).
 */
export type FederationMode = "off" | "allowlist" | "any";

export type FederationConfig = {
  mode: FederationMode;
  /** Normalised origins. */
  allowlist: string[];
  allowInsecure: boolean;
  /** AES-256 key, or null when missing or malformed. */
  key: Buffer | null;
};

export type FederationState = { kind: "absent" } | { kind: "misconfigured"; problems: string[]; config: FederationConfig } | { kind: "enabled"; config: FederationConfig };

export function parseMode(v: unknown): FederationMode {
  return v === "allowlist" || v === "any" ? v : "off";
}

/** The origin form of an address, or null. Only https (http with `allowInsecure`), no credentials; path, query and fragment are dropped. */
export function normaliseOrigin(input: string, allowInsecure: boolean): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.origin;
}

/** 32-byte key from 64 hex characters or base64 (standard or url-safe). */
export function parseKey(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  return null;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): FederationConfig {
  const allowInsecure = env.MERGEPORT_FEDERATION_ALLOW_INSECURE === "1" && env.NODE_ENV !== "production";
  const allowlist = (env.MERGEPORT_FEDERATION_ALLOWLIST ?? "")
    .split(",")
    .map((s) => normaliseOrigin(s, allowInsecure))
    .filter((s): s is string => s !== null);
  return { mode: parseMode(env.MERGEPORT_FEDERATION?.trim().toLowerCase()), allowlist: [...new Set(allowlist)], allowInsecure, key: parseKey(env.MERGEPORT_ENCRYPTION_KEY) };
}

/**
 * Whether federation exists at all on this instance. Not hosted, or ceiling off: absent (every route answers 404). On with no usable
 * encryption key: misconfigured, also treated as absent by the routes; the settings page tells the administrator why.
 */
export function federationState(env: NodeJS.ProcessEnv = process.env, hosted: boolean = isHosted()): FederationState {
  const config = readConfig(env);
  if (!hosted || config.mode === "off") return { kind: "absent" };
  const problems: string[] = [];
  if (!config.key) problems.push("MERGEPORT_ENCRYPTION_KEY must be 32 random bytes (64 hex characters or base64). It encrypts the access tokens of linked instances.");
  if (env.MERGEPORT_FEDERATION_ALLOW_INSECURE === "1" && env.NODE_ENV === "production") problems.push("MERGEPORT_FEDERATION_ALLOW_INSECURE is ignored in production.");
  if (!config.key) return { kind: "misconfigured", problems, config };
  return { kind: "enabled", config };
}

/** The config when federation is usable on this instance, else null (the 404 case). */
export function activeConfig(): FederationConfig | null {
  const s = federationState();
  return s.kind === "enabled" ? s.config : null;
}

// ---------- secrets ----------

const b64u = (b: Buffer) => b.toString("base64url");

/** AES-256-GCM, `v1.<iv|tag|ciphertext>` (base64url). The key never leaves the environment; the output never contains the plaintext. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`;
}

/** Null when the blob is malformed, was made under another key, or was altered. */
export function decryptSecret(blob: string, key: Buffer): string | null {
  if (!blob.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(blob.slice(3), "base64url");
    if (raw.length < 12 + 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** PKCE S256: base64url(sha256(verifier)). */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Unguessable origin-bound hash for rate-limit keys, so an address is never stored. */
export const keyHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
