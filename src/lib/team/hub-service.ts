import { ValidationError } from "@/lib/errors";
import type { HubAdminApi, HubMember, HubSessionPort, HubSpaceInfo } from "@/lib/hub/ports";
import { hubSessionPort } from "@/lib/hub/ports-stub";

/**
 * Team administration in hub mode. The hub enforces every rule; the local checks here only give friendlier
 * messages before a request is sent. GitHub mode stays in `TeamService`.
 */
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

export type HubOverview = { teamName: string; me: HubMember; members: HubMember[]; spaces: HubSpaceInfo[]; canAdmin: boolean };

export class HubTeamService {
  constructor(
    private readonly api: HubAdminApi,
    private readonly actorGithubId: string,
  ) {}

  private last: HubOverview | null = null;

  async overview(): Promise<HubOverview> {
    const r = await this.api.me();
    return (this.last = { teamName: r.team.name, me: r.member, members: r.members, spaces: r.spaces, canAdmin: r.member.role === "OWNER" || r.member.role === "ADMIN" });
  }

  private async requireAdmin(what: string): Promise<HubOverview> {
    // reuse the last overview so a refused action sends nothing; the hub still decides
    const o = this.last ?? (await this.overview());
    if (!o.canAdmin) throw new ValidationError(`Only admins can ${what}.`);
    return o;
  }

  async invite(login: string, role: "ADMIN" | "MEMBER" | "READER" = "MEMBER"): Promise<void> {
    await this.requireAdmin("invite people");
    const l = login.trim().replace(/^@/, "").toLowerCase();
    if (!l || !LOGIN.test(l)) throw new ValidationError("Enter a valid GitHub username.");
    await this.api.invite(l, role);
  }

  async changeRole(githubId: string, role: "ADMIN" | "MEMBER" | "READER"): Promise<void> {
    const o = await this.requireAdmin("change roles");
    if (githubId === this.actorGithubId) throw new ValidationError("You cannot change your own role.");
    if (o.members.find((m) => m.githubId === githubId)?.role === "OWNER") throw new ValidationError("The owner's role cannot be changed.");
    await this.api.setRole(githubId, role);
  }

  async removeMember(githubId: string): Promise<void> {
    const o = await this.requireAdmin("remove people");
    if (o.members.find((m) => m.githubId === githubId)?.role === "OWNER") throw new ValidationError("The owner cannot be removed.");
    await this.api.removeMember(githubId);
  }

  async createSpace(name: string, members: { githubId: string; canWrite: boolean }[]): Promise<HubSpaceInfo> {
    await this.requireAdmin("create spaces");
    const n = name.trim();
    if (!n) throw new ValidationError("Give the space a name.");
    return this.api.createSpace(n, members);
  }

  async updateSpace(id: string, p: { name?: string; members?: { githubId: string; canWrite: boolean }[] }): Promise<void> {
    await this.requireAdmin("change spaces");
    await this.api.updateSpace(id, p);
  }

  async deleteSpace(id: string, opts: { confirmed: boolean }): Promise<void> {
    await this.requireAdmin("delete spaces");
    if (opts.confirmed !== true) throw new ValidationError("Deleting this space removes its projects, cards and tasks from every member's computer.");
    await this.api.deleteSpace(id);
  }

  /** Ends the session on the hub (a down hub does not block it), then forgets it locally. */
  async signOut(dbFile: string, session: Pick<HubSessionPort, "remove"> = hubSessionPort): Promise<{ switchTo: "github" }> {
    try {
      await this.api.logout();
    } catch {
      // the hub being unreachable must not keep the user signed in here
    }
    await session.remove(dbFile);
    return { switchTo: "github" };
  }
}
