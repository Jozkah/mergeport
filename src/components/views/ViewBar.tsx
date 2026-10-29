"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteViewAction, saveViewAction, shareViewAction } from "@/app/view-actions";
import { ActionMenu } from "@/components/ui/ActionMenu";
import type { ViewRow } from "@/lib/services/views";

/**
 * Saved views for a page. A view is the page's current filters, grouping and sort as a link. Sharing one gives teammates the
 * definition only; each person sees the results their own access allows.
 */
export function ViewBar({ scope, views }: { scope: string; views: ViewRow[] }) {
  const params = useSearchParams();
  const path = usePathname();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = params.toString();
  const active = views.find((v) => v.query === current);

  const save = () =>
    start(async () => {
      const r = await saveViewAction({ scope, name, query: current, shared });
      if (r.ok) {
        setAdding(false);
        setName("");
        setShared(false);
        setError(null);
      } else setError(r.error);
    });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Saved views">
      {views.length === 0 && <span className="text-[12.5px] text-ink-3">No saved views</span>}
      {views.map((v) => (
        <span key={v.id} className={`inline-flex items-center rounded-full border text-[12.5px] ${active?.id === v.id ? "border-ink bg-hover" : "border-line"}`}>
          <Link href={v.href} className="px-2.5 py-1" title={v.shared ? (v.mine ? "Shared with your team" : `Shared by ${v.ownerLogin}`) : undefined}>
            {v.name}
            {v.shared && <span className="ml-1 text-ink-3">{v.mine ? "· shared" : `· ${v.ownerLogin}`}</span>}
          </Link>
          {v.mine && (
            <ActionMenu
              label={`Options for ${v.name}`}
              items={[
                { label: v.shared ? "Stop sharing" : "Share with team", onSelect: () => start(async () => void (await shareViewAction({ scope, id: v.id, shared: !v.shared }))) },
                { label: "Delete view", danger: true, onSelect: () => start(async () => void (await deleteViewAction({ scope, id: v.id }))) },
              ]}
            />
          )}
        </span>
      ))}
      {adding ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label className="sr-only" htmlFor={`view-name-${scope}`}>View name</label>
          <input id={`view-name-${scope}`} className="input !h-8 w-44" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" autoFocus maxLength={60} />
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with team</label>
          <button type="submit" className="btn" disabled={pending || !name.trim()}>Save</button>
          <button type="button" className="btn btn-quiet" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
          {error && <span role="alert" className="text-[12px] text-blocked">{error}</span>}
        </form>
      ) : (
        <button type="button" className="btn btn-quiet" onClick={() => setAdding(true)} title={`Save the current filters of ${path} as a view`}>Save current view</button>
      )}
    </div>
  );
}
