/**
 * One-off: configure the signed-in profile's workspace for the newer features, using the app's own services (so every rule and
 * validation applies). Local only: nothing is sent to GitHub and nothing is published to a team space.
 *   MERGEPORT_DB=<profile db> node --import tsx scripts/setup-workspace.ts [--clones <folder>]
 */
import path from "node:path";
import { createPrisma } from "../src/lib/db";
import { loadViewer } from "../src/lib/authz/viewer";
import { setPrefs } from "../src/lib/services/notification-prefs";
import { saveView } from "../src/lib/services/views";
import { createBoard, setAutomation } from "../src/lib/services/planning-ext";
import { applyAutoSetup, planAutoSetup } from "../src/lib/services/auto-setup";

const file = process.env.MERGEPORT_DB;
if (!file) throw new Error("Set MERGEPORT_DB to the profile database");
const clones = process.argv.includes("--clones") ? process.argv[process.argv.indexOf("--clones") + 1] : path.dirname(process.cwd());

async function main() {
  const db = createPrisma(path.resolve(file!), { migrate: false });
  const user = await db.user.findFirstOrThrow({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  const v = (await loadViewer(db, user.id))!;
  const did: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      did.push(`done: ${label}`);
    } catch (e) {
      did.push(`skipped: ${label} (${e instanceof Error ? e.message : "failed"})`);
    }
  };

  await step("notification preferences (in-app and desktop for both events, quiet 23:00-07:00)", () =>
    setPrefs(db, v.userId, { kinds: { "review-requested": { inApp: true, desktop: true }, "changes-requested": { inApp: true, desktop: true } }, quiet: { enabled: true, start: "23:00", end: "07:00" } }),
  );

  const views: [string, string, string][] = [
    ["attention", "Needs my review", "queue=needs-me"],
    ["attention", "Blocked", "queue=blocked"],
    ["attention", "Waiting on maintainers", "queue=waiting"],
    ["attention", "Changes requested on mine", "queue=changes"],
    ["tasks", "My open tasks", "scope=mine"],
    ["tasks", "Unassigned", "scope=unassigned"],
    ["PULL_REQUEST", "My open pull requests", `state=OPEN&author=${user.login}`],
    ["PULL_REQUEST", "Merged, newest first", "state=MERGED&sort=updated"],
  ];
  for (const [scope, name, query] of views) await step(`saved view "${name}"`, () => saveView(db, v, { scope, name, query }));

  // Only the project that is not shared with anyone: its board and automation settings stay on this computer.
  const mine = await db.project.findFirst({ where: { name: "Mine", spaceId: null } });
  if (mine) {
    await step('board "Delivery" on Mine', () => createBoard(db, v, { projectId: mine.id, template: "delivery", density: "compact" }));
    await step('board "Maintenance" on Mine', () => createBoard(db, v, { projectId: mine.id, template: "maintenance", groupBy: "repository", density: "compact" }));
    await step("suggest Done for merged PRs and closed issues on Mine (preview only)", () => setAutomation(db, v, mine.id, "suggest"));
  }

  // Local folders for tracked repositories whose clone was found next to this app (the same list Settings proposes).
  const plan = await planAutoSetup(db, v, { clonesFolder: clones });
  const folders = plan.steps.filter((s) => s.kind === "folder").map((s) => s.id);
  if (folders.length) await step(`map ${folders.length} local clone folder(s) (read-only, stays on this computer)`, () => applyAutoSetup(db, v, folders, { clonesFolder: clones }));

  console.log(did.join("\n"));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
