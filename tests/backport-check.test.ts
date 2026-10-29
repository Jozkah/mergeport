import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBackport, patchSignature } from "@/lib/local/backport-check";

const dirs: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-backport-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  return d;
}
const write = (d: string, f: string, text: string) => fs.writeFileSync(path.join(d, f), text);
const NL = String.fromCharCode(10);
let r: string;
let upstreamFix: string; // a fix made on the "up" branch
let ancestorSha: string;

beforeAll(() => {
  r = repo();
  write(r, "a.txt", ["one", "two", "three", ""].join(NL));
  git(r, "add", "."); git(r, "commit", "-q", "-m", "base");
  ancestorSha = git(r, "rev-parse", "HEAD");
  // upstream branch: fixes "two"
  git(r, "checkout", "-q", "-b", "up");
  write(r, "a.txt", ["one", "TWO fixed", "three", ""].join(NL));
  git(r, "commit", "-qam", "fix two");
  upstreamFix = git(r, "rev-parse", "HEAD");
  // a second upstream change that the fork never takes
  write(r, "b.txt", "new file" + NL);
  git(r, "add", "."); git(r, "commit", "-qm", "add b");
  // fork branch: unrelated work, then the same fix cherry-picked on a different base
  git(r, "checkout", "-q", "main");
  write(r, "c.txt", "fork only" + NL);
  git(r, "add", "."); git(r, "commit", "-qm", "fork work");
  git(r, "cherry-pick", upstreamFix);
  git(r, "branch", "fork-pick");
  git(r, "reset", "-q", "--hard", "HEAD~2"); // main goes back to base only
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("local backport evidence", () => {
  it("a patch signature ignores line numbers, context and whitespace but not the change", () => {
    const a = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO  fixed", " three"].join(NL);
    const b = ["@@ -10,3 +40,3 @@", " zero", "-two", "+TWO fixed", " four"].join(NL);
    expect(patchSignature(a)).toBe(patchSignature(b));
    expect(patchSignature(a)).not.toBe(patchSignature(a.replace("TWO", "XXX")));
    expect(patchSignature(" no change lines")).toBeNull();
  });

  it("finds ancestry when the upstream commit is part of the branch", async () => {
    const c = await checkBackport(r, ancestorSha, "main");
    expect(c.result).toBe("ancestor");
  });

  it("reports a cherry-pick as possible patch equivalence, naming the local commit", async () => {
    const c = await checkBackport(r, upstreamFix, "fork-pick");
    expect(c.result).toBe("patch-equivalent");
    expect(c.localSha).toBe(git(r, "rev-parse", "fork-pick"));
    expect(c.reason).toMatch(/possible equivalence rather than proof/);
  });

  it("says not-found (without claiming absence) when the commit is present but the change is not", async () => {
    const c = await checkBackport(r, upstreamFix, "main");
    expect(c.result).toBe("not-found");
    expect(c.reason).toMatch(/does not prove it is absent/);
  });

  it("is honest when it cannot check", async () => {
    expect((await checkBackport(r, "f".repeat(40), "main")).result).toBe("not-checked"); // not in the clone
    expect((await checkBackport(r, upstreamFix, "no-such-branch")).result).toBe("not-checked");
    expect((await checkBackport(r, "not a sha", "main")).result).toBe("not-checked");
    expect((await checkBackport(r, upstreamFix, "main..other")).result).toBe("not-checked");
    expect((await checkBackport(path.join(os.tmpdir(), "definitely-not-a-repo-xyz"), upstreamFix, "main")).result).toBe("not-checked");
  });
});
