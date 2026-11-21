import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { githubAppConfig, githubAppConfigProblems, githubAppConfigured, readGithubAppEnv } from "@/lib/github/app-config";

const pair = (opts: { type: "rsa"; bits: number } | { type: "ec" }) =>
  opts.type === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: opts.bits, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey
    : generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;

let pem: string;
let weak: string;
let ec: string;
beforeAll(() => {
  pem = pair({ type: "rsa", bits: 2048 });
  weak = pair({ type: "rsa", bits: 1024 });
  ec = pair({ type: "ec" });
});

const SECRETS = { webhook: "whsec_0123456789abcdef0123", client: "client-secret-0123456789abcdef0123" };
const full = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  MERGEPORT_GITHUB_APP_ID: "123456",
  MERGEPORT_GITHUB_APP_PRIVATE_KEY: pem,
  MERGEPORT_GITHUB_APP_WEBHOOK_SECRET: SECRETS.webhook,
  MERGEPORT_GITHUB_APP_CLIENT_ID: "Iv1.0123456789abcdef",
  MERGEPORT_GITHUB_APP_CLIENT_SECRET: SECRETS.client,
  MERGEPORT_GITHUB_APP_SLUG: "mergeport-acme",
  ...over,
});

describe("GitHub App configuration", () => {
  it("is absent and fine when nothing is set", () => {
    expect(githubAppConfigured({})).toBe(false);
    expect(githubAppConfigProblems({})).toEqual([]);
    expect(githubAppConfig({})).toBeNull();
    expect(githubAppConfigProblems({ MERGEPORT_GITHUB_APP_ID: "  " })).toEqual([]);
  });

  it("accepts a complete configuration", () => {
    const c = githubAppConfig(full())!;
    expect(c.appId).toBe("123456");
    expect(c.slug).toBe("mergeport-acme");
    expect(githubAppConfigured(full())).toBe(true);
    expect(githubAppConfigProblems(full())).toEqual([]);
  });

  it("reports each missing variable when only some are set", () => {
    const env = { MERGEPORT_GITHUB_APP_ID: "123456", MERGEPORT_GITHUB_APP_SLUG: "x-app" };
    const p = githubAppConfigProblems(env).join("\n");
    expect(githubAppConfigured(env)).toBe(false);
    for (const v of ["PRIVATE_KEY", "WEBHOOK_SECRET", "CLIENT_ID", "CLIENT_SECRET"]) expect(p).toContain(`MERGEPORT_GITHUB_APP_${v}`);
    expect(p).not.toContain("MERGEPORT_GITHUB_APP_ID is required");
  });

  it("restores escaped newlines in the key and strips quotes", () => {
    const escaped = pem.trim().replace(/\n/g, "\\n");
    expect(githubAppConfig(full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: escaped }))?.privateKeyPem).toBe(pem);
    expect(githubAppConfig(full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: `"${escaped}"` }))).not.toBeNull();
  });

  it("reads the key from a file, and rejects both sources and an unreadable file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghapp-"));
    try {
      const f = path.join(dir, "app.pem");
      fs.writeFileSync(f, pem);
      const viaFile = full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: undefined, MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE: f });
      expect(githubAppConfig(viaFile)?.privateKeyPem).toBe(pem);
      expect(githubAppConfigProblems({ ...viaFile, MERGEPORT_GITHUB_APP_PRIVATE_KEY: pem }).join()).toContain("only one");
      const missing = githubAppConfigProblems({ ...viaFile, MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE: path.join(dir, "nope.pem") }).join();
      expect(missing).toContain("cannot be read");
      expect(missing).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the key: PEM, RSA, at least 2048 bits", () => {
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: "not a key" })).join()).toContain("valid PEM");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: ec })).join()).toContain("RSA");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_PRIVATE_KEY: weak })).join()).toContain("2048");
  });

  it("validates app id, slug, and minimum secret lengths", () => {
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_ID: "abc" })).join()).toContain("numeric");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_SLUG: "Bad Slug!" })).join()).toContain("MERGEPORT_GITHUB_APP_SLUG");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_SLUG: "-lead" })).length).toBe(1);
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_WEBHOOK_SECRET: "short" })).join()).toContain("WEBHOOK_SECRET must be at least");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_CLIENT_SECRET: "short" })).join()).toContain("CLIENT_SECRET must be at least");
    expect(githubAppConfigProblems(full({ MERGEPORT_GITHUB_APP_CLIENT_ID: "x" })).join()).toContain("CLIENT_ID");
  });

  it("never puts a secret value in a message, even for invalid values", () => {
    const secrets = ["super-secret-webhook-value-1", "tiny", "also-too-short-secret", pem.split("\n")[1], "p@ss word"];
    const env = full({
      MERGEPORT_GITHUB_APP_WEBHOOK_SECRET: secrets[0],
      MERGEPORT_GITHUB_APP_CLIENT_SECRET: secrets[1],
      MERGEPORT_GITHUB_APP_CLIENT_ID: secrets[4],
      MERGEPORT_GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${secrets[3]}\n-----END PRIVATE KEY-----`,
      MERGEPORT_GITHUB_APP_SLUG: secrets[2],
      MERGEPORT_GITHUB_APP_ID: "id-secret-9",
    });
    const msgs = githubAppConfigProblems(env).join("\n");
    expect(msgs.length).toBeGreaterThan(0);
    for (const s of secrets.concat("id-secret-9")) expect(msgs).not.toContain(s);
    expect(readGithubAppEnv(env).config).toBeNull();
  });

  describe("hosted startup", () => {
    afterEach(() => vi.unstubAllEnvs());
    const hosted = () => {
      vi.stubEnv("MERGEPORT_PUBLIC_URL", "https://app.example.com");
      vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
    };
    const clear = () => {
      for (const k of Object.keys(full())) vi.stubEnv(k, "");
      vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE", "");
    };

    it("allows a completely unset App, flags a partial one, accepts a complete one", () => {
      hosted();
      clear();
      expect(hostedConfigProblems()).toEqual([]);
      vi.stubEnv("MERGEPORT_GITHUB_APP_ID", "123456");
      expect(hostedConfigProblems().join()).toContain("MERGEPORT_GITHUB_APP_PRIVATE_KEY");
      for (const [k, v] of Object.entries(full())) vi.stubEnv(k, v as string);
      expect(hostedConfigProblems()).toEqual([]);
    });
  });
});
