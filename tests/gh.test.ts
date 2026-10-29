import { describe, expect, it } from "vitest";
import { GhMissingError, ghFetch, ghStatus, loginCommand, parseHttpResponse, type GhResult, type GhRunner } from "@/lib/github/gh";

const recorder = (reply: GhResult | Error) => {
  const calls: { args: string[]; input?: string }[] = [];
  const run: GhRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
};
const http = (status: number, headers: Record<string, string>, body: string) => `HTTP/2.0 ${status} X\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`;

describe("gh transport", () => {
  it("calls gh with an argument array and never forwards a credential header", async () => {
    const { run, calls } = recorder({ code: 0, stderr: "", stdout: http(200, { etag: '"abc"', "x-ratelimit-remaining": "4999" }, '{"ok":true}') });
    const f = ghFetch(run, "github.com");
    const res = await f("https://api.github.com/repos/acme/tool/issues?per_page=5", { headers: { authorization: "Bearer ghp_SECRET", accept: "application/vnd.github+json", "if-none-match": '"old"' } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(await res.json()).toEqual({ ok: true });
    const { args } = calls[0];
    expect(args.slice(0, 6)).toEqual(["api", "--hostname", "github.com", "-i", "-X", "GET"]);
    expect(args.at(-1)).toBe("repos/acme/tool/issues?per_page=5");
    expect(args.join(" ")).not.toMatch(/ghp_SECRET|authorization/i);
    expect(args).toContain('if-none-match: "old"');
  });

  it("sends request bodies on stdin, not on the command line", async () => {
    const { run, calls } = recorder({ code: 0, stderr: "", stdout: http(201, {}, "{}") });
    await ghFetch(run, "github.com")("https://api.github.com/repos/a/b/issues", { method: "POST", body: JSON.stringify({ title: "$(rm -rf /); `x`" }) });
    expect(calls[0].input).toContain("rm -rf");
    expect(calls[0].args.join(" ")).not.toContain("rm -rf");
    expect(calls[0].args).toContain("--input");
  });

  it("maps 304 to a bodiless response and 'no HTTP response' to a fetch TypeError", async () => {
    const notModified = recorder({ code: 0, stderr: "", stdout: http(304, { etag: '"abc"' }, "") });
    expect((await ghFetch(notModified.run, "github.com")("https://api.github.com/x")).status).toBe(304);
    const offline = recorder({ code: 1, stderr: "error connecting to api.github.com", stdout: "" });
    await expect(ghFetch(offline.run, "github.com")("https://api.github.com/x")).rejects.toBeInstanceOf(TypeError);
  });

  it("surfaces a missing gh as its own error and refuses option-looking paths", async () => {
    await expect(ghFetch(recorder(new GhMissingError()).run, "github.com")("https://api.github.com/x")).rejects.toBeInstanceOf(GhMissingError);
    await expect(ghFetch(recorder({ code: 0, stderr: "", stdout: "" }).run, "github.com")("https://api.github.com/--hostname=evil.example")).rejects.toBeInstanceOf(TypeError);
  });

  it("parses status, headers and body", () => {
    const r = parseHttpResponse(http(403, { "retry-after": "60", "x-ratelimit-remaining": "0" }, '{"message":"rate limit"}'))!;
    expect(r.status).toBe(403);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.body).toBe('{"message":"rate limit"}');
    expect(parseHttpResponse("not http")).toBeNull();
  });
});

describe("gh identity", () => {
  const status = (r: GhResult | Error) => ghStatus(recorder(r).run, "github.com");
  it("identifies the signed-in account by numeric id", async () => {
    const s = await status({ code: 0, stderr: "", stdout: JSON.stringify({ id: 12345, login: "Alice", name: "A", avatar_url: null }) });
    expect(s).toMatchObject({ state: "ok", identity: { id: 12345n, login: "Alice", host: "github.com" } });
  });
  it("distinguishes missing gh, signed out and other failures", async () => {
    expect(await status(new GhMissingError())).toEqual({ state: "missing-gh" });
    expect(await status({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login", stdout: "" })).toEqual({ state: "not-logged-in" });
    expect(await status({ code: 1, stderr: "dial tcp: lookup api.github.com", stdout: "" })).toMatchObject({ state: "error" });
    expect(await status({ code: 0, stderr: "", stdout: "<html>" })).toMatchObject({ state: "error" });
  });
  it("tells the person exactly which scopes it asks for", () => {
    expect(loginCommand("github.com")).toBe("gh auth login --hostname github.com --web --git-protocol https --scopes repo,read:org");
  });
});
