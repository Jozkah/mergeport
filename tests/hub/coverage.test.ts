import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHubDb } from "../../hub/src/db";
import { deliver, ghRepo, signInAs, startTestHub, type TestHub } from "./harness";

const SECRET = "c".repeat(24) + "0123456789abcdef";
type Msg = { t: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly ws: WebSocket;
  readonly msgs: Msg[] = [];
  readonly opened: Promise<boolean>;
  constructor(url: string, token: string) {
    this.ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", ["mergeport.v1", "bearer." + token]);
    this.ws.addEventListener("message", (e) => this.msgs.push(JSON.parse(String(e.data)) as Msg));
    this.opened = new Promise((r) => {
      this.ws.addEventListener("open", () => r(true));
      this.ws.addEventListener("error", () => r(false));
    });
  }
  covered(): string[][] {
    return this.msgs.filter((m) => m.t === "covered").map((m) => m.repos as string[]);
  }
  async waitFor(pred: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(this.msgs).slice(0, 500)}`);
      await sleep(10);
    }
  }
  /** Sends `watch`, then a ping; the pong proves the hub handled the watch. */
  async watch(ids: string[]): Promise<void> {
    const before = this.msgs.filter((m) => m.t === "pong").length;
    this.ws.send(JSON.stringify({ t: "watch", repos: ids }));
    this.ws.send(JSON.stringify({ t: "ping" }));
    await this.waitFor(() => this.msgs.filter((m) => m.t === "pong").length > before);
  }
}

let hub: TestHub;
const clients: Client[] = [];
async function connect(token: string): Promise<Client> {
  const c = new Client(hub.url, token);
  clients.push(c);
  expect(await c.opened).toBe(true);
  await c.waitFor(() => c.msgs.some((m) => m.t === "hello"));
  return c;
}
const covered = () => (hub.db.prepare("SELECT repo_id FROM github_covered ORDER BY repo_id").all() as { repo_id: string }[]).map((r) => r.repo_id);
const repos = (...ids: number[]) => ids.map((id) => ({ id, full_name: `o/r${id}` }));

beforeEach(async () => {
  hub = await startTestHub();
  const owner = await signInAs(hub, 1n, "olive");
  expect((await hub.api(owner)("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(204);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await hub.close();
});

describe("coverage from deliveries", () => {
  it("installation created marks its repositories; unrelated actions do not", async () => {
    expect((await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(1, 2, 3) })).body).toEqual({ ok: true });
    expect(covered()).toEqual(["1", "2", "3"]);
    await deliver(hub, SECRET, "installation", { action: "new_permissions_accepted", repositories: repos(4) });
    await deliver(hub, SECRET, "installation", { action: "unsuspend", repositories: repos(5) });
    await deliver(hub, SECRET, "installation", { action: "something_else", repositories: repos(6) });
    expect(covered()).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("installation deleted and suspend remove the listed ids", async () => {
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(1, 2, 3) });
    await deliver(hub, SECRET, "installation", { action: "suspend", repositories: repos(1) });
    expect(covered()).toEqual(["2", "3"]);
    await deliver(hub, SECRET, "installation", { action: "deleted", repositories: repos(2, 3) });
    expect(covered()).toEqual([]);
  });

  it("installation_repositories adds and removes", async () => {
    await deliver(hub, SECRET, "installation_repositories", { action: "added", repositories_added: repos(10, 11), repositories_removed: [] });
    expect(covered()).toEqual(["10", "11"]);
    await deliver(hub, SECRET, "installation_repositories", { action: "removed", repositories_added: [], repositories_removed: repos(10) });
    expect(covered()).toEqual(["11"]);
  });

  it("a normal event marks its repository", async () => {
    expect((await deliver(hub, SECRET, "issues", { action: "opened", issue: { number: 1 }, repository: ghRepo(77, "o") })).status).toBe(200);
    expect(covered()).toEqual(["77"]);
  });

  it("ignores non-integer ids and caps the work per delivery", async () => {
    const list = [{ id: 1.5 }, { id: "abc" }, { id: -1 }, { id: null }, { id: "42" }, { id: 7 }, null, 3];
    await deliver(hub, SECRET, "installation", { action: "created", repositories: list });
    expect(covered()).toEqual(["42", "7"]);
    const many = Array.from({ length: 5100 }, (_, i) => ({ id: i + 1000 }));
    await deliver(hub, SECRET, "installation", { action: "created", repositories: many });
    expect(covered().length).toBe(2 + 5000);
  });

  it("installation events are still not relayed and a bad signature marks nothing", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["1"]);
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(1) });
    await sleep(100);
    expect(c.msgs.some((m) => m.t === "gh")).toBe(false);
    expect((await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(9) }, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect(covered()).toEqual(["1"]);
  });

  it("survives a hub restart", async () => {
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(5, 6) });
    hub.db.pragma("wal_checkpoint(TRUNCATE)");
    const db2 = openHubDb(hub.dataDir);
    expect((db2.prepare("SELECT repo_id FROM github_covered ORDER BY repo_id").all() as { repo_id: string }[]).map((r) => r.repo_id)).toEqual(["5", "6"]);
    db2.close();
  });
});

describe("covered over the WebSocket", () => {
  it("sends only watched covered ids after watch, and again only when they change", async () => {
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(1, 2, 99) });
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["1", "2", "3"]);
    expect(c.covered()).toEqual([["1", "2"]]);

    // The same set again: nothing new.
    await c.watch(["1", "2", "3"]);
    expect(c.covered()).toHaveLength(1);

    // A mark that adds nothing new sends nothing; a real change does.
    await deliver(hub, SECRET, "issues", { action: "opened", issue: { number: 1 }, repository: ghRepo(1, "o") });
    await deliver(hub, SECRET, "installation_repositories", { action: "added", repositories_added: repos(3, 500), repositories_removed: [] });
    await c.waitFor(() => c.covered().length === 2);
    expect(c.covered()[1]).toEqual(["1", "2", "3"]);

    await deliver(hub, SECRET, "installation_repositories", { action: "removed", repositories_added: [], repositories_removed: repos(1) });
    await c.waitFor(() => c.covered().length === 3);
    expect(c.covered()[2]).toEqual(["2", "3"]);

    // A change outside the watched set sends nothing.
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(600) });
    await sleep(100);
    expect(c.covered()).toHaveLength(3);

    // watch changing the set sends the new list.
    await c.watch(["2"]);
    expect(c.covered()[3]).toEqual(["2"]);
  });

  it("sends an empty list right after the first watch when nothing is covered", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["1"]);
    expect(c.covered()).toEqual([[]]);
  });

  it("never tells a member about ids it does not watch", async () => {
    await deliver(hub, SECRET, "installation", { action: "created", repositories: repos(1, 2) });
    const ownerToken = await signInAs(hub, 1n, "olive");
    const owner = await connect(ownerToken);
    hub.github.addUser({ id: 2n, login: "ann" });
    expect((await hub.api(ownerToken)("POST", "/admin/invites", { githubLogin: "ann", role: "MEMBER" })).status).toBe(201);
    const ann = await connect(await signInAs(hub, 2n, "ann"));
    await owner.watch(["1", "2"]);
    await ann.watch(["2"]);
    await deliver(hub, SECRET, "installation_repositories", { action: "added", repositories_added: repos(3), repositories_removed: [] });
    await sleep(100);
    expect(ann.covered().flat()).toEqual(["2"]);
    expect(ann.msgs.filter((m) => m.t === "covered").every((m) => !(m.repos as string[]).includes("1"))).toBe(true);
    expect(owner.covered().flat()).not.toContain("3");
  });
});
