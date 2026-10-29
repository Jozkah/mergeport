import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Saved views: a page, a name and a query string (filters, grouping, sort, density, scope). One mechanism for every list page.
 * A shared view is only that definition. It is synchronised to teammates, and each person's results are computed from their own
 * access, so sharing a view never shares the items it shows.
 */
export const VIEW_PAGES = {
  attention: "/attention",
  tasks: "/tasks",
  planning: "/planning",
  forks: "/forks",
  PULL_REQUEST: "/pull-requests",
  ISSUE: "/issues",
} as const;
export type ViewScope = keyof typeof VIEW_PAGES;
export const isViewScope = (s: string): s is ViewScope => s in VIEW_PAGES;

const MAX_PER_SCOPE = 50;

/** Re-serialises through URLSearchParams so only plain key=value pairs survive, and bounds the size. */
export function cleanQuery(raw: string): string {
  const p = new URLSearchParams(raw.replace(/^\?/, "").slice(0, 1000));
  const out = new URLSearchParams();
  let n = 0;
  for (const [k, val] of p) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(k) || val.length > 200 || n >= 20) continue;
    out.append(k, val);
    n++;
  }
  return out.toString();
}

export const viewHref = (scope: ViewScope, query: string) => `${VIEW_PAGES[scope]}${query ? `?${query}` : ""}`;

export type ViewRow = { id: string; name: string; query: string; shared: boolean; mine: boolean; ownerLogin: string | null; href: string };

export async function listViews(db: Db, v: Viewer, scope: string): Promise<ViewRow[]> {
  if (!isViewScope(scope)) return [];
  const rows = await db.savedFilter.findMany({ where: { scope, userId: v.userId }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, name: r.name, query: r.query, shared: r.shared, mine: !r.shared || (r.ownerLogin ?? v.login).toLowerCase() === v.login.toLowerCase(), ownerLogin: r.ownerLogin, href: viewHref(scope, r.query) }));
}

export async function saveView(db: Db, v: Viewer, input: { scope: string; name: string; query: string; shared?: boolean }) {
  if (!isViewScope(input.scope)) throw new ValidationError("That page cannot have saved views");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Name the view");
  if (name.length > 60) throw new ValidationError("A view name can have at most 60 characters");
  if ((await db.savedFilter.count({ where: { userId: v.userId, scope: input.scope } })) >= MAX_PER_SCOPE) throw new ValidationError(`You can keep at most ${MAX_PER_SCOPE} views per page`);
  if (await db.savedFilter.findFirst({ where: { userId: v.userId, scope: input.scope, name } })) throw new ValidationError("You already have a view with that name");
  return db.savedFilter.create({ data: { userId: v.userId, scope: input.scope, name, query: cleanQuery(input.query), shared: !!input.shared, ownerLogin: v.login } });
}

async function own(db: Db, v: Viewer, id: string) {
  const r = await db.savedFilter.findFirst({ where: { id, userId: v.userId } });
  if (!r) throw new NotFoundError();
  // A view that arrived from a teammate belongs to them: it can be hidden from sharing by them, not edited here.
  if (r.shared && r.ownerLogin && r.ownerLogin.toLowerCase() !== v.login.toLowerCase()) throw new ValidationError(`This view is shared by ${r.ownerLogin}; only they can change it`);
  return r;
}

export async function setViewShared(db: Db, v: Viewer, id: string, shared: boolean) {
  await own(db, v, id);
  await db.savedFilter.update({ where: { id }, data: { shared, ownerLogin: v.login } });
}

export async function deleteView(db: Db, v: Viewer, id: string) {
  await own(db, v, id);
  await db.savedFilter.delete({ where: { id } });
}
