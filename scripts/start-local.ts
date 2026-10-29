/**
 * Starts Mergeport locally:  npm run local   (or  npm run local:demo  for synthetic data without GitHub)
 *
 * - works out WHO is signed in to the GitHub CLI and opens that account's own profile database
 *   (~/.mergeport/profiles/<host>-<account id>/mergeport.db), so accounts never share data;
 * - binds the server to 127.0.0.1 only;
 * - opens your browser on a one-time launch link that binds that browser to this process.
 * No database server, Docker, tunnel or inbound network access is needed.
 */
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrisma } from "../src/lib/db";
import { killTree } from "../src/lib/github/exec";
import { ghStatus, loginCommand, REQUIRED_SCOPES } from "../src/lib/github/gh";
import { mergeportHome, profileDbPath } from "../src/lib/local/profile";
import { looksOffline, savedProfiles } from "../src/lib/local/saved-profiles";
import { seedDemo } from "../src/lib/demo/seed";
import { activeDbFile, profileDirOf } from "../src/lib/local/contexts";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const noOpen = args.includes("--no-open");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.MERGEPORT_PORT) || 3000;
const host = process.env.MERGEPORT_HOST ?? "github.com";

async function main() {
  const home = mergeportHome(process.env.MERGEPORT_HOME);
  let dbFile: string;
  if (demo) {
    dbFile = path.join(home, "demo", "mergeport-demo.db");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = createPrisma(dbFile);
    if ((await db.user.count()) === 0) await seedDemo(db);
    await db.$disconnect();
    console.log("Demo mode: synthetic data, no GitHub access.");
  } else {
    const st = await ghStatus(undefined, host);
    if (st.state === "missing-gh") {
      console.error("The GitHub CLI (gh) is required. Install it from https://cli.github.com/ (Windows: winget install GitHub.cli), then run this again.");
      process.exit(2);
    }
    if (st.state === "not-logged-in") {
      console.error(`You are not signed in to GitHub. Run:\n\n  ${loginCommand(host)}\n\nThis asks GitHub for the scopes ${REQUIRED_SCOPES.join(", ")}. “repo” is broad read/write access to repositories you can reach, not a read-only permission. gh stores the token in your OS credential store; Mergeport never reads it.`);
      process.exit(2);
    }
    if (st.state === "error") {
      // GitHub being unreachable must not lock a person out of data already on this computer. With exactly one saved profile
      // the app opens it read-and-edit locally; nothing is sent to GitHub until the account is verified by numeric id again.
      const saved = looksOffline(st.message) ? savedProfiles(home, host) : [];
      if (saved.length !== 1) {
        console.error("Could not ask GitHub who you are: " + st.message + (looksOffline(st.message) ? (saved.length > 1 ? "\nSeveral saved profiles exist, so Mergeport cannot pick one without GitHub. Connect to the network and run this again." : "\nThere is no saved profile on this computer yet, so there is nothing to open offline. Connect to the network and run this again.") : ""));
        process.exit(2);
      }
      dbFile = saved[0].dbFile;
      createPrisma(dbFile); // applies migrations
      console.log(`GitHub is unreachable (${st.message}). Opening the saved profile for @${saved[0].login} (id ${saved[0].id}) from this computer: ${dbFile}\nData is shown as last saved. Nothing is sent to GitHub until the account is verified again.`);
    } else {
      dbFile = profileDbPath(home, host, st.identity.id);
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      createPrisma(dbFile); // applies migrations
      console.log(`Signed in to ${host} as ${st.identity.login} (id ${st.identity.id}). Profile: ${dbFile}`);
    }
  }

  // The profile's base database is the one chosen above. The ACTIVE context (a separate database file for another team) may be a
  // different file in the same folder; switching writes the new choice and exits with RESTART so this launcher reopens it.
  const baseFile = dbFile;
  const dir = profileDirOf(baseFile);
  const baseName = path.basename(baseFile);
  const RESTART = 75;
  for (;;) {
    const file = activeDbFile(dir, baseName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const migrated = createPrisma(file); // applies migrations to this context's database
    if (demo && (await migrated.user.count()) === 0) await seedDemo(migrated);
    await migrated.$disconnect();
    if (file !== baseFile) console.log(`Opening context database: ${file}`);
    const code = await serve(file, baseFile);
    if (code !== RESTART) process.exit(code);
    console.log("Switching context: restarting Mergeport…");
  }
}

function serve(dbFile: string, baseFile: string): Promise<number> {
  const token = randomBytes(24).toString("base64url");
  const env = { ...process.env, MERGEPORT_DB: dbFile, MERGEPORT_BASE_DB: baseFile, MERGEPORT_LAUNCHER: "1", MERGEPORT_LAUNCH_TOKEN: token, MERGEPORT_PORT: String(port), DEMO_MODE: demo ? "true" : "false", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
  const next = path.join("node_modules", "next", "dist", "bin", "next");
  return (async () => {
    if (!fs.existsSync(".next/BUILD_ID")) {
      console.log("First run: building the app (one time)…");
      await new Promise<void>((resolve, reject) => spawn(process.execPath, [next, "build"], { stdio: "inherit", env: { ...env, NODE_ENV: "production" } }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("build failed")))));
    }
    const child = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], { stdio: "inherit", env });
    const url = `http://127.0.0.1:${port}/api/local/launch?token=${encodeURIComponent(token)}`;
    setTimeout(() => {
      console.log(`\nMergeport is running at http://127.0.0.1:${port} (this computer only).`);
      if (demo) console.log("Demo sign-in is on the sign-in page.");
      if (!noOpen) {
        const [cmd, a] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
        execFile(cmd as string, a as string[], () => {});
      } else console.log("Open this one-time link:\n" + url);
    }, 2500);
    // Stop the whole tree (the server AND any gh it is running) so nothing outlives the launcher. On Windows a plain kill would orphan them.
    const stop = () => killTree(child);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return await new Promise<number>((resolve) =>
      child.on("exit", (c) => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve(c ?? 0);
      }),
    );
  })();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
