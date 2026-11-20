/**
 * Starts Mergeport locally:  npm run local   (or  npm run local:demo  for synthetic data without GitHub)
 *
 * - works out WHO is signed in to the GitHub CLI and opens that account's own profile database
 *   (~/.mergeport/profiles/<host>-<account id>/mergeport.db), so accounts never share data;
 * - binds the server to 127.0.0.1 only;
 * - opens your browser on a one-time launch link that binds that browser to this process.
 * No database server, Docker, tunnel or inbound network access is needed.
 */
import "dotenv/config";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrisma } from "../src/lib/db";
import { ghStatus, loginCommand, REQUIRED_SCOPES } from "../src/lib/github/gh";
import { mergeportHome } from "../src/lib/local/profile";
import { writeActive } from "../src/lib/local/registry";
import { resolveStartProfile, resolveSwitchTarget } from "../src/lib/local/start-profile";
import { spawnNext, waitForReady } from "../src/lib/local/child-process";
import type { Backend } from "../src/lib/local/backends";
import { NOT_RESTORED, Supervisor } from "../src/lib/local/supervisor";
import { looksOffline, savedProfiles } from "../src/lib/local/saved-profiles";
import { seedDemo } from "../src/lib/demo/seed";
import { activeDbFile, profileDirOf, readIndex } from "../src/lib/local/contexts";
import { buildReason, buildWithRetry, currentStamp, onChildExit, writeStamp } from "../src/lib/local/launcher";
import { removeControlFile, writeControlFile } from "../src/lib/local/fresh-link";
import { restrictToCurrentUser } from "../src/lib/hub/session-vault";
import { LAUNCH_TOKEN_TTL_MS } from "../src/lib/local/launch-token";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const noOpen = args.includes("--no-open");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.MERGEPORT_PORT) || 3000;
const host = process.env.MERGEPORT_HOST ?? "github.com";

