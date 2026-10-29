import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubBackendId } from "@/lib/local/backends";
import { upsertHub, writeActive } from "@/lib/local/registry";
import { listWorkspaces } from "@/lib/local/workspaces";

const dirs: string[] = [];
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-ws-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const hub = (origin: string, teamName: string, id: string, addedAt: string) => ({ origin, teamName, lastSignedInAs: { id, login: `u${id}` }, addedAt });

describe("listWorkspaces", () => {
  it("empty home: only GitHub, active github", () => {
    const r = listWorkspaces(home(), "github.com", "7");
    expect(r.active).toBe("github");
    expect(r.entries).toEqual([{ backend: "github", label: "GitHub (repositories)", available: true }]);
  });

  it("lists hubs in addedAt order after GitHub", () => {
    const h = home();
    upsertHub(h, hub("https://b.example.com", "Beta", "7", "2026-02-01T00:00:00Z"));
    upsertHub(h, hub("https://a.example.com", "Alpha", "7", "2026-03-01T00:00:00Z"));
    const r = listWorkspaces(h, "github.com", "7");
    expect(r.entries.map((e) => e.label)).toEqual(["GitHub (repositories)", "Beta", "Alpha"]);
    expect(r.entries[1]).toMatchObject({ backend: hubBackendId("https://b.example.com"), detail: "https://b.example.com", available: true });
  });

  it("marks the active workspace from active.json", () => {
    const h = home();
    upsertHub(h, hub("https://a.example.com", "Alpha", "7", "2026-01-01T00:00:00Z"));
    writeActive(h, { host: "github.com", accountId: "7", backend: hubBackendId("https://a.example.com") });
    expect(listWorkspaces(h, "github.com", "7").active).toBe(hubBackendId("https://a.example.com"));
  });

  it("flags a hub last used by another account as unavailable", () => {
    const h = home();
    upsertHub(h, hub("https://a.example.com", "Alpha", "99", "2026-01-01T00:00:00Z"));
    const e = listWorkspaces(h, "github.com", "7").entries[1];
    expect(e).toMatchObject({ available: false, detail: "Signed in as @u99" });
  });

  it("corrupt active.json falls back to github", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "active.json"), "{not json");
    expect(listWorkspaces(h, "github.com", "7").active).toBe("github");
  });
});
