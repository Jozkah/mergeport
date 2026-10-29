// A stand-in for the GitHub CLI, run as a REAL child process by the tests (its directory name contains a space on purpose).
// State lives in a JSON file the test edits between calls, which is how "gh auth switch" is simulated:
//   { active: "alice", accounts: { alice: { id: 1, token: "tok-alice" } }, noUserFlag?: bool, offline?: bool, delayMs?: number, mode?: "stall"|"tree" }
// Every call appends a line to the log file (argv, which account served it, whether an explicit token was supplied).
import fs from "node:fs";
import { spawn } from "node:child_process";

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);
const log = (o) => fs.appendFileSync(logPath, JSON.stringify(o) + "\n");
const explicit = process.env.GH_TOKEN ?? process.env.GH_ENTERPRISE_TOKEN ?? null;
const byToken = (t) => Object.entries(state.accounts).find(([, a]) => a.token === t)?.[0] ?? null;
const served = explicit ? byToken(explicit) : state.active;
const entry = { argv, served, explicit: !!explicit, inheritedToken: process.env.GITHUB_TOKEN ?? null, ghTokenEnv: process.env.GH_TOKEN ?? null, pid: process.pid };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (state.delayMs) await sleep(state.delayMs);
if (process.env.FAKE_GH_PIDFILE) fs.writeFileSync(process.env.FAKE_GH_PIDFILE, String(process.pid));

if (state.mode === "stall") {
  log({ ...entry, mode: "stall" });
  setInterval(() => {}, 1000);
} else if (state.mode === "tree") {
  // a child that starts a grandchild, like a credential helper would
  const g = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)", process.env.FAKE_GH_GRANDCHILD], { stdio: "ignore" });
  log({ ...entry, mode: "tree", grandchild: g.pid });
  setInterval(() => {}, 1000);
} else if (state.mode === "echo") {
  log({ ...entry, mode: "echo" });
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) input += c;
  process.stdout.write(JSON.stringify({ argv, input }));
} else if (argv[0] === "auth" && argv[1] === "token") {
  const u = argv[argv.indexOf("--user") + 1];
  log({ ...entry, kind: "auth-token", asked: u });
  if (state.noUserFlag) {
    process.stderr.write("unknown flag: --user\n");
    process.exit(1);
  }
  const a = state.accounts[u];
  if (!a) {
    process.stderr.write(`no oauth token found for ${u}\n`);
    process.exit(1);
  }
  process.stdout.write(a.token + "\n");
} else if (argv[0] === "api" && state.offline) {
  log({ ...entry, offline: true });
  process.stderr.write("error connecting to api.github.com\n");
  process.exit(1);
} else if (argv[0] === "api") {
  let input = "";
  if (argv.includes("--input")) {
    process.stdin.setEncoding("utf8");
    for await (const c of process.stdin) input += c;
  }
  const path = argv[argv.length - 1];
  const method = argv.includes("-X") ? argv[argv.indexOf("-X") + 1] : "GET";
  const withHeaders = argv.includes("-i");
  log({ ...entry, kind: "api", method, path, input });
  const respond = (status, body) => process.stdout.write(withHeaders ? `HTTP/2.0 ${status} X\r\ncontent-type: application/json; charset=utf-8\r\netag: "e1"\r\n\r\n${JSON.stringify(body)}` : JSON.stringify(body));
  if (!served) {
    // an unknown credential
    if (withHeaders) respond(401, { message: "Bad credentials" });
    else {
      process.stderr.write("gh: Bad credentials (HTTP 401)\n");
      process.exit(1);
    }
  } else if (path === "user") respond(200, { id: state.accounts[served].id, login: served });
  else if (path.startsWith("user/repos?")) {
    const mk = (id, name) => ({ id, name, full_name: `${served}/${name}`, html_url: `https://github.com/${served}/${name}`, private: true, fork: false, default_branch: "main", archived: false, owner: { id: state.accounts[served].id, login: served, type: "User" } });
    respond(200, [mk(7001, "demo-app"), mk(7002, "demo-api")]);
  }
  else if (state.leakTokenToStderr && explicit) {
    process.stderr.write(`something failed using ${explicit}\n`);
    process.exit(1);
  } else respond(method === "POST" ? 201 : 200, { ok: true, by: served, path });
} else {
  log({ ...entry, kind: "other" });
  process.exit(2);
}
