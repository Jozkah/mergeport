import { describe, expect, it, vi } from "vitest";
import { redirect, notFound } from "next/navigation";
import { run } from "@/lib/action-result";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

vi.mock("@/lib/local/runtime", () => ({ syncSoon: () => {} }));

// The real next/navigation: redirect()/notFound() throw Next's own control-flow errors, which is what the wrapper must not swallow.
describe("run: framework control flow", () => {
  it("lets a redirect pass through untouched", async () => {
    const err = await run(async () => redirect("/sign-in")).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(String((err as { digest?: string }).digest)).toContain("NEXT_REDIRECT");
  });

  it("lets notFound pass through untouched", async () => {
    const err = await run(async () => notFound()).then(() => null, (e) => e);
    expect(String((err as { digest?: string }).digest)).toContain("NEXT_HTTP_ERROR_FALLBACK");
  });
});

describe("run: domain errors keep their result messages", () => {
  it("maps ValidationError", async () => {
    expect(await run(async () => { throw new ValidationError("bad input"); })).toEqual({ ok: false, error: "bad input", retryable: false });
  });
  it("maps ForbiddenError (not the framework forbidden())", async () => {
    expect(await run(async () => { throw new ForbiddenError("no way"); })).toEqual({ ok: false, error: "no way", retryable: false });
  });
  it("maps NotFoundError (not the framework notFound())", async () => {
    expect(await run(async () => { throw new NotFoundError(); })).toEqual({ ok: false, error: "That item was not found, or you do not have access to it." });
  });
  it("maps ConflictError as retryable", async () => {
    expect(await run(async () => { throw new ConflictError("clash"); })).toEqual({ ok: false, error: "clash", retryable: true });
  });
  it("maps an unknown error generically", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(async () => { throw new Error("boom"); })).toEqual({ ok: false, error: "Something went wrong. Nothing was changed. Try again." });
    spy.mockRestore();
  });
});
