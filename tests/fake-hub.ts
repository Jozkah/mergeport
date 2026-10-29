import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test double for a Mergeport hub: only /health and the two device-flow endpoints, on loopback.
 * It never logs; every request is recorded so tests can assert on what the client sent.
 */
export type FakeHubOpts = {
  publicUrl?: string;
  githubHost?: string;
  team?: string | null;
  invited?: boolean;
  removed?: boolean;
  expired?: boolean;
  pollsBeforeOk?: number;
  githubId?: string;
  login?: string;
};
export type FakeHubRequest = { method: string; path: string; body: unknown };

export async function startFakeHub(opts: FakeHubOpts = {}) {
  const requests: FakeHubRequest[] = [];
  let polls = 0;
  let origin = "";
  const team = opts.team === undefined ? "Fake Team" : opts.team;
  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const p = (req.url ?? "").split("?")[0];
      requests.push({ method: req.method ?? "", path: p, body });
      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true, team: team === null ? null : { name: team }, schema: 1, publicUrl: opts.publicUrl ?? origin, githubHost: opts.githubHost ?? "github.com" });
      if (req.method === "POST" && p === "/auth/device/start") return send(res, 200, { deviceCode: "dev-code-secret", userCode: "ABCD-1234", verificationUri: `${origin}/device`, interval: 1, expiresIn: 600 });
      if (req.method === "POST" && p === "/auth/device/poll") {
        if (opts.expired) return send(res, 410);
        if (opts.removed) return send(res, 403, { reason: "removed" });
        if (opts.invited === false) return send(res, 403, { reason: "not-invited" });
        if (polls++ < (opts.pollsBeforeOk ?? 0)) return send(res, 202);
        return send(res, 200, { session: "session-token-secret", member: { githubId: opts.githubId ?? "1", login: opts.login ?? "octocat" }, team: { name: team ?? "" } });
      }
      send(res, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
