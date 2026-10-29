import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HubConfig } from "./config";
import type { HubDb } from "./db";
import { adminRoutes } from "./admin-routes";
import { authRoutes } from "./auth-routes";
import { HttpError, json, matchRoute, route, type Route } from "./http";
import { createLogger, type Logger } from "./log";

export type { Logger };

export type HubContext = {
  config: HubConfig;
  db: HubDb;
  now: () => number;
  log: Logger;
  /** Public base URL: config value, or the listened URL when config leaves it empty. */
  publicUrl: () => string;
};

export type Hub = { listen(port?: number): Promise<{ port: number; url: string }>; close(): Promise<void> };

/** Later tasks add their routes here, or pass `routes` to createHub. */
export function coreRoutes(): Route<HubContext>[] {
  return [
    route<HubContext>("GET", "/health", (ctx, _req, res) => {
      const team = ctx.db.prepare("SELECT name FROM team LIMIT 1").get() as { name: string } | undefined;
      json(res, 200, { ok: true, team: team ? { name: team.name } : null, schema: 1, publicUrl: ctx.publicUrl(), githubHost: "github.com" });
    }),
    ...authRoutes(),
    ...adminRoutes(),
  ];
}

export function createHub(opts: { config: HubConfig; db: HubDb; now?: () => number; log?: Logger; routes?: Route<HubContext>[] }): Hub {
  let listened = "";
  const ctx: HubContext = {
    config: opts.config,
    db: opts.db,
    now: opts.now ?? Date.now,
    log: opts.log ?? createLogger(),
    publicUrl: () => opts.config.publicUrl || listened,
  };
  const routes = [...coreRoutes(), ...(opts.routes ?? [])];

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://hub.local");
        const m = matchRoute(routes, req.method ?? "GET", url.pathname);
        if (!m) throw new HttpError(404, "not found");
        await m.route.handler(ctx, req, res, m.params, url);
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (e instanceof HttpError) json(res, e.status, { error: e.message }, e.headers);
        else {
          ctx.log.error("unhandled", { method: req.method, path: req.url?.split("?")[0], error: e instanceof Error ? e.message : "unknown error" });
          json(res, 500, { error: "internal" });
        }
      }
    })();
  });

  return {
    listen(port = opts.config.port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, opts.config.bindHost, () => {
          const p = (server.address() as AddressInfo).port;
          listened = `http://127.0.0.1:${p}`;
          resolve({ port: p, url: listened });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
