import { z } from "zod";

/**
 * Local-first configuration. Nothing here is a secret that is shared between teammates: there is no shared
 * database URL, no shared encryption key, no GitHub App private key and no OAuth client secret. GitHub credentials
 * live in the GitHub CLI's own store (OS keyring by default) and are never read by this application.
 */
const schema = z.object({
  /** Where profiles live. Default: ~/.mergeport */
  MERGEPORT_HOME: z.string().optional(),
  /** SQLite file of the active profile. Set by the launcher; defaults to ./.data/dev.db for development. */
  MERGEPORT_DB: z.string().optional(),
  MERGEPORT_HOST: z.string().default("github.com"),
  MERGEPORT_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** One-time token the launcher puts in the URL it opens, to bind the browser to this process. */
  MERGEPORT_LAUNCH_TOKEN: z.string().optional(),
  /** Optional override of the GitHub CLI command, JSON array, e.g. ["node","fake-gh.mjs"]. Used by tests. */
  MERGEPORT_GH_CMD: z.string().optional(),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  /** Active coordination polling interval in seconds (floor 15). */
  MERGEPORT_POLL_SECONDS: z.coerce.number().int().min(15).default(30),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) throw new Error("Invalid environment: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    cached = parsed.data;
  }
  return cached;
}

export const resetEnvCache = () => {
  cached = undefined;
};
export const isDemo = () => env().DEMO_MODE === "true";
