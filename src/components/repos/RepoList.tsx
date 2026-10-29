"use client";

import * as D from "@radix-ui/react-dialog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { refreshRepositoryAction, untrackRepositoryAction } from "@/app/actions";
import { shareRepositoryAction, unshareRepositoryAction } from "@/app/team-actions";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { Avatar } from "@/components/ui/Avatar";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { Building2, GitFork, Globe, Lock, Search, Unplug, User, Users, X } from "@/components/ui/icons";
import { ctx } from "@/lib/ctx";

export type RepoRow = {
  id: string;
  name: string;
  fullName: string;
  ownerLogin: string;
  ownerAvatar: string | null;
  ownerType: "USER" | "ORGANIZATION" | "UNKNOWN";
  visibility: string;
  access: { label: string; detail: string };
  archived: boolean;
  demo: boolean;
  fork: { of: string | null } | null;
  openItems: number | null;
  status: "ok" | "disconnected" | "rate" | "failed";
  statusDetail: string | null;
  synced: string;
  spaceId: string | null;
  spaceName: string | null;
  canUnshare: boolean;
  projects: string[];
};
export type SpaceOpt = { id: string; name: string; everyone: boolean };

type Filter = "all" | "problems" | "private" | "forks" | "archived" | "shared";
const PAGE = 30;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/**
 * One calm line per repository: who it belongs to, whether it is healthy, who it is shared with, and one button. Everything else
 * (refresh, share, stop tracking, open on GitHub) is in the row's menu, and the choices that matter get a short confirmation.
 */
