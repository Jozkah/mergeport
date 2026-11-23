import { z } from "zod";

/**
 * Process configuration read through env(). The hosted deployment's own settings (public URL, GitHub App, sign-in, federation, MCP)
 * are read where they are used, from their own modules (docs/github-app.md, docs/auth.md, docs/federation.md, docs/mcp.md).
 */
const schema = z.object({
  /** Demo mode: synthetic data, no GitHub access. `npm run demo` sets it for the dev server. */
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
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
