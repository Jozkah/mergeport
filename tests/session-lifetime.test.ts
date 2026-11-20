import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "@/lib/auth/session";

describe("browser sign-in lifetime", () => {
  it("lasts months, not two weeks, so a local app does not ask to sign in again every fortnight", () => {
    const days = SESSION_TTL_MS / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThan(400); // browsers cap cookie lifetime near 400 days
  });
});
