import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * The ONLY place that fetches an address a person typed. Everything federation sends to another instance goes through here.
 *
 *  - https only (http and loopback targets only with `allowInsecure`, which the config refuses in production);
 *  - the host is resolved HERE, every answer is checked, and the connection is pinned to the checked address through a custom
 *    `lookup`: a second DNS answer (rebinding) can never change where the socket goes. If any answer is forbidden the call fails;
 *  - forbidden: loopback, private, link-local (cloud metadata 169.254.169.254), CGNAT, multicast, reserved and documentation
 *    ranges, for IPv4, IPv6 and IPv4 inside IPv6 (mapped, NAT64, 6to4, compatible);
 *  - no redirects: any 3xx except 304 Not Modified is an error (nothing to re-validate, no credentials to strip). No cookies are ever sent or kept;
 *  - connect timeout 5 s, total 10 s, response capped at 2 MB, the answer must be application/json.
 */
export type SafeFetchErrorCode = "bad-url" | "scheme" | "port" | "blocked-address" | "dns" | "redirect" | "timeout" | "too-large" | "content-type" | "network" | "bad-header";

export class SafeFetchError extends Error {
  constructor(public code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
/** `http.request` / `https.request` shape, injectable so the tests can feed an answer without a socket. */
export type RequestFn = (options: http.RequestOptions | https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.ClientRequest;

export type SafeFetchInit = { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; allowInsecure?: boolean; connectTimeoutMs?: number; totalTimeoutMs?: number; maxBytes?: number };
export type SafeFetchDeps = { resolve?: Resolver; request?: { http?: RequestFn; https?: RequestFn } };
export type SafeFetchResponse = { status: number; headers: Record<string, string>; text: string; json: unknown };

/** What the federation code calls; tests substitute an implementation that routes by origin to the provider handlers. */
export type FedFetch = (url: string, init?: SafeFetchInit) => Promise<SafeFetchResponse>;

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// ---------- address classification ----------

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** 16 bytes of an IPv6 address (zone ids refused), or null. Handles `::` and a trailing dotted quad. */
export function parseV6(input: string): number[] | null {
  if (input.includes("%")) return null;
  let s = input.toLowerCase();
  const tail = s.lastIndexOf(":");
  let v4: number[] | null = null;
  if (s.includes(".")) {
    v4 = parseV4(s.slice(tail + 1));
    if (!v4) return null;
    s = s.slice(0, tail + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  if (v4) out.splice(12, 4, ...v4);
  return out;
}

const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function inV4(o: number[], base: number[], bits: number): boolean {
  const a = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const b = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

const isLoopbackV4 = (o: number[]) => o[0] === 127;

/** True when a connection to this IPv4 must be refused. `allowLoopback` is the development override (loopback only; metadata and private ranges stay refused). */
function blockedV4(o: number[], allowLoopback: boolean): boolean {
  if (allowLoopback && isLoopbackV4(o)) return false;
  return V4_BLOCKED.some(([base, bits]) => inV4(o, base, bits));
}

function blockedV6(b: number[], allowLoopback: boolean): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embedded = () => b.slice(12, 16);
  if (zeros(0, 15) && b[15] === 1) return !allowLoopback; // ::1
  if (zeros(0, 16)) return true; // ::
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(embedded(), allowLoopback); // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 12)) return true; // ::a.b.c.d (deprecated compatible form)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return blockedV4(embedded(), allowLoopback); // 64:ff9b::/96 NAT64
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return true; // 64:ff9b:1::/48 local-use NAT64
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true; // ::ffff:0:0:0/96 SIIT (IPv4-translated)
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true; // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (embeds an IPv4)
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** True when `ip` (IPv4 or IPv6 text) is somewhere a federation call must never connect. Unparseable input counts as forbidden. */
export function isForbiddenAddress(ip: string, allowLoopback = false): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const o = parseV4(ip);
    return !o || blockedV4(o, allowLoopback);
  }
  if (kind === 6) {
    const b = parseV6(ip);
    return !b || blockedV6(b, allowLoopback);
  }
  return true;
}

// ---------- fetch ----------

const defaultResolve: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

const FORBIDDEN_HEADERS = new Set(["cookie", "host", "connection", "transfer-encoding", "content-length", "proxy-authorization"]);

export async function safeFetchJson(rawUrl: string, init: SafeFetchInit = {}, deps: SafeFetchDeps = {}): Promise<SafeFetchResponse> {
  const allowInsecure = init.allowInsecure === true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("bad-url", "That is not a valid address.");
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) throw new SafeFetchError("scheme", "Only https addresses are allowed.");
  if (url.username || url.password) throw new SafeFetchError("bad-url", "Addresses with credentials are not allowed.");
  if (url.port && !allowInsecure) throw new SafeFetchError("port", "Only the standard https port is allowed."); // no port scanning through error messages
  for (const k of Object.keys(init.headers ?? {})) if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new SafeFetchError("bad-header", `The ${k} header is not allowed.`);

  // Resolve once, check every answer, pin the first. An IP literal is its own answer.
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let answers: { address: string; family: number }[];
  if (net.isIP(host)) answers = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      answers = await (deps.resolve ?? defaultResolve)(host);
    } catch {
      throw new SafeFetchError("dns", "That address could not be found.");
    }
  }
  if (answers.length === 0) throw new SafeFetchError("dns", "That address could not be found.");
  if (answers.some((a) => isForbiddenAddress(a.address, allowInsecure))) throw new SafeFetchError("blocked-address", "That address points to a network that federation never contacts.");
  const pinned = answers[0];

  const connectMs = init.connectTimeoutMs ?? 5000;
  const totalMs = init.totalTimeoutMs ?? 10_000;
  const maxBytes = init.maxBytes ?? MAX_RESPONSE_BYTES;
  const isHttps = url.protocol === "https:";
  const doRequest = (isHttps ? deps.request?.https ?? https.request : deps.request?.http ?? http.request) as RequestFn;
  const body = init.body;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "mergeport-federation/1", ...lower(init.headers) };
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

