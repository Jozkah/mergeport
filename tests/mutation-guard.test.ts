import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static check: every exported function of a "use server" file must pass a role guard before it does anything, so a READER (who
 * looks but never changes anything) cannot reach a mutation through a forgotten action. A guard is a call to requireWriter() (or writerCtx(), the helper in actions.ts that wraps it),
 * requireAdminViewer() or requireWrite(). An action that is allowed to run without one must be listed below WITH A REASON; the test
 * also fails when an entry no longer matches an unguarded function, so the list cannot go stale.
 *
 * What this does not see: a service called from a route handler instead of an action, and a guard in a helper the action calls.
 * Route handlers: see src/lib/api-viewer.ts and the POST routes (ai/draft calls requireWrite itself; backup restore is admin-only in the service).
 */
const GUARD = /\b(requireWriter|requireAdminViewer|requireWrite|writerCtx)\(/;
/** A database write written out in the function itself. When a guard exists it must come first; services called from the function are not inspected (not practical without types). */
const MUTATION = /\b(?:db|tx|prisma)\.\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/;
/** Comments (and a guard named only in one) must not count. A `//` inside a URL string is left alone. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<![:"'`\w])\/\/[^\n]*/g, "");
const guardedFirst = (body: string) => {
  const code = stripComments(body);
  const g = GUARD.exec(code);
  if (!g) return false;
  const m = MUTATION.exec(code);
  return !m || g.index < m.index;
};

type Allow = { file: string; fn: string; reason: string };
const ALLOW: Allow[] = [
  { file: "src/app/account-actions.ts", fn: "createWorkspaceAction", reason: "Identity level: a person with no workspace yet creates their first one. There is no workspace role to check." },
  { file: "src/app/account-actions.ts", fn: "signOutEverywhereAction", reason: "Ends the caller's own sessions; touches no workspace data." },
  { file: "src/app/account-actions.ts", fn: "signOutEverywhereFormAction", reason: "The Settings sheet's form action: it only calls signOutEverywhereAction (own sessions, no workspace data)." },
  { file: "src/app/account-actions.ts", fn: "switchWorkspaceAction", reason: "Chooses among the caller's own ACTIVE memberships; selectWorkspace re-checks membership." },
  { file: "src/app/invite/actions.ts", fn: "acceptInviteAction", reason: "The caller is not a member yet; acceptInvitation checks the token and the verified address." },
  { file: "src/app/invite/actions.ts", fn: "acceptPendingInviteAction", reason: "Same as acceptInviteAction: the caller is not a member yet; the invitation is listed to their verified address and accepted by id under the same checks." },
  { file: "src/app/workspace-actions.ts", fn: "leaveWorkspaceAction", reason: "A reader may leave too; leaveWorkspace refuses the owner and re-reads the membership." },
  { file: "src/app/actions.ts", fn: "setTimezoneAction", reason: "The caller's own timezone." },
  { file: "src/app/actions.ts", fn: "saveFilterAction", reason: "The caller's own saved filter (per person, not per workspace)." },
  { file: "src/app/actions.ts", fn: "deleteFilterAction", reason: "The caller's own saved filter." },
  { file: "src/app/actions.ts", fn: "markNotificationsReadAction", reason: "The caller's own notifications." },
  { file: "src/app/digest-actions.ts", fn: "regenerateDigestAction", reason: "Rebuilds the caller's own digest from data they can already see." },
  { file: "src/app/digest-actions.ts", fn: "markDigestReadAction", reason: "The caller's own digest state." },
  { file: "src/app/digest-actions.ts", fn: "saveDigestSettingsAction", reason: "The caller's own digest preference." },
  { file: "src/app/inbox-actions.ts", fn: "inboxAction", reason: "The caller's own inbox state (read, done, snooze); never shared." },
  { file: "src/app/inbox-actions.ts", fn: "inboxReadAllAction", reason: "The caller's own inbox state." },
  { file: "src/app/inbox-actions.ts", fn: "markSeenAction", reason: "The caller's own seen marker; never a review decision." },
  { file: "src/app/notify-actions.ts", fn: "savePrefsAction", reason: "The caller's own notification preferences." },
  { file: "src/app/palette-actions.ts", fn: "previewQuickAction", reason: "Preview only: computes what applyQuickAction would do and writes nothing." },
  { file: "src/app/scope-actions.ts", fn: "setScopeAction", reason: "Remembers the caller's working scope in a cookie." },
  { file: "src/app/github-link-actions.ts", fn: "startGithubLinkAction", reason: "The caller's OWN GitHub link, any role (a reader links too). Writes only a single-use state row bound to the caller; the link itself is made by the callback, behind state, nonce, PKCE and GitHub's own answer." },
  { file: "src/app/github-link-actions.ts", fn: "unlinkGithubAction", reason: "Removes the caller's OWN link, token, cached access and digests, whatever their role now is. Touches nobody else." },
  { file: "src/app/github-link-actions.ts", fn: "checkGithubAccessAction", reason: "Asks for a refresh of the caller's OWN cached GitHub access (a queued job keyed by the caller's id, rate limited per person). Reads nothing of anyone else." },
  { file: "src/app/api-token-actions.ts", fn: "createApiTokenAction", reason: "Creates a personal access token for the CALLER only, any role; createApiToken limits a READER to a read-only token. Hosted only. The secret is returned once." },
  { file: "src/app/api-token-actions.ts", fn: "revokeApiTokenAction", reason: "Revokes the caller's own token, or any token of the workspace for an administrator; revokeApiToken decides and answers NotFound / Forbidden otherwise." },
  { file: "src/app/oauth-actions.ts", fn: "decideOAuthAction", reason: "The caller's own consent for an app, any role: it re-validates the request against the registered client and redirect address, checks the session CSRF token, lets the caller pick only their own workspaces, and issueCode limits a READER to read access. Hosted only." },
  { file: "src/app/oauth-actions.ts", fn: "revokeOAuthGrantAction", reason: "Disconnects the caller's own app, or any app of the workspace for an administrator; revokeGrant() decides and answers NotFound / Forbidden otherwise." },
  { file: "src/app/federation-actions.ts", fn: "unlinkAction", reason: "Your own link (any role, even after a downgrade to READER); unlink() lets only an administrator end someone else's." },
  { file: "src/app/federation-actions.ts", fn: "approveFederationAction", reason: "The person's own consent to share what they themselves can see, read-only; any role may. Session CSRF token and policy are re-checked in the action and service." },
  { file: "src/app/federation-actions.ts", fn: "denyFederationAction", reason: "Declining a link request; changes nothing but the redirect. Session CSRF token checked." },
  { file: "src/app/server-email-actions.ts", fn: "saveSmtpSettingsAction", reason: "Server-wide, not a workspace: guarded by the SERVER administrator flag (serverAdmin(), and saveSmtpSettings re-reads User.isServerAdmin). A workspace role must not grant it." },
  { file: "src/app/server-email-actions.ts", fn: "sendTestEmailAction", reason: "Server administrators only (serverAdmin()); sends one message to the caller's own address and writes nothing." },
  { file: "src/app/federation-actions.ts", fn: "revokeGrantAction", reason: "Your own grant (any role) or, for an administrator, any grant of the workspace; revokeGrant() decides and answers NotFound otherwise." },
];

