import type { Db } from "@/lib/db";
import { repoWhere, type Viewer } from "@/lib/authz/viewer";
import { LOGIN_QUERY, MENTION_LIMIT, referencedNumbers, type ItemSuggestion, type MentionKind, type MentionSuggestion, type UserSuggestion } from "@/lib/mentions";
import type { MentionRefs } from "@/lib/markdown";

/** The repository, only when the viewer may see it. Hidden and missing look the same: nothing. */
async function visibleRepo(db: Db, v: Viewer, repositoryId: string) {
  if (!repositoryId) return null;
  return db.repository.findFirst({ where: { AND: [repoWhere(v), { id: repositoryId }] }, select: { id: true, htmlUrl: true } });
}

const itemHref = (i: { id: string; type: string }) => `/${i.type === "PULL_REQUEST" ? "pull-requests" : "issues"}/${i.id}`;

/**
 * Suggestions for the mention popup: people (authors, assignees and commenters known for the repository; collaborators are not
 * stored) or issues and pull requests of that repository. Only for a repository the viewer may see, and only from that repository.
 */
export async function suggestMentions(db: Db, v: Viewer, repositoryId: string, kind: MentionKind, rawQuery: string): Promise<MentionSuggestion[]> {
  const repo = await visibleRepo(db, v, repositoryId);
  if (!repo) return [];
  const q = String(rawQuery ?? "").trim().slice(0, 50);
  return kind === "user" ? users(db, repo.id, q) : items(db, repo.id, q);
}

async function users(db: Db, repositoryId: string, q: string): Promise<UserSuggestion[]> {
  if (!LOGIN_QUERY.test(q)) return [];
  const lq = q.toLowerCase();
  const like = { contains: q, mode: "insensitive" as const };
  const [authors, assigned, commenters] = await Promise.all([
    db.workItem.findMany({ where: { repositoryId, authorLogin: like }, distinct: ["authorLogin"], select: { authorLogin: true, authorAvatar: true }, take: 50 }),
    db.workItem.findMany({ where: { repositoryId, assigneeLogins: { contains: lq } }, select: { assignees: true }, take: 50 }),
    db.workItemComment.findMany({ where: { workItem: { repositoryId }, authorLogin: like }, distinct: ["authorLogin"], select: { authorLogin: true }, take: 50 }),
  ]);
  const found = new Map<string, UserSuggestion>();
  const add = (login: unknown, avatar: string | null = null) => {
    if (typeof login !== "string" || !login || !login.toLowerCase().includes(lq)) return;
    const k = login.toLowerCase();
    const had = found.get(k);
    if (!had) found.set(k, { kind: "user", login, avatar });
    else if (!had.avatar && avatar) had.avatar = avatar;
  };
  for (const a of authors) add(a.authorLogin, a.authorAvatar);
  for (const w of assigned) if (Array.isArray(w.assignees)) for (const l of w.assignees) add(l);
  for (const c of commenters) add(c.authorLogin);
  const rank = (l: string) => (l.toLowerCase().startsWith(lq) ? 0 : 1);
  return [...found.values()].sort((a, b) => rank(a.login) - rank(b.login) || a.login.localeCompare(b.login)).slice(0, MENTION_LIMIT);
}

async function items(db: Db, repositoryId: string, q: string): Promise<ItemSuggestion[]> {
  const select = { id: true, number: true, title: true, type: true, state: true } as const;
  let rows;
  if (/^\d{1,9}$/.test(q)) {
    // Numbers starting with the digits typed: 12 -> 12, 120-129, 1200-1299, ...
    // The exact number is read on its own so it is never crowded out by longer numbers (1200-1299 for "12"). "0" has no prefix range.
    const n = Number(q);
    const ranges = n === 0 ? [] : [1, 2, 3, 4, 5].filter((k) => (n + 1) * 10 ** k <= 2 ** 31 - 1).map((k) => ({ number: { gte: n * 10 ** k, lt: (n + 1) * 10 ** k } }));
    const [exact, more] = await Promise.all([
      db.workItem.findFirst({ where: { repositoryId, number: n }, select }),
      db.workItem.findMany({ where: { repositoryId, number: { not: n }, OR: [...ranges, { title: { contains: q, mode: "insensitive" } }] }, select, orderBy: { number: "desc" }, take: 50 }),
    ]);
    more.sort((a, b) => Number(String(b.number).startsWith(q)) - Number(String(a.number).startsWith(q)) || b.number - a.number);
    rows = exact ? [exact, ...more] : more;
  } else {
    rows = await db.workItem.findMany({ where: { repositoryId, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) }, select, orderBy: { updatedAtGh: "desc" }, take: MENTION_LIMIT });
  }
  return rows.slice(0, MENTION_LIMIT).map((r) => ({ kind: "item", number: r.number, title: r.title, type: r.type, state: r.state, href: itemHref(r) }));
}

/**
 * Link targets for `#123` in a repository's texts: the Mergeport page for items known here, GitHub's issue address otherwise.
 * Undefined when the viewer may not see the repository (then only `@login` is linked).
 */
export async function mentionRefs(db: Db, v: Viewer, repositoryId: string, texts: (string | null | undefined)[]): Promise<MentionRefs | undefined> {
  const repo = await visibleRepo(db, v, repositoryId);
  if (!repo) return undefined;
  const numbers = referencedNumbers(texts);
  const rows = numbers.length ? await db.workItem.findMany({ where: { repositoryId: repo.id, number: { in: numbers } }, select: { id: true, number: true, type: true } }) : [];
  return { repoUrl: repo.htmlUrl, items: new Map(rows.map((r) => [r.number, itemHref(r)])) };
}
