import fs from "node:fs";
import path from "node:path";
import type { Space } from "@/generated/prisma/client";
import { createPrisma, type Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { GitHubRest } from "@/lib/github/rest";
import { ensureLocalProfile } from "@/lib/local/profile";
import { createColumnsForProject } from "@/lib/services/planning";
import { slugify } from "@/lib/slug";
import { SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { TeamService } from "@/lib/team/service";

/** An isolated local Mergeport client: its own SQLite file and its own GitHub identity against a shared fake GitHub. */
export type Client = Awaited<ReturnType<typeof makeClient>>;

let counter = 0;
export const clock = { t: Date.parse("2026-10-29T10:00:00Z"), now: () => new Date(clock.t), advance(ms: number) { clock.t += ms; } };

export async function makeClient(server: FakeGitHubServer, login: string, opts: { events?: { spaceId: string; reason: string }[] } = {}) {
  const user = server.users.get(login) ?? server.addUser(login);
  const file = path.resolve(".data", `client-${login}-${process.pid}-${counter++}.db`);
  for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(file + sfx, { force: true });
  const db: Db = createPrisma(file);
  const actor = { id: BigInt(user.id), login };
  const profile = await ensureLocalProfile(db, { id: actor.id, login, name: login, avatarUrl: null, host: "github.com" });
  const f = server.fetchFor(login);
  const engine = new SyncEngine({
    db, actor, now: clock.now, random: () => 0.5,
    store: (s: Space) => new CoordinationStore(new GitHubRest(f), s.repoOwner, s.repoName),
    onChange: (e) => opts.events?.push(e),
  });
  const team = new TeamService(db, f, actor, engine, clock.now);
  const viewer = async (): Promise<Viewer> => (await loadViewer(db, profile.user.id))!;
  return { login, db, file, actor, engine, team, profile, viewer, fetch: f, close: () => db.$disconnect() };
}

/** Everything anyone with read access could see in a coordination repository: current files plus every commit message. */
export const visibleText = (server: FakeGitHubServer, owner: string, name: string) => JSON.stringify(server.files(owner, name)) + JSON.stringify(server.history(owner, name));

/** Shares a repository, creates a project and a card in `space` on this client (as the person who has write access there). */
export async function seedProject(c: Client, space: Space, o: { repoFullName?: string; githubId?: bigint; project?: string; card?: string } = {}) {
  const ws = c.profile.workspace;
  const [ownerLogin, repoName] = (o.repoFullName ?? "acme/secret-repo").split("/");
  const owner = await c.db.githubOwner.upsert({ where: { githubId: 777n }, create: { githubId: 777n, login: ownerLogin, type: "ORGANIZATION" }, update: {} });
  const githubId = o.githubId ?? 424242n;
  const repo = await c.db.repository.upsert({
    where: { workspaceId_githubId: { workspaceId: ws.id, githubId } },
    create: { workspaceId: ws.id, githubId, ownerId: owner.id, name: repoName, fullName: `${ownerLogin}/${repoName}`, htmlUrl: `https://github.com/${ownerLogin}/${repoName}`, visibility: "PRIVATE", defaultBranch: "main", spaceId: space.id },
    update: { spaceId: space.id },
  });
  const pname = o.project ?? "Secret Project";
  const project = await c.db.project.create({ data: { workspaceId: ws.id, name: pname, slug: `${slugify(pname)}-${counter++}`, spaceId: space.id } });
  await createColumnsForProject(c.db, project.id);
  await c.db.projectRepository.create({ data: { projectId: project.id, repositoryId: repo.id } });
  await c.db.projectMember.create({ data: { projectId: project.id, memberId: c.profile.member.id } });
  const col = await c.db.planningColumn.findFirstOrThrow({ where: { projectId: project.id, key: "ready" } });
  const card = await c.db.planningItem.create({ data: { projectId: project.id, columnId: col.id, position: 1024, title: o.card ?? "Rotate the signing keys", createdById: c.profile.member.id } });
  return { repo, project, card };
}

export const cardColumn = async (c: Client, id: string) => (await c.db.planningItem.findUnique({ where: { id }, include: { column: true } }))?.column.key;