const root = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
const isUseServerFile = (src: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(src);

type Fn = { file: string; name: string; guarded: boolean };

function actionFunctions(): { fns: Fn[]; inline: string[] } {
  const fns: Fn[] = [];
  const inline: string[] = [];
  for (const f of walk(path.join(root, "src"))) {
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes("use server")) continue;
    if (!isUseServerFile(src)) {
      inline.push(rel(f)); // an inline "use server" inside a component or page
      continue;
    }
    const re = /^export (?:async function|const|function) (\w+)/gm;
    const starts: { name: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
    starts.forEach((s, i) => {
      const body = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
      fns.push({ file: rel(f), name: s.name, guarded: guardedFirst(body) });
    });
  }
  return { fns, inline };
}

describe("every exported server action passes a role guard", () => {
  const { fns, inline } = actionFunctions();

  it("finds the action files (the scan itself works)", () => {
    expect(fns.length).toBeGreaterThan(100);
    expect(new Set(fns.map((f) => f.file)).size).toBeGreaterThan(15);
  });

  it("has no exported action without a guard that is not on the allowlist", () => {
    const bad = fns.filter((f) => !f.guarded && !ALLOW.some((a) => a.file === f.file && a.fn === f.name)).map((f) => `${f.file}: ${f.name}`);
    expect(bad).toEqual([]);
  });

  it("has no stale allowlist entry (the function exists and really is unguarded)", () => {
    const stale = ALLOW.filter((a) => !fns.some((f) => f.file === a.file && f.name === a.fn && !f.guarded)).map((a) => `${a.file}: ${a.fn}`);
    expect(stale).toEqual([]);
    for (const a of ALLOW) expect(a.reason.length).toBeGreaterThan(15);
  });

  it("there are no inline server actions", () => {
    expect(inline.sort()).toEqual([]);
  });

  it("every member and space administration action is guarded", () => {
    const mine = fns.filter((f) => f.file === "src/app/workspace-actions.ts" && f.name !== "leaveWorkspaceAction");
    expect(mine.length).toBeGreaterThanOrEqual(12);
    expect(mine.every((f) => f.guarded)).toBe(true);
  });
});

/**
 * Route handlers: a POST, PUT, PATCH or DELETE under src/app must pass the same guard, or be listed with a reason. The demo's own
 * routes (src/app/api/local) are loopback-only, answer 404 on a hosted server and have no workspace viewer.
 */
const ROUTE_ALLOW: { file: string; reason: string }[] = [
  { file: "src/app/api/backup/preview/route.ts", reason: "Read-only preview; previewRestore refuses non-administrators and writes nothing." },
  { file: "src/app/api/backup/restore/route.ts", reason: "restoreBackup refuses non-administrators (an administrator always writes), and applies the space ACL." },
  { file: "src/app/auth/magic/request/route.ts", reason: "Sign-in: asks for a link before any session exists." },
  { file: "src/app/setup/claim/route.ts", reason: "First server administrator: the single-use setup link printed at server start is the credential (claimSetup uses it once, only while nobody is server administrator). Rate limited per address; 404 unless hosted." },
  { file: "src/app/api/federation/v1/token/route.ts", reason: "Server to server: a one-time PKCE code is the credential; there is no session or viewer. 404 unless federation is on." },
  { file: "src/app/api/github/webhook/route.ts", reason: "Server to server: GitHub signs the body with the App's webhook secret (HMAC checked before anything else); there is no session or viewer. 404 unless hosted and the App is configured. It only queues refreshes and records installation state of installations we already hold." },
  { file: "src/app/api/mcp/route.ts", reason: "Server to client AI apps: a personal access token (Bearer) is the credential, bound to one workspace and person; the viewer is loaded fresh per call and every write tool checks the token scope AND requireWrite (tests/mcp-hosted.test.ts). 404 unless hosted." },
  { file: "src/app/api/oauth/register/route.ts", reason: "Dynamic client registration (RFC 7591): no credential by design, no session or viewer. Public clients only, https or loopback redirect addresses, address rate limit and a cap on the table; a registered app can do nothing until a signed-in person consents. 404 unless hosted." },
  { file: "src/app/api/oauth/token/route.ts", reason: "OAuth token endpoint: the credential is a single-use authorization code with its PKCE verifier, or a rotating refresh token; there is no session. It only issues tokens for a grant a signed-in person consented to, and re-loads that person's membership. 404 unless hosted." },
  { file: "src/app/api/federation/v1/revoke/route.ts", reason: "Server to server: the bearer token being revoked is the credential; it only ever ends that token." },
];
const ROUTE_ALLOW_PREFIX = [{ prefix: "src/app/api/local/", reason: "Demo sign-in and sign-out: loopback only, 404 when hosted, no workspace viewer." }];

function routeHandlers() {
  const out: { file: string; method: string; guarded: boolean }[] = [];
  for (const f of walk(path.join(root, "src/app")).filter((x) => /route\.ts$/.test(x))) {
    const src = fs.readFileSync(f, "utf8");
    const re = /^export (?:async )?function (POST|PUT|PATCH|DELETE)\b/gm;
    const starts: { method: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) starts.push({ method: m[1], at: m.index });
    starts.forEach((st, i) => out.push({ file: rel(f), method: st.method, guarded: guardedFirst(src.slice(st.at, i + 1 < starts.length ? starts[i + 1].at : src.length)) }));
  }
  return out;
}

describe("every mutating route handler passes a role guard", () => {
  const handlers = routeHandlers();
  const allowed = (file: string) => ROUTE_ALLOW.some((a) => a.file === file) || ROUTE_ALLOW_PREFIX.some((a) => file.startsWith(a.prefix));

  it("finds the handlers", () => {
    expect(handlers.length).toBeGreaterThan(10);
    expect(handlers.some((h) => h.file === "src/app/api/ai/draft/route.ts" && h.guarded)).toBe(true);
  });

  it("has no POST/PUT/PATCH/DELETE without a guard that is not allowlisted", () => {
    expect(handlers.filter((h) => !h.guarded && !allowed(h.file)).map((h) => `${h.file}: ${h.method}`)).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    expect(ROUTE_ALLOW.filter((a) => !handlers.some((h) => h.file === a.file && !h.guarded)).map((a) => a.file)).toEqual([]);
    expect(ROUTE_ALLOW_PREFIX.filter((a) => !handlers.some((h) => h.file.startsWith(a.prefix) && !h.guarded)).map((a) => a.prefix)).toEqual([]);
  });
});

describe("the guard detector itself", () => {
  it("ignores a guard that only appears in a comment, and demands it before a database write", () => {
    expect(guardedFirst("export async function a() {\n  // requireWriter() later\n  await db.task.create({});\n}")).toBe(false);
    expect(guardedFirst("export async function a() {\n  /* requireWrite(v) */\n}")).toBe(false);
    expect(guardedFirst("export async function a() {\n  await db.task.create({});\n  await requireWriter();\n}")).toBe(false);
    expect(guardedFirst("export async function a() {\n  const { viewer } = await requireWriter();\n  await db.task.create({});\n}")).toBe(true);
    expect(guardedFirst("export async function a() {\n  const u = \"https://x.example\"; requireWrite(v);\n}")).toBe(true);
  });
});
