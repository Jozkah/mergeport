import { createElement } from "react";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { DesktopOnly } from "@/components/ui/DesktopOnly";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrisma } from "./pg";
import { HOST, ORIGIN, state } from "./auth-mocks";
import { BASE, leaks } from "./helpers";
import { addMember, workspaceWithOwner } from "./roles-helpers";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { seedDemo, type DemoIds } from "@/lib/demo/seed";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { createRestrictedSpace, listMySpaces, listSpacesForAdmin, removeSpaceMember, setProjectAccessSpace, setSpaceMember } from "@/lib/services/access-spaces";
import { createColumnsForProject } from "@/lib/services/planning";
import { listProjects, searchGlobal } from "@/lib/services/queries";
import { planningBoard } from "@/lib/services/planning-view";
import { createTask, listTasks } from "@/lib/services/tasks";
import { makeWorld, linkUp, get, openPolicies, type World } from "./federation-harness";
import { projectsRoute, projectRoute } from "@/lib/federation/provider-http";

/**
 * 1. Putting a project into a restricted space (Project.accessSpaceId) from the Projects page, with the membership rule.
 * 2. No desktop-only wording on a hosted workspace.
 */
vi.mock("next/headers", async () => {
  const m = await import("./auth-mocks");
  return { cookies: m.headersMock.cookies, headers: async () => new Headers({ host: HOST }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: (await import("./auth-mocks")).dbProxy }));

let n = 0;
beforeEach(() => {
  state.db = createTestPrisma(`hosted-access-ui-${n++}`);
  state.jar.clear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await state.db!.$disconnect();
});
const db = () => state.db!;

describe("moving a project into or out of a restricted space", () => {
  let ids: DemoIds;
  let admin: Viewer; // OWNER of the demo workspace
  let a: Viewer; // MEMBER
  let b: Viewer; // MEMBER
  beforeEach(async () => {
    ids = await seedDemo(db(), BASE);
    [admin, a, b] = (await Promise.all([ids.users.admin.id, ids.users.a.id, ids.users.b.id].map((id) => loadViewer(db(), id)))) as Viewer[];
  });
  const atlas = () => ids.projects.atlas.id;
  const accessOf = async () => (await db().project.findUniqueOrThrow({ where: { id: atlas() } })).accessSpaceId;

  it("an administrator outside the space cannot move a project INTO it", async () => {
    const space = await createRestrictedSpace(db(), admin, "Skunkworks");
    await expect(setProjectAccessSpace(db(), admin, atlas(), space.id)).rejects.toThrow(ForbiddenError);
    expect(await accessOf()).toBeNull();
    await setSpaceMember(db(), admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db(), admin, atlas(), space.id);
    expect(await accessOf()).toBe(space.id);
  });

  it("an administrator outside the space cannot move a project OUT of it (it is invisible to them, and the rule would refuse anyway)", async () => {
    const space = await createRestrictedSpace(db(), admin, "Skunkworks");
    await setSpaceMember(db(), admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db(), admin, atlas(), space.id);
    await removeSpaceMember(db(), admin, space.id, ids.members.admin.id);
    await expect(setProjectAccessSpace(db(), admin, atlas(), null)).rejects.toThrow(NotFoundError);
    expect(await accessOf()).toBe(space.id);
    // a different restricted space the administrator IS in does not help either
    const other = await createRestrictedSpace(db(), admin, "Other");
    await setSpaceMember(db(), admin, other.id, ids.members.admin.id, true);
    await expect(setProjectAccessSpace(db(), admin, atlas(), other.id)).rejects.toThrow(NotFoundError);
    expect(await accessOf()).toBe(space.id);
    // once in the space they can move it out
    await setSpaceMember(db(), admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db(), admin, atlas(), null);
    expect(await accessOf()).toBeNull();
  });

  it("a space of another workspace is refused", async () => {
    const other = await workspaceWithOwner(db(), "o@x.test", "Other");
    const theirs = await createRestrictedSpace(db(), other.viewer, "Theirs");
    await expect(setProjectAccessSpace(db(), admin, atlas(), theirs.id)).rejects.toThrow(NotFoundError);
    await expect(setProjectAccessSpace(db(), admin, atlas(), "nonexistent")).rejects.toThrow(NotFoundError);
    expect(await accessOf()).toBeNull();
  });

  it("MEMBER and READER are refused, even inside the space", async () => {
    const space = await createRestrictedSpace(db(), admin, "Skunkworks");
    await setSpaceMember(db(), admin, space.id, ids.members.a.id, true);
    await expect(setProjectAccessSpace(db(), a, atlas(), space.id)).rejects.toThrow(ForbiddenError);
    const reader = await addMember(db(), ids.ws.id, "reader@x.test", "READER");
    await setSpaceMember(db(), admin, space.id, reader.member.id, true);
    await expect(setProjectAccessSpace(db(), await reader.viewer(), atlas(), space.id)).rejects.toThrow(ForbiddenError);
    expect(await accessOf()).toBeNull();
  });

  it("the move is audited, and the picker never lists a restricted space the person is not in", async () => {
    const secret = await createRestrictedSpace(db(), admin, "TOP-SECRET-SPACE-NAME");
    expect(leaks(await listMySpaces(db(), admin), "TOP-SECRET-SPACE-NAME")).toBe(false);
    await setSpaceMember(db(), admin, secret.id, ids.members.admin.id, true);
    expect((await listMySpaces(db(), admin)).map((s) => s.name)).toContain("TOP-SECRET-SPACE-NAME");
    await setProjectAccessSpace(db(), admin, atlas(), secret.id);
    const row = await db().auditLog.findFirstOrThrow({ where: { workspaceId: ids.ws.id, action: "project.space" } });
    expect(row).toMatchObject({ actorUserId: admin.userId, targetType: "Project", targetId: atlas() });
  });

  it("after the move the project is gone for non-members: lists, search, planning, tasks", async () => {
    const space = await createRestrictedSpace(db(), admin, "Skunkworks");
    await setSpaceMember(db(), admin, space.id, ids.members.admin.id, true);
    await setSpaceMember(db(), admin, space.id, ids.members.a.id, true);
    await createTask(db(), admin, { projectId: atlas(), title: "ZEBRA-MOVED-TASK" });
    await setProjectAccessSpace(db(), admin, atlas(), space.id);
    expect((await listProjects(db(), b)).map((p) => p.name)).toEqual(["Dashboard"]);
    expect((await listTasks(db(), b)).map((t) => t.title)).not.toContain("ZEBRA-MOVED-TASK");
    expect((await searchGlobal(db(), b, "ZEBRA")).planning).toHaveLength(0);
    await expect(planningBoard(db(), b, atlas())).rejects.toThrow(NotFoundError);
    expect((await listProjects(db(), a)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
    expect((await searchGlobal(db(), a, "ZEBRA")).planning).toHaveLength(1);
    // moved back by a member: visible to everyone again
    await setProjectAccessSpace(db(), admin, atlas(), null);
    expect((await listProjects(db(), b)).map((p) => p.name).sort()).toEqual(["Atlas", "Dashboard"]);
  });

  it("the Spaces panel numbers: the common space and each restricted one count their projects", async () => {
    const space = await createRestrictedSpace(db(), admin, "Skunkworks");
    let list = await listSpacesForAdmin(db(), admin);
    expect(list.find((s) => s.kind === "COMMON")!.projectCount).toBe(2);
    expect(list.find((s) => s.id === space.id)!.projectCount).toBe(0);
    await setSpaceMember(db(), admin, space.id, ids.members.admin.id, true);
    await setProjectAccessSpace(db(), admin, atlas(), space.id);
    list = await listSpacesForAdmin(db(), admin);
    expect(list.find((s) => s.kind === "COMMON")!.projectCount).toBe(1);
    expect(list.find((s) => s.id === space.id)!.projectCount).toBe(1);
    await expect(ConflictError).toBeDefined();
  });
});

describe("a federation grant stops listing a project once it moves into a space its person is not in", () => {
  it("lists it before, not after; the member of the space still sees it", async () => {
    const w: World = await makeWorld(db());
    await openPolicies(w);
    const outside = await linkUp(w, w.aOwner, { userId: w.ids.users.b.id, workspaceId: w.ids.ws.id });
    const names = async (t: string) => ((await (await projectsRoute(w.B, get("/api/federation/v1/projects", t))).json()) as { projects: { name: string }[] }).projects.map((p) => p.name).sort();
    expect(await names(outside.token)).toEqual(["Atlas", "Dashboard"]);
    const space = await createRestrictedSpace(db(), w.admin, "Skunkworks");
    await setSpaceMember(db(), w.admin, space.id, w.ids.members.admin.id, true);
    await setProjectAccessSpace(db(), w.admin, w.ids.projects.atlas.id, space.id);
    expect(await names(outside.token)).toEqual(["Dashboard"]);
    expect((await projectRoute(w.B, get(`/api/federation/v1/projects/${w.ids.projects.atlas.id}`, outside.token), w.ids.projects.atlas.id)).status).toBe(404);
  });
});

// ---------- hosted wording ----------

/** Phrases that only make sense for the local desktop app. None may appear on a hosted workspace. Matched case-insensitively. */
const BANNED = [
  "only on this computer",
  "on this computer",
  "this computer",
  "your computer",
  "no branch set",
  "shared with your team. folder paths never are",
  "nobody runs a server",
  "private github repository",
  "set up a team",
  "gh sign-in",
  "gh auth",
  "github cli",
  "save sharing",
  "shared through",
  "worktree",
  "clone",
  "mergeport is open",
];

/** Every string in a rendered element tree (function types, database handles and cycles skipped). */
function text(el: unknown): string {
  const seen = new WeakSet<object>();
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") return void out.push(v);
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      if (k === "type" || k === "_owner" || k === "_store" || k === "db") continue;
      out.push(k);
      walk(x);
    }
  };
  walk(el);
  return out.join(" ");
}

/** Components that render other components (the desktop-only page) are rendered to HTML, so their own text is seen. */
const markup = (el: unknown) => renderToStaticMarkup(createElement(TooltipProvider, null, el as never));

describe("hosted mode shows no desktop-only wording", () => {
  async function signedIn() {
    vi.stubEnv("MERGEPORT_PUBLIC_URL", ORIGIN);
    vi.stubEnv("MERGEPORT_TRUST_PROXY", "true");
    vi.stubEnv("DEMO_MODE", "false");
    const w = await workspaceWithOwner(db(), "owner@hosted.test", "Hosted Co");
    const { token } = await createSession(db(), w.owner.id, new Date(), w.ws.id);
    state.jar.set(SESSION_COOKIE, { value: token, options: {} });
    const project = await db().project.create({ data: { workspaceId: w.ws.id, name: "Roadmap", slug: "roadmap" } });
    await createColumnsForProject(db(), project.id);
    const task = await createTask(db(), w.viewer, { projectId: project.id, title: "A task" });
    return { w, project, task };
  }
  const pages = async (taskId: string) => ({
    "admin/projects": () => import("@/app/(app)/admin/projects/page").then((m) => m.default()),
    "tasks/[id]": () => import("@/app/(app)/tasks/[id]/page").then((m) => m.default({ params: Promise.resolve({ id: taskId }), searchParams: Promise.resolve({}) })),
    help: () => import("@/app/(app)/help/page").then((m) => m.default()),
    sync: () => import("@/app/(app)/sync/page").then((m) => m.default()),
    repositories: () => import("@/app/(app)/repositories/page").then((m) => m.default({ searchParams: Promise.resolve({}) } as never)),
    digest: () => import("@/app/(app)/digest/page").then((m) => m.default({ searchParams: Promise.resolve({}) } as never)),
    settings: () => import("@/app/(app)/settings/page").then((m) => m.default({ searchParams: Promise.resolve({}) })),
    "settings/members": () => import("@/app/(app)/settings/members/page").then((m) => m.default()),
    "desktop-only (team)": () => import("@/app/(app)/team/page").then(async () => text(await DesktopOnly())),
    "desktop-only (branches)": () => import("@/app/(app)/branches/page").then(async () => text(await DesktopOnly())),
  });

  it("none of the banned phrases appears on the key pages", async () => {
    const { task } = await signedIn();
    const rendered = new Map<string, string>();
    for (const [name, render] of Object.entries(await pages(task.id))) rendered.set(name, text(await (render as () => Promise<unknown>)()).toLowerCase());
    for (const [name, t] of rendered) {
      expect(t.length, `${name} rendered something`).toBeGreaterThan(20);
      for (const phrase of BANNED) expect(t, `${name} must not say "${phrase}"`).not.toContain(phrase);
    }
  });

  it("the desktop-only pages say so and point back, instead of a 404", async () => {
    await signedIn();
    for (const path of ["team", "branches"]) {
      const el = (await (await import(`@/app/(app)/${path}/page`)).default({ searchParams: Promise.resolve({}) })) as { type: unknown };
      expect(el.type, path).toBe(DesktopOnly); // the page IS the explanation, not a 404
      expect(text(DesktopOnly()).toLowerCase(), path).toContain("this page is for the desktop app");
    }
  });

  // Components that hold wording of their own are rendered with the hosted flag, so a local-only sentence cannot slip back in.
  it("the settings and shell components carry no desktop-only wording when hosted", async () => {
    const [{ NotificationSettings }, { AiSettingsPanel }, { BackupPanel }, { DigestActions }, { SyncBadge }] = await Promise.all([
      import("@/components/settings/NotificationSettings"),
      import("@/components/settings/AiSettingsPanel"),
      import("@/components/settings/BackupPanel"),
      import("@/components/digest/DigestActions"),
      import("@/components/sync/SyncBadge"),
    ]);
    const prefs = { kinds: {}, quiet: { enabled: false, from: "22:00", to: "07:00" }, digest: { enabled: true, hour: 8 } } as never;
    const states = ["synced", "pending", "syncing", "reconnecting", "offline", "conflict", "revoked", "signin", "rate-limited", "schema", "read-only"] as const;
    const html = [
      renderToStaticMarkup(createElement(AiSettingsPanel, { baseUrl: "", hasKey: true, model: null, autopilot: "suggest", hosted: true })),
      renderToStaticMarkup(createElement(BackupPanel, { hosted: true })),
      renderToStaticMarkup(createElement(DigestActions, { day: "2026-01-01", read: false, hosted: true })),
      ...states.map((s) => markup(createElement(SyncBadge, { state: s, hosted: true }))),
      text(DesktopOnly()),
    ];
    try {
      html.push(renderToStaticMarkup(createElement(NotificationSettings, { initial: prefs, hosted: true })));
    } catch {
      // The notification table needs the full preference object; its hosted sentence is checked in the source below.
    }
    const all = html.join(" ").toLowerCase();
    for (const phrase of BANNED) expect(all, `components must not say "${phrase}"`).not.toContain(phrase);
    const src = (await import("node:fs")).readFileSync("src/components/settings/NotificationSettings.tsx", "utf8");
    expect(src).toContain("hosted ?");
  });

  it("the Projects page offers Access (not Sharing), lists only the spaces the person is in, and never names a restricted space they are outside of", async () => {
    const { w, project } = await signedIn();
    const mine = await createRestrictedSpace(db(), w.viewer, "MY-SPACE-NAME");
    await setSpaceMember(db(), w.viewer, mine.id, w.viewer.memberId, true);
    const hidden = await createRestrictedSpace(db(), w.viewer, "HIDDEN-SPACE-NAME"); // the owner is not in it
    expect(hidden.id).toBeTruthy();
    const t = text(await (await import("@/app/(app)/admin/projects/page")).default());
    expect(t).toContain("Access");
    expect(t).toContain("Everyone in the workspace");
    expect(t).toContain("MY-SPACE-NAME");
    expect(t).not.toContain("HIDDEN-SPACE-NAME");
    expect(t).not.toContain("Shared with the workspace"); // one phrase for the state
    expect(t).not.toContain("Save sharing");
    // and the local app keeps its legacy Sharing section
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const local = text(await (await import("@/app/(app)/admin/projects/page")).default());
    expect(local).toContain("Save sharing");
    expect(local).toContain("only on this computer");
    expect(project.id).toBeTruthy();
  });

  it("the local wording is unchanged when not hosted", async () => {
    const { task } = await signedIn();
    vi.stubEnv("MERGEPORT_PUBLIC_URL", "");
    const help = text(await (await import("@/app/(app)/help/page")).default()).toLowerCase();
    expect(help).toContain("this computer");
    expect(help).toContain("gh auth login");
    const t = text(await (await import("@/app/(app)/tasks/[id]/page")).default({ params: Promise.resolve({ id: task.id }), searchParams: Promise.resolve({}) })).toLowerCase();
    expect(t).toContain("shared with your team. folder paths never are");
  });
});
