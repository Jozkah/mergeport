import { describe, expect, it } from "vitest";
import { describeAccess, describeOwner } from "@/lib/domain/repo-access";

describe("repository access wording (from GitHub's own fields)", () => {
  it("reports the strongest permission GitHub gave", () => {
    expect(describeAccess({ admin: true, maintain: true, push: true, triage: true, pull: true }).level).toBe("admin");
    expect(describeAccess({ admin: false, maintain: true, push: true, triage: true, pull: true }).level).toBe("maintain");
    expect(describeAccess({ admin: false, maintain: false, push: true, triage: true, pull: true }).level).toBe("write");
    expect(describeAccess({ admin: false, maintain: false, push: false, triage: true, pull: true }).level).toBe("triage");
    expect(describeAccess({ pull: true }).level).toBe("read");
  });

  it("never turns missing permissions into read access", () => {
    for (const p of [null, undefined, {}, { pull: false }]) expect(describeAccess(p).level).toBe("unknown");
  });

  it("takes the account type from GitHub, not from the name", () => {
    expect(describeOwner("ORGANIZATION", "octocat", "octocat").label).toBe("Organization");
    expect(describeOwner("USER", "octocat", "octocat").label).toBe("Personal");
    expect(describeOwner("USER", "somebody", "octocat").label).toBe("Other user");
    expect(describeOwner(undefined, "x", "octocat").label).toBe("Owner type unknown");
  });
});