  return await new Promise<SafeFetchResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      clearTimeout(connect);
      fn();
    };
    const req = doRequest(
      {
        protocol: url.protocol,
        host: host,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers,
        agent: false, // no connection reuse: every call is validated and pinned on its own
        servername: net.isIP(host) ? undefined : host,
        // The pinned address is the only place the socket may go; whatever name the HTTP layer asks for, it gets this answer.
        lookup: ((_name: string, opts: { all?: boolean }, cb: (err: Error | null, a: unknown, f?: number) => void) => {
          if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        clearTimeout(connect);
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304) {
          res.destroy();
          return done(() => reject(new SafeFetchError("redirect", "The other instance answered with a redirect, which federation does not follow.")));
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status !== 304 && !/^application\/json(\s*;|$)/.test(type)) {
          res.destroy();
          return done(() => reject(new SafeFetchError("content-type", "The other instance did not answer with JSON.")));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return done(() => reject(new SafeFetchError("too-large", "The answer is too large.")));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            return done(() => reject(new SafeFetchError("too-large", "The answer is too large.")));
          }
          chunks.push(c);
        });
        res.on("error", () => done(() => reject(new SafeFetchError("network", "The connection broke."))));
        res.on("end", () =>
          done(() => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                return reject(new SafeFetchError("content-type", "The other instance did not answer with valid JSON."));
              }
            }
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string" && k !== "set-cookie") out[k] = v; // cookies are never read
            resolve({ status, headers: out, text, json });
          }),
        );
      },
    );
    const total = setTimeout(() => {
      req.destroy();
      done(() => reject(new SafeFetchError("timeout", "The other instance took too long to answer.")));
    }, totalMs);
    const connect = setTimeout(() => {
      req.destroy();
      done(() => reject(new SafeFetchError("timeout", "Could not connect to the other instance in time.")));
    }, connectMs);
    req.on("socket", (s) => s.once(isHttps ? "secureConnect" : "connect", () => clearTimeout(connect)));
    req.on("error", () => done(() => reject(new SafeFetchError("network", "Could not reach the other instance."))));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function lower(h: Record<string, string> | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) o[k.toLowerCase()] = v;
  return o;
}

/** The production FedFetch. */
export const realFedFetch: FedFetch = (url, init) => safeFetchJson(url, init);
