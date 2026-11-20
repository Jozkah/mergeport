import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { ORIGIN, RecordingMailer } from "./auth-mocks";
import { person, workspaceWithOwner } from "./roles-helpers";
import type { Db } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { createWorkspaceFor } from "@/lib/auth/workspaces";
import { loadViewer } from "@/lib/authz/viewer";
import { INVITE_LIMITS, createInvitation } from "@/lib/services/invitations";

let db: Db;
let n = 0;
let mailer: RecordingMailer;
beforeEach(() => {
  db = createTestPrisma(`invitation-budgets-${n++}`);
  mailer = new RecordingMailer();
});

const send = (viewer: Parameters<typeof createInvitation>[1], email: string, now: Date) => createInvitation(db, viewer, { email, role: "MEMBER", mailer, origin: ORIGIN, now });

describe("budgets cannot be reset by making more workspaces", () => {
  it("one person's hourly budget follows them across their workspaces", async () => {
    const a = await workspaceWithOwner(db, "multi@example.com", "A");
    const b = await createWorkspaceFor(db, a.owner.id, "B");
    const vb = (await loadViewer(db, a.owner.id, b.id))!;
    const t = new Date();
    for (let i = 0; i < INVITE_LIMITS.perUserPerHour; i++) await send(i % 2 ? a.viewer : vb, `u${i}@example.com`, t);
    await expect(send(vb, "over@example.com", t)).rejects.toThrow(/lot of invitations/);
    await expect(send(a.viewer, "over2@example.com", t)).rejects.toThrow(/lot of invitations/);
  });

  it("one address receives at most 3 invitations a day from all workspaces together", async () => {
    const t = new Date();
    for (let i = 0; i < INVITE_LIMITS.perRecipientPerDay; i++) {
      const w = await workspaceWithOwner(db, `boss${i}@example.com`, `W${i}`);
      await send(w.viewer, "victim@example.com", t);
    }
    const w = await workspaceWithOwner(db, "boss-x@example.com", "WX");
    await expect(send(w.viewer, "victim@example.com", t)).rejects.toThrow(/several invitations today/);
    expect(mailer.sent).toHaveLength(INVITE_LIMITS.perRecipientPerDay);
    await send(w.viewer, "victim@example.com", new Date(t.getTime() + 25 * 3600_000)); // the next day
  });

  it("a person can create only a few workspaces a day (MERGEPORT_MAX_WORKSPACES_PER_DAY, default 5)", async () => {
    const u = await person(db, "maker@example.com");
    for (let i = 0; i < 5; i++) await createWorkspaceFor(db, u.id, `W${i}`);
    await expect(createWorkspaceFor(db, u.id, "W6")).rejects.toThrow(ConflictError);
    expect(await db.workspace.count()).toBe(5);
    const other = await person(db, "other-maker@example.com");
    await createWorkspaceFor(db, other.id, "Fine"); // the budget is per person
    vi.stubEnv("MERGEPORT_MAX_WORKSPACES_PER_DAY", "2");
    const third = await person(db, "third@example.com");
    await createWorkspaceFor(db, third.id, "One");
    await createWorkspaceFor(db, third.id, "Two");
    await expect(createWorkspaceFor(db, third.id, "Three")).rejects.toThrow(ConflictError);
    vi.unstubAllEnvs();
  });
});
