"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlobView, InlineComment } from "@/lib/services/git-view";
import type { DiffFile, DiffLine } from "@/lib/diff";
import { toSplitRows } from "@/lib/diff";
import { inlineCommentAction } from "@/app/actions";
import { Avatar } from "@/components/ui/Avatar";
import { Tokens } from "@/components/code/Code";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Plus } from "@/components/ui/icons";

export type FilesData = { headSha: string | null; files: DiffFile[]; truncated: boolean; inline?: Record<string, InlineComment[]>; canComment?: boolean };

const EXPAND_STEP = 20;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or blocked storage: the choice just is not remembered
  }
}

const sig = (f: DiffFile) => `${f.additions}-${f.deletions}-${f.hunks.length}`;
const fileId = (i: number) => `df-${i}`;

/**
 * A pull request's (or one commit's) changed files, drawn like GitHub's Files tab: a file tree, unified or split view, line
 * numbers on both sides, expandable context between hunks, inline review comments, and a per-file "Viewed" mark that is
 * remembered and resets by itself when the file changes again.
 */
export function DiffViewer({ itemId, data, storeKey, repoId, githubFilesUrl, onPosted }: { itemId: string; data: FilesData; storeKey: string; repoId: string; githubFilesUrl: string; onPosted?: () => void }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Read once after mount: storage does not exist on the server, so the first render must not depend on it.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMode(load<"unified" | "split">("mp.diff.mode", "unified"));
    setWrap(load("mp.diff.wrap", true));
    setViewed(load<Record<string, string>>(`mp.viewed.${storeKey}`, {}));
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [storeKey]);

  const files = data.files;
  const totals = useMemo(() => ({ add: files.reduce((n, f) => n + f.additions, 0), del: files.reduce((n, f) => n + f.deletions, 0) }), [files]);
  const isViewed = (f: DiffFile) => viewed[f.filename] === sig(f);
  const viewedCount = files.filter(isViewed).length;
  const isCollapsed = (f: DiffFile) => collapsed[f.filename] ?? (f.heavy || isViewed(f));

  const setViewedFor = (f: DiffFile, on: boolean) => {
    const next = { ...viewed };
    if (on) next[f.filename] = sig(f);
    else delete next[f.filename];
    setViewed(next);
    save(`mp.viewed.${storeKey}`, next);
    setCollapsed((c) => ({ ...c, [f.filename]: on }));
  };
  const changeMode = (m: "unified" | "split") => {
    setMode(m);
    save("mp.diff.mode", m);
  };
  const changeWrap = (w: boolean) => {
    setWrap(w);
    save("mp.diff.wrap", w);
  };
  const jump = (i: number) => {
    const f = files[i];
    setCollapsed((c) => (c[f.filename] === false ? c : { ...c, [f.filename]: false }));
    requestAnimationFrame(() => document.getElementById(fileId(i))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  if (files.length === 0) return <p className="p-6 text-[13px] text-ink-3">No changed files are available for this pull request.</p>;

  const tree = <FileTree files={files} isViewed={isViewed} onJump={jump} />;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span className="text-ink-2">
          {files.length} changed file{files.length === 1 ? "" : "s"} <span className="tnum text-ok">+{totals.add}</span> <span className="tnum text-blocked">−{totals.del}</span>
        </span>
        <span className="tnum text-ink-3">{viewedCount} / {files.length} viewed</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={() => setCollapsed(Object.fromEntries(files.map((f) => [f.filename, true])))}>Collapse all</button>
          <button type="button" className="btn" onClick={() => setCollapsed(Object.fromEntries(files.map((f) => [f.filename, false])))}>Expand all</button>
          <label className="inline-flex items-center gap-1.5 text-ink-2"><input type="checkbox" checked={wrap} onChange={(e) => changeWrap(e.target.checked)} /> Wrap lines</label>
          <span className="inline-flex overflow-hidden rounded-[8px] border border-line" role="group" aria-label="Diff layout">
            {(["unified", "split"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => changeMode(m)} className={`h-8 px-3 text-[13px] ${mode === m ? "bg-ink text-ink-invert" : "bg-surface hover:bg-hover"}`}>{m === "unified" ? "Unified" : "Split"}</button>
            ))}
          </span>
        </span>
      </div>
      {data.truncated && <p className="rounded-[8px] border border-line bg-surface p-3 text-[12.5px] text-ink-2">GitHub lists only the first 100 files of a pull request here. <a className="link" href={githubFilesUrl} target="_blank" rel="noopener noreferrer">Open the full diff on GitHub</a>.</p>}

      <details className="rounded-[8px] border border-line bg-surface p-2 lg:hidden"><summary className="cursor-pointer px-1 text-[13px] font-medium">Files ({files.length})</summary><div className="mt-2 max-h-72 overflow-auto">{tree}</div></details>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <nav aria-label="Changed files" className="sticky top-3 hidden max-h-[calc(100vh-24px)] self-start overflow-auto rounded-[8px] border border-line bg-surface p-2 lg:block">{tree}</nav>
        <div className="flex min-w-0 flex-col gap-4">
          {files.map((f, i) => (
            <LazyFile key={f.filename + i} id={fileId(i)} lines={f.hunks.reduce((n, h) => n + h.lines.length, 0)}>
              <FileDiff
                file={f}
                itemId={itemId}
                repoId={repoId}
                headSha={data.headSha}
                githubFilesUrl={githubFilesUrl}
                mode={mode}
                wrap={wrap}
                collapsed={ready ? isCollapsed(f) : f.heavy}
                onToggle={() => setCollapsed((c) => ({ ...c, [f.filename]: !isCollapsed(f) }))}
                viewed={isViewed(f)}
                onViewed={(on) => setViewedFor(f, on)}
                comments={data.inline?.[f.filename] ?? []}
                canComment={!!data.canComment && !!data.headSha}
                onPosted={onPosted}
              />
            </LazyFile>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Draws a file only once it is near the screen; a 3,000-line diff far below costs nothing until the reader gets there. */
function LazyFile({ id, lines, children }: { id: string; lines: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "1500px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return (
    <div id={id} ref={ref} className="scroll-mt-4" style={near ? undefined : { minHeight: Math.min(2400, 44 + lines * 20) }}>
      {near ? children : null}
    </div>
  );
}

// ---------- tree ----------

type TNode = { name: string; path: string; children: TNode[]; index?: number };

function buildTree(files: DiffFile[]): TNode[] {
  const root: TNode = { name: "", path: "", children: [] };
  files.forEach((f, idx) => {
    let node = root;
    const parts = f.filename.split("/");
    parts.forEach((part, k) => {
      const last = k === parts.length - 1;
      let child = node.children.find((c) => c.name === part && (c.index !== undefined) === last);
      if (!child) {
        child = { name: part, path: parts.slice(0, k + 1).join("/"), children: [], ...(last ? { index: idx } : {}) };
        node.children.push(child);
      }
      node = child;
    });
  });
  const tidy = (n: TNode): TNode => {
    n.children = n.children.map(tidy);
    n.children.sort((a, b) => Number(a.index !== undefined) - Number(b.index !== undefined) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    // a folder that holds only one folder is shown as one row, like GitHub ("src/components")
    while (n.index === undefined && n.children.length === 1 && n.children[0].index === undefined && n.name) {
      const only = n.children[0];
      n = { name: `${n.name}/${only.name}`, path: only.path, children: only.children };
    }
    return n;
  };
  return root.children.map(tidy);
}

function FileTree({ files, isViewed, onJump }: { files: DiffFile[]; isViewed: (f: DiffFile) => boolean; onJump: (i: number) => void }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const nodes = useMemo(() => buildTree(files), [files]);
  const needle = q.trim().toLowerCase();
  const show = (n: TNode): boolean => (n.index !== undefined ? files[n.index].filename.toLowerCase().includes(needle) : n.children.some(show));
  const row = (n: TNode, depth: number): React.ReactNode => {
    if (needle && !show(n)) return null;
    if (n.index !== undefined) {
      const f = files[n.index];
      const tone = f.status === "added" ? "text-ok" : f.status === "removed" ? "text-blocked" : f.status === "renamed" ? "text-waiting" : "text-changes";
      const mark = f.status === "added" ? "+" : f.status === "removed" ? "−" : f.status === "renamed" ? "→" : "●";
      return (
        <li key={n.path}>
          <button type="button" className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onJump(n.index!)} title={f.filename}>
            <span aria-hidden className={`w-3 shrink-0 text-center text-[11px] ${tone}`}>{mark}</span>
            <span className={`min-w-0 flex-1 truncate ${isViewed(f) ? "text-ink-3" : ""}`}>{n.name}</span>
            {isViewed(f) && <Check size={13} aria-label="Viewed" className="shrink-0 text-ok" />}
          </button>
        </li>
      );
    }
    const open = needle ? true : !closed[n.path];
    return (
      <li key={n.path}>
        <button type="button" className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [n.path]: open }))}>
          {open ? <ChevronDown size={13} aria-hidden className="shrink-0 text-ink-3" /> : <ChevronRight size={13} aria-hidden className="shrink-0 text-ink-3" />}
          <span className="min-w-0 flex-1 truncate text-ink-2">{n.name}</span>
        </button>
        {open && <ul>{n.children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} className="input mb-2 !h-8" placeholder="Filter files" aria-label="Filter changed files" />
      <ul>{nodes.map((n) => row(n, 0))}</ul>
    </div>
  );
}

// ---------- one file ----------

type Gap = { top: number; bottom: number };
type Seg = { kind: "lines"; lines: DiffLine[]; key: string } | { kind: "gap"; g: number; hidden: number; header: string; up: boolean; down: boolean; key: string };

function FileDiff({ file, itemId, repoId, headSha, githubFilesUrl, mode, wrap, collapsed, onToggle, viewed, onViewed, comments, canComment, onPosted }: {
  file: DiffFile; itemId: string; repoId: string; headSha: string | null; githubFilesUrl: string; mode: "unified" | "split"; wrap: boolean; collapsed: boolean; onToggle: () => void; viewed: boolean; onViewed: (on: boolean) => void; comments: InlineComment[]; canComment: boolean; onPosted?: () => void;
}) {
  const [blob, setBlob] = useState<BlobView | null>(null);
  const [blobState, setBlobState] = useState<"idle" | "loading" | "error">("idle");
  const [reveal, setReveal] = useState<Record<number, Gap>>({});
  const [composer, setComposer] = useState<{ side: "LEFT" | "RIGHT"; line: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const canExpand = file.state === "ok" && file.status !== "added" && file.status !== "removed" && !!headSha;

  const ensureBlob = useCallback(async () => {
    if (blob || blobState === "loading") return blob;
    setBlobState("loading");
    try {
      const r = await fetch(`/api/pr/${itemId}/blob?path=${encodeURIComponent(file.filename)}`);
      if (!r.ok) throw new Error("blob");
      const b = (await r.json()) as BlobView;
      setBlob(b);
      setBlobState("idle");
      return b;
    } catch {
      setBlobState("error");
      return null;
    }
  }, [blob, blobState, itemId, file.filename]);

  const bump = async (g: number, dir: "top" | "bottom" | "all") => {
    const b = await ensureBlob();
    if (!b) return;
    setReveal((r) => {
      const cur = r[g] ?? { top: 0, bottom: 0 };
      return { ...r, [g]: dir === "all" ? { top: 100_000, bottom: 0 } : { ...cur, [dir]: cur[dir] + EXPAND_STEP } };
    });
  };

  const palette = useMemo(() => [...file.palette], [file.palette]);
  // Revealed context uses the file's own tokens; their palette is appended so both share one index space.
  const merged = useMemo(() => {
    const all = [...palette];
    const map = new Map<number, number>();
    (blob?.palette ?? []).forEach((c, i) => map.set(i, all.indexOf(c) >= 0 ? all.indexOf(c) : all.push(c) - 1));
    return { all, map };
  }, [palette, blob]);

  const segs = useMemo<Seg[]>(() => {
    const out: Seg[] = [];
    const hunks = file.hunks;
    const total = blob ? blob.lines.length : null;
    for (let g = 0; g <= hunks.length; g++) {
      const prev = hunks[g - 1];
      const next = hunks[g];
      const start = prev ? prev.newStart + prev.newLines : 1;
      const end = next ? next.newStart - 1 : (total ?? start - 1);
      const offset = prev ? prev.oldStart + prev.oldLines - (prev.newStart + prev.newLines) : 0;
      const size = Math.max(0, end - start + 1);
      const r = reveal[g] ?? { top: 0, bottom: 0 };
      const top = Math.min(size, r.top);
      const bottom = Math.min(size - top, r.bottom);
      const ctx = (from: number, to: number): DiffLine[] => {
        const rows: DiffLine[] = [];
        for (let n = from; n <= to; n++) {
          const toks = blob?.lines[n - 1] ?? [["", -1] as [string, number]];
          rows.push({ t: "ctx", o: n + offset, n, tok: toks.map(([s, i]) => [s, i < 0 ? -1 : (merged.map.get(i) ?? -1)] as [string, number]) });
        }
        return rows;
      };
      if (top > 0) out.push({ kind: "lines", lines: ctx(start, start + top - 1), key: `g${g}t` });
      const hidden = size - top - bottom;
      if (next && hidden > 0) out.push({ kind: "gap", g, hidden, header: next.header, up: canExpand, down: g > 0 && canExpand, key: `g${g}` });
      // After the last hunk the file's length is unknown until it has been loaded once.
      if (!next && canExpand && (!blob || hidden > 0)) out.push({ kind: "gap", g, hidden: blob ? hidden : -1, header: "", up: false, down: true, key: `g${g}` });
      if (bottom > 0) out.push({ kind: "lines", lines: ctx(end - bottom + 1, end), key: `g${g}b` });
      if (next) out.push({ kind: "lines", lines: next.lines, key: `h${g}` });
    }
    return out;
  }, [file.hunks, reveal, blob, merged, canExpand]);

  const byLine = useMemo(() => {
    const m = new Map<number, InlineComment[]>();
    for (const c of comments) m.set(c.line, [...(m.get(c.line) ?? []), c]);
    return m;
  }, [comments]);
  const shown = useMemo(() => {
    const s = new Set<number>();
    for (const sg of segs) if (sg.kind === "lines") for (const l of sg.lines) if (l.n !== null && l.t !== "del") s.add(l.n);
    return s;
  }, [segs]);
  const orphans = comments.filter((c) => !shown.has(c.line));

  const label = file.previous && file.previous !== file.filename ? `${file.previous} → ${file.filename}` : file.filename;
  const sum = file.additions + file.deletions;
  const blocks = sum === 0 ? [] : Array.from({ length: 5 }, (_, k) => (k < Math.round((file.additions / sum) * 5) ? "a" : k < 5 && file.deletions > 0 ? "d" : "n"));
  const viewUrl = `/repositories/${repoId}/code/${file.filename.split("/").map(encodeURIComponent).join("/")}${headSha ? `?ref=${headSha}` : ""}`;

  const colgroup = mode === "unified" ? (
    <colgroup><col style={{ width: 50 }} /><col style={{ width: 50 }} /><col /></colgroup>
  ) : (
    <colgroup><col style={{ width: 50 }} /><col /><col style={{ width: 50 }} /><col /></colgroup>
  );

  const composerRow = (side: "LEFT" | "RIGHT", line: number, span: number) => (
    <tr key={`c-${side}-${line}`}><td colSpan={span} style={{ padding: 0 }}>
      <Composer itemId={itemId} path={file.filename} side={side} line={line} onClose={() => setComposer(null)} onPosted={() => { setComposer(null); onPosted?.(); }} />
    </td></tr>
  );
  const threadRow = (n: number, span: number) => {
    const list = byLine.get(n);
    return list ? (
      <tr key={`t-${n}`}><td colSpan={span} style={{ padding: 0 }}><Thread comments={list} /></td></tr>
    ) : null;
  };

  const unifiedLine = (l: DiffLine, k: string) => {
    const n = l.t === "del" ? l.o! : l.n!;
    const side: "LEFT" | "RIGHT" = l.t === "del" ? "LEFT" : "RIGHT";
    return [
      <tr key={k} className={l.t}>
        <td className="no">{canComment && <button type="button" className="cbtn" aria-label={`Comment on line ${n}`} onClick={() => setComposer({ side, line: n })}><Plus size={12} aria-hidden /></button>}{l.o ?? ""}</td>
        <td className="no">{l.n ?? ""}</td>
        <td className="tx"><span className="mk">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span><span className="hl"><Tokens tok={l.tok} palette={merged.all} /></span>{l.nonl && <span className="ml-2 text-ink-3">⏎ no newline at end of file</span>}</td>
      </tr>,
      l.t !== "del" && l.n !== null ? threadRow(l.n, 3) : null,
      composer && composer.side === side && composer.line === n && (l.t === "del") === (side === "LEFT") ? composerRow(side, n, 3) : null,
    ];
  };

  const splitCell = (l: DiffLine | null, side: "L" | "R") => {
    const sep = side === "R" ? " split-sep" : "";
    if (!l) return [<td key={`${side}n`} className={`no empty${sep}`} />, <td key={`${side}t`} className="tx empty" />];
    const cls = l.t === "add" ? "c-add" : l.t === "del" ? "c-del" : "";
    const num = side === "L" ? l.o : l.n;
    return [
      <td key={`${side}n`} className={`no ${cls}${sep}`}>{canComment && num !== null && <button type="button" className="cbtn" aria-label="Add a comment" onClick={() => setComposer({ side: side === "L" ? "LEFT" : "RIGHT", line: num })}><Plus size={12} aria-hidden /></button>}{num ?? ""}</td>,
      <td key={`${side}t`} className={`tx ${cls}`}><span className="mk">{l.t === "add" ? "+" : l.t === "del" ? "\u2212" : ""}</span><span className="hl"><Tokens tok={l.tok} palette={merged.all} /></span></td>,
    ];
  };

  return (
    <section className={`diff-file ${collapsed ? "is-collapsed" : ""}`} aria-label={file.filename}>
      <div className="diff-file-head">
        <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.filename}`} onClick={onToggle}>{collapsed ? <ChevronRight size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}</button>
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={label}>{label}</span>
        <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7" aria-label="Copy file path" onClick={() => navigator.clipboard?.writeText(file.filename).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}</button>
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[12.5px]">
          <span className="tnum"><span className="text-ok">+{file.additions}</span> <span className="text-blocked">−{file.deletions}</span></span>
          <span className="diffstat" aria-hidden>{blocks.map((b, k) => <i key={k} className={b === "n" ? "" : b} />)}</span>
          {file.status !== "removed" && <Link className="link inline-flex items-center gap-1" href={viewUrl} prefetch={false}>View file</Link>}
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-line bg-surface px-2 py-1"><input type="checkbox" checked={viewed} onChange={(e) => onViewed(e.target.checked)} /> Viewed</label>
        </span>
      </div>
      {!collapsed && (
        file.state === "nopatch" ? (
          <p className="p-4 text-[13px] text-ink-3">{file.status === "renamed" && file.additions + file.deletions === 0 ? "The file was renamed without changes." : "No text diff is available: the file is binary, empty, or too large. "}<a className="link inline-flex items-center gap-1" href={githubFilesUrl} target="_blank" rel="noopener noreferrer">Open on GitHub <ExternalLink size={12} aria-hidden /></a></p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`diff ${wrap ? "" : "nowrap"}`}>
              {colgroup}
              <tbody>
                {segs.map((sg) => {
                  if (sg.kind === "gap") {
                    const span = mode === "unified" ? 3 : 4;
                    return (
                      <tr key={sg.key} className="hunk">
                        <td className="no" colSpan={mode === "unified" ? 2 : 1}>
                          {sg.down && <button type="button" aria-label="Show lines below" title="Show 20 more lines below the previous change" onClick={() => bump(sg.g, "top")}><ChevronDown size={14} aria-hidden /></button>}
                          {sg.up && sg.header && <button type="button" aria-label="Show lines above" title="Show 20 more lines above the next change" onClick={() => bump(sg.g, "bottom")}><ChevronDown size={14} aria-hidden className="rotate-180" /></button>}
                        </td>
                        <td className="tx" colSpan={span - (mode === "unified" ? 2 : 1)}>
                          {sg.hidden > 0 ? <button type="button" className="mr-3 !inline !w-auto !h-auto underline-offset-2 hover:underline" style={{ display: "inline" }} onClick={() => bump(sg.g, "all")}>Show {sg.hidden} hidden line{sg.hidden === 1 ? "" : "s"}</button> : sg.hidden < 0 ? <button type="button" className="mr-3 !inline !w-auto !h-auto hover:underline" style={{ display: "inline" }} onClick={() => bump(sg.g, "top")}>Show more lines</button> : null}
                          {sg.header}
                          {blobState === "loading" && <span className="ml-3">Loading…</span>}
                          {blobState === "error" && <span className="ml-3">Could not load the file.</span>}
                        </td>
                      </tr>
                    );
                  }
                  if (mode === "unified") return sg.lines.flatMap((l, k) => unifiedLine(l, `${sg.key}-${k}`));
                  return toSplitRows(sg.lines).flatMap((r, k) => {
                    const rowKey = `${sg.key}-${k}`;
                    const rn = r.right && r.right.t !== "del" ? r.right.n : null;
                    const lc = r.left?.t === "del" && composer?.side === "LEFT" && composer.line === r.left.o;
                    const rc = r.right && composer?.side === "RIGHT" && composer.line === r.right.n && r.right.t !== "del";
                    return [
                      <tr key={rowKey} className="ln">
                        {splitCell(r.left, "L")}
                        {splitCell(r.right, "R")}
                      </tr>,
                      rn !== null ? threadRow(rn, 4) : null,
                      lc ? composerRow("LEFT", r.left!.o!, 4) : null,
                      rc ? composerRow("RIGHT", r.right!.n!, 4) : null,
                    ];
                  });
                })}
              </tbody>
            </table>
            {orphans.length > 0 && (
              <div className="border-t border-line p-3">
                <p className="mb-1 px-1 text-[12px] text-ink-3">Comments on lines that are not shown here</p>
                <Thread comments={orphans} flat />
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}

function Thread({ comments, flat }: { comments: InlineComment[]; flat?: boolean }) {
  return (
    <div className={flat ? "" : "cthread"}>
      {comments.map((c) => (
        <div key={c.id} className="border-b border-line p-3 last:border-b-0">
          <p className="mb-1 flex items-center gap-2 text-[12.5px] text-ink-3"><Avatar login={c.author ?? "?"} size={18} /><strong className="font-medium text-ink">{c.author ?? "unknown"}</strong><span>commented {new Date(c.createdAt).toLocaleString()}</span></p>
          <div className="md" dangerouslySetInnerHTML={{ __html: c.html }} />
        </div>
      ))}
    </div>
  );
}

function Composer({ itemId, path, side, line, onClose, onPosted }: { itemId: string; path: string; side: "LEFT" | "RIGHT"; line: number; onClose: () => void; onPosted: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await inlineCommentAction({ id: itemId, path, line, side, body });
    setBusy(false);
    if (r.ok) onPosted();
    else setErr(r.error);
  };
  return (
    <div className="cthread">
      <div className="p-3">
        <label className="label" htmlFor={`ic-${path}-${side}-${line}`}>Comment on line {line} of {path}</label>
        <textarea id={`ic-${path}-${side}-${line}`} className="textarea min-h-20" autoFocus value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }} />
        {err && <p className="mt-2 text-[12.5px] text-blocked" role="alert">{err}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="mr-auto text-[12px] text-ink-3">Posted to GitHub as you. Ctrl+Enter sends.</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!body.trim() || busy} onClick={submit}>{busy ? "Posting…" : "Comment"}</button>
        </div>
      </div>
    </div>
  );
}
