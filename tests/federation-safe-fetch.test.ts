import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES, SafeFetchError, isForbiddenAddress, parseV6, safeFetchJson, type RequestFn, type Resolver, type SafeFetchErrorCode } from "@/lib/federation/safe-fetch";

/** The SSRF-safe fetcher: address classification, DNS pinning, redirects, size, time and content rules. */

describe("address classification", () => {
  const forbidden = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.1.2.3", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.5", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    // IPv6
    "::", "::1", "fe80::1", "fe80::abcd:1", "febf::1", "fc00::1", "fd00:ec2::254", "fdff::1", "ff02::1", "ff00::", "fec0::1", "100::1", "2001::1", "2001:db8::1", "2002:7f00:1::", "2002:a00:1::",
    // IPv4 inside IPv6: mapped, compatible, NAT64
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:192.168.0.1", "64:ff9b:1::1", "64:ff9b:1:abcd::1", "::ffff:0:8.8.8.8", "::ffff:0:808:808", "0:0:0:0:ffff:0:a00:1", "0:0:0:0:0:ffff:127.0.0.1", "::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::169.254.169.254",
    // not an address at all
    "", "localhost", "999.1.1.1", "1.2.3", "gggg::1", "fe80::1%eth0", "1::2::3",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.20.0.1", "2606:4700:4700::1111", "2a00:1450:4001::1", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808"];
  it.each(forbidden)("refuses %s", (ip) => expect(isForbiddenAddress(ip)).toBe(true));
  it.each(allowed)("allows %s", (ip) => expect(isForbiddenAddress(ip)).toBe(false));
  it("the development override allows loopback only (metadata and private ranges stay refused)", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isForbiddenAddress(ip, true), ip).toBe(false);
    for (const ip of ["169.254.169.254", "10.0.0.1", "192.168.1.1", "fe80::1", "fd00:ec2::254", "::ffff:10.0.0.1", "::"]) expect(isForbiddenAddress(ip, true), ip).toBe(true);
  });
  it("parses IPv6 forms", () => {
    expect(parseV6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseV6("::ffff:1.2.3.4")!.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseV6("1:2:3:4:5:6:7:8")).toHaveLength(16);
    expect(parseV6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseV6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

// ---------- a fake transport: no sockets, full control of the answer ----------

type Spec = { status?: number; headers?: Record<string, string>; chunks?: string[]; never?: boolean; neverConnects?: boolean };
type Seen = { options: Parameters<RequestFn>[0]; body: string; lookup?: { address: string; family: number }; destroyed: boolean; res?: FakeRes };
class FakeRes extends EventEmitter {
  destroyed = false;
  constructor(public statusCode: number, public headers: Record<string, string>) {
    super();
  }
  destroy() {
    this.destroyed = true;
  }
}

function transport(spec: Spec | (() => Spec)) {
  const seen: Seen[] = [];
  const request = ((options: Parameters<RequestFn>[0], cb: (res: never) => void) => {
    const s: Seen = { options, body: "", destroyed: false };
    seen.push(s);
    const req = new EventEmitter() as EventEmitter & { write(b: string): void; end(): void; destroy(): void };
    req.write = (b) => void (s.body += b);
    req.destroy = () => void (s.destroyed = true);
    req.end = () => {
      // The HTTP layer would call lookup to learn where to connect: record the answer it gets.
      (options as { lookup: (n: string, o: object, c: (e: Error | null, a: string, f: number) => void) => void }).lookup(String(options.host), {}, (_e, address, family) => (s.lookup = { address, family }));
      const sp = typeof spec === "function" ? spec() : spec;
      if (sp.never) return;
      setImmediate(() => {
        const res = new FakeRes(sp.status ?? 200, { "content-type": "application/json", ...(sp.headers ?? {}) });
        s.res = res;
        cb(res as never);
        for (const c of sp.chunks ?? ['{"ok":true}']) res.emit("data", Buffer.from(c));
        res.emit("end");
      });
    };
    return req as never;
  }) as unknown as RequestFn;
  return { seen, deps: { request: { https: request, http: request } } };
}

const resolver = (map: Record<string, string[]>, calls: string[] = []): Resolver => async (host) => {
  calls.push(host);
  return (map[host] ?? []).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
};
const fails = async (p: Promise<unknown>, code: SafeFetchErrorCode) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(SafeFetchError);
  expect((e as SafeFetchError).code).toBe(code);
};

describe("safeFetchJson with an injected resolver and transport", () => {
  it("fetches JSON from a public address, pinned to the validated IP, with no cookies and no connection reuse", async () => {
    const t = transport({ chunks: ['{"a":', "1}"], headers: { "set-cookie": "sid=1", etag: '"x"' } });
    const r = await safeFetchJson("https://peer.test/api?x=1", { headers: { Authorization: "Bearer abc" } }, { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) });
    expect(r).toMatchObject({ status: 200, json: { a: 1 }, headers: { etag: '"x"' } });
    expect(r.headers["set-cookie"]).toBeUndefined(); // response cookies are never read
    const s = t.seen[0];
    expect(s.lookup).toEqual({ address: "93.184.216.34", family: 4 }); // the socket goes to the checked IP, whatever the name says
    expect(s.options).toMatchObject({ host: "peer.test", path: "/api?x=1", method: "GET", agent: false, servername: "peer.test" });
    expect(s.options.headers).toMatchObject({ authorization: "Bearer abc", accept: "application/json" });
    expect(Object.keys(s.options.headers as object)).not.toContain("cookie");
  });

  it("sends a JSON body with its length", async () => {
    const t = transport({});
    await safeFetchJson("https://peer.test/x", { method: "POST", body: '{"é":1}', headers: { "content-type": "application/json" } }, { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) });
    expect(t.seen[0].body).toBe('{"é":1}');
    expect((t.seen[0].options.headers as Record<string, string>)["content-length"]).toBe(String(Buffer.byteLength('{"é":1}')));
  });

  it("outside development only the standard https port is allowed (no port scanning through error messages)", async () => {
    const t = transport({});
    const d = { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) };
    for (const url of ["https://peer.test:8443/", "https://peer.test:22/", "https://peer.test:80/", "https://peer.test:6379/x"]) await fails(safeFetchJson(url, {}, d), "port");
    expect(t.seen).toHaveLength(0);
    await safeFetchJson("https://peer.test:443/", {}, d); // the default port, written out, is the default port
    expect(t.seen).toHaveLength(1);
    await safeFetchJson("http://peer.test:8080/", { allowInsecure: true }, d); // the development override keeps ports
    expect(t.seen).toHaveLength(2);
  });

  it("refuses http, credentials in the address, bad addresses and a Cookie header", async () => {
    const t = transport({});
    const d = { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) };
    await fails(safeFetchJson("http://peer.test/", {}, d), "scheme");
    await fails(safeFetchJson("ftp://peer.test/", {}, d), "scheme");
    await fails(safeFetchJson("https://u:p@peer.test/", {}, d), "bad-url");
    await fails(safeFetchJson("not a url", {}, d), "bad-url");
    await fails(safeFetchJson("https://peer.test/", { headers: { Cookie: "a=b" } }, d), "bad-header");
    await fails(safeFetchJson("https://peer.test/", { headers: { host: "evil.test" } }, d), "bad-header");
    expect(t.seen).toHaveLength(0);
  });

  it("http is allowed only with the development override", async () => {
    const t = transport({});
    await safeFetchJson("http://peer.test/", { allowInsecure: true }, { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) });
    expect(t.seen).toHaveLength(1);
  });

  it.each([
    ["a private A record", ["10.0.0.5"]],
    ["a loopback A record", ["127.0.0.1"]],
    ["the metadata address", ["169.254.169.254"]],
    ["a CGNAT address", ["100.64.1.1"]],
    ["a loopback AAAA record", ["::1"]],
    ["an IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["a unique-local IPv6", ["fd12:3456::1"]],
    ["one good and one private answer", ["93.184.216.34", "192.168.1.10"]],
    ["a private answer listed after a public IPv6", ["2606:4700:4700::1111", "10.1.1.1"]],
  ])("refuses a name that resolves to %s, without connecting", async (_n, answers) => {
    const t = transport({});
    await fails(safeFetchJson("https://peer.test/", {}, { ...t.deps, resolve: resolver({ "peer.test": answers }) }), "blocked-address");
    expect(t.seen).toHaveLength(0);
  });

  it.each(["https://10.0.0.1/", "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[fe80::1]/", "https://169.254.169.254/latest/meta-data", "https://2130706433/", "https://0x7f000001/", "https://017700000001/", "https://127.1/", "https://[::ffff:a00:1]/"])("refuses the IP literal %s without resolving it", async (url) => {
    const calls: string[] = [];
    const t = transport({});
    await fails(safeFetchJson(url, {}, { ...t.deps, resolve: resolver({}, calls) }), "blocked-address");
    expect(calls).toEqual([]);
    expect(t.seen).toHaveLength(0);
  });

  it("an unresolvable name or an empty answer is a DNS error", async () => {
    const t = transport({});
    await fails(safeFetchJson("https://nowhere.test/", {}, { ...t.deps, resolve: resolver({}) }), "dns");
    await fails(safeFetchJson("https://nowhere.test/", {}, { ...t.deps, resolve: async () => Promise.reject(new Error("ENOTFOUND")) }), "dns");
  });

  it("DNS rebinding: the name is resolved ONCE per call and the socket is pinned to that answer, even if the next answer is internal", async () => {
    const calls: string[] = [];
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const resolve: Resolver = async (host) => {
      calls.push(host);
      return (answers[Math.min(calls.length - 1, 1)] ?? []).map((a) => ({ address: a, family: 4 }));
    };
    const t = transport({});
    await safeFetchJson("https://rebind.test/", {}, { ...t.deps, resolve });
    expect(calls).toHaveLength(1);
    expect(t.seen[0].lookup!.address).toBe("93.184.216.34");
    // the second call sees the "rebound" internal answer and is refused
    await fails(safeFetchJson("https://rebind.test/", {}, { ...t.deps, resolve }), "blocked-address");
    expect(calls).toHaveLength(2);
    expect(t.seen).toHaveLength(1);
  });

  it("the pinned lookup answers both the plain and the all:true form with only the validated address", async () => {
    const t = transport({});
    await safeFetchJson("https://peer.test/", {}, { ...t.deps, resolve: resolver({ "peer.test": ["2606:4700:4700::1111"] }) });
    const lookup = (t.seen[0].options as unknown as { lookup: (n: string, o: object, cb: (e: unknown, a: unknown) => void) => void }).lookup;
    let all: unknown;
    lookup("anything-else.test", { all: true }, (_e, a) => (all = a));
    expect(all).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
  });

  it("never follows a redirect, including one to an internal host", async () => {
    const t = transport({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, chunks: [""] });
    await fails(safeFetchJson("https://peer.test/", {}, { ...t.deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) }), "redirect");
    expect(t.seen).toHaveLength(1); // no second request
    expect(t.seen[0].res!.destroyed).toBe(true);
    for (const status of [301, 303, 307, 308]) await fails(safeFetchJson("https://peer.test/", {}, { ...transport({ status }).deps, resolve: resolver({ "peer.test": ["93.184.216.34"] }) }), "redirect");
  });

  it("requires application/json, except for an empty 304", async () => {
    const d = { resolve: resolver({ "peer.test": ["93.184.216.34"] }) };
    await fails(safeFetchJson("https://peer.test/", {}, { ...transport({ headers: { "content-type": "text/html" }, chunks: ["<html>"] }).deps, ...d }), "content-type");
    await fails(safeFetchJson("https://peer.test/", {}, { ...transport({ headers: { "content-type": "application/jsonp" } }).deps, ...d }), "content-type");
    await fails(safeFetchJson("https://peer.test/", {}, { ...transport({ chunks: ["not json"] }).deps, ...d }), "content-type");
    expect((await safeFetchJson("https://peer.test/", {}, { ...transport({ headers: { "content-type": "application/json; charset=utf-8" } }).deps, ...d })).status).toBe(200);
    const nm = await safeFetchJson("https://peer.test/", {}, { ...transport({ status: 304, headers: { "content-type": "" }, chunks: [] }).deps, ...d });
    expect(nm).toMatchObject({ status: 304, json: null });
  });

  it("caps the response at 2 MB by declared length and by streamed bytes", async () => {
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    const d = { resolve: resolver({ "peer.test": ["93.184.216.34"] }) };
    const declared = transport({ headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) }, chunks: ["{}"] });
    await fails(safeFetchJson("https://peer.test/", {}, { ...declared.deps, ...d }), "too-large");
    expect(declared.seen[0].res!.destroyed).toBe(true);
    const big = "x".repeat(600 * 1024);
    const streamed = transport({ chunks: ['{"a":"', big, big, big, big, '"}'] });
    await fails(safeFetchJson("https://peer.test/", {}, { ...streamed.deps, ...d }), "too-large");
    expect(streamed.seen[0].res!.destroyed).toBe(true);
    await fails(safeFetchJson("https://peer.test/", { maxBytes: 8 }, { ...transport({ chunks: ['{"abc":1}'] }).deps, ...d }), "too-large");
  });

  it("times out a host that never answers (total) and one that never connects (connect)", async () => {
    const d = { resolve: resolver({ "peer.test": ["93.184.216.34"] }) };
    const slow = transport({ never: true });
    await fails(safeFetchJson("https://peer.test/", { totalTimeoutMs: 40, connectTimeoutMs: 5000 }, { ...slow.deps, ...d }), "timeout");
    expect(slow.seen[0].destroyed).toBe(true);
    const noconnect = transport({ never: true });
    await fails(safeFetchJson("https://peer.test/", { totalTimeoutMs: 5000, connectTimeoutMs: 30 }, { ...noconnect.deps, ...d }), "timeout");
    expect(noconnect.seen[0].destroyed).toBe(true);
  });
});

