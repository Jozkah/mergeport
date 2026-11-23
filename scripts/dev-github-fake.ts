/**
 * A local, fake GitHub for development and browser checks:  npm run dev:github-fake
 * Wraps the in-process fake used by the tests (src/lib/github/fake-server.ts) in a plain HTTP server on 127.0.0.1 so the whole GitHub UI
 * (connect, link, sign in with GitHub, issue and comment writes, sync) can be exercised without real GitHub. Steps: docs/dev-github-fake.md.
 *
 * Point the app at it with MERGEPORT_GITHUB_API_BASE and MERGEPORT_GITHUB_WEB_BASE (both http://127.0.0.1:4010, honoured only in
 * development). The App values (id, private key, client id and secret, slug) are read from the SAME environment the app uses; the fake
 * trusts the app JWT signed with that key. Seeded: org `fake-org` (owner `devuser`, member `teammate`), a public and a private
 * repository with issues and pull requests, and the App installed on the org. Not GitHub: a simulation of documented behaviour.
 *
 *   FAKE_GITHUB_PORT   port (default 4010)             FAKE_GITHUB_LOGIN  the person the authorize page approves (default devuser)
 *   FAKE_GITHUB_EMAIL  devuser's verified primary email (default dev@mergeport.test; use the address you sign in with by magic link)
 *   MERGEPORT_PUBLIC_URL  where the app answers (default http://127.0.0.1:3100): the install page sends the browser back to it
 */
import "dotenv/config";
import http from "node:http";
import { readGithubAppEnv } from "../src/lib/github/app-config";
import { FakeGitHubServer } from "../src/lib/github/fake-server";

const port = Number(process.env.FAKE_GITHUB_PORT ?? 4010);
const login = (process.env.FAKE_GITHUB_LOGIN ?? "devuser").trim();
const email = (process.env.FAKE_GITHUB_EMAIL ?? "dev@mergeport.test").trim();
const appOrigin = new URL(process.env.MERGEPORT_PUBLIC_URL?.trim() || "http://127.0.0.1:3100").origin;
const ORG = "fake-org";

const env = readGithubAppEnv();
if (!env.config || env.problems.length) {
  console.error("The GitHub App values are missing or invalid. Set these (docs/dev-github-fake.md):");
  console.error("  MERGEPORT_GITHUB_APP_ID, MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE (or _PRIVATE_KEY), MERGEPORT_GITHUB_APP_WEBHOOK_SECRET,");
  console.error("  MERGEPORT_GITHUB_APP_CLIENT_ID, MERGEPORT_GITHUB_APP_CLIENT_SECRET, MERGEPORT_GITHUB_APP_SLUG");
  for (const p of env.problems) console.error(`  - ${p}`);
  process.exit(1);
}
const config = env.config;

// ---------- seed ----------
const fake = new FakeGitHubServer();
fake.registerAppWithKey(config.appId, config.privateKeyPem);
fake.setOAuthClient(config.clientId, config.clientSecret);
fake.addUser(login);
fake.addUser("teammate");
fake.addOrg(ORG, [login], ["teammate"]);
fake.setEmails(login, [{ email, primary: true, verified: true }]);

const asOwner = fake.fetchFor(login);
const create = async (name: string, isPrivate: boolean) => {
  const r = await asOwner(`https://api.github.com/orgs/${ORG}/repos`, { method: "POST", body: JSON.stringify({ name, private: isPrivate }) });
  if (r.status !== 201) throw new Error(`seed: could not create ${name} (${r.status})`);
  await asOwner(`https://api.github.com/repos/${ORG}/${name}/contents/README.md`, { method: "PUT", body: JSON.stringify({ message: "Initial commit", content: Buffer.from(`# ${name}\n\nSeeded by the fake GitHub.\n`).toString("base64") }) });
};
await create("public-repo", false);
await create("private-repo", true);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
fake.addWork(ORG, "public-repo", { number: 1, title: "Grid loses focus after sorting", body: "Steps:\n1. Sort a column\n2. Press Tab", author: "teammate", updatedAt: ago(3) });
fake.addWork(ORG, "public-repo", { number: 2, title: "Support custom row renderers", author: login, updatedAt: ago(2), comments: [{ id: 9001, user: "teammate", body: "Would love this." }] });
fake.addWork(ORG, "public-repo", { number: 3, kind: "pr", title: "Fix focus handling after sort", author: "teammate", updatedAt: ago(1), reviews: [{ id: 9101, user: login, state: "APPROVED" }], requested: [login] });
fake.addWork(ORG, "public-repo", { number: 4, title: "Old report, already fixed", author: login, state: "closed", updatedAt: ago(20) });
fake.addWork(ORG, "private-repo", { number: 1, title: "Rotate the staging credentials", author: login, updatedAt: ago(5) });
fake.addWork(ORG, "private-repo", { number: 2, kind: "pr", title: "Add the billing export", author: login, updatedAt: ago(1), requested: ["teammate"] });
fake.addWork(ORG, "private-repo", { number: 3, kind: "pr", title: "Draft: new onboarding copy", author: "teammate", updatedAt: ago(0.2) });
const installation = fake.addInstallation(ORG, { selection: "all" });

