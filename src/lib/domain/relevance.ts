/**
 * Upstream relevance subscriptions: saved criteria that say which upstream changes matter to this fork. Pure.
 * Every match reports WHY (which criterion hit), and a criterion that cannot be evaluated (paths whose files are not loaded) is
 * reported as unknown rather than as a non-match or a match.
 */
export type Criteria = { labels?: string[]; paths?: string[]; milestone?: string; authors?: string[]; titleContains?: string[] };

export type UpstreamFacts = {
  labels: string[];
  author: string | null;
  milestone: string | null;
  title: string;
  /** Changed file paths when they are known (cached); null when they have not been loaded. */
  files: string[] | null;
};

export type Subscription = { id: string; name: string; criteria: Criteria; muted: boolean; mappingId: string | null };
export type Match = { subscriptionId: string; name: string; reasons: string[]; unknown: string[] };

const lc = (s: string) => s.toLowerCase();

export function cleanCriteria(raw: unknown): Criteria {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : []);
  const out: Criteria = {};
  if (list(r.labels).length) out.labels = list(r.labels);
  if (list(r.paths).length) out.paths = list(r.paths);
  if (list(r.authors).length) out.authors = list(r.authors).map((a) => a.replace(/^@/, ""));
  if (list(r.titleContains).length) out.titleContains = list(r.titleContains);
  if (typeof r.milestone === "string" && r.milestone.trim()) out.milestone = r.milestone.trim().slice(0, 80);
  return out;
}

export const hasCriteria = (c: Criteria) => Object.keys(c).length > 0;

/** A path criterion is a prefix ("src/auth/") or a `*` glob. */
export function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`);
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*")}$`);
  return re.test(path);
}

/**
 * A subscription matches when ANY of its criteria hits (it is a list of interests, not a filter that all must pass). Muted
 * subscriptions never match. An empty subscription matches nothing.
 */
export function matchSubscription(sub: Subscription, f: UpstreamFacts): Match | null {
  if (sub.muted || !hasCriteria(sub.criteria)) return null;
  const c = sub.criteria;
  const reasons: string[] = [];
  const unknown: string[] = [];
  const labels = f.labels.map(lc);
  for (const l of c.labels ?? []) if (labels.includes(lc(l))) reasons.push(`has the label "${l}"`);
  if (c.milestone && f.milestone && lc(f.milestone) === lc(c.milestone)) reasons.push(`is in milestone "${c.milestone}"`);
  for (const a of c.authors ?? []) if (f.author && lc(a) === lc(f.author)) reasons.push(`was opened by @${a}`);
  for (const t of c.titleContains ?? []) if (lc(f.title).includes(lc(t))) reasons.push(`mentions "${t}" in its title`);
  if (c.paths?.length) {
    if (f.files === null) unknown.push("changed files are not loaded, so path criteria could not be checked");
    else for (const p of c.paths) {
      const hit = f.files.find((x) => pathMatches(p, x));
      if (hit) reasons.push(`changes ${hit} (matches ${p})`);
    }
  }
  return reasons.length > 0 || unknown.length > 0 ? { subscriptionId: sub.id, name: sub.name, reasons, unknown } : null;
}

export function matchAll(subs: Subscription[], f: UpstreamFacts, mappingId: string | null): Match[] {
  return subs.filter((s) => s.mappingId === null || s.mappingId === mappingId).flatMap((s) => {
    const m = matchSubscription(s, f);
    return m ? [m] : [];
  });
}
