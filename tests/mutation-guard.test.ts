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

type Allow = { file: string; fn: string; reason: string };
const ALLOW: Allow[] = [
  { file: "src/app/account-actions.ts", fn: "createWorkspaceAction", reason: "Identity level: a person with no workspace yet creates their first one. There is no workspace role to check." },
  { file: "src/app/account-actions.ts", fn: "signOutEverywhereAction", reason: "Ends the caller's own sessions; touches no workspace data." },
  { file: "src/app/account-actions.ts", fn: "switchWorkspaceAction", reason: "Chooses among the caller's own ACTIVE memberships; selectWorkspace re-checks membership." },
  { file: "src/app/invite/actions.ts", fn: "acceptInviteAction", reason: "The caller is not a member yet; acceptInvitation checks the token and the verified address." },
  { file: "src/app/sign-in/actions.ts", fn: "startGhLoginAction", reason: "Local app sign-in, before any session exists." },
  { file: "src/app/workspace-actions.ts", fn: "leaveWorkspaceAction", reason: "A reader may leave too; leaveWorkspace refuses the owner and re-reads the membership." },
  { file: "src/app/actions.ts", fn: "setTimezoneAction", reason: "The caller's own timezone." },
  { file: "src/app/actions.ts", fn: "saveFilterAction", reason: "The caller's own saved filter (per person, not per workspace)." },
  { file: "src/app/actions.ts", fn: "deleteFilterAction", reason: "The caller's own saved filter." },
  { file: "src/app/actions.ts", fn: "markNotificationsReadAction", reason: "The caller's own notifications." },
  { file: "src/app/context-actions.ts", fn: "switchContextAction", reason: "Local app only: picks which local profile to open." },
  { file: "src/app/digest-actions.ts", fn: "regenerateDigestAction", reason: "Rebuilds the caller's own digest from data they can already see." },
  { file: "src/app/digest-actions.ts", fn: "markDigestReadAction", reason: "The caller's own digest state." },
  { file: "src/app/digest-actions.ts", fn: "saveDigestSettingsAction", reason: "The caller's own digest preference." },
  { file: "src/app/inbox-actions.ts", fn: "inboxAction", reason: "The caller's own inbox state (read, done, snooze); never shared." },
  { file: "src/app/inbox-actions.ts", fn: "inboxReadAllAction", reason: "The caller's own inbox state." },
  { file: "src/app/inbox-actions.ts", fn: "markSeenAction", reason: "The caller's own seen marker; never a review decision." },
  { file: "src/app/notify-actions.ts", fn: "savePrefsAction", reason: "The caller's own notification preferences." },
  { file: "src/app/palette-actions.ts", fn: "previewQuickAction", reason: "Preview only: computes what applyQuickAction would do and writes nothing." },
  { file: "src/app/scope-actions.ts", fn: "setScopeAction", reason: "Remembers the caller's working scope in a cookie." },
  { file: "src/app/upstream-update-actions.ts", fn: "markReleasesSeenAction", reason: "The caller's own seen marker." },
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
      fns.push({ file: rel(f), name: s.name, guarded: GUARD.test(body) });
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

  it("inline server actions only delegate to guarded actions", () => {
    // tasks/[id]/page.tsx defines saveDetailsAction inline and calls updateTaskAction and taskBranchAction, both guarded above.
    expect(inline.sort()).toEqual(["src/app/(app)/tasks/[id]/page.tsx"]);
    const src = fs.readFileSync(path.join(root, "src/app/(app)/tasks/[id]/page.tsx"), "utf8");
    expect(src).toMatch(/updateTaskAction\(fd\)/);
    expect(fns.find((f) => f.name === "updateTaskAction")?.guarded).toBe(true);
    expect(fns.find((f) => f.name === "taskBranchAction")?.guarded).toBe(true);
  });

  it("every member and space administration action is guarded", () => {
    const mine = fns.filter((f) => f.file === "src/app/workspace-actions.ts" && f.name !== "leaveWorkspaceAction");
    expect(mine.length).toBeGreaterThanOrEqual(12);
    expect(mine.every((f) => f.guarded)).toBe(true);
  });
});
