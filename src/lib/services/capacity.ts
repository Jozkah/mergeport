import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { derivedOpen } from "./queries";
import { audit } from "./audit";

/**
 * Who has how much review waiting, and who covers when someone is away. Both are advice: a configured backup is only suggested,
 * nobody is reassigned and nobody is notified. Availability is shared team configuration (an administrator or the person themselves sets it).
 */
export type CapacityRow = {
  login: string;
  name: string | null;
  queued: number;
  oldestSince: Date | null;
  oldestItemId: string | null;
  unavailable: boolean;
  unavailableUntil: Date | null;
  note: string | null;
  backup: string | null;
  /** Set only when the person is unavailable, has queued work and a configured backup who is available. */
  suggestion: string | null;
};

const lc = (s: string) => s.toLowerCase();
type Window = { unavailableFrom: Date | null; unavailableUntil: Date | null };
/** Away when now falls inside the window. A window with neither end set is not an absence. */
const awayNow = (a: Window | undefined, now: Date) => !!a && (!!a.unavailableFrom || !!a.unavailableUntil) && (!a.unavailableFrom || a.unavailableFrom <= now) && (!a.unavailableUntil || a.unavailableUntil > now);

export async function reviewCapacity(db: Db, v: Viewer, now = new Date()): Promise<CapacityRow[]> {
  const [members, avail, derived] = await Promise.all([
    db.member.findMany({ where: { workspaceId: v.workspaceId, status: "ACTIVE" }, include: { user: true } }),
    db.reviewerAvailability.findMany({ where: { workspaceId: v.workspaceId } }),
    derivedOpen(db, v, { now }),
  ]);
  const away = new Map(avail.map((a) => [lc(a.login), a]));
  const tally = new Map<string, { n: number; since: Date | null; item: string | null }>();
  for (const d of derived) {
    if (!d.derivation.applicable || d.item.draft) continue;
    for (const a of d.derivation.actors) {
      if (a.actor.kind !== "USER" || a.external || a.status !== "PENDING") continue;
      const t = tally.get(lc(a.actor.ref)) ?? { n: 0, since: null, item: null };
      t.n++;
      if (a.since && (!t.since || a.since < t.since)) [t.since, t.item] = [a.since, d.item.id];
      tally.set(lc(a.actor.ref), t);
    }
  }
  const logins = new Set(members.map((m) => lc(m.user.login)));
  const rows = members.map((m) => {
    const login = m.user.login;
    const a = away.get(lc(login));
    const t = tally.get(lc(login));
    const unavailable = awayNow(a, now);
    const backup = a?.backupLogin ?? null;
    const backupFree = !!backup && logins.has(lc(backup)) && !awayNow(away.get(lc(backup)), now);
    return {
      login,
      name: m.user.name,
      queued: t?.n ?? 0,
      oldestSince: t?.since ?? null,
      oldestItemId: t?.item ?? null,
      unavailable,
      unavailableUntil: unavailable ? (a?.unavailableUntil ?? null) : null,
      note: a?.note ?? null,
      backup,
      suggestion: unavailable && (t?.n ?? 0) > 0 && backupFree ? backup : null,
    };
  });
  return rows.sort((x, y) => y.queued - x.queued || lc(x.login).localeCompare(lc(y.login)));
}

export async function setAvailability(db: Db, v: Viewer, input: { login: string; unavailableFrom?: Date | null; unavailableUntil?: Date | null; backupLogin?: string | null; note?: string | null; clear?: boolean }) {
  const login = lc(input.login.trim().replace(/^@/, ""));
  if (!login) throw new ValidationError("Choose a person");
  if (!v.isAdmin && login !== lc(v.login)) throw new ForbiddenError("You can only set your own availability, or ask an administrator");
  const members = await db.member.findMany({ where: { workspaceId: v.workspaceId, status: "ACTIVE" }, include: { user: true } });
  const names = new Set(members.map((m) => lc(m.user.login)));
  if (!names.has(login)) throw new ValidationError("That person is not a member of this workspace");
  if (input.clear) {
    await db.reviewerAvailability.deleteMany({ where: { workspaceId: v.workspaceId, login } });
    await audit(db, v, "availability.clear", { type: "ReviewerAvailability", id: login });
    return;
  }
  const backup = input.backupLogin ? lc(input.backupLogin.trim().replace(/^@/, "")) : null;
  if (backup === login) throw new ValidationError("A person cannot be their own backup");
  if (backup && !names.has(backup)) throw new ValidationError("The backup must be a member of this workspace");
  if (input.unavailableFrom && input.unavailableUntil && input.unavailableUntil <= input.unavailableFrom) throw new ValidationError("The end must be after the start");
  const data = { unavailableFrom: input.unavailableFrom ?? null, unavailableUntil: input.unavailableUntil ?? null, backupLogin: backup, note: input.note?.trim().slice(0, 200) || null };
  await db.reviewerAvailability.upsert({ where: { workspaceId_login: { workspaceId: v.workspaceId, login } }, create: { workspaceId: v.workspaceId, login, ...data }, update: data });
  await audit(db, v, "availability.set", { type: "ReviewerAvailability", id: login });
}
