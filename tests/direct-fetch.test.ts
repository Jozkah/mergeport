import { describe, expect, it } from "vitest";
import { GhMissingError, IdentityError } from "@/lib/github/exec";
import { apiBase, directFetch } from "@/lib/github/gh";

type Seen = { url: string; init: RequestInit };
const recorder = (res: () => Response | Promise<Response> = () => new Response("{}", { status: 200 })) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return res();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};
const hdr = (s: Seen, k: string) => new Headers(s.init.headers).get(k);

describe("direct GitHub requests", () => {
  it("sends only the path, always to the profile's own host, with the verified token", async () => {
    const { seen, fetchImpl } = recorder();
    const f = directFetch(async () => "tok-123", "github.com", { fetchImpl });
    // the caller names another origin and brings its own credential: neither is used
    await f("https://evil.example/repos/a/b/pulls?state=open", { headers: { authorization: "Bearer attacker", "user-agent": "x", accept: "application/vnd.github.v3+json", "if-none-match": 'W/"1"' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.github.com/repos/a/b/pulls?state=open");
    expect(hdr(seen[0], "authorization")).toBe("Bearer tok-123");
    expect(hdr(seen[0], "user-agent")).toBe("Mergeport");
    expect(hdr(seen[0], "accept")).toBe("application/vnd.github.v3+json");
    expect(hdr(seen[0], "if-none-match")).toBe('W/"1"'); // conditional requests keep working
  });

  it("sends JSON bodies and the right method; enterprise hosts use /api/v3", async () => {
    const { seen, fetchImpl } = recorder();
    const f = directFetch(async () => "t", "ghe.example.com", { fetchImpl });
    await f("https://api.github.com/repos/o/r/issues/3/comments", { method: "POST", body: JSON.stringify({ body: "hi" }) });
    expect(seen[0].url).toBe("https://ghe.example.com/api/v3/repos/o/r/issues/3/comments");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBe('{"body":"hi"}');
    expect(hdr(seen[0], "content-type")).toBe("application/json");
    expect(apiBase("github.com")).toBe("https://api.github.com");
  });

  it("passes statuses, 304 and rate-limit headers through, and forgets a rejected token", async () => {
    let forgot = 0;
    const r304 = recorder(() => new Response(null, { status: 304, headers: { etag: 'W/"2"', "x-ratelimit-remaining": "4999" } }));
    const a = await directFetch(async () => "t", "github.com", { fetchImpl: r304.fetchImpl, onUnauthorized: () => forgot++ })("https://api.github.com/user");
    expect(a.status).toBe(304);
    expect(a.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(forgot).toBe(0);
    const r401 = recorder(() => new Response("{}", { status: 401 }));
    const b = await directFetch(async () => "t", "github.com", { fetchImpl: r401.fetchImpl, onUnauthorized: () => forgot++ })("https://api.github.com/user");
    expect(b.status).toBe(401);
    expect(forgot).toBe(1);
  });

  it("fails the way the CLI path does: identity problems are a flagged 401, everything else looks offline", async () => {
    const { seen, fetchImpl } = recorder();
    const blocked = await directFetch(async () => { throw new IdentityError("mismatch", "wrong account"); }, "github.com", { fetchImpl })("https://api.github.com/user");
    expect(blocked.status).toBe(401);
    expect(blocked.headers.get("x-mergeport-identity")).toBe("mismatch");
    expect(seen).toHaveLength(0); // nothing was sent
    await expect(directFetch(async () => null, "github.com", { fetchImpl })("https://api.github.com/user")).rejects.toThrow("fetch failed");
    await expect(directFetch(async () => { throw new GhMissingError(); }, "github.com", { fetchImpl })("https://api.github.com/user")).rejects.toBeInstanceOf(GhMissingError);
    const down = recorder(() => { throw new Error("ECONNRESET"); });
    await expect(directFetch(async () => "t", "github.com", { fetchImpl: down.fetchImpl })("https://api.github.com/user")).rejects.toThrow("fetch failed");
    await expect(directFetch(async () => "t", "github.com", { fetchImpl })("https://api.github.com/-x")).rejects.toThrow(/command-line option/);
  });

  it("honours cancellation", async () => {
    const hang = (async (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => { if (init.signal?.aborted) return rej(new Error("aborted")); init.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = directFetch(async () => "t", "github.com", { fetchImpl: hang })("https://api.github.com/user", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("fetch failed");
  });
});
