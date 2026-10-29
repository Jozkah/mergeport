import { z } from "zod";

export type HubConfig = {
  port: number;
  dataDir: string;
  publicUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  trustProxy: boolean;
  /** Tests only: override via MERGEPORT_HUB_GITHUB_API_BASE. */
  githubApiBase: string;
  /** Tests only: override via MERGEPORT_HUB_GITHUB_OAUTH_BASE. */
  githubOauthBase: string;
  bindHost: "0.0.0.0" | "127.0.0.1";
};

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  MERGEPORT_HUB_PORT: z.string().regex(/^\d+$/, "must be a port number").default("8787").transform(Number),
  MERGEPORT_HUB_DATA: z.string().min(1),
  MERGEPORT_HUB_PUBLIC_URL: z.string().url(),
  MERGEPORT_HUB_GITHUB_CLIENT_ID: z.string().min(1),
  MERGEPORT_HUB_GITHUB_CLIENT_SECRET: z.string().min(1),
  MERGEPORT_HUB_TRUST_PROXY: bool.default(true),
  MERGEPORT_HUB_GITHUB_API_BASE: z.string().url().default("https://api.github.com"),
  MERGEPORT_HUB_GITHUB_OAUTH_BASE: z.string().url().default("https://github.com"),
});

export function loadConfig(env: Record<string, string | undefined>): HubConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`);
    throw new Error(`Invalid hub configuration. ${problems.join("; ")}`);
  }
  const e = parsed.data;
  const publicUrl = e.MERGEPORT_HUB_PUBLIC_URL.replace(/\/+$/, "");
  // Bind all interfaces only when no proxy fronts the hub and the public URL is https; otherwise loopback.
  const direct = !e.MERGEPORT_HUB_TRUST_PROXY && publicUrl.startsWith("https://");
  return {
    port: e.MERGEPORT_HUB_PORT,
    dataDir: e.MERGEPORT_HUB_DATA,
    publicUrl,
    githubClientId: e.MERGEPORT_HUB_GITHUB_CLIENT_ID,
    githubClientSecret: e.MERGEPORT_HUB_GITHUB_CLIENT_SECRET,
    trustProxy: e.MERGEPORT_HUB_TRUST_PROXY,
    githubApiBase: e.MERGEPORT_HUB_GITHUB_API_BASE.replace(/\/+$/, ""),
    githubOauthBase: e.MERGEPORT_HUB_GITHUB_OAUTH_BASE.replace(/\/+$/, ""),
    bindHost: direct ? "0.0.0.0" : "127.0.0.1",
  };
}
