import { z } from "zod";
import { bootstrapOrAdmit, createSession, getMember, requireSession, revokeSession, toMember, type Member } from "./auth";
import { fetchGithubUser, pollDeviceFlow, startDeviceFlow } from "./github-oauth";
import { HttpError, json, readJson, route, type Route } from "./http";
import type { HubContext } from "./server";

export const memberJson = (m: Member) => ({ githubId: m.githubId.toString(), login: m.login, name: m.name, avatarUrl: m.avatarUrl, role: m.role, status: m.status });

function teamJson(ctx: HubContext): { id: string; name: string } {
  const t = ctx.db.prepare("SELECT id, name FROM team LIMIT 1").get() as { id: string; name: string } | undefined;
  if (!t) throw new HttpError(500, "no team");
  return t;
}

export function authRoutes(): Route<HubContext>[] {
  return [
    route<HubContext>("POST", "/auth/device/start", async (ctx, _req, res) => {
      json(res, 200, await startDeviceFlow(ctx.config));
    }),
    route<HubContext>("POST", "/auth/device/poll", async (ctx, req, res) => {
      const { deviceCode } = await readJson(req, z.object({ deviceCode: z.string().min(1).max(256), clientName: z.string().max(100).optional() }));
      const polled = await pollDeviceFlow(ctx.config, deviceCode);
      if (polled.kind === "pending" || polled.kind === "slow_down") return json(res, 202, { pending: true });
      if (polled.kind === "expired") return json(res, 410, { error: "expired" });
      if (polled.kind === "denied") return json(res, 403, { reason: "denied" });
      // The GitHub access token is used for this one lookup, then dropped.
      const user = await fetchGithubUser(ctx.config, polled.accessToken);
      const admission = bootstrapOrAdmit(ctx.db, user, ctx.now());
      if (!admission.ok) {
        ctx.log.info("sign-in refused", { githubId: user.id, login: user.login, reason: admission.reason });
        return json(res, 403, { reason: admission.reason });
      }
      const clientName = (req.headers["x-mergeport-client"] as string | undefined)?.slice(0, 100) ?? null;
      const session = createSession(ctx.db, admission.member.githubId, clientName, ctx.now());
      ctx.log.info("sign-in", { githubId: user.id, login: user.login, role: admission.member.role });
      json(res, 200, { session, member: memberJson(admission.member), team: teamJson(ctx) });
    }),
    route<HubContext>("POST", "/auth/logout", (ctx, req, res) => {
      const s = requireSession(ctx, req);
      revokeSession(ctx.db, s.idHash);
      res.writeHead(204);
      res.end();
    }),
    route<HubContext>("GET", "/me", (ctx, req, res) => {
      const s = requireSession(ctx, req);
      const rows = ctx.db.prepare("SELECT * FROM member WHERE status = 'ACTIVE' ORDER BY joined_at, github_id").safeIntegers(true).all() as Parameters<typeof toMember>[0][];
      const self = getMember(ctx.db, s.githubId) ?? s.member;
      // spaces arrive with Task 3.
      json(res, 200, { member: memberJson(self), team: teamJson(ctx), members: rows.map((r) => memberJson(toMember(r))), spaces: [] });
    }),
  ];
}
