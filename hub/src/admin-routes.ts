import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSession, revokeSessions, toMember, type Member } from "./auth";
import { memberJson } from "./auth-routes";
import { requireRole, ROLES } from "./authz";
import { HttpError, json, readJson, route, type Route } from "./http";
import type { HubContext } from "./server";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GITHUB_ID = 9223372036854775807n;

/** What changed, for the one seam Task 5 hooks to push WebSocket notifications. */
export type AccessChange = { kind: "member-removed"; githubId: bigint } | { kind: "member-role"; githubId: bigint } | { kind: "spaces"; spaceId: string };

/** Single place called after every committed removal, role change or space change. Task 5 notifies live sockets here. */
function accessChanged(ctx: HubContext, change: AccessChange): void {
  ctx.log.info("access changed", { ...change });
}

/** Parses a GitHub id from a path segment or body string as BigInt; 400 on anything but a positive 63-bit integer. */
export function parseGithubId(raw: string): bigint {
  if (!/^[0-9]{1,19}$/.test(raw)) throw new HttpError(400, "invalid github id");
  const id = BigInt(raw);
  if (id > MAX_GITHUB_ID) throw new HttpError(400, "invalid github id");
  return id;
}

const githubIdSchema = z.string().refine((s) => /^[0-9]{1,19}$/.test(s) && BigInt(s) <= MAX_GITHUB_ID, "invalid github id");
const spaceMembers = z.array(z.object({ githubId: githubIdSchema, canWrite: z.boolean() })).max(1000);
const spaceName = z.string().trim().min(1).max(100);

type SpaceRow = { id: string; kind: string; name: string };

function spaceJson(ctx: HubContext, s: SpaceRow) {
  const rows = ctx.db.prepare("SELECT github_id, can_write FROM space_member WHERE space_id = ? ORDER BY github_id").safeIntegers(true).all(s.id) as {
    github_id: bigint;
    can_write: bigint;
  }[];
  return { id: s.id, kind: s.kind, name: s.name, members: rows.map((r) => ({ githubId: r.github_id.toString(), canWrite: r.can_write === 1n })) };
}

function getSpace(ctx: HubContext, id: string): SpaceRow {
  const s = ctx.db.prepare("SELECT id, kind, name FROM space WHERE id = ?").get(id) as SpaceRow | undefined;
  if (!s) throw new HttpError(404, "space not found");
  return s;
}

function requireActive(ctx: HubContext, ids: bigint[]): void {
  const q = ctx.db.prepare("SELECT 1 FROM member WHERE github_id = ? AND status = 'ACTIVE'");
  for (const id of ids) if (!q.get(id)) throw new HttpError(400, "unknown member");
}

function replaceSpaceMembers(ctx: HubContext, spaceId: string, members: { githubId: string; canWrite: boolean }[]): void {
  const parsed = members.map((m) => ({ id: parseGithubId(m.githubId), canWrite: m.canWrite }));
  requireActive(ctx, parsed.map((m) => m.id));
  ctx.db.prepare("DELETE FROM space_member WHERE space_id = ?").run(spaceId);
  const ins = ctx.db.prepare("INSERT OR REPLACE INTO space_member (space_id, github_id, can_write) VALUES (?, ?, ?)");
  for (const m of parsed) ins.run(spaceId, m.id, m.canWrite ? 1 : 0);
}

function targetMember(ctx: HubContext, raw: string): Member {
  const row = ctx.db.prepare("SELECT * FROM member WHERE github_id = ?").safeIntegers(true).get(parseGithubId(raw)) as Parameters<typeof toMember>[0] | undefined;
  if (!row) throw new HttpError(404, "member not found");
  return toMember(row);
}

const noContent = (res: import("node:http").ServerResponse) => {
  res.writeHead(204);
  res.end();
};

