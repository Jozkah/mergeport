import { sameLogin } from "./text-index";

/**
 * A person as GitHub knows them. The numeric id never changes; a login can be renamed and later taken by someone else, so wherever
 * both sides carry an id the ids decide and the logins are ignored. The login is only the fallback for a side without an id
 * (a local or demo item, a row stored before ids were recorded, a person without a linked account).
 */
export type Who = { login: string | null; id: bigint | null };
/** Accepts a bare login (tests, callers that only have one) as well as a full identity. */
export type WhoLike = string | null | Who;

export const asWho = (w: WhoLike | undefined): Who => (w && typeof w === "object" ? { login: w.login ?? null, id: w.id ?? null } : { login: w ?? null, id: null });

/** The viewer as GitHub data sees them. The id is only used together with a trusted login, so "no linked account" stays "matches nothing". */
export const viewerWho = (v: { githubLogin: string | null; githubId: bigint | null }): Who => ({ login: v.githubLogin, id: v.githubLogin === null ? null : v.githubId });

export function samePerson(a: WhoLike, b: WhoLike): boolean {
  const x = asWho(a);
  const y = asWho(b);
  const xi = x.id ?? null;
  const yi = y.id ?? null;
  if (xi !== null && yi !== null) return xi === yi;
  return sameLogin(x.login, y.login);
}

/** "|123|456|" index of numeric ids, next to the login index. */
export const indexIds = (ids: readonly (bigint | number | string)[]): string => (ids.length ? "|" + ids.map(String).join("|") + "|" : "");
export const idNeedle = (id: bigint | number | string): string => "|" + String(id) + "|";

/** Whether an item is assigned to the person: by id when the item recorded assignee ids, by login otherwise. */
export function assignedTo(row: { assigneeLogins: string; assigneeIds?: string | null }, me: WhoLike): boolean {
  const w = asWho(me);
  if (row.assigneeIds && w.id !== null) return row.assigneeIds.includes(idNeedle(w.id));
  return !!w.login && row.assigneeLogins.includes("|" + w.login.toLowerCase() + "|");
}

/** An item the person wrote (matched by author id when both are known). */
export const authoredBy = (row: { authorLogin: string | null; authorGithubId?: bigint | null }, me: WhoLike): boolean => samePerson({ login: row.authorLogin, id: row.authorGithubId ?? null }, me);

/** Prisma `where` for "assigned to the person", the same rule as `assignedTo`. Never matches without a login or id. */
export function assignedWhere(me: WhoLike) {
  const w = asWho(me);
  const byLogin = w.login ? { assigneeLogins: { contains: "|" + w.login.toLowerCase() + "|" } } : null;
  if (w.id !== null) return { OR: [{ assigneeIds: { contains: idNeedle(w.id) } }, ...(byLogin ? [{ assigneeIds: "", ...byLogin }] : [])] };
  return byLogin ?? { id: "\u0000none" };
}

/** Prisma `where` for "written by the person", the same rule as `authoredBy`. */
export function authoredWhere(me: WhoLike) {
  const w = asWho(me);
  const byLogin = w.login ? { authorLogin: { equals: w.login, mode: "insensitive" as const } } : null;
  if (w.id !== null) return { OR: [{ authorGithubId: w.id }, ...(byLogin ? [{ authorGithubId: null, ...byLogin }] : [])] };
  return byLogin ?? { id: "\u0000none" };
}
