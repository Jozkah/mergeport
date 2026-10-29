import { describe, expect, it } from "vitest";
import { cacheControlFor } from "@/proxy";

describe("cache headers", () => {
  it("never stores API responses", () => expect(cacheControlFor("/api/sync/events")).toBe("no-store"));
  it("lets the browser keep pages but always revalidate them", () => expect(cacheControlFor("/attention")).toBe("private, no-cache"));
  it("caches the public icon", () => expect(cacheControlFor("/icon.svg")).toMatch(/^public, max-age=\d+/));
});
