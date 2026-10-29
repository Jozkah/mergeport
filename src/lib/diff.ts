import { highlightLines, langForPath, type Tok } from "@/lib/highlight";

/**
 * GitHub's per-file `patch` (a unified diff without the file header) turned into rows a viewer can draw: old and new line
 * numbers, one highlighted token list per line, hunk headers with the section name, and "no newline at end of file" marks.
 */

export type DiffLine = { t: "ctx" | "add" | "del"; o: number | null; n: number | null; tok: Tok[]; nonl?: boolean };
export type Hunk = { header: string; section: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };
export type DiffFile = {
  filename: string;
  previous: string | null;
  status: string;
  additions: number;
  deletions: number;
  lang: string | null;
  /** "ok": hunks present. "nopatch": GitHub sent no patch (binary, too large, or a pure rename/mode change). */
  state: "ok" | "nopatch";
  hunks: Hunk[];
  palette: string[];
  /** Heavy files start collapsed, like GitHub's "Load diff". */
  heavy: boolean;
};

type RawLine = { t: "ctx" | "add" | "del"; text: string; nonl?: boolean };
type RawHunk = { header: string; section: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: RawLine[] };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let cur: RawHunk | null = null;
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    const m = HUNK.exec(line);
    if (m) {
      cur = { header: line, section: m[5] ?? "", oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\\")) {
      const last = cur.lines[cur.lines.length - 1];
      if (last) last.nonl = true;
      continue;
    }
    const c = line[0];
    if (c === "+") cur.lines.push({ t: "add", text: line.slice(1) });
    else if (c === "-") cur.lines.push({ t: "del", text: line.slice(1) });
    else if (c === " " || line === "") {
      // A trailing empty string from the final newline is not a line; a context line that lost its space is.
      if (line === "" && cur.lines.length >= cur.oldLines && cur.lines.length >= cur.newLines) continue;
      cur.lines.push({ t: "ctx", text: line.slice(1) });
    }
  }
  return hunks;
}

const HEAVY_LINES = 1200;
const MAX_LINES = 6000;

type FileIn = { filename: string; status: string; additions: number; deletions: number; patch: string | null; previousFilename?: string | null };

export function buildDiffFile(f: FileIn): DiffFile {
  const lang = langForPath(f.filename);
  const base = { filename: f.filename, previous: f.previousFilename ?? null, status: f.status, additions: f.additions, deletions: f.deletions, lang, palette: [] as string[] };
  if (!f.patch) return { ...base, state: "nopatch", hunks: [], heavy: false };
  const raw = parsePatch(f.patch);
  const total = raw.reduce((n, h) => n + h.lines.length, 0);
  if (total > MAX_LINES) return { ...base, state: "nopatch", hunks: [], heavy: false };

  // Highlight the old side (context + removed) and the new side (context + added) as two documents, so a token that spans lines
  // is coloured the way it would be in the real file.
  const oldText: string[] = [];
  const newText: string[] = [];
  for (const h of raw) {
    for (const l of h.lines) {
      if (l.t !== "add") oldText.push(l.text);
      if (l.t !== "del") newText.push(l.text);
    }
    oldText.push("");
    newText.push("");
  }
  const hOld = highlightLines(oldText.join("\n"), lang);
  const hNew = highlightLines(newText.join("\n"), lang);
  // Two palettes merge into one so the viewer ships a single list.
  const palette = [...hNew.palette];
  const remap = new Map<number, number>();
  hOld.palette.forEach((c, i) => {
    const at = palette.indexOf(c);
    remap.set(i, at >= 0 ? at : palette.push(c) - 1);
  });
  const fromOld = (toks: Tok[]): Tok[] => toks.map(([s, i]) => [s, i < 0 ? -1 : (remap.get(i) ?? -1)]);

  let oi = 0;
  let ni = 0;
  const hunks: Hunk[] = raw.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    const lines: DiffLine[] = h.lines.map((l) => {
      if (l.t === "ctx") {
        const line: DiffLine = { t: "ctx", o: o++, n: n++, tok: hNew.lines[ni] ?? [[l.text, -1]], nonl: l.nonl };
        oi++;
        ni++;
        return line;
      }
      if (l.t === "del") return { t: "del", o: o++, n: null, tok: fromOld(hOld.lines[oi++] ?? [[l.text, -1]]), nonl: l.nonl };
      return { t: "add", o: null, n: n++, tok: hNew.lines[ni++] ?? [[l.text, -1]], nonl: l.nonl };
    });
    oi++; // the separator line between hunks
    ni++;
    return { header: h.header, section: h.section, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
  });
  return { ...base, state: "ok", hunks, palette, heavy: total > HEAVY_LINES };
}

/** What GitHub calls a "split" row: the old line on the left, the new on the right; a run of removals pairs with the additions after it. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.t === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].t === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") adds.push(lines[i++]);
    const k = Math.max(dels.length, adds.length);
    for (let x = 0; x < k; x++) rows.push({ left: dels[x] ?? null, right: adds[x] ?? null });
  }
  return rows;
}