async function main() {
  // Schema changes come from the Prisma CLI, not from the app: apply pending migrations to DATABASE_URL first.
  execFileSync(process.execPath, [path.resolve("node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], { stdio: "inherit" });
  const home = mergeportHome(process.env.MERGEPORT_HOME);
  let dbFile: string;
  let startBackend: Backend = "github";
  let signedInId: bigint | null = null; // who gh is (or, offline, who the saved profile is); switching only opens this account's profiles
  if (demo) {
    dbFile = path.join(home, "demo", "mergeport-demo.db");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = createPrisma();
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
      signedInId = BigInt(saved[0].id);
      createPrisma();
      console.log(`GitHub is unreachable (${st.message}). Opening the saved profile for @${saved[0].login} (id ${saved[0].id}) from this computer: ${dbFile}\nData is shown as last saved. Nothing is sent to GitHub until the account is verified again.`);
    } else {
      signedInId = st.identity.id;
      const prof = resolveStartProfile(home, host, st.identity.id);
      dbFile = prof.dbFile;
      startBackend = prof.backend;
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      createPrisma();
      console.log(`Signed in to ${host} as ${st.identity.login} (id ${st.identity.id}). Profile: ${dbFile}`);
    }
  }

  const next = path.join("node_modules", "next", "dist", "bin", "next");
  // Rebuild whenever the code changed since the last build (git pull), not only when there is none: an old build must not run
  // against a database this launcher just migrated for the new code.
  const root = process.cwd();
  const reason = buildReason(root);
  if (reason) {
    console.log(`Building the app (${reason}; about half a minute)…`);
    const buildEnv = { ...process.env, MERGEPORT_DB: dbFile, MERGEPORT_PORT: String(port), DEMO_MODE: demo ? "true" : "false", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    const run = () =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        let output = "";
        const p = spawn(process.execPath, [next, "build"], { stdio: ["ignore", "pipe", "pipe"], env: buildEnv });
        p.stdout.on("data", (d) => ((output += d), process.stdout.write(d)));
        p.stderr.on("data", (d) => ((output += d), process.stderr.write(d)));
        p.on("error", (e) => resolve({ code: null, output: output + e.message }));
        p.on("exit", (code) => resolve({ code, output }));
      });
    const b = await buildWithRetry(root, run);
    if (!b.ok) throw new Error(`Building Mergeport failed (next build exit code ${b.code}, ${b.attempts} attempt${b.attempts > 1 ? "s" : ""}). The build output is above; fix it and run this again.`);
    writeStamp(root);
  }

  // Team contexts: one profile can hold several databases. A child that exits with RESTART_EXIT_CODE asked to be reopened on the profile's (new) active one.
  const baseOf = (file: string) => {
    const dir = profileDirOf(file);
    return path.basename(path.dirname(file)) === "contexts" ? path.join(dir, readIndex(dir, path.basename(file)).base) : file;
  };
  const openContext = async (base: string) => {
    const file = activeDbFile(profileDirOf(base), path.basename(base));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const migrated = createPrisma()
    if (demo && (await migrated.user.count()) === 0) await seedDemo(migrated);
    await migrated.$disconnect();
    if (file !== base) console.log(`Opening context database: ${file}`);
    return file;
  };
  let lastBase = dbFile;
  let lastBackend = startBackend; // a relaunch reopens whatever workspace was running, not necessarily the one the launcher started with
  // The supervisor owns the one app process, so a workspace switch is a restart on another database, never an in-process swap.
  const control = { url: "" };
  // The desktop shortcut asks the running app for a fresh sign-in link with this secret (see fresh-link.ts), so it need not restart it.
  const controlSecret = randomBytes(24).toString("base64url");
  const supervisor = new Supervisor(
    {
      spawnChild: (spec) => spawnNext(spec, { MERGEPORT_CONTROL_URL: control.url, MERGEPORT_CONTROL_SECRET: controlSecret, MERGEPORT_LAUNCHER: "1", MERGEPORT_BASE_DB: ((lastBackend = spec.backend ?? lastBackend), (lastBase = baseOf(spec.dbFile))) }),
      waitReady: (p, signal) => waitForReady(p, signal),
      resolveTarget: async ({ backend }) => {
        if (demo || signedInId === null) throw new Error("Switching workspaces is not available in this mode.");
        return resolveSwitchTarget(home, host, signedInId, backend);
      },
      // The launcher owns active.json: it changes only once the new workspace is really up.
      onSwitched: (backend) => {
        if (signedInId !== null) writeActive(home, { host, accountId: String(signedInId), backend });
      },
      newToken: () => randomBytes(24).toString("base64url"),
    },
    { port, demo },
  );
  Object.assign(control, await supervisor.listenControl());
  // Stop the whole tree (the server AND any gh it is running) so nothing outlives the launcher. On Windows a plain kill would orphan them.
  const stop = () => void supervisor.stop().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A child that dies outside a switch ends the launcher, as before.
  // Exit 75 (context switch) relaunches and opens the new link even under --no-open: see onChildExit.
  supervisor.on("child-exit", (c) => {
    void onChildExit(c, {
      relaunch: () => openContext(lastBase).then((file) => supervisor.start({ dbFile: file, backend: lastBackend })).then((r) => r.launchUrl),
      openInBrowser: (u) => openLink(u, true),
      exit: (code) => process.exit(code),
      log: console.log,
    });
  });
  // A switch that failed after the browser was told it was accepted has no other way to be reported.
  supervisor.on("switch-failed", (err) => {
    console.error(err.message);
    if (err.message === NOT_RESTORED) void supervisor.stop().finally(() => process.exit(1)); // no child is running any more
  });

  // --no-open applies to the first start only; `force` is the relaunch a user started from the browser.
  const openLink = (url: string, force = false) => {
    if (!noOpen || force) {
      const [cmd, a] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      execFile(cmd as string, a as string[], () => {});
    } else
      console.log(`Open this one-time link (it works once, within ${LAUNCH_TOKEN_TTL_MS / 60000} minutes):\n${url}\nFor a fresh link later, stop Mergeport and start it again (or use the desktop shortcut, which restarts it).`);
  };
  const started = Date.now();
  const { launchUrl: url } = await supervisor.start({ dbFile: await openContext(dbFile), backend: startBackend }).catch(async (e) => {
    await supervisor.stop();
    throw e;
  });
  if (!demo) {
    writeControlFile(home, { port, secret: controlSecret, pid: process.pid, stamp: currentStamp(root) }, restrictToCurrentUser);
    process.on("exit", () => removeControlFile(home, process.pid));
  }
  setTimeout(() => {
    console.log(`\nMergeport is running at http://127.0.0.1:${port} (this computer only).`);
    if (demo) console.log("Demo sign-in is on the sign-in page.");
    openLink(url);
  }, Math.max(0, 2500 - (Date.now() - started)));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