export function RepoList({ rows, writable }: { rows: RepoRow[]; writable: SpaceOpt[] }) {
  const router = useRouter();
  const { show } = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: "share" | "untrack"; ids: string[] } | null>(null);
  const [, start] = useTransition();

  const counts = useMemo(
    () => ({
      all: rows.length,
      problems: rows.filter((r) => r.status !== "ok").length,
      private: rows.filter((r) => r.visibility !== "PUBLIC").length,
      forks: rows.filter((r) => r.fork).length,
      archived: rows.filter((r) => r.archived).length,
      shared: rows.filter((r) => r.spaceId).length,
    }),
    [rows],
  );
  const match = (r: RepoRow) => (filter === "all" ? true : filter === "problems" ? r.status !== "ok" : filter === "private" ? r.visibility !== "PUBLIC" : filter === "forks" ? !!r.fork : filter === "archived" ? r.archived : !!r.spaceId);
  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => match(r) && (!needle || `${r.fullName} ${r.projects.join(" ")} ${r.spaceName ?? ""}`.toLowerCase().includes(needle)));
  const shown = visible.slice(0, limit);
  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

  const run = (label: string, jobs: Promise<{ ok: boolean; error?: string }>[]) =>
    start(async () => {
      const res = await Promise.all(jobs);
      const bad = res.find((r) => !r.ok);
      if (bad) show("error", bad.error ?? "That did not work.");
      else show("ok", label);
      setPicked(new Set());
      router.refresh();
    });
  const refresh = (ids: string[]) => run(ids.length === 1 ? "Refresh queued." : `Refresh queued for ${ids.length} repositories.`, ids.map((id) => refreshRepositoryAction(fd({ repositoryId: id })) as Promise<{ ok: boolean; error?: string }>));

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "problems", label: "Needs attention" },
    { key: "private", label: "Private" },
    { key: "forks", label: "Forks" },
    { key: "shared", label: "Shared" },
    { key: "archived", label: "Archived" },
  ];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter repositories" className="flex flex-wrap gap-1">
          {chips.filter((c) => c.key === "all" || counts[c.key] > 0).map((c) => (
            <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => { setFilter(c.key); setLimit(PAGE); }} className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] ${filter === c.key ? "border-ink bg-ink text-ink-invert" : "border-line bg-surface text-ink-2 hover:bg-hover"}`}>
              {c.label}<span className={`tnum ${filter === c.key ? "opacity-80" : "text-ink-3"}`}>{counts[c.key]}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto">
          <span className="sr-only">Search repositories</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} className="input !h-8 !w-60 !pl-8" placeholder="Search repositories" />
        </label>
      </div>

      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-canvas px-3 py-2 text-[12.5px]" role="region" aria-label="Selected repositories">
          <strong className="font-medium">{picked.size} selected</strong>
          <button type="button" className="btn !h-7 !px-2.5 !text-[12.5px]" onClick={() => refresh([...picked])}>Refresh</button>
          <button type="button" className="btn btn-danger !h-7 !px-2.5 !text-[12.5px]" onClick={() => setDialog({ kind: "untrack", ids: [...picked] })}>Stop tracking</button>
          <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="rounded-[8px] border border-dashed border-line p-8 text-center text-[13px] text-ink-3">No repositories match.</p>
      ) : (
        <ul className="overflow-hidden rounded-[10px] border border-line bg-surface">
          <li className="flex items-center gap-3 border-b border-line bg-faint px-3 py-1.5 text-[12px] text-ink-3">
            <input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
            <span className="min-w-0 flex-1">Repository</span>
            <span className="hidden w-44 md:block">Status</span>
            <span className="hidden w-48 lg:block">Shared with</span>
            <span className="hidden w-40 xl:block">Projects</span>
            <span className="w-[8.5rem] text-right"><span className="sr-only">Actions</span></span>
          </li>
          {shown.map((r) => (
            <li key={r.id} data-ctx={ctx([{ label: "Browse code", href: `/repositories/${r.id}/code` }, { label: "Open on GitHub", href: `https://github.com/${r.fullName}`, external: true }, "sep", { label: "Copy repository name", copy: r.fullName }, { label: "Copy clone URL", copy: `https://github.com/${r.fullName}.git` }])} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-hover/50">
              <input type="checkbox" aria-label={`Select ${r.fullName}`} checked={picked.has(r.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar login={r.ownerLogin} url={r.ownerAvatar} size={28} />
                <div className="min-w-0">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Link href={`/repositories/${r.id}/code`} className="truncate text-[14px] font-medium text-ink hover:underline">{r.name}</Link>
                    <span title={r.visibility === "PUBLIC" ? "Public" : "Private"} className="inline-flex shrink-0 items-center text-ink-3">{r.visibility === "PUBLIC" ? <Globe size={12} aria-label="Public" /> : <Lock size={12} aria-label="Private" />}</span>
                    {r.archived && <span className="pill pill-unknown">Archived</span>}
                    {r.demo && <span className="pill pill-needs">Demo</span>}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
                    <span className="inline-flex items-center gap-1" title={r.ownerType === "ORGANIZATION" ? "Organization account" : r.ownerType === "USER" ? "Personal account" : "Account type unknown"}>{r.ownerType === "ORGANIZATION" ? <Building2 size={11} aria-hidden /> : <User size={11} aria-hidden />}{r.ownerLogin}</span>
                    {r.fork && <span className="inline-flex items-center gap-1"><GitFork size={11} aria-hidden />fork{r.fork.of ? ` of ${r.fork.of}` : ""}</span>}
                    {!/unknown/i.test(r.access.label) && <span title={r.access.detail}>{r.access.label}</span>}
                    <span>{r.openItems === null ? "not synced yet" : `${r.openItems} open`}</span>
                  </p>
                </div>
              </div>
              <div className="hidden w-44 shrink-0 md:block">
                {r.status === "disconnected" ? <span className="pill pill-blocked"><Unplug size={12} aria-hidden /> Disconnected</span> : r.status === "rate" ? <span className="pill pill-waiting">Rate limited</span> : r.status === "failed" ? <span className="pill pill-changes" title={r.statusDetail ?? undefined}>Sync failed</span> : <span className="pill pill-ok">Active</span>}
                <p className="mt-0.5 text-[11.5px] text-ink-3">{r.synced}</p>
              </div>
              <div className="hidden w-48 shrink-0 text-[12.5px] lg:block">
                {r.spaceId ? <span className="inline-flex items-center gap-1.5 text-ink-2"><Users size={13} aria-hidden className="text-ink-3" /><span className="truncate">{r.spaceName ?? "a team space"}</span></span> : <span className="text-ink-3">Only on this computer</span>}
              </div>
              <div className="hidden w-40 shrink-0 text-[12.5px] xl:block">
                {r.projects.length === 0 ? <span className="text-ink-3">No project</span> : <span className="flex flex-wrap gap-1">{r.projects.slice(0, 2).map((p) => <span key={p} className="rounded-full border border-line px-2 py-0.5 text-[11.5px]">{p}</span>)}{r.projects.length > 2 && <span className="text-ink-3">+{r.projects.length - 2}</span>}</span>}
              </div>
              <div className="flex w-[8.5rem] shrink-0 items-center justify-end gap-1">
                <Link href={`/repositories/${r.id}/code`} className="btn !h-8" aria-label={`Browse code of ${r.fullName}`}>Browse</Link>
                <ActionMenu
                  label={`More actions for ${r.fullName}`}
                  items={[
                    { label: "Refresh now", onSelect: () => refresh([r.id]) },
                    { label: "Open on GitHub", href: `https://github.com/${r.fullName}`, external: true },
                    "sep",
                    r.spaceId ? { label: "Stop sharing", disabled: !r.canUnshare, onSelect: () => run("No longer shared.", [unshareRepositoryAction(fd({ repositoryId: r.id })) as Promise<{ ok: boolean; error?: string }>]) } : { label: "Share with my team…", disabled: writable.length === 0, onSelect: () => setDialog({ kind: "share", ids: [r.id] }) },
                    "sep",
                    { label: "Stop tracking…", danger: true, onSelect: () => setDialog({ kind: "untrack", ids: [r.id] }) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {visible.length > shown.length && <button type="button" className="btn self-start" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, visible.length - shown.length)} more <span className="text-ink-3">of {visible.length - shown.length} left</span></button>}

      <Dialog open={dialog?.kind === "untrack"} onClose={() => setDialog(null)} title={dialog && dialog.ids.length > 1 ? `Stop tracking ${dialog.ids.length} repositories?` : "Stop tracking this repository?"} description="It disappears from this app on this computer. Nothing is deleted or changed on GitHub, and you can connect it again later.">
        <button type="button" className="btn btn-danger" onClick={() => { const ids = dialog!.ids; setDialog(null); run(ids.length === 1 ? "Removed from tracking." : `${ids.length} repositories removed from tracking.`, ids.map((id) => untrackRepositoryAction(fd({ repositoryId: id })) as Promise<{ ok: boolean; error?: string }>)); }}>Stop tracking</button>
      </Dialog>
      <ShareDialog open={dialog?.kind === "share"} id={dialog?.ids[0]} name={rows.find((r) => r.id === dialog?.ids[0])?.fullName ?? ""} spaces={writable} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); show("ok", msg); router.refresh(); }} onError={(m) => show("error", m)} />
    </div>
  );
}