export function adminRoutes(): Route<HubContext>[] {
  const admin = (ctx: HubContext, req: import("node:http").IncomingMessage) => {
    const s = requireSession(ctx, req);
    requireRole(s.member, "ADMIN");
    return s.member;
  };

  return [
    route<HubContext>("GET", "/admin/members", (ctx, req, res) => {
      admin(ctx, req);
      const rows = ctx.db.prepare("SELECT * FROM member ORDER BY joined_at, github_id").safeIntegers(true).all() as Parameters<typeof toMember>[0][];
      json(res, 200, { members: rows.map((r) => memberJson(toMember(r))) });
    }),

    route<HubContext>("POST", "/admin/invites", async (ctx, req, res) => {
      const actor = admin(ctx, req);
      const body = await readJson(
        req,
        z.object({ githubLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/), role: z.enum(["READER", "MEMBER", "ADMIN"]) }),
      );
      if (body.role === "ADMIN") requireRole(actor, "OWNER");
      const active = ctx.db.prepare("SELECT 1 FROM member WHERE lower(login) = lower(?) AND status = 'ACTIVE'").get(body.githubLogin);
      if (active) throw new HttpError(409, "already a member");
      const now = ctx.now();
      const invite = {
        id: randomUUID(),
        githubLogin: body.githubLogin,
        role: body.role,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
      };
      ctx.db
        .prepare("INSERT INTO invite (id, github_login, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(invite.id, invite.githubLogin, invite.role, actor.githubId, invite.createdAt, invite.expiresAt);
      json(res, 201, { invite });
    }),

    route<HubContext>("DELETE", "/admin/members/:githubId", (ctx, req, res, params) => {
      const actor = admin(ctx, req);
      const target = targetMember(ctx, params.githubId);
      if (target.role === "OWNER") throw new HttpError(409, "owner cannot be removed");
      if (target.role === "ADMIN") requireRole(actor, "OWNER");
      ctx.db.transaction(() => {
        ctx.db.prepare("UPDATE member SET status = 'REMOVED' WHERE github_id = ?").run(target.githubId);
        ctx.db.prepare("DELETE FROM space_member WHERE github_id = ?").run(target.githubId);
        revokeSessions(ctx.db, target.githubId);
      })();
      accessChanged(ctx, { kind: "member-removed", githubId: target.githubId });
      noContent(res);
    }),

    route<HubContext>("PATCH", "/admin/members/:githubId", async (ctx, req, res, params) => {
      const actor = admin(ctx, req);
      const { role } = await readJson(req, z.object({ role: z.enum(ROLES) }));
      const target = targetMember(ctx, params.githubId);
      if (target.status !== "ACTIVE") throw new HttpError(409, "member is removed");
      if (target.role === "OWNER") {
        // Ownership only moves by transferring it to someone else.
        throw new HttpError(409, "owner role can only be transferred");
      }
      if (role === "OWNER") {
        requireRole(actor, "OWNER");
        ctx.db.transaction(() => {
          ctx.db.prepare("UPDATE member SET role = 'ADMIN' WHERE github_id = ?").run(actor.githubId);
          ctx.db.prepare("UPDATE member SET role = 'OWNER' WHERE github_id = ?").run(target.githubId);
          ctx.db.prepare("UPDATE team SET owner_github_id = ?").run(target.githubId);
        })();
        accessChanged(ctx, { kind: "member-role", githubId: actor.githubId });
      } else {
        if (role === "ADMIN" || target.role === "ADMIN") requireRole(actor, "OWNER");
        ctx.db.prepare("UPDATE member SET role = ? WHERE github_id = ?").run(role, target.githubId);
      }
      accessChanged(ctx, { kind: "member-role", githubId: target.githubId });
      const row = ctx.db.prepare("SELECT * FROM member WHERE github_id = ?").safeIntegers(true).get(target.githubId) as Parameters<typeof toMember>[0];
      json(res, 200, { member: memberJson(toMember(row)) });
    }),

    route<HubContext>("GET", "/admin/spaces", (ctx, req, res) => {
      admin(ctx, req);
      const rows = ctx.db.prepare("SELECT id, kind, name FROM space ORDER BY (kind = 'COMMON') DESC, name, id").all() as SpaceRow[];
      json(res, 200, { spaces: rows.map((s) => spaceJson(ctx, s)) });
    }),

    route<HubContext>("POST", "/admin/spaces", async (ctx, req, res) => {
      const actor = admin(ctx, req);
      const body = await readJson(req, z.object({ name: spaceName, members: spaceMembers.default([]) }));
      const id = randomUUID();
      ctx.db.transaction(() => {
        ctx.db.prepare("INSERT INTO space (id, kind, name, created_at, created_by) VALUES (?, 'RESTRICTED', ?, ?, ?)").run(id, body.name, new Date(ctx.now()).toISOString(), actor.githubId);
        replaceSpaceMembers(ctx, id, body.members);
      })();
      accessChanged(ctx, { kind: "spaces", spaceId: id });
      json(res, 201, { space: spaceJson(ctx, getSpace(ctx, id)) });
    }),

    route<HubContext>("PATCH", "/admin/spaces/:id", async (ctx, req, res, params) => {
      admin(ctx, req);
      const body = await readJson(req, z.object({ name: spaceName.optional(), members: spaceMembers.optional() }));
      const space = getSpace(ctx, params.id);
      if (space.kind === "COMMON" && body.members !== undefined) throw new HttpError(400, "common space membership is implicit");
      ctx.db.transaction(() => {
        if (body.name !== undefined) ctx.db.prepare("UPDATE space SET name = ? WHERE id = ?").run(body.name, space.id);
        if (body.members !== undefined) replaceSpaceMembers(ctx, space.id, body.members);
      })();
      accessChanged(ctx, { kind: "spaces", spaceId: space.id });
      json(res, 200, { space: spaceJson(ctx, getSpace(ctx, space.id)) });
    }),

    route<HubContext>("DELETE", "/admin/spaces/:id", (ctx, req, res, params) => {
      admin(ctx, req);
      const space = getSpace(ctx, params.id);
      if (space.kind === "COMMON") throw new HttpError(409, "common space cannot be deleted");
      ctx.db.transaction(() => {
        for (const t of ["entity_event", "entity", "space_member"]) ctx.db.prepare(`DELETE FROM ${t} WHERE space_id = ?`).run(space.id);
        ctx.db.prepare("DELETE FROM space WHERE id = ?").run(space.id);
      })();
      accessChanged(ctx, { kind: "spaces", spaceId: space.id });
      noContent(res);
    }),
  ];
}
