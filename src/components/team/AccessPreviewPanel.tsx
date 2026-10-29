import type { AccessPreview, SourcePermission } from "@/lib/services/access-preview";
import { Mono } from "@/components/ui/primitives";

const WORD: Record<SourcePermission, string> = { admin: "admin", write: "can write", read: "can read", none: "no access", unknown: "could not be checked" };

/** Shown before invitations are sent: what the space stores (and its history), and each person's separate access to the source repositories. */
export function AccessPreviewPanel({ preview }: { preview: AccessPreview }) {
  const c = preview.contents;
  return (
    <section aria-label="Access preview" className="mt-3 rounded-[10px] border border-line bg-canvas p-3 text-[12.5px]">
      <p className="font-medium">What this space shares</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
        <li>{c.repositories.length} repositor{c.repositories.length === 1 ? "y" : "ies"} by name: {c.repositories.slice(0, 8).map((r) => <Mono key={r.fullName}>{r.fullName} </Mono>)}{c.repositories.length > 8 ? "…" : ""}</li>
        <li>{c.projects.length} project{c.projects.length === 1 ? "" : "s"}: {c.projects.map((p) => `${p.name} (${p.cards} cards)`).join(", ") || "none"}</li>
        <li>{c.tasks.total} local task{c.tasks.total === 1 ? "" : "s"}{c.tasks.titles.length ? `, including: ${c.tasks.titles.slice(0, 5).join("; ")}` : ""}</li>
        {Object.entries(c.counts).filter(([k]) => !["repositories", "projects", "cards and tasks"].includes(k)).map(([k, n]) => <li key={k}>{n} {k}</li>)}
        <li className="text-waiting">{c.history.versionsKept} earlier version{c.history.versionsKept === 1 ? "" : "s"} are kept in history. {c.history.note}</li>
      </ul>
      <p className="mt-3 font-medium">Each person&rsquo;s separate access to the source repositories</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {preview.people.map((p) => (
          <li key={p.login} className="rounded-[8px] border border-line p-2">
            <p><span className="font-medium">@{p.login}</span> {p.coordination.will}.</p>
            {p.source.length === 0 ? <p className="text-ink-3">No source repositories are named in this space.</p> : (
              <p className="text-ink-3">{p.source.map((s) => `${s.repo}: ${WORD[s.permission]}`).join(" · ")}</p>
            )}
            {p.missing.length > 0 && <p className="text-waiting">Will see these records but cannot open {p.missing.join(", ")}.</p>}
          </li>
        ))}
      </ul>
      {preview.notes.map((n) => <p key={n} className="mt-2 text-ink-3">{n}</p>)}
    </section>
  );
}
