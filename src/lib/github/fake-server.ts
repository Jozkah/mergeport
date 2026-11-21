import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";

/**
 * In-memory GitHub, enough REST surface to run team creation, invitations, discovery and the coordination
 * repository protocol (contents, git data, refs, collaborators, invitations) with REAL permission checks per acting user.
 * It is a SIMULATION of documented behaviour for tests; passing against it is not live GitHub verification.
 */

type Perm = "none" | "pull" | "push" | "admin";
type Obj = { type: "blob"; content: string } | { type: "tree"; files: Record<string, string> } | { type: "commit"; tree: string; parents: string[]; message: string };
type Invitation = { id: number; invitee: string; inviter: string; permission: Perm; createdAt: number; expired: boolean };
type FakeRepo = {
  id: number; owner: string; name: string; private: boolean; defaultBranch: string;
  collaborators: Map<string, Perm>; invitations: Map<number, Invitation>;
  objects: Map<string, Obj>; refs: Map<string, string>;
  pulls?: Map<number, { number: number; state: "open" | "closed"; head: string; base: string; title: string; body: string }>;
  /** Releases as GitHub's REST lists them, newest first. */
  releases?: { id: number; tag_name: string; name: string | null; html_url: string; published_at: string | null; draft: boolean; prerelease: boolean; body: string | null }[];
  /** Issues and pull requests (see `addWork`); read with installation tokens. */
  work?: { id: number; number: number; kind: "issue" | "pr"; title: string; author: string; state: "open" | "closed"; updatedAt: string; headSha: string; reviews?: { id: number; user: string; state: string }[]; requested?: string[]; comments?: { id: number; user: string; body: string }[] }[];
};

export type FakeInstallation = { id: number; accountLogin: string; accountId: number; accountType: "User" | "Organization"; selection: "all" | "selected"; repos: Set<string>; suspended: boolean };

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), ...headers } });

export class FakeGitHubServer {
  users = new Map<string, { id: number; login: string }>();
  orgs = new Map<string, { id: number; login: string; owners: Set<string>; members: Set<string> }>();
  repos = new Map<string, FakeRepo>();
  calls: string[] = [];
  installations = new Map<number, FakeInstallation>();
  private app: { appId: string; publicKeyPem: string } | null = null;
  private instTokens = new Map<string, { installationId: number; expiresAt: number }>();
  private userTokens = new Map<string, string>();
  offline = false;
  rateLimitedUntil: number | null = null;
  private nextId = 1000;
  private nextInv = 1;
  private failures: { re: RegExp; status: number; message: string; times: number }[] = [];
  private lose: RegExp[] = [];
  /** Per-user override: requests by this login see a revoked/removed collaborator state immediately. */
  constructor(public clock: () => number = () => Date.now()) {}

  addUser(login: string): { id: number; login: string } {
    const u = { id: this.nextId++, login };
    this.users.set(login, u);
    return u;
  }
  addOrg(login: string, owners: string[], members: string[] = []) {
    this.orgs.set(login, { id: this.nextId++, login, owners: new Set(owners), members: new Set([...owners, ...members]) });
  }
  failNext(re: RegExp, status: number, message: string, times = 1) {
    this.failures.push({ re, status, message, times });
  }
  /** The next matching request is APPLIED, then the response is lost (the client sees a network error). */
  loseResponseNext(re: RegExp) {
    this.lose.push(re);
  }

  // ---------- permissions ----------
  repo(owner: string, name: string) {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }
  perm(r: FakeRepo, login: string): Perm {
    if (r.owner.toLowerCase() === login.toLowerCase()) return "admin";
    const org = this.orgs.get(r.owner);
    if (org?.owners.has(login)) return "admin";
    return r.collaborators.get(login) ?? "none";
  }
  private canRead(r: FakeRepo, login: string) {
    return !r.private || this.perm(r, login) !== "none";
  }
  revoke(owner: string, name: string, login: string) {
    this.repo(owner, name)?.collaborators.delete(login);
  }
  private repoJson(r: FakeRepo, login: string) {
    const p = this.perm(r, login);
    return {
      id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, visibility: r.private ? "private" : "public", fork: false, archived: false, default_branch: r.defaultBranch,
      html_url: `https://github.com/${r.owner}/${r.name}`, description: null,
      owner: { id: (this.users.get(r.owner) ?? this.orgs.get(r.owner))?.id ?? 0, login: r.owner, type: this.orgs.has(r.owner) ? "Organization" : "User" },
      permissions: { pull: p !== "none", push: p === "push" || p === "admin", admin: p === "admin" },
    };
  }

