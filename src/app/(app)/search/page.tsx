import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { searchGlobal } from "@/lib/services/queries";
import { EmptyState, Mono, PageHeader, Panel } from "@/components/ui/primitives";
import { Search } from "@/components/ui/icons";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { viewer } = await requireViewer();
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const r = await searchGlobal(db, viewer, q);
  const none = r.repositories.length + r.workItems.length + r.planning.length === 0;
  return (
    <>
      <PageHeader title="Search" subtitle={q ? `Results for “${q}” in repositories you can access.` : "Type at least two characters in the search box."} />
      {q && none && <Panel title="No results" icon={Search}><EmptyState icon={Search} title="Nothing found">Only repositories, work and planning items you have access to are searched.</EmptyState></Panel>}
      <div className="flex flex-col gap-5">
        {r.repositories.length > 0 && <Panel title="Repositories" icon={Search}><ul>{r.repositories.map((x) => <li key={x.id} className="border-b border-line px-4 py-2.5 text-[13px] last:border-b-0"><Link href="/repositories" className="hover:underline"><Mono>{x.fullName}</Mono></Link></li>)}</ul></Panel>}
        {r.workItems.length > 0 && <Panel title="Issues and pull requests" icon={Search}><ul>{r.workItems.map((x) => <li key={x.id} className="border-b border-line px-4 py-2.5 text-[13px] last:border-b-0"><Link href={x.type === "PULL_REQUEST" ? `/pull-requests/${x.id}` : `/issues/${x.id}`} className="hover:underline [overflow-wrap:anywhere]">{x.title}</Link><p className="text-[12px] text-ink-3"><Mono>{x.repository.fullName}#{x.number}</Mono></p></li>)}</ul></Panel>}
        {r.planning.length > 0 && <Panel title="Planning cards" icon={Search}><ul>{r.planning.map((x) => <li key={x.id} className="border-b border-line px-4 py-2.5 text-[13px] last:border-b-0"><Link href={`/planning?project=${x.projectId}`} className="hover:underline">{x.title}</Link></li>)}</ul></Panel>}
      </div>
    </>
  );
}
