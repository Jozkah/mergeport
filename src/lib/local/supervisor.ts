import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Backend } from "@/lib/local/backends";

export type ChildSpec = { dbFile: string; token: string; port: number; demo: boolean };
export type ChildHandle = { kill(): Promise<void>; onExit(cb: (code: number | null) => void): void };
export type SupervisorDeps = {
  spawnChild(spec: ChildSpec): ChildHandle;
  /** Resolves the child's boot id once it answers; rejects when the signal aborts. */
  waitReady(port: number, signal: AbortSignal): Promise<string>;
  /** Throws when the workspace cannot be opened (not signed in, hub gone, ...). */
  resolveTarget(req: { backend: Backend }): Promise<{ dbFile: string }>;
  newToken(): string;
};
type Started = { launchUrl: string; bootId: string };

const BACKEND_RE = /^(github|hub-[0-9a-f]{16})$/;
const SECRET_HEADER = "x-mergeport-control";
const RESTORED = "Could not start the other workspace; the previous one was restored";

/** The target cannot be opened; answered as 409 on the control channel. */
class TargetUnavailableError extends Error {}

type Running = { spec: ChildSpec; handle: ChildHandle; expectedExit: boolean };

/** Owns the one app child process. A switch kills it and starts another, so two children never share the port. */
export class Supervisor {
  private current: Running | null = null;
  private inflight: Promise<Started> | null = null;
  private control: Server | null = null;
  private stopping = new AbortController();
  private listeners: Array<(code: number | null) => void> = [];

  constructor(private deps: SupervisorDeps, private opts: { port: number; demo: boolean }) {}

  /** Only event: "child-exit", for a child that died outside a switch. The supervisor does not respawn it. */
  on(event: "child-exit", cb: (code: number | null) => void) {
    if (event === "child-exit") this.listeners.push(cb);
  }

  start(initial: { dbFile: string }): Promise<Started> {
    return this.serialized(async () => this.boot({ dbFile: initial.dbFile, token: this.deps.newToken(), port: this.opts.port, demo: this.opts.demo }));
  }

  switchTo(req: { backend: Backend }): Promise<Started> {
    return this.serialized(async () => {
      let target: { dbFile: string };
      try {
        target = await this.deps.resolveTarget(req);
      } catch (e) {
        throw new TargetUnavailableError(e instanceof Error ? e.message : "That workspace is not available.");
      }
      const previous = this.current?.spec ?? null;
      await this.killCurrent();
      try {
        return await this.boot({ dbFile: target.dbFile, token: this.deps.newToken(), port: this.opts.port, demo: this.opts.demo });
      } catch {
        await this.killCurrent();
        if (previous && !this.stopping.signal.aborted) await this.boot(previous).catch(() => undefined);
        throw new Error(RESTORED);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.inflight?.catch(() => undefined);
    await this.killCurrent();
    const control = this.control;
    this.control = null;
    if (control) await new Promise<void>((resolve) => control.close(() => resolve()));
  }

  /** Loopback-only HTTP endpoint the app child calls to ask for a switch. */
  listenControl(): Promise<{ url: string; secret: string }> {
    const secret = randomBytes(24).toString("hex");
    const server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/switch") return reply(404, { error: "Not found" });
      if (!sameSecret(req.headers[SECRET_HEADER], secret)) return reply(401, { error: "Unauthorized" });
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c;
        if (raw.length > 4096) req.destroy();
      });
      req.on("end", () => {
        const backend = parseBackend(raw);
        if (!backend) return reply(400, { error: "Bad request" });
        this.switchTo({ backend }).then(
          (r) => reply(200, { launchUrl: r.launchUrl }),
          (e) => (e instanceof TargetUnavailableError ? reply(409, { error: e.message }) : reply(500, { error: e instanceof Error ? e.message : "Switch failed" })),
        );
      });
    });
    this.control = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("Control channel failed to bind"));
        resolve({ url: `http://127.0.0.1:${addr.port}`, secret });
      });
    });
  }

  /** One operation at a time; a caller arriving mid-flight gets the same promise. */
  private serialized(fn: () => Promise<Started>): Promise<Started> {
    if (this.inflight) return this.inflight;
    const p = fn().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async boot(spec: ChildSpec): Promise<Started> {
    const run: Running = { spec, handle: this.deps.spawnChild(spec), expectedExit: false };
    this.current = run;
    // Aborting on exit lets waitReady fail fast when the child dies while booting.
    const boot = new AbortController();
    const abort = () => boot.abort();
    this.stopping.signal.addEventListener("abort", abort, { once: true });
    run.handle.onExit((code) => {
      boot.abort();
      if (this.current === run) this.current = null;
      if (!run.expectedExit) this.listeners.forEach((cb) => cb(code));
    });
    try {
      const bootId = await this.deps.waitReady(spec.port, boot.signal);
      return { launchUrl: `http://127.0.0.1:${spec.port}/api/local/launch?token=${spec.token}`, bootId };
    } finally {
      this.stopping.signal.removeEventListener("abort", abort);
    }
  }

  private async killCurrent() {
    const run = this.current;
    if (!run) return;
    run.expectedExit = true;
    this.current = null;
    await run.handle.kill();
  }
}

function sameSecret(got: string | string[] | undefined, secret: string): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBackend(raw: string): Backend | null {
  try {
    const b = (JSON.parse(raw) as { backend?: unknown }).backend;
    return typeof b === "string" && BACKEND_RE.test(b) ? (b as Backend) : null;
  } catch {
    return null;
  }
}

/** Used by the app child to ask the supervisor for a switch. */
export class ControlClient {
  constructor(private url: string, private secret: string) {}

  async switchTo(backend: Backend): Promise<{ launchUrl: string }> {
    const res = await fetch(`${this.url}/switch`, {
      method: "POST",
      headers: { "content-type": "application/json", [SECRET_HEADER]: this.secret },
      body: JSON.stringify({ backend }),
    });
    const body = (await res.json().catch(() => ({}))) as { launchUrl?: string; error?: string };
    if (!res.ok || !body.launchUrl) throw new Error(body.error ?? `Switch failed (${res.status})`);
    return { launchUrl: body.launchUrl };
  }
}
