import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { activeDbFile, contextIdOf, createContext, peekContext, profileDirOf, readIndex, renameContext, setActive, slugify } from "@/lib/local/contexts";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-ctx-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("team contexts", () => {
  it("starts with one default context and never touches the existing database file", () => {
    const dir = tmp();
    const base = path.join(dir, "mergeport.db");
    fs.writeFileSync(base, "existing");
    const idx = readIndex(dir, "mergeport.db");
    expect(idx.contexts.map((c) => c.id)).toEqual(["default"]);
    expect(activeDbFile(dir, "mergeport.db")).toBe(base);
    expect(fs.readFileSync(base, "utf8")).toBe("existing");
  });

  it("creates, renames and activates contexts with their own database files; the default stays as it was", () => {
    const dir = tmp();
    const a = createContext(dir, "mergeport.db", "Atlas Crew");
    expect(a).toMatchObject({ id: "atlas-crew", file: "contexts/atlas-crew.db" });
    expect(() => createContext(dir, "mergeport.db", "atlas crew")).toThrow(/already exists/);
    expect(() => createContext(dir, "mergeport.db", "  ")).toThrow(/Name the context/);
    expect(() => createContext(dir, "mergeport.db", "x".repeat(41))).toThrow(/at most 40/);
    expect(activeDbFile(dir, "mergeport.db")).toBe(path.join(dir, "mergeport.db")); // creating does not switch
    setActive(dir, "mergeport.db", "atlas-crew");
    expect(activeDbFile(dir, "mergeport.db")).toBe(path.join(dir, "contexts", "atlas-crew.db"));
    expect(contextIdOf(dir, "mergeport.db", path.join(dir, "contexts", "atlas-crew.db"))).toBe("atlas-crew");
    expect(profileDirOf(path.join(dir, "contexts", "atlas-crew.db"))).toBe(dir);
    expect(profileDirOf(path.join(dir, "mergeport.db"))).toBe(dir);
    renameContext(dir, "mergeport.db", "atlas-crew", "Atlas");
    expect(readIndex(dir, "mergeport.db").contexts.find((c) => c.id === "atlas-crew")!.name).toBe("Atlas");
    expect(() => setActive(dir, "mergeport.db", "nope")).toThrow(/no such context/);
    setActive(dir, "mergeport.db", "default");
    expect(activeDbFile(dir, "mergeport.db")).toBe(path.join(dir, "mergeport.db"));
  });

  it("ignores a damaged or hostile index instead of trusting it", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "contexts.json"), "{not json");
    expect(readIndex(dir, "mergeport.db").active).toBe("default");
    fs.writeFileSync(path.join(dir, "contexts.json"), JSON.stringify({ version: 1, base: "mergeport.db", active: "evil", contexts: [{ id: "evil", name: "x", file: "../../outside.db", createdAt: "" }, { id: "ok", name: "ok", file: "contexts/ok.db", createdAt: "" }] }));
    const idx = readIndex(dir, "mergeport.db");
    expect(idx.contexts.map((c) => c.id)).toEqual(["default", "ok"]); // the traversal entry was dropped
    expect(idx.active).toBe("default");
    expect(activeDbFile(dir, "mergeport.db").startsWith(dir)).toBe(true);
    expect(slugify("Ünï Cødé / Team!")).toBe("uni-c-de-team");
  });

  it("summarises a parked database read-only, and says nothing about one never opened", () => {
    const dir = tmp();
    expect(peekContext(path.join(dir, "missing.db"))).toMatchObject({ exists: false, spaces: 0 });
    const file = path.join(dir, "parked.db");
    const db = new Database(file);
    db.exec(`CREATE TABLE TeamConfig (id TEXT PRIMARY KEY, name TEXT, mode TEXT); INSERT INTO TeamConfig VALUES ('team','Atlas Crew','TEAM');
             CREATE TABLE Space (id TEXT, lastPolledAt TEXT); INSERT INTO Space VALUES ('s1','2026-10-29T10:00:00Z');
             CREATE TABLE OutboxOp (id TEXT, status TEXT); INSERT INTO OutboxOp VALUES ('o1','PENDING'),('o2','DONE');
             CREATE TABLE SyncConflict (id TEXT, status TEXT); INSERT INTO SyncConflict VALUES ('c1','OPEN');`);
    db.close();
    expect(peekContext(file)).toMatchObject({ exists: true, team: "Atlas Crew", mode: "TEAM", spaces: 1, unsent: 1, conflicts: 1 });
    expect(fs.readFileSync(file).length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(dir, "garbage.db"), "not a database");
    expect(peekContext(path.join(dir, "garbage.db")).spaces).toBe(0);
  });
});