// ---------- real sockets on loopback (development override) ----------

describe("safeFetchJson over real sockets", () => {
  let server: http.Server;
  let base: string;
  let hostSeen: string | undefined;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hostSeen = req.headers.host;
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/ok") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ hello: "world", cookie: req.headers.cookie ?? null }));
      }
      if (u.pathname === "/redirect") return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      if (u.pathname === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = "x".repeat(256 * 1024);
        res.write('{"a":"');
        let i = 0;
        const t = setInterval(() => {
          if (++i > 12 || res.destroyed) {
            clearInterval(t);
            return void res.end('"}');
          }
          res.write(chunk);
        }, 1);
        return;
      }
      if (u.pathname === "/slow") return; // never answers
      if (u.pathname === "/html") return void res.writeHead(200, { "content-type": "text/html" }).end("<b>hi</b>");
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("works against a real server, sends no cookie, and refuses loopback without the override", async () => {
    const r = await safeFetchJson(`${base}/ok`, { allowInsecure: true });
    expect(r.json).toEqual({ hello: "world", cookie: null });
    await fails(safeFetchJson(`${base}/ok`), "scheme");
    await fails(safeFetchJson(`https://127.0.0.1:${new URL(base).port}/ok`), "port");
    await fails(safeFetchJson("https://127.0.0.1/ok"), "blocked-address");
  });

  it("pins the connection: the name in the URL is irrelevant, the resolved (checked) address is where the socket goes", async () => {
    const port = new URL(base).port;
    const r = await safeFetchJson(`http://pinned.test:${port}/ok`, { allowInsecure: true }, { resolve: resolver({ "pinned.test": ["127.0.0.1"] }) });
    expect(r.status).toBe(200);
    expect(hostSeen).toBe(`pinned.test:${port}`); // the Host header keeps the name, the socket went to 127.0.0.1
  });

  it("does not follow a real redirect, rejects real HTML, caps a real oversize body and times out a real slow one", async () => {
    await fails(safeFetchJson(`${base}/redirect`, { allowInsecure: true }), "redirect");
    await fails(safeFetchJson(`${base}/html`, { allowInsecure: true }), "content-type");
    await fails(safeFetchJson(`${base}/big`, { allowInsecure: true }), "too-large");
    await fails(safeFetchJson(`${base}/slow`, { allowInsecure: true, totalTimeoutMs: 150 }), "timeout");
  });

  it("a closed port is a network error", async () => {
    await fails(safeFetchJson("http://127.0.0.1:1/", { allowInsecure: true, totalTimeoutMs: 2000 }), "network");
  });
});
