/**
 * Mergeport tasks from the command line, for people and AI agents:  npm run mp -- help
 * Runs the app's own services against the signed-in profile's database as that profile's user. No network, no GitHub, no tokens.
 */
import { loadProfileViewer, locateProfile, CliError } from "../src/lib/cli/locate";
import { runMp } from "../src/lib/cli/mp";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const fail = (m: string, candidates?: string[]) => {
    console.error(json ? JSON.stringify({ error: m, ...(candidates ? { candidates } : {}) }) : `Error: ${m}${candidates ? "\n" + candidates.map((c) => `  ${c}`).join("\n") : ""}`);
    return 1;
  };
  try {
    if (argv[0] === "help" || argv[0] === "--help") return runMp(argv, { db: null as never, viewer: null as never, now: () => new Date(), out: { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) } });
    const loc = locateProfile();
    process.env.MERGEPORT_DB = loc.file; // the shared client opens exactly this profile's database
    const { db } = await import("../src/lib/db");
    try {
      const viewer = await loadProfileViewer(db, loc.expectedGithubId);
      return await runMp(argv, { db, viewer, now: () => new Date(), out: { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) } });
    } finally {
      await db.$disconnect();
    }
  } catch (e) {
    return e instanceof CliError ? fail(e.message, e.candidates) : fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
main().then((c) => (process.exitCode = c));
