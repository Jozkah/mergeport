import { createPrivateKey, type KeyObject } from "node:crypto";
import fs from "node:fs";

/**
 * The deployment's GitHub App, read from the environment (docs/github-app.md). ONE App per deployment, registered by the operator.
 *
 *   MERGEPORT_GITHUB_APP_ID, MERGEPORT_GITHUB_APP_PRIVATE_KEY (PEM, newlines may be written as \n) or MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE,
 *   MERGEPORT_GITHUB_APP_WEBHOOK_SECRET, MERGEPORT_GITHUB_APP_CLIENT_ID, MERGEPORT_GITHUB_APP_CLIENT_SECRET, MERGEPORT_GITHUB_APP_SLUG.
 *
 * Completely unset: the App is simply not configured (hosted workspaces show "not connected" as before). Partly set: a configuration
 * problem. No message here ever contains a value of these variables, only their names.
 */

export type EnvLike = Record<string, string | undefined>;

export type GithubAppConfig = {
  appId: string;
  /** PEM text with real newlines. Never stored, never logged. */
  privateKeyPem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  slug: string;
};

export type GithubAppEnv = { config: GithubAppConfig | null; problems: string[]; anySet: boolean };

const VARS = [
  "MERGEPORT_GITHUB_APP_ID",
  "MERGEPORT_GITHUB_APP_PRIVATE_KEY",
  "MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE",
  "MERGEPORT_GITHUB_APP_WEBHOOK_SECRET",
  "MERGEPORT_GITHUB_APP_CLIENT_ID",
  "MERGEPORT_GITHUB_APP_CLIENT_SECRET",
  "MERGEPORT_GITHUB_APP_SLUG",
] as const;

export const MIN_WEBHOOK_SECRET = 16;
export const MIN_CLIENT_SECRET = 20;
export const MIN_CLIENT_ID = 8;
export const MIN_RSA_BITS = 2048;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const APP_ID = /^[1-9]\d{0,14}$/;

const val = (env: EnvLike, k: string) => (env[k] ?? "").trim();

/** PEM text from a variable: real newlines stay, a literal backslash-n becomes a newline, surrounding quotes are dropped. */
export function normalizePem(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1);
  return s.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim() + "\n";
}

/** The parsed private key, or a fixed-text problem (the parser's own message is dropped: it may echo input). */
export function parsePrivateKey(pem: string): { key: KeyObject } | { problem: string } {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return { problem: "the GitHub App private key is not a valid PEM private key" };
  }
  if (key.asymmetricKeyType !== "rsa") return { problem: "the GitHub App private key must be an RSA key" };
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) return { problem: `the GitHub App private key must be at least ${MIN_RSA_BITS} bits` };
  return { key };
}

/** Reads and validates the variables. Pure apart from reading the key file when one is named. */
export function readGithubAppEnv(env: EnvLike = process.env): GithubAppEnv {
  const anySet = VARS.some((k) => val(env, k) !== "");
  if (!anySet) return { config: null, problems: [], anySet: false };
  const problems: string[] = [];

  const appId = val(env, "MERGEPORT_GITHUB_APP_ID");
  const webhookRaw = env.MERGEPORT_GITHUB_APP_WEBHOOK_SECRET ?? "";
  const webhookSecret = webhookRaw.trim() === "" ? "" : webhookRaw; // never trimmed: the HMAC key is exactly what GitHub was given
  const clientId = val(env, "MERGEPORT_GITHUB_APP_CLIENT_ID");
  const clientSecret = val(env, "MERGEPORT_GITHUB_APP_CLIENT_SECRET");
  const slug = val(env, "MERGEPORT_GITHUB_APP_SLUG");
  const keyRaw = val(env, "MERGEPORT_GITHUB_APP_PRIVATE_KEY");
  const keyFile = val(env, "MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE");

  if (!appId) problems.push("MERGEPORT_GITHUB_APP_ID is required when any GitHub App variable is set.");
  else if (!APP_ID.test(appId)) problems.push("MERGEPORT_GITHUB_APP_ID must be the numeric App ID.");

  let privateKeyPem = "";
  if (keyRaw && keyFile) problems.push("Set only one of MERGEPORT_GITHUB_APP_PRIVATE_KEY and MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE.");
  else if (!keyRaw && !keyFile) problems.push("MERGEPORT_GITHUB_APP_PRIVATE_KEY or MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE is required when any GitHub App variable is set.");
  else {
    let text = keyRaw;
    if (keyFile) {
      try {
        text = fs.readFileSync(keyFile, "utf8");
      } catch {
        problems.push("MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE cannot be read.");
        text = "";
      }
    }
    if (text) {
      const pem = normalizePem(text);
      const parsed = parsePrivateKey(pem);
      if ("problem" in parsed) problems.push(`${keyFile ? "MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE" : "MERGEPORT_GITHUB_APP_PRIVATE_KEY"}: ${parsed.problem}.`);
      else privateKeyPem = pem;
    }
  }

  if (!webhookSecret) problems.push("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET is required when any GitHub App variable is set.");
  else if (webhookSecret !== webhookSecret.trim()) problems.push("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET has leading or trailing whitespace; remove it (the secret is used exactly as written, so it must match GitHub's byte for byte).");
  else if (webhookSecret.length < MIN_WEBHOOK_SECRET) problems.push(`MERGEPORT_GITHUB_APP_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET} characters.`);

  if (!clientId) problems.push("MERGEPORT_GITHUB_APP_CLIENT_ID is required when any GitHub App variable is set.");
  else if (clientId.length < MIN_CLIENT_ID || /\s/.test(clientId)) problems.push(`MERGEPORT_GITHUB_APP_CLIENT_ID must be the App's client ID (at least ${MIN_CLIENT_ID} characters, no spaces).`);

  if (!clientSecret) problems.push("MERGEPORT_GITHUB_APP_CLIENT_SECRET is required when any GitHub App variable is set.");
  else if (clientSecret.length < MIN_CLIENT_SECRET) problems.push(`MERGEPORT_GITHUB_APP_CLIENT_SECRET must be at least ${MIN_CLIENT_SECRET} characters.`);

  if (!slug) problems.push("MERGEPORT_GITHUB_APP_SLUG is required when any GitHub App variable is set.");
  else if (!SLUG.test(slug)) problems.push("MERGEPORT_GITHUB_APP_SLUG must be the App's URL name: lowercase letters, digits and hyphens, at most 39 characters.");

  if (problems.length) return { config: null, problems, anySet: true };
  return { config: { appId, privateKeyPem, webhookSecret, clientId, clientSecret, slug }, problems: [], anySet: true };
}

/** Empty when the App is fully configured or completely unset; one line per problem when it is partly or wrongly set. */
export function githubAppConfigProblems(env: EnvLike = process.env): string[] {
  return readGithubAppEnv(env).problems;
}

/** True only when every variable is set and valid. */
export function githubAppConfigured(env: EnvLike = process.env): boolean {
  return readGithubAppEnv(env).config !== null;
}

let memo: { config: GithubAppConfig | null } | null = null;

/**
 * The validated configuration, or null when the App is not (fully) configured. Called with no argument it reads the process
 * environment ONCE and remembers the answer (the key file is read and parsed once, so changing the key needs a restart);
 * an explicit `env` is always parsed fresh.
 */
export function githubAppConfig(env?: EnvLike): GithubAppConfig | null {
  if (env) return readGithubAppEnv(env).config;
  if (!memo) memo = { config: readGithubAppEnv(process.env).config };
  return memo.config;
}

/** Test hook: forget the remembered process configuration. */
export function resetGithubAppConfigCache(): void {
  memo = null;
}
