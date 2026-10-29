import fs from "node:fs";
import path from "node:path";
import { HubForbidden, HubRequestError, HubUnauthorized, type HubAdminApi, type HubLinkStatus, type HubSessionPort } from "@/lib/hub/ports";

/**
 * STAND-IN for plan 2. The real implementation keeps the session token encrypted in the profile db (HubSession table
 * plus a key file) and stores the backend on TeamConfig. Until those columns exist, this writes two small files beside
 * the db instead (`save`, `read` and `remove` all act on `hub-session.json`). `hub-session.json` holds the token in clear text, so it is only ever written inside the profile
 * directory (never hubs.json, active.json, logs or any response) and is replaced wholesale by plan 2.
 */

const writeJson = (file: string, value: unknown, mode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
};

export const hubSessionPort: HubSessionPort = {
  async save(dbFile, s) {
    writeJson(path.join(path.dirname(dbFile), "hub-session.json"), { origin: s.origin, token: s.token, githubId: s.githubId }, 0o600);
  },
  async markProfile(dbFile, p) {
    writeJson(path.join(path.dirname(dbFile), "hub-profile.json"), { backend: p.backend, origin: p.origin, teamName: p.teamName });
  },
  async read(dbFile) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(path.dirname(dbFile), "hub-session.json"), "utf8"));
      if (typeof j?.origin === "string" && typeof j.token === "string" && typeof j.githubId === "string") return { origin: j.origin, token: j.token, githubId: j.githubId };
    } catch {
      // missing or unreadable: no session
    }
    return null;
  },
  async remove(dbFile) {
    fs.rmSync(path.join(path.dirname(dbFile), "hub-session.json"), { force: true });
  },
};

const TIMEOUT_MS = 8000;

/** HTTP admin client. Errors never carry the token or the response body. */
export function httpHubAdmin(origin: string, token: () => Promise<string | null>, fetchImpl: typeof fetch = fetch): HubAdminApi {
  const call = async (method: string, p: string, body?: unknown): Promise<unknown> => {
    const t = await token();
    if (!t) throw new HubUnauthorized();
    const headers: Record<string, string> = { authorization: `Bearer ${t}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new HubRequestError("Could not reach the server", 0);
    }
    if (res.status === 401) throw new HubUnauthorized();
    if (res.status === 403) throw new HubForbidden();
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      throw new HubRequestError(ra ? `The server is busy. Try again in ${ra} seconds.` : "The server is busy. Try again shortly.", 429, ra);
    }
    if (!res.ok) throw new HubRequestError(`The server answered ${res.status}`, res.status);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new HubRequestError("The server sent an unreadable answer", res.status);
    }
  };
  const seg = encodeURIComponent;
  return {
    me: async () => (await call("GET", "/me")) as Awaited<ReturnType<HubAdminApi["me"]>>,
    invite: async (login, role) => void (await call("POST", "/admin/invites", { login, role })),
    removeMember: async (id) => void (await call("DELETE", `/admin/members/${seg(id)}`)),
    setRole: async (id, role) => void (await call("PATCH", `/admin/members/${seg(id)}`, { role })),
    createSpace: async (name, members) => (await call("POST", "/admin/spaces", { name, members })) as Awaited<ReturnType<HubAdminApi["createSpace"]>>,
    updateSpace: async (id, p) => void (await call("PATCH", `/admin/spaces/${seg(id)}`, p)),
    deleteSpace: async (id) => void (await call("DELETE", `/admin/spaces/${seg(id)}`)),
    logout: async () => void (await call("POST", "/auth/logout")),
  };
}

/** Plan 2 reports the live sync link; until then every hub profile reads as offline. */
export async function hubLinkStatus(_dbFile: string): Promise<HubLinkStatus> {
  return { state: "offline", pendingOps: 0, needsSignIn: false };
}
