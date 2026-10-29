/**
 * Scoped labels: `family::value` (for example `priority::high`) and cross-repository mappings. Pure.
 *
 * A mapping says "this repository's spelling means this dashboard concept". Mappings only change how Mergeport reads labels; they
 * never rewrite a label on GitHub. A migration is only ever previewed (which items would read as which concept).
 */
export type Scoped = { family: string; value: string };

export function parseScoped(label: string): Scoped | null {
  const i = label.indexOf("::");
  if (i <= 0 || i >= label.length - 2) return null;
  const family = label.slice(0, i).trim().toLowerCase();
  const value = label.slice(i + 2).trim().toLowerCase();
  return family && value && !value.includes("::") ? { family, value } : null;
}

export const concept = (s: Scoped) => `${s.family}::${s.value}`;

export type Mapping = { concept: string; spelling: string; repositoryId: string | null };

/** The concept a label stands for in a repository: a repository-specific mapping beats a global one, which beats the label's own scope. */
export function conceptOf(label: string, repositoryId: string | null, mappings: Mapping[]): string | null {
  const key = label.trim().toLowerCase();
  const own = mappings.find((m) => m.spelling.toLowerCase() === key && m.repositoryId !== null && m.repositoryId === repositoryId);
  const global = mappings.find((m) => m.spelling.toLowerCase() === key && m.repositoryId === null);
  const hit = own ?? global;
  if (hit) return hit.concept;
  const s = parseScoped(label);
  return s ? concept(s) : null;
}

/** Every spelling that reads as a concept, so a filter on `priority::high` also finds `P1` in repositories that map it. */
export function spellingsOf(conceptName: string, mappings: Mapping[]): string[] {
  const out = new Set<string>([conceptName]);
  for (const m of mappings) if (m.concept.toLowerCase() === conceptName.toLowerCase()) out.add(m.spelling);
  return [...out];
}

export type Family = { family: string; values: string[] };

/** The families in use, from scoped labels and mapping concepts. `exclusive` is implied: an item should carry one value per family. */
export function families(labels: string[], mappings: Mapping[]): Family[] {
  const m = new Map<string, Set<string>>();
  const add = (c: string | null) => {
    const s = c ? parseScoped(c) : null;
    if (s) (m.get(s.family) ?? m.set(s.family, new Set()).get(s.family)!).add(s.value);
  };
  for (const l of labels) add(l);
  for (const x of mappings) add(x.concept);
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([family, v]) => ({ family, values: [...v].sort() }));
}

/** Items that carry more than one value of the same family, which the scoped convention treats as a mistake worth showing. */
export function conflicts(labels: string[], repositoryId: string | null, mappings: Mapping[]): string[] {
  const seen = new Map<string, Set<string>>();
  for (const l of labels) {
    const c = conceptOf(l, repositoryId, mappings);
    const s = c ? parseScoped(c) : null;
    if (s) (seen.get(s.family) ?? seen.set(s.family, new Set()).get(s.family)!).add(s.value);
  }
  return [...seen].filter(([, v]) => v.size > 1).map(([f]) => f);
}

export type MigrationPreview = { concept: string; spelling: string; repositoryId: string | null; items: number }[];

/** What a mapping set would change in how existing items read. Counts only; nothing is written anywhere. */
export function previewMapping(items: { repositoryId: string; labels: string[] }[], mappings: Mapping[]): MigrationPreview {
  const out = new Map<string, { concept: string; spelling: string; repositoryId: string | null; items: number }>();
  for (const it of items) {
    for (const l of it.labels) {
      const c = conceptOf(l, it.repositoryId, mappings);
      if (!c || parseScoped(l)?.family === parseScoped(c)?.family && l.toLowerCase() === c) continue;
      const hit = mappings.find((m) => m.spelling.toLowerCase() === l.toLowerCase() && (m.repositoryId === null || m.repositoryId === it.repositoryId));
      if (!hit) continue;
      const k = `${hit.concept}|${hit.spelling}|${hit.repositoryId ?? ""}`;
      const e = out.get(k) ?? { concept: hit.concept, spelling: hit.spelling, repositoryId: hit.repositoryId, items: 0 };
      e.items++;
      out.set(k, e);
    }
  }
  return [...out.values()].sort((a, b) => b.items - a.items);
}
