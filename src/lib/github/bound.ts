import { IdentityError, type GhRunner, type GhRunOpts } from "./exec";
import { getGhRunner } from "./gh";

/**
 * Binds every GitHub call to ONE account: the immutable numeric user id the local profile was created for.
 *
 * `gh api` with no credential uses whichever account the CLI has selected globally, and that can change at any moment
 * (`gh auth switch` in another terminal). Re-checking "who is selected?" before a call cannot fix that: the selection can
 * change between the check and the call. So the call never depends on the selection. Instead:
 *
 *   1. ask the CLI for THIS account's token explicitly (`gh auth token --user <login>`; a token, not "the active one");
 *   2. verify, using that very token, that it belongs to the profile's numeric id (`GET /user`);
 *   3. run the real call with that token in the child's environment (never in arguments, never in a log, never in a
 *      response to the browser). The token fixes the account for the whole call.
 *
 * If the account is not signed in, is a different id (a renamed or recycled login), or the CLI is too old for `--user`,
 * the call is BLOCKED with an IdentityError and the person is asked to reconnect. It never falls back to another account.
 * A 401 from GitHub drops the remembered token so the next call re-verifies from scratch.
 */

export type Binding = { id: bigint; login: string; host: string };

type Credential = { ok: true; token: string } | { ok: false; transient: Awaited<ReturnType<GhRunner>> };

const cache = new Map<string, Promise<Credential>>();
const keyOf = (b: Binding) => `${b.host}#${b.id}`;

export const forgetCredential = (b: Binding) => void cache.delete(keyOf(b));
export const forgetAllCredentials = () => cache.clear();

/** The environment variable gh reads for a host's token. */
export const tokenEnv = (host: string, token: string): Record<string, string> => (host === "github.com" ? { GH_TOKEN: token } : { GH_ENTERPRISE_TOKEN: token, GH_HOST: host });

const redact = (text: string, token: string) => (token ? text.split(token).join("***") : text);

async function acquire(b: Binding, base: GhRunner, signal?: AbortSignal): Promise<Credential> {
  const t = await base(["auth", "token", "--hostname", b.host, "--user", b.login], { timeoutMs: 10_000, signal });
  const token = t.stdout.trim();
  if (t.code !== 0 || !token) {
    if (/unknown (shorthand )?flag|unknown command/i.test(t.stderr)) throw new IdentityError("unsupported-gh", "This GitHub CLI is too old to select an account. Update gh (2.40 or newer) and reconnect.");
    throw new IdentityError("not-signed-in", `${b.login} is not signed in to the GitHub CLI on ${b.host}. Run: gh auth login --hostname ${b.host}  (or gh auth switch), then reconnect.`);
  }
  const who = await base(["api", "--hostname", b.host, "user"], { timeoutMs: 15_000, signal, env: tokenEnv(b.host, token) });
  if (who.code !== 0) {
    if (/HTTP 401|bad credentials|requires authentication/i.test(who.stderr + who.stdout)) throw new IdentityError("not-signed-in", `The stored GitHub sign-in for ${b.login} is no longer valid. Run: gh auth login --hostname ${b.host}, then reconnect.`);
    return { ok: false, transient: { stdout: "", stderr: redact(who.stderr, token), code: who.code } }; // offline or similar: behaves like any other unreachable call
  }
  let id: string | undefined;
  try {
    id = String((JSON.parse(who.stdout) as { id?: number | string }).id);
  } catch {
    return { ok: false, transient: { stdout: "", stderr: "Unexpected response while verifying the GitHub account", code: 1 } };
  }
  if (id !== b.id.toString()) throw new IdentityError("mismatch", `The GitHub sign-in named ${b.login} now belongs to a different account than this profile (user id ${b.id}). Nothing was sent. Reconnect as the original account, or start Mergeport for the other one.`);
  return { ok: true, token };
}

/** A runner that can only ever act as `binding`. The base runner is resolved at call time so tests can substitute it. */
export function bindRunner(binding: Binding, base: () => GhRunner = getGhRunner): GhRunner {
  return async (args: string[], opts: GhRunOpts = {}) => {
    const run = base();
    let entry = cache.get(keyOf(binding));
    if (!entry) {
      entry = acquire(binding, run, opts.signal).catch((e) => {
        cache.delete(keyOf(binding)); // blocked or failed: try again from scratch next time, never cache a refusal
        throw e;
      });
      cache.set(keyOf(binding), entry);
    }
    const cred = await entry;
    if (!cred.ok) {
      cache.delete(keyOf(binding));
      return cred.transient;
    }
    const res = await run(args, { ...opts, env: { ...opts.env, ...tokenEnv(binding.host, cred.token) } });
    if (/^HTTP\/[\d.]+ 401\b/.test(res.stdout)) forgetCredential(binding);
    return { ...res, stderr: redact(res.stderr, cred.token) };
  };
}
