/**
 * Mergeport as an MCP server over stdio:  npm run --silent mcp
 * Lets any MCP-capable AI app (Claude, opencode, Cursor...) create and update Mergeport tasks and look up pull request status.
 * Runs against the signed-in profile's database as that profile's user. No network, no GitHub, no tokens.
 * stdout carries protocol messages only; anything else goes to stderr.
 */
import { loadProfileViewer, locateProfile } from "../src/lib/cli/locate";
import { serve } from "../src/lib/mcp/server";

async function main(): Promise<number> {
  const loc = locateProfile();
  process.env.MERGEPORT_DB = loc.file; // the shared client opens exactly this profile's database
  const { db } = await import("../src/lib/db");
  try {
    const viewer = await loadProfileViewer(db, loc.expectedGithubId);
    await serve(process.stdin, (line) => process.stdout.write(line + "\n"), { db, viewer });
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (c) => (process.exitCode = c),
  (e) => {
    console.error(`mergeport mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
