import { describe, expect, it } from "vitest";
import { formatInstantDated } from "@/lib/format";

const now = new Date("2026-11-18T12:00:00Z");

describe("formatInstantDated", () => {
  it("omits the year for this year and shows it for any other", () => {
    expect(formatInstantDated(new Date("2026-03-04T09:05:00Z"), "UTC", now)).toBe("Mar 4, 09:05");
    expect(formatInstantDated(new Date("2025-03-04T09:05:00Z"), "UTC", now)).toBe("Mar 4, 2025, 09:05");
  });

  it("reads the time in the person's zone, and the year in that zone too", () => {
    expect(formatInstantDated(new Date("2026-03-04T23:30:00Z"), "Pacific/Auckland", now)).toBe("Mar 5, 12:30");
    expect(formatInstantDated(new Date("2025-12-31T23:30:00Z"), "Pacific/Auckland", now)).toBe("Jan 1, 12:30"); // 2026 in Auckland: this year
  });

  it("falls back to ISO for an unknown zone", () => {
    expect(formatInstantDated(new Date("2026-03-04T09:05:00Z"), "Not/AZone", now)).toBe("2026-03-04T09:05:00.000Z");
  });
});
