import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Team contexts: each one is its own database file in the same profile folder, so one team's records are never stored with, or
 * queried alongside, another team's. Switching is not leaving: the context you switch away from is kept exactly as it was
 * (its spaces, its unsent edits, its personal state) and syncs again when you switch back. Only the active context is open and
 * syncing. The GitHub account is the same for all of them; credentials are not stored in any of them.
 *
 * Pure file handling, no database access except a read-only look at a parked context for its summary.
 */
export type Context = { id: string; name: string; /** Relative to the profile folder. */ file: string; createdAt: string };
export type ContextIndex = { version: 1; base: string; active: string; contexts: Context[] };

export const DEFAULT_ID = "default";
const NAME_MAX = 40;

/** The profile folder, whether `dbFile` is the base database or one under `contexts/`. */
export function profileDirOf(dbFile: string): string {
  const dir = path.dirname(dbFile);
  return path.basename(dir) === "contexts" ? path.dirname(dir) : dir;
}

const indexFile = (dir: string) => path.join(dir, "contexts.json");

export function readIndex(dir: string, baseName: string): ContextIndex {
  const fresh: ContextIndex = { version: 1, base: baseName, active: DEFAULT_ID, contexts: [{ id: DEFAULT_ID, name: "Main", file: baseName, createdAt: new Date(0).toISOString() }] };
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(dir), "utf8")) as Partial<ContextIndex>;
    if (raw.version !== 1 || !Array.isArray(raw.contexts)) return fresh;
    const contexts = raw.contexts.filter((c): c is Context => !!c && typeof c.id === "string" && typeof c.name === "string" && typeof c.file === "string" && /^[A-Za-z0-9._/-]+$/.test(c.file) && !c.file.includes("..")).slice(0, 20);
    if (!contexts.some((c) => c.id === DEFAULT_ID)) contexts.unshift(fresh.contexts[0]);
    const active = contexts.some((c) => c.id === raw.active) ? String(raw.active) : DEFAULT_ID;
    return { version: 1, base: typeof raw.base === "string" ? raw.base : baseName, active, contexts };
  } catch {
    return fresh;
  }
}

function write(dir: string, idx: ContextIndex) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = indexFile(dir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexFile(dir)); // never leaves a half-written index
}

export const slugify = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

export function createContext(dir: string, baseName: string, name: string): Context {
  const n = name.trim();
  if (!n) throw new Error("Name the context");
  if (n.length > NAME_MAX) throw new Error(`A name can have at most ${NAME_MAX} characters`);
  const idx = readIndex(dir, baseName);
  if (idx.contexts.length >= 20) throw new Error("That is the most contexts one profile can hold");
  if (idx.contexts.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new Error("A context with that name already exists");
  let id = slugify(n) || "context";
  while (idx.contexts.some((c) => c.id === id)) id += "-2";
  const ctx: Context = { id, name: n, file: `contexts/${id}.db`, createdAt: new Date().toISOString() };
  idx.contexts.push(ctx);
  write(dir, idx);
  return ctx;
}

export function renameContext(dir: string, baseName: string, id: string, name: string) {
  const n = name.trim();
  if (!n || n.length > NAME_MAX) throw new Error("Choose a name of 1 to 40 characters");
  const idx = readIndex(dir, baseName);
  const c = idx.contexts.find((x) => x.id === id);
  if (!c) throw new Error("There is no such context");
  if (idx.contexts.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw new Error("A context with that name already exists");
  c.name = n;
  write(dir, idx);
}

export function setActive(dir: string, baseName: string, id: string) {
  const idx = readIndex(dir, baseName);
  if (!idx.contexts.some((c) => c.id === id)) throw new Error("There is no such context");
  idx.active = id;
  write(dir, idx);
}

/** The database file the launcher should open: the active context's, always inside the profile folder. */
export function activeDbFile(dir: string, baseName: string): string {
  const idx = readIndex(dir, baseName);
  const c = idx.contexts.find((x) => x.id === idx.active) ?? idx.contexts[0];
  const file = path.resolve(dir, c.file);
  return file.startsWith(path.resolve(dir) + path.sep) ? file : path.resolve(dir, baseName);
}

export function contextIdOf(dir: string, baseName: string, dbFile: string): string {
  const idx = readIndex(dir, baseName);
  const abs = path.resolve(dbFile);
  return idx.contexts.find((c) => path.resolve(dir, c.file) === abs)?.id ?? DEFAULT_ID;
}

export type ContextSummary = { team: string | null; mode: string | null; spaces: number; unsent: number; conflicts: number; lastSyncedAt: string | null; exists: boolean };

/** A read-only look at a context's database for the switcher. A file that does not exist yet (never opened) has nothing to show. */
export function peekContext(file: string): ContextSummary {
  const none: ContextSummary = { team: null, mode: null, spaces: 0, unsent: 0, conflicts: 0, lastSyncedAt: null, exists: false };
  if (!fs.existsSync(file)) return none;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1500 });
    const one = <T,>(sql: string): T | undefined => {
      try {
        return db!.prepare(sql).get() as T | undefined;
      } catch {
        return undefined;
      }
    };
    const t = one<{ name: string | null; mode: string }>(`SELECT name, mode FROM TeamConfig WHERE id = 'team'`);
    return {
      exists: true,
      team: t?.name ?? null,
      mode: t?.mode ?? null,
      spaces: one<{ n: number }>(`SELECT COUNT(*) AS n FROM Space`)?.n ?? 0,
      unsent: one<{ n: number }>(`SELECT COUNT(*) AS n FROM OutboxOp WHERE status IN ('PENDING','SENT','FAILED','QUARANTINED')`)?.n ?? 0,
      conflicts: one<{ n: number }>(`SELECT COUNT(*) AS n FROM SyncConflict WHERE status = 'OPEN'`)?.n ?? 0,
      lastSyncedAt: one<{ at: string | number | null }>(`SELECT MAX(lastPolledAt) AS at FROM Space`)?.at?.toString() ?? null,
    };
  } catch {
    return { ...none, exists: true };
  } finally {
    db?.close();
  }
}