// ---------- http ----------
const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
const text = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
};
const redirect = (res: http.ServerResponse, to: string) => {
  res.writeHead(302, { location: to, "cache-control": "no-store" });
  res.end();
};
const loopbackTarget = (raw: string | null): URL | null => {
  try {
    const u = raw ? new URL(raw) : null;
    return u && (u.protocol === "http:" || u.protocol === "https:") && loopback(u.hostname) ? u : null;
  } catch {
    return null;
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const method = (req.method ?? "GET").toUpperCase();
    if (fake.calls.length > 5000) fake.calls.splice(0, 2500);

    if (method === "GET" && url.pathname === "/") return text(res, 200, `Fake GitHub for Mergeport development (not GitHub).\nOrg ${ORG}, user ${login}, installation ${installation.id}.\nState: /__fake/state\n`);
    if (method === "GET" && url.pathname === "/__fake/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ login, installationId: installation.id, userWrites: fake.userWrites.map((w) => ({ ...w, tokenPrefix: undefined })), recentCalls: fake.calls.slice(-50) }, null, 2));
    }

    // Browser pages. Both auto-approve as `login` and send the browser straight back, as GitHub does after the person agrees.
    if (method === "GET" && url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== config.clientId) return text(res, 404, "Unknown client_id (it must be MERGEPORT_GITHUB_APP_CLIENT_ID).");
      const back = loopbackTarget(url.searchParams.get("redirect_uri"));
      if (!back) return text(res, 400, "redirect_uri must be an http(s) address on a loopback name.");
      const code = fake.issueOAuthCode(login, { redirectUri: back.href, codeChallenge: url.searchParams.get("code_challenge") ?? undefined });
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      return redirect(res, back.href);
    }
    const inst = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
    if (method === "GET" && inst) {
      if (decodeURIComponent(inst[1]) !== config.slug) return text(res, 404, "Unknown App slug (it must be MERGEPORT_GITHUB_APP_SLUG).");
      const back = new URL("/api/github/app/callback", appOrigin);
      const code = fake.issueOAuthCode(login, { redirectUri: back.href });
      back.searchParams.set("code", code);
      back.searchParams.set("installation_id", String(installation.id));
      back.searchParams.set("setup_action", "install");
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      return redirect(res, back.href);
    }

    // Everything else is the REST API (and the OAuth token exchange, which the fake recognises by the github.com host).
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
    const isToken = url.pathname === "/login/oauth/access_token";
    const target = new URL(url.pathname + url.search, isToken ? "https://github.com" : "https://api.github.com");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await fake.appFetch()(target, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => (out[k] = v));
    // Absolute links in the fake's paging headers name api.github.com; clients follow them against this server instead.
    if (out.link) out.link = out.link.replaceAll("https://api.github.com", `http://127.0.0.1:${port}`);
    res.writeHead(r.status, out);
    res.end(r.status === 204 || r.status === 304 ? undefined : Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("fake github error:", e instanceof Error ? e.message : e);
    if (!res.headersSent) text(res, 500, "fake github error");
    else res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\nFake GitHub ready on http://127.0.0.1:${port}  (org ${ORG}, user ${login}, ${email}, installation ${installation.id})`);
  console.log(`  MERGEPORT_GITHUB_API_BASE=http://127.0.0.1:${port}\n  MERGEPORT_GITHUB_WEB_BASE=http://127.0.0.1:${port}\n  Install redirects back to ${appOrigin}. Ctrl+C stops it.`);
});
server.on("error", (e) => {
  console.error(`Could not listen on 127.0.0.1:${port}:`, e.message);
  process.exit(1);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