function Dialog({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description: string; children: React.ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
        <D.Content className="sheet fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-line bg-surface p-5 shadow-pop">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-[16px] font-medium">{title}</D.Title>
              <D.Description className="mt-1 text-[13px] text-ink-3">{description}</D.Description>
            </div>
            <D.Close className="btn btn-quiet btn-icon -mr-1.5" aria-label="Close"><X size={16} aria-hidden /></D.Close>
          </div>
          <div className="flex justify-end gap-2">
            <D.Close className="btn">Cancel</D.Close>
            {children}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function ShareDialog({ open, id, name, spaces, onClose, onDone, onError }: { open: boolean; id?: string; name: string; spaces: SpaceOpt[]; onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [space, setSpace] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = space || spaces[0]?.id || "";
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
        <D.Content className="sheet fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-line bg-surface p-5 shadow-pop">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-[16px] font-medium">Share {name}</D.Title>
              <D.Description className="mt-1 text-[13px] text-ink-3">Everyone with access to the space you pick will see this repository&apos;s name and its planning data (tasks, boards). Your code stays on GitHub with GitHub&apos;s own permissions.</D.Description>
            </div>
            <D.Close className="btn btn-quiet btn-icon -mr-1.5" aria-label="Close"><X size={16} aria-hidden /></D.Close>
          </div>
          <label className="label" htmlFor="share-space">Share with</label>
          <Select id="share-space" value={chosen} onChange={(e) => setSpace(e.target.value)} className="select">
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}{s.everyone ? " (everyone on the team)" : ""}</option>)}
          </Select>
          <div className="mt-5 flex justify-end gap-2">
            <D.Close className="btn">Cancel</D.Close>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !chosen || !id}
              onClick={async () => {
                setBusy(true);
                const r = await shareRepositoryAction(fd({ repositoryId: id!, spaceId: chosen, confirm: "on" }));
                setBusy(false);
                if (r.ok) onDone("Shared. It reaches everyone in that space on their next sync.");
                else onError(r.error);
              }}
            >
              {busy ? "Sharing…" : "Share"}
            </button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
