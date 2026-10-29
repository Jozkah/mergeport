import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { looksOffline, savedProfiles } from "@/lib/local/saved-profiles";

const dirs: string[] = [];
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-profiles-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function profile(h: string, host: string, id: number, login: string, isDemo = 0) {
  const dir = path.join(h, "profiles", `${host}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "mergeport.db"));
  db.exec('create table User (id text, githubId integer, login text, isDemo integer, createdAt text)');
  db.prepare("insert into User values ('u', ?, ?, ?, '2026-01-01')").run(id, login, isDemo);
  db.close();
}

describe("offline start: saved profiles", () => {
  it("finds the profile of a host and ignores other hosts, demo users and foreign files", () => {
    const h = home();
    profile(h, "github.com", 12345678, "octocat");
    profile(h, "ghe.example.com", 7, "someone");
    fs.mkdirSync(path.join(h, "profiles", "github.com-9"), { recursive: true });
    fs.writeFileSync(path.join(h, "profiles", "github.com-9", "mergeport.db"), "not a database");
    const found = savedProfiles(h, "github.com");
    expect(found.map((p) => [p.id, p.login])).toEqual([[12345678n, "octocat"]]);
  });
  it("returns nothing when there is no profile folder", () => expect(savedProfiles(home(), "github.com")).toEqual([]));
  it("reports two profiles so the launcher refuses to guess", () => {
    const h = home();
    profile(h, "github.com", 1, "a");
    profile(h, "github.com", 2, "b");
    expect(savedProfiles(h, "github.com")).toHaveLength(2);
  });
  it("treats only network failures as offline, never a refused or signed-out account", () => {
    expect(looksOffline("error connecting to api.github.com")).toBe(true);
    expect(looksOffline("gh timed out after 20s")).toBe(true);
    expect(looksOffline("gh: Bad credentials (HTTP 401)")).toBe(false);
    expect(looksOffline("You are not logged in")).toBe(false);
  });
});
