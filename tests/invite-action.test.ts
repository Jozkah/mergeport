import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mail: "sent" as "sent" | "pending" | "failed", revalidated: [] as string[] }));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void h.revalidated.push(p) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.com" }) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/mailer", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/mailer")>()), getMailer: () => ({ send: async () => {} }) }));
vi.mock("@/lib/auth/current", () => ({ requireViewer: async () => ({}), requireWriter: async () => ({ viewer: { workspaceId: "w", memberId: "m", userId: "u", role: "OWNER", isAdmin: true, login: "o" }, user: {}, csrf: "x" }) }));
vi.mock("@/lib/services/invitations", () => ({
  createInvitation: async (_db: unknown, _v: unknown, i: { email: string }) => ({ id: "i1", email: i.email, mail: h.mail }),
  resendInvitation: async () => ({ email: "a@example.com", mail: h.mail }),
  revokeInvitation: async () => {},
}));

import { inviteMemberAction, resendInvitationAction } from "@/app/workspace-actions";

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
beforeEach(() => {
  h.mail = "sent";
  h.revalidated = [];
});

describe("the invite form's feedback", () => {
  it("success names the address and refreshes the pending list", async () => {
    const r = await inviteMemberAction(form({ email: "a@example.com", role: "MEMBER" }));
    expect(r).toMatchObject({ ok: true, message: "Invitation sent to a@example.com. It works for 7 days." });
    expect(h.revalidated).toContain("/settings/members");
  });

  it("a slow mail server still confirms the invitation exists", async () => {
    h.mail = "pending";
    const r = await inviteMemberAction(form({ email: "a@example.com", role: "MEMBER" }));
    expect(r).toMatchObject({ ok: true });
    expect((r as { message: string }).message).toMatch(/saved for a@example.com.*use Resend/);
  });

  it("a failed send says so, points at Resend, and still refreshes the list so the pending row shows", async () => {
    h.mail = "failed";
    const r = await inviteMemberAction(form({ email: "a@example.com", role: "MEMBER" }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/could not be sent.*Resend/);
    expect(h.revalidated).toContain("/settings/members");
    h.mail = "failed";
    expect(await resendInvitationAction(form({ invitationId: "i1" }))).toMatchObject({ ok: false });
    h.mail = "sent";
    expect(await resendInvitationAction(form({ invitationId: "i1" }))).toMatchObject({ ok: true, message: expect.stringContaining("sent again to a@example.com") });
  });
});
