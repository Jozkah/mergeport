import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "@/lib/database-url";

describe("resolveDatabaseUrl", () => {
  it("builds the bundled compose database URL from POSTGRES_PASSWORD", () => {
    expect(resolveDatabaseUrl({ POSTGRES_PASSWORD: "abc123" })).toBe("postgresql://mergeport:abc123@postgres:5432/mergeport");
  });

  it("percent-encodes a password with special characters", () => {
    expect(resolveDatabaseUrl({ POSTGRES_PASSWORD: "p@ss:w/rd#" })).toBe("postgresql://mergeport:p%40ss%3Aw%2Frd%23@postgres:5432/mergeport");
  });

  it("an explicit DATABASE_URL wins", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgresql://a:b@db:5432/x", POSTGRES_PASSWORD: "abc" })).toBe("postgresql://a:b@db:5432/x");
  });

  it("an empty DATABASE_URL falls back to the password", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "  ", POSTGRES_PASSWORD: "abc" })).toBe("postgresql://mergeport:abc@postgres:5432/mergeport");
  });

  it("neither set gives no URL", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
  });
});