  // ---------- fetch as a user ----------
  fetchFor(login: string): typeof fetch {
    return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      const method = (init.method ?? "GET").toUpperCase();
      const label = `${method} ${url.pathname}${url.search}`;
      this.calls.push(`${login} ${label}`);
      if (this.offline) throw new TypeError("fetch failed");
      for (const f of this.failures) if (f.times > 0 && f.re.test(label)) { f.times--; return json(f.status, { message: f.message }); }
      if (this.rateLimitedUntil && this.rateLimitedUntil > this.clock()) {
        return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(this.rateLimitedUntil / 1000)) });
      }
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init.headers);
      const res = this.route(login, method, url, body, headers);
      const li = this.lose.findIndex((re) => re.test(label));
      if (li >= 0) {
        this.lose.splice(li, 1);
        throw new TypeError("fetch failed"); // the request was applied above; the response never arrives
      }
      return res;
    }) as typeof fetch;
  }

  private route(me: string, method: string, url: URL, body: any, headers: Headers): Response {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/user") return json(200, { ...this.users.get(me), login: me, name: me, avatar_url: null });
    if (method === "GET" && (m = /^\/users\/([^/]+)$/.exec(path))) {
      const u = this.users.get(m[1]) ?? (this.orgs.get(m[1]) as any);
      return u ? json(200, { id: u.id, login: u.login, type: this.orgs.has(m[1]) ? "Organization" : "User" }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && path === "/user/repos") {
      const mine = [...this.repos.values()].filter((r) => this.perm(r, me) !== "none").sort((a, b) => a.id - b.id);
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = mine.slice((page - 1) * per, page * per);
      const link = page * per < mine.length ? `<https://api.github.com/user/repos?per_page=${per}&page=${page + 1}>; rel="next"` : "";
      return json(200, slice.map((r) => this.repoJson(r, me)), link ? { link } : {});
    }
    if (method === "POST" && path === "/user/repos") return this.createRepo(me, me, body);
    if (method === "POST" && (m = /^\/orgs\/([^/]+)\/repos$/.exec(path))) {
      const org = this.orgs.get(m[1]);
      if (!org) return json(404, { message: "Not Found" });
      if (!org.owners.has(me)) return json(403, { message: "You do not have permission to create repositories in this organization" });
      return this.createRepo(me, m[1], body);
    }
    if (method === "GET" && path === "/user/repository_invitations") {
      const out: unknown[] = [];
      for (const r of this.repos.values()) for (const i of r.invitations.values()) if (i.invitee === me) out.push(this.invJson(r, i, me));
      return json(200, out);
    }
    if ((m = /^\/user\/repository_invitations\/(\d+)$/.exec(path))) {
      for (const r of this.repos.values()) {
        const i = r.invitations.get(Number(m[1]));
        if (!i || i.invitee !== me) continue;
        if (method === "PATCH") {
          if (i.expired) return json(404, { message: "Not Found" });
          r.collaborators.set(me, i.permission);
          r.invitations.delete(i.id);
          return json(204, null);
        }
        if (method === "DELETE") {
          r.invitations.delete(i.id);
          return json(204, null);
        }
      }
      return json(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) {
      const r = this.repo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      const sub = m[3] ?? "";
      if (!r || !this.canRead(r, me)) return json(404, { message: "Not Found" });
      return this.repoRoute(me, r, method, sub, url, body, headers);
    }
    return json(404, { message: "Not Found" });
  }

  private invJson(r: FakeRepo, i: Invitation, me: string) {
    return { id: i.id, repository: this.repoJson(r, me), invitee: { login: i.invitee }, inviter: { login: i.inviter }, permissions: i.permission, created_at: new Date(i.createdAt).toISOString(), expired: i.expired };
  }

  private createRepo(me: string, owner: string, b: any): Response {
    const name = String(b?.name ?? "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(422, { message: "Repository name is invalid" });
    if (this.repo(owner, name)) return json(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
    const r: FakeRepo = { id: this.nextId++, owner, name, private: !!b?.private, defaultBranch: "main", collaborators: new Map(), invitations: new Map(), objects: new Map(), refs: new Map() };
    this.repos.set(`${owner}/${name}`.toLowerCase(), r);
    return json(201, this.repoJson(r, me));
  }

  private head(r: FakeRepo) {
    return r.refs.get(`heads/${r.defaultBranch}`) ?? null;
  }

  private repoRoute(me: string, r: FakeRepo, method: string, sub: string, url: URL, b: any, headers: Headers): Response {
    const p = this.perm(r, me);
    let m: RegExpExecArray | null;
    if (method === "GET" && sub === "") return json(200, this.repoJson(r, me));

    // collaborators / invitations
    if (sub === "/collaborators" && method === "GET") return p === "push" || p === "admin" ? json(200, [{ login: r.owner, permissions: { admin: true } }, ...[...r.collaborators].map(([login, perm]) => ({ login, permissions: { admin: perm === "admin", push: perm !== "pull", pull: true } }))]) : json(403, { message: "Must have push access to view repository collaborators." });
    if ((m = /^\/collaborators\/([^/]+)\/permission$/.exec(sub)) && method === "GET") {
      if (p !== "push" && p !== "admin") return json(403, { message: "Must have push access to view repository collaborators." });
      const who = decodeURIComponent(m[1]);
      const lvl = this.perm(r, who);
      return json(200, { permission: lvl === "admin" ? "admin" : lvl === "push" ? "write" : lvl === "pull" || !r.private ? "read" : "none" });
    }
    if ((m = /^\/collaborators\/([^/]+)$/.exec(sub))) {
      const who = decodeURIComponent(m[1]);
      if (p !== "admin") return json(403, { message: "Must have admin rights to Repository." });
      if (method === "PUT") {
        if (!this.users.has(who)) return json(404, { message: "Not Found" });
        const perm = (["pull", "push", "admin"].includes(b?.permission) ? b.permission : "push") as Perm;
        if (r.collaborators.has(who)) { r.collaborators.set(who, perm); return json(204, null); }
        const inv: Invitation = { id: this.nextInv++, invitee: who, inviter: me, permission: perm, createdAt: this.clock(), expired: false };
        r.invitations.set(inv.id, inv);
        return json(201, this.invJson(r, inv, me));
      }
      if (method === "DELETE") { r.collaborators.delete(who); return json(204, null); }
    }
    if (sub === "/invitations" && method === "GET") return p === "admin" ? json(200, [...r.invitations.values()].map((i) => this.invJson(r, { ...i, expired: i.expired || this.clock() - i.createdAt > 7 * 86400_000 }, me))) : json(403, { message: "Must have admin rights to Repository." });
    if ((m = /^\/invitations\/(\d+)$/.exec(sub)) && method === "DELETE") { if (p !== "admin") return json(403, { message: "Must have admin rights to Repository." }); r.invitations.delete(Number(m[1])); return json(204, null); }

    // contents (initial commit and simple reads)
    if ((m = /^\/contents\/(.+)$/.exec(sub))) {
      const path = decodeURIComponent(m[1]);
      if (method === "GET") {
        const h = this.head(r);
        if (!h) return json(404, { message: "Not Found" });
        const files = (r.objects.get((r.objects.get(h) as any).tree) as any).files as Record<string, string>;
        return files[path] ? json(200, { path, sha: files[path], encoding: "base64", content: Buffer.from((r.objects.get(files[path]) as any).content, "utf8").toString("base64") }) : json(404, { message: "Not Found" });
      }
      if (method === "PUT") {
        if (p !== "push" && p !== "admin") return json(403, { message: "Resource not accessible" });
        const content = Buffer.from(String(b.content), "base64").toString("utf8");
        const blob = this.putObj(r, { type: "blob", content });
        const h = this.head(r);
        const prev = h ? { ...(((r.objects.get((r.objects.get(h) as any).tree) as any).files) as Record<string, string>) } : {};
        if (prev[path] && b.sha !== prev[path]) return json(409, { message: `${path} does not match ${prev[path]}` });
        prev[path] = blob;
        const tree = this.putObj(r, { type: "tree", files: prev });
        const commit = this.putObj(r, { type: "commit", tree, parents: h ? [h] : [], message: String(b.message ?? "") });
        r.refs.set(`heads/${r.defaultBranch}`, commit);
        return json(201, { content: { path, sha: blob }, commit: { sha: commit } });
      }
    }

    // head and git data
    if (method === "GET" && (m = /^\/commits\/(.+)$/.exec(sub))) {
      const h = this.head(r);
      if (!h) return json(409, { message: "Git Repository is empty." });
      const etag = `"${h}"`;
      if (headers.get("if-none-match") === etag) return json(304, null, { etag });
      return json(200, { sha: h, commit: { tree: { sha: (r.objects.get(h) as any).tree } } }, { etag });
    }
    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]+)$/.exec(sub))) {
      const t = r.objects.get(m[1]);
      if (!t || t.type !== "tree") return json(404, { message: "Not Found" });
      return json(200, { sha: m[1], truncated: false, tree: Object.entries(t.files).map(([path, sha]) => ({ path, sha, type: "blob", mode: "100644" })) });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(sub))) {
      const o = r.objects.get(m[1]);
      return o && o.type === "blob" ? json(200, { sha: m[1], encoding: "base64", content: Buffer.from(o.content, "utf8").toString("base64") }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && p !== "push" && p !== "admin" && sub.startsWith("/git/")) return json(403, { message: "Resource not accessible" });
    if (method === "POST" && sub === "/git/blobs") return json(201, { sha: this.putObj(r, { type: "blob", content: String(b.content) }) });
    if (method === "POST" && sub === "/git/trees") {
      const base = r.objects.get(b.base_tree);
      const files = { ...(base && base.type === "tree" ? base.files : {}) };
      for (const e of b.tree as { path: string; sha: string | null }[]) { if (e.sha === null) delete files[e.path]; else files[e.path] = e.sha; }
      return json(201, { sha: this.putObj(r, { type: "tree", files }) });
    }
    if (method === "POST" && sub === "/git/commits") return json(201, { sha: this.putObj(r, { type: "commit", tree: b.tree, parents: b.parents ?? [], message: String(b.message) }) });
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(sub))) {
      const ref = `heads/${decodeURIComponent(m[1])}`;
      const cur = r.refs.get(ref);
      if (cur && !b.force && !this.isAncestor(r, cur, b.sha)) return json(422, { message: "Update is not a fast forward" });
      r.refs.set(ref, b.sha);
      return json(200, { ref: `refs/${ref}`, object: { sha: b.sha } });
    }
    // releases (read only; the ETag is a hash of the list, so an unchanged list answers 304 as GitHub does)
    if (method === "GET" && sub === "/releases") {
      const list = r.releases ?? [];
      const etag = `W/"${sha1(JSON.stringify(list))}"`;
      if (headers.get("if-none-match") === etag) return json(304, null, { etag });
      return json(200, list, { etag });
    }
    // pull requests (same-repository head/base only: what the upstream auto-updater needs)
    const pulls = (r.pulls ??= new Map());
    const pullJson = (x: { number: number; state: string; head: string; base: string; title: string; body: string }) => ({ number: x.number, state: x.state, title: x.title, body: x.body, html_url: `https://github.com/${r.owner}/${r.name}/pull/${x.number}`, head: { ref: x.head, label: `${r.owner}:${x.head}` }, base: { ref: x.base } });
    if (method === "GET" && sub === "/pulls") {
      const state = url.searchParams.get("state") ?? "open";
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      const hit = [...pulls.values()].filter((x) => (state === "all" || x.state === state) && (!head || head === `${r.owner}:${x.head}`) && (!base || base === x.base));
      return json(200, hit.map(pullJson));
    }
    if (method === "POST" && sub === "/pulls") {
      if (p !== "push" && p !== "admin") return json(403, { message: "Resource not accessible" });
      if (!r.refs.has(`heads/${b?.head}`) || !r.refs.has(`heads/${b?.base}`)) return json(422, { message: "Validation Failed", errors: [{ message: "head or base is not a branch" }] });
      if ([...pulls.values()].some((x) => x.state === "open" && x.head === b.head && x.base === b.base)) return json(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${r.owner}:${b.head}.` }] });
      const x = { number: pulls.size + 1, state: "open" as const, head: String(b.head), base: String(b.base), title: String(b.title ?? ""), body: String(b.body ?? "") };
      pulls.set(x.number, x);
      return json(201, pullJson(x));
    }
    if (method === "PATCH" && (m = /^\/pulls\/(\d+)$/.exec(sub))) {
      if (p !== "push" && p !== "admin") return json(403, { message: "Resource not accessible" });
      const x = pulls.get(Number(m[1]));
      if (!x) return json(404, { message: "Not Found" });
      if (typeof b?.title === "string") x.title = b.title;
      if (typeof b?.body === "string") x.body = b.body;
      return json(200, pullJson(x));
    }
    return json(404, { message: "Not Found" });
  }

  // ---------- GitHub App surface ----------
  /** Registers the fake App: a fresh RSA key pair. The private key is for the test to configure Mergeport with; the public key verifies app JWTs here. */
  registerApp(appId = "12345"): { appId: string; privateKeyPem: string; publicKeyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    this.app = { appId, publicKeyPem: publicKey };
    return { appId, privateKeyPem: privateKey, publicKeyPem: publicKey };
  }
  /** Installs the App on a user or organisation; `repos` are full names that must already exist in `repos`. */
  addInstallation(accountLogin: string, o: { repos?: string[]; selection?: "all" | "selected"; suspended?: boolean } = {}): FakeInstallation {
    const acct = this.users.get(accountLogin) ?? this.orgs.get(accountLogin);
    if (!acct) throw new Error(`unknown account ${accountLogin}`);
    const inst: FakeInstallation = { id: this.nextId++, accountLogin, accountId: acct.id, accountType: this.orgs.has(accountLogin) ? "Organization" : "User", selection: o.selection ?? "selected", repos: new Set((o.repos ?? []).map((n) => n.toLowerCase())), suspended: !!o.suspended };
    this.installations.set(inst.id, inst);
    return inst;
  }
  /** A user-to-server token for `login` (what the OAuth flow of a later task will hold). */
  issueUserToken(login: string): string {
    const t = `ghu_${randomBytes(18).toString("hex")}`;
    this.userTokens.set(t, login);
    return t;
  }
  /** Seconds an installation token lives (GitHub: one hour). */
  installationTokenTtlMs = 3_600_000;
  /** Test helper: the installation token strings handed out so far. */
  issuedInstallationTokens(): string[] {
    return [...this.instTokens.keys()];
  }

  /** The fetch Mergeport's App code uses: authenticates by the Authorization header (app JWT, installation token or user token). */
  appFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      const method = (init.method ?? "GET").toUpperCase();
      const label = `${method} ${url.pathname}${url.search}`;
      this.calls.push(`app ${label}`);
      if (this.offline) throw new TypeError("fetch failed");
      for (const f of this.failures) if (f.times > 0 && f.re.test(label)) { f.times--; return json(f.status, { message: f.message }); }
      if (this.rateLimitedUntil && this.rateLimitedUntil > this.clock()) {
        return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(this.rateLimitedUntil / 1000)) });
      }
      const headers = new Headers(init.headers);
      const auth = headers.get("authorization") ?? "";
      // GitHub accepts both schemes; Octokit sends `token <t>` for installation tokens and `Bearer <jwt>` for the app JWT.
      const bearer = /^(?:Bearer|token) (.+)$/i.exec(auth)?.[1];
      const inst = bearer ? this.instTokens.get(bearer) : undefined;
      if (inst) this.calls.push(`inst:${inst.installationId} ${label}`);
      return this.appRoute(method, url, bearer, headers);
    }) as typeof fetch;
  }

  /** GitHub's own checks on an app JWT: RS256 signature, `iat` not in the future, `exp` in the future and at most 10 minutes ahead, `iss` the App. */
  private checkAppJwt(jwt: string | undefined): Response | null {
    const bad = (message: string) => json(401, { message, documentation_url: "https://docs.github.com/rest" });
    if (!this.app) return bad("A JSON web token could not be decoded");
    const parts = (jwt ?? "").split(".");
    if (parts.length !== 3) return bad("A JSON web token could not be decoded");
    let head: any, claims: any;
    try {
      head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return bad("A JSON web token could not be decoded");
    }
    if (head?.alg !== "RS256") return bad("A JSON web token could not be decoded");
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(this.app.publicKeyPem), Buffer.from(parts[2], "base64url"));
    if (!ok) return bad("Bad credentials");
    const nowS = Math.floor(this.clock() / 1000);
    if (!Number.isInteger(claims.iat) || claims.iat > nowS) return bad("'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued");
    if (!Number.isInteger(claims.exp) || claims.exp <= nowS) return bad("'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires");
    if (claims.exp > nowS + 600) return bad("'Expiration time' claim ('exp') is too far in the future");
    if (String(claims.iss) !== this.app.appId) return bad("'Issuer' claim ('iss') must be the App's ID");
    return null;
  }

  private instJson(i: FakeInstallation) {
    return {
      id: i.id, app_id: Number(this.app?.appId ?? 0), target_type: i.accountType, repository_selection: i.selection,
      account: { id: i.accountId, login: i.accountLogin, type: i.accountType },
      suspended_at: i.suspended ? new Date(this.clock()).toISOString() : null,
    };
  }
  private instRepos(i: FakeInstallation) {
    return [...this.repos.values()].filter((r) => i.selection === "all" ? r.owner === i.accountLogin : i.repos.has(`${r.owner}/${r.name}`.toLowerCase())).sort((a, b) => a.id - b.id);
  }
  private page<T>(items: T[], url: URL, key: string, render: (x: T) => unknown): Response {
    const per = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = items.slice((page - 1) * per, page * per);
    const next = new URL(url.href);
    next.searchParams.set("page", String(page + 1));
    return json(200, { total_count: items.length, [key]: slice.map(render) }, page * per < items.length ? { link: `<${next.href}>; rel="next"` } : {});
  }

  // ---------- issues and pull requests, as an installation sees them ----------
  /** Test helper: an issue or pull request in a fake repository (what `GET /repos/{o}/{r}/issues` lists). */
  addWork(owner: string, name: string, w: { number: number; kind?: "issue" | "pr"; title: string; author?: string; state?: "open" | "closed"; updatedAt?: string; headSha?: string; reviews?: { id: number; user: string; state: string }[]; requested?: string[]; comments?: { id: number; user: string; body: string }[] }): void {
    const r = this.repo(owner, name);
    if (!r) throw new Error(`unknown repository ${owner}/${name}`);
    (r.work ??= []).push({ ...w, kind: w.kind ?? "issue", author: w.author ?? owner, state: w.state ?? "open", updatedAt: w.updatedAt ?? new Date(this.clock()).toISOString(), id: this.nextId++, headSha: w.headSha ?? sha1(`${name}#${w.number}`) });
  }

  private userJson(login: string) {
    return { id: (this.users.get(login) ?? this.orgs.get(login))?.id ?? 1, login, avatar_url: null };
  }

  private workJson(r: FakeRepo, w: NonNullable<FakeRepo["work"]>[number]) {
    const base = {
      id: w.id, number: w.number, title: w.title, body: null, state: w.state, user: this.userJson(w.author), labels: [], assignees: [], milestone: null,
      html_url: `https://github.com/${r.owner}/${r.name}/${w.kind === "pr" ? "pull" : "issues"}/${w.number}`, created_at: w.updatedAt, updated_at: w.updatedAt, closed_at: w.state === "closed" ? w.updatedAt : null, draft: false,
    };
    return w.kind === "pr" ? { ...base, pull_request: { merged_at: null }, merged: false, merged_at: null, head: { sha: w.headSha, ref: `feature-${w.number}` }, base: { ref: r.defaultBranch }, mergeable: true, additions: 1, deletions: 0, changed_files: 1 } : base;
  }

  /** Reads of one repository with an installation token: only repositories the installation can access exist. ETags make an unchanged list answer 304, as GitHub does. */
  private installationRepoRoute(i: FakeInstallation, method: string, url: URL, headers: Headers): Response {
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const r = m ? this.repo(decodeURIComponent(m[1]), decodeURIComponent(m[2])) : undefined;
    if (!m || !r || !this.instRepos(i).includes(r)) return json(404, { message: "Not Found" });
    if (method !== "GET") return json(403, { message: "Resource not accessible by integration" }); // the App holds read permissions only
    const sub = m[3] ?? "";
    const work = r.work ?? [];
    const cacheable = (body: unknown, headers2: Record<string, string> = {}) => {
      const etag = `W/"${sha1(JSON.stringify(body))}"`;
      if (headers.get("if-none-match") === etag) return json(304, null, { etag });
      return json(200, body, { etag, ...headers2 });
    };
    let n: RegExpExecArray | null;
    if (sub === "") return cacheable(this.repoJson(r, i.accountLogin));
    if (sub === "/issues") {
      const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const since = url.searchParams.get("since");
      const all = work.filter((w) => !since || w.updatedAt >= since).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const next = new URL(url.href);
      next.searchParams.set("page", String(page + 1));
      return cacheable(all.slice((page - 1) * per, page * per).map((w) => this.workJson(r, w)), page * per < all.length ? { link: `<${next.href}>; rel="next"` } : {});
    }
    if ((n = /^\/(?:issues|pulls)\/(\d+)$/.exec(sub))) {
      const w = work.find((x) => x.number === Number(n![1]) && (sub.startsWith("/pulls") ? x.kind === "pr" : true));
      return w ? cacheable(this.workJson(r, w)) : json(404, { message: "Not Found" });
    }
    if ((n = /^\/pulls\/(\d+)\/reviews$/.exec(sub))) return cacheable((work.find((x) => x.number === Number(n![1]))?.reviews ?? []).map((v) => ({ id: v.id, user: this.userJson(v.user), state: v.state, body: "", commit_id: null, submitted_at: new Date(this.clock()).toISOString() })));
    if ((n = /^\/(?:issues|pulls)\/(\d+)\/comments$/.exec(sub))) return cacheable(sub.startsWith("/issues") ? (work.find((x) => x.number === Number(n![1]))?.comments ?? []).map((c) => ({ id: c.id, user: this.userJson(c.user), body: c.body, created_at: new Date(this.clock()).toISOString(), updated_at: new Date(this.clock()).toISOString() })) : []);
    if ((n = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(sub))) return cacheable({ users: (work.find((x) => x.number === Number(n![1]))?.requested ?? []).map((u) => this.userJson(u)), teams: [] });
    if (/^\/commits\/[^/]+\/check-runs$/.test(sub)) return cacheable({ total_count: 0, check_runs: [] });
    if (/^\/commits\/[^/]+\/status$/.test(sub)) return cacheable({ state: "pending", total_count: 0, statuses: [] });
    if (sub === "/branches") return cacheable([{ name: r.defaultBranch, commit: { sha: this.head(r) ?? sha1(`${r.name}@head`) } }]);
    return json(404, { message: "Not Found" });
  }

  private appRoute(method: string, url: URL, bearer: string | undefined, headers: Headers = new Headers()): Response {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path.startsWith("/repos/")) {
      const t = bearer ? this.instTokens.get(bearer) : undefined;
      if (!t || t.expiresAt <= this.clock()) return json(401, { message: "Bad credentials" });
      const i = this.installations.get(t.installationId);
      if (!i) return json(401, { message: "Bad credentials" });
      if (i.suspended) return json(403, { message: "This installation has been suspended" });
      return this.installationRepoRoute(i, method, url, headers);
    }
    if (method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      const err = this.checkAppJwt(bearer);
      if (err) return err;
      const i = this.installations.get(Number(m[1]));
      if (!i) return json(404, { message: "Not Found" });
      if (i.suspended) return json(403, { message: "This installation has been suspended" });
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expires = this.clock() + this.installationTokenTtlMs;
      this.instTokens.set(token, { installationId: i.id, expiresAt: expires });
      return json(201, { token, expires_at: new Date(expires).toISOString(), permissions: { metadata: "read" }, repository_selection: i.selection });
    }
    if (method === "GET" && (m = /^\/app\/installations\/(\d+)$/.exec(path))) {
      const err = this.checkAppJwt(bearer);
      if (err) return err;
      const i = this.installations.get(Number(m[1]));
      return i ? json(200, this.instJson(i)) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && path === "/installation/repositories") {
      const t = bearer ? this.instTokens.get(bearer) : undefined;
      if (!t || t.expiresAt <= this.clock()) return json(401, { message: "Bad credentials" });
      const i = this.installations.get(t.installationId);
      if (!i) return json(401, { message: "Bad credentials" });
      if (i.suspended) return json(403, { message: "This installation has been suspended" });
      return this.page(this.instRepos(i), url, "repositories", (r) => this.repoJson(r, r.owner));
    }
    const me = bearer ? this.userTokens.get(bearer) : undefined;
    if (path === "/user/installations" || /^\/user\/installations\/\d+\/repositories$/.test(path)) {
      if (!me) return json(401, { message: "Bad credentials" });
      const mine = (i: FakeInstallation) => !i.suspended && (i.accountLogin === me || !!this.orgs.get(i.accountLogin)?.members.has(me));
      if (path === "/user/installations") return this.page([...this.installations.values()].filter(mine).sort((a, b) => a.id - b.id), url, "installations", (i) => this.instJson(i));
      const i = this.installations.get(Number(/\/(\d+)\//.exec(path)![1]));
      if (!i || !mine(i)) return json(404, { message: "Not Found" });
      return this.page(this.instRepos(i).filter((r) => this.canRead(r, me)), url, "repositories", (r) => this.repoJson(r, me));
    }
    return json(404, { message: "Not Found" });
  }

  private putObj(r: FakeRepo, o: Obj): string {
    const sha = sha1(JSON.stringify(o) + (o.type === "commit" ? String(this.nextId++) : ""));
    r.objects.set(sha, o);
    return sha;
  }
  private isAncestor(r: FakeRepo, ancestor: string, of: string): boolean {
    const seen = new Set<string>();
    const stack = [of];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const o = r.objects.get(s);
      if (o && o.type === "commit") stack.push(...o.parents);
    }
    return false;
  }

  /** Test helper: every blob path and content currently on the default branch (what ANYONE with read access can see). */
  files(owner: string, name: string): Record<string, string> {
    const r = this.repo(owner, name)!;
    const h = this.head(r);
    if (!h) return {};
    const tree = r.objects.get((r.objects.get(h) as any).tree) as any;
    return Object.fromEntries(Object.entries(tree.files as Record<string, string>).map(([p, s]) => [p, (r.objects.get(s) as any).content as string]));
  }
  /** Test helper: all commit messages in history (history is readable by everyone with read access). */
  history(owner: string, name: string): string[] {
    const r = this.repo(owner, name)!;
    const out: string[] = [];
    let h = this.head(r);
    while (h) { const c = r.objects.get(h) as any; out.push(c.message); h = c.parents[0] ?? null; }
    return out;
  }
  expireInvitations(owner: string, name: string) {
    for (const i of this.repo(owner, name)!.invitations.values()) i.expired = true;
  }
}
