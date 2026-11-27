import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { writableRepos } from "@/lib/services/queries";
import { aiEnabled } from "@/lib/services/ai";
import { REFUSAL_MESSAGES, writeRefusal } from "@/lib/github/writes";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { CircleDot } from "@/components/ui/icons";
import { NewIssueForm, type NewIssueRepo } from "@/components/work/NewIssueForm";

export const metadata = { title: "New issue" };

export default async function Page({ searchParams }: { searchParams: Promise<{ repo?: string | string[] }> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  const writable = await writableRepos(db, viewer);
  const rows = await db.repository.findMany({ where: { ...repoWhere(viewer), id: { in: writable.map((r) => r.id) } }, select: { id: true, githubId: true, installationId: true, isDemo: true, fullName: true, workspaceId: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Why a write cannot happen from here, per repository, so the page can say so before anything is typed. The action checks again.
  const repos: NewIssueRepo[] = await Promise.all(
    writable.map(async (r) => {
      const row = byId.get(r.id)!;
      const reason = await writeRefusal(db, viewer, row);
      return { id: r.id, fullName: r.fullName, isDemo: row.isDemo, refusal: reason ? REFUSAL_MESSAGES[reason] : null };
    }),
  );
  // Research may read any repository the person can see, not only the ones they may write to.
  const [ai, visible] = await Promise.all([aiEnabled(db, viewer.workspaceId), db.repository.findMany({ where: repoWhere(viewer), orderBy: { fullName: "asc" }, select: { id: true, fullName: true } })]);
  const wanted = Array.isArray(sp.repo) ? sp.repo[0] : sp.repo;
  const preselect = wanted && repos.some((r) => r.id === wanted) ? wanted : null;

  return (
    <>
      <PageHeader title="New issue" subtitle="Created on GitHub under your own account. Nothing is sent until you press Create issue; while you type, a draft is kept in this browser." actions={<Link href="/issues" className="btn">Back to issues</Link>} />
      {repos.length === 0 ? (
        <EmptyState icon={CircleDot} title="No repository to create issues in">
          You cannot create issues in any repository you can see. Ask an administrator for a grant that lets you manage work.
        </EmptyState>
      ) : (
        <NewIssueForm repos={repos} preselect={preselect} draftKey={`mergeport:new-issue-draft:${viewer.userId}`} ai={{ enabled: ai, repos: visible }} />
      )}
    </>
  );
}
