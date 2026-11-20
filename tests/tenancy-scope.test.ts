import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_WORKSPACE_ALLOWLIST, TENANCY_ALLOWLIST, type TenancyAllow } from "@/lib/authz/tenancy-allowlist";
import { firstWorkspaceCalls, rootModels, scan, type Violation } from "./tenancy-scan";

const root = path.resolve(import.meta.dirname, "..");
const allows = (e: TenancyAllow, v: Violation) => e.file === v.file && (!e.models || e.models.includes(v.model)) && (!e.ops || e.ops.includes(v.op));

describe("tenancy: every ROOT-model query is scoped to a workspace", () => {
  const all = scan(root);

  it("derives the ROOT models from the schema", () => {
    const m = rootModels(root);
    for (const name of ["Repository", "Project", "Member", "Space", "TeamConfig", "HubSession", "AiSettings", "Job", "GitCache", "DiscoveryCache"]) expect(m).toContain(name);
    for (const name of ["User", "Session", "PublicCacheEntry", "WorkItem", "PlanningItem"]) expect(m).not.toContain(name);
  });

  it("finds no unscoped call outside the allowlist", () => {
    const bad = all.filter((v) => !TENANCY_ALLOWLIST.some((e) => allows(e, v)));
    expect(bad.map((v) => `${v.file}:${v.line} ${v.model}.${v.op} ${v.snippet}`)).toEqual([]);
  });

  it("keeps the allowlist honest: every entry points at a real file and still matches a call", () => {
    for (const e of TENANCY_ALLOWLIST) {
      expect(fs.existsSync(path.join(root, e.file)), `${e.file} exists`).toBe(true);
      expect(e.reason.length, `${e.file} has a reason`).toBeGreaterThan(20);
      expect(
        all.some((v) => allows(e, v)),
        `${e.file} ${(e.models ?? []).join(",")} ${(e.ops ?? []).join(",")} matches no unscoped call: remove the entry`,
      ).toBe(true);
    }
  });

  it("firstWorkspace( (the profile's one workspace, fail closed) is called only from the allowlisted single-profile files", () => {
    const calls = firstWorkspaceCalls(root);
    const allowed = new Set(FIRST_WORKSPACE_ALLOWLIST.map((e) => e.file));
    expect([...calls.keys()].filter((f) => !allowed.has(f)).map((f) => `${f}:${calls.get(f)!.join(",")}`)).toEqual([]);
    for (const e of FIRST_WORKSPACE_ALLOWLIST) {
      expect(e.reason.length, `${e.file} has a reason`).toBeGreaterThan(20);
      expect(calls.has(e.file), `${e.file} no longer calls firstWorkspace: remove the entry`).toBe(true);
    }
  });

  it("catches the obvious misses and accepts scoped calls (scanner self-test)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenancy-"));
    try {
      fs.mkdirSync(path.join(dir, "prisma"));
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "prisma", "schema.prisma"), "model Repository {\n  id String @id\n  workspaceId String\n}\nmodel WorkItem {\n  id String @id\n}\n");
      fs.writeFileSync(
        path.join(dir, "src", "a.ts"),
        [
          "const bad1 = db.repository.findMany({ where: { name: 'x' } });",
          "const bad2 = tx.repository.count();",
          "const bad3 = db.repository.deleteMany({ where: { id } });",
          "const bad4 = db.repository.updateMany({ where: { id: { in: ids } }, data: {} });",
          "const ok1 = db.repository.findMany({ where: { workspaceId: v.workspaceId } });",
          "const ok2 = db.repository.findFirst({ where: { id, ...repoWhere(v) } });",
          "const ok3 = db.workItem.findMany({ where: { id } });", // child model: not a ROOT, not checked here
          "const ok4 = db.repository.create({ data: { workspaceId, name: 'a (b)' } });",
        ].join("\n"),
      );
      const hits = scan(dir).map((v) => v.line);
      expect(hits).toEqual([1, 2, 3, 4]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
