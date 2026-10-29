/**
 * The person comes first. On any list that mixes a person's own things with their teams', organizations or other people,
 * "Me" / "Personal" and the viewer's own account sort ahead; everything else keeps its own (case-insensitive) order.
 */
const PERSONAL_NAMES = new Set(["me", "mine", "my", "personal", "personal workspace", "my stuff", "my projects", "my repositories"]);

export function isPersonalName(name: string, viewerLogin?: string | null): boolean {
  const n = name.trim().toLowerCase();
  return PERSONAL_NAMES.has(n) || (!!viewerLogin && n === viewerLogin.trim().toLowerCase());
}

/** Sort comparator for names: the viewer's own first, then alphabetical. */
export function byPersonalFirst(viewerLogin?: string | null) {
  return (a: string, b: string) => {
    const pa = isPersonalName(a, viewerLogin) ? 0 : 1;
    const pb = isPersonalName(b, viewerLogin) ? 0 : 1;
    return pa - pb || a.localeCompare(b, undefined, { sensitivity: "base" });
  };
}

/** `owner/name` strings: the viewer's own repositories first. */
export function byOwnerFirst(viewerLogin?: string | null) {
  const me = (viewerLogin ?? "").toLowerCase();
  return (a: string, b: string) => {
    const pa = a.split("/")[0].toLowerCase() === me ? 0 : 1;
    const pb = b.split("/")[0].toLowerCase() === me ? 0 : 1;
    return pa - pb || a.localeCompare(b, undefined, { sensitivity: "base" });
  };
}

/** Stable: items the viewer owns first, the rest in their given order. */
export function personFirst<T>(items: T[], isMine: (item: T) => boolean): T[] {
  return [...items.filter(isMine), ...items.filter((i) => !isMine(i))];
}
