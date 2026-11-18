import { describe, expect, it } from "vitest";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { discoverAll } from "@/lib/github/factory";

const repo = (id: number, full: string, push = false) => {
  const [owner, name] = full.split("/");
  return { id, full_name: full, name, html_url: `https://github.com/${full}`, private: false, visibility: "public", fork: false, archived: false, default_branch: "main", owner: { id: id + 1000, login: owner, type: "Organization" }, permissions: { push, pull: true } };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function port(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const hit = routes[u.pathname];
    return hit ? hit() : json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { port: new OctokitPort(createOctokit("t", fetchImpl)), calls };
}

describe("discovery extras", () => {
  it("adds public org repos and repos you sent pull requests to, once each", async () => {
    const mine = repo(1, "me/own", true);
    const { port: p, calls } = port({
      "/user/repos": () => json([mine]),
      "/user/orgs": () => json([{ login: "AI-Cluster" }]),
      "/orgs/AI-Cluster/repos": () => json([repo(2, "AI-Cluster/pub"), repo(1, "me/own", true)]),
      "/search/issues": () => json({ items: [{ repository_url: "https://api.github.com/repos/CNC/ScanRuler" }, { repository_url: "https://api.github.com/repos/me/own" }] }),
      "/repos/CNC/ScanRuler": () => json(repo(3, "CNC/ScanRuler")),
    });
    const d = await discoverAll(p);
    expect(d.repos.map((r) => r.fullName).sort()).toEqual(["AI-Cluster/pub", "CNC/ScanRuler", "me/own"]);
    expect(calls).not.toContain("/repos/me/own");
  });

  it("adds the upstream of a fork of yours", async () => {
    const fork = { ...repo(1, "me/scanruler", true), fork: true, owner: { id: 9, login: "me", type: "User" } };
    const { port: p } = port({
      "/user/repos": () => json([fork]),
      "/repos/me/scanruler": () => json({ ...fork, parent: { id: 5, full_name: "CNC/ScanRuler" } }),
      "/repos/CNC/ScanRuler": () => json(repo(5, "CNC/ScanRuler")),
    });
    const d = await discoverAll(p);
    expect(d.repos.map((r) => r.fullName).sort()).toEqual(["CNC/ScanRuler", "me/scanruler"]);
  });

  it("keeps the authorized list when the extras fail", async () => {
    const { port: p } = port({ "/user/repos": () => json([repo(1, "me/own", true)]), "/user/orgs": () => json({ message: "boom" }, 500), "/search/issues": () => json({ message: "rate" }, 403) });
    const d = await discoverAll(p);
    expect(d.repos.map((r) => r.fullName)).toEqual(["me/own"]);
  });
});
