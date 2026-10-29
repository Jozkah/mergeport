import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { NotFoundError } from "@/lib/errors";
import { GithubError } from "@/lib/github/port";
import { repoContentsView, type CodeView } from "@/lib/services/git-view";
import { formatBytes } from "@/lib/format";
import { Banner, PageHeader } from "@/components/ui/primitives";
import { ExternalLink, FolderGit2 } from "@/components/ui/icons";
import { Tokens } from "@/components/code/Code";
import { RefPicker } from "@/components/code/RefPicker";

export const metadata = { title: "Code" };

const MAX_SHOWN_LINES = 4000;

export default async function CodePage({ params, searchParams }: { params: Promise<{ id: string; path?: string[] }>; searchParams: Promise<{ ref?: string; plain?: string }> }) {
  const { viewer } = await requireViewer();
  const { id, path: segs } = await params;
  const sp = await searchParams;
  const repo = await db.repository.findFirst({ where: { id, ...repoWhere(viewer) }, include: { owner: true, branches: { orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { name: true } } } });
  if (!repo) notFound();
  const path = (segs ?? []).map(decodeURIComponent).join("/");
  const ref = sp.ref || repo.defaultBranch || "";
  const base = `/repositories/${repo.id}/code`;
  const withRef = (p: string) => `${base}${p ? "/" + p.split("/").map(encodeURIComponent).join("/") : ""}${sp.ref ? `?ref=${encodeURIComponent(sp.ref)}` : ""}`;

  let view: CodeView | null = null;
  let problem: string | null = null;
  try {
    view = await repoContentsView(db, viewer, repo.id, path, sp.ref ?? null);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    problem = e instanceof GithubError && e.kind === "not-found" ? "That folder or file does not exist on this branch." : e instanceof Error ? e.message : "GitHub could not be reached.";
  }

  const crumbs = path ? path.split("/") : [];
  return (
    <>
      <PageHeader
        title={<span className="inline-flex items-center gap-2"><FolderGit2 size={20} aria-hidden /> {repo.fullName}</span>}
        subtitle="Browse the code and read it with the same colours as GitHub. Nothing here changes the repository."
        actions={<a href={`${repo.htmlUrl}${path ? `/${view?.kind === "dir" ? "tree" : "blob"}/${encodeURIComponent(ref)}/${path}` : ""}`} target="_blank" rel="noopener noreferrer" className="btn"><ExternalLink size={14} aria-hidden /> Open on GitHub</a>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[14px]">
        <RefPicker repoId={repo.id} path={path} current={ref} branches={repo.branches.map((b) => b.name)} />
        <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1">
          <Link href={withRef("")} className="font-semibold text-[#0969da] hover:underline dark:text-[#4493f8]">{repo.name}</Link>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1"><span className="text-ink-3">/</span>{i === crumbs.length - 1 ? <strong className="font-semibold">{c}</strong> : <Link href={withRef(crumbs.slice(0, i + 1).join("/"))} className="text-[#0969da] hover:underline dark:text-[#4493f8]">{c}</Link>}</span>
          ))}
        </nav>
      </div>

      {problem && <Banner tone="error" title="Could not load this">{problem}</Banner>}

      {view?.kind === "dir" && (
        <div className="flex flex-col gap-4">
          <div className="code-box">
            <ul className="divide-y divide-[var(--code-border)]">
              {path && <li><Link href={withRef(crumbs.slice(0, -1).join("/"))} className="block px-4 py-2 text-[14px] hover:bg-hover">..</Link></li>}
              {view.entries.map((e) => (
                <li key={e.path} className="flex items-center gap-3 px-4 py-2 text-[14px] hover:bg-hover">
                  <span aria-hidden className="w-4 shrink-0 text-center text-ink-3">{e.type === "dir" ? "▸" : e.type === "submodule" ? "◈" : "•"}</span>
                  {e.type === "submodule" ? <span>{e.name}</span> : <Link href={withRef(e.path)} className="min-w-0 flex-1 truncate hover:text-[#0969da] hover:underline dark:hover:text-[#4493f8]">{e.name}{e.type === "dir" ? "/" : ""}</Link>}
                  {e.type === "file" && <span className="tnum shrink-0 text-[12px] text-ink-3">{formatBytes(e.size)}</span>}
                </li>
              ))}
              {view.entries.length === 0 && <li className="px-4 py-6 text-[13px] text-ink-3">This folder is empty.</li>}
            </ul>
          </div>
          {view.readme && (
            <div className="code-box">
              <div className="code-head"><span className="font-medium text-ink">{view.readme.path.split("/").pop()}</span></div>
              <div className="md p-6 sm:p-8" dangerouslySetInnerHTML={{ __html: view.readme.html }} />
            </div>
          )}
        </div>
      )}

      {view?.kind === "file" && <FileView view={view} path={path} plain={sp.plain === "1"} href={withRef(path)} githubUrl={view.blob.htmlUrl} />}
    </>
  );
}

function FileView({ view, path, plain, href, githubUrl }: { view: Extract<CodeView, { kind: "file" }>; path: string; plain: boolean; href: string; githubUrl: string | null }) {
  const b = view.blob;
  const showMd = !!view.markdown && !plain;
  const lines = b.lines.slice(0, MAX_SHOWN_LINES);
  const sep = href.includes("?") ? "&" : "?";
  return (
    <div className="code-box">
      <div className="code-head">
        <span className="font-medium text-ink">{path.split("/").pop()}</span>
        <span className="tnum">{b.lines.length > 0 ? `${b.lines.length} line${b.lines.length === 1 ? "" : "s"} · ` : ""}{formatBytes(b.size)}</span>
        {b.lang && <span className="rounded-full border border-[var(--code-border)] px-2 text-[12px]">{b.lang}</span>}
        <span className="ml-auto flex items-center gap-3">
          {view.markdown && (plain ? <Link className="link" href={href}>Preview</Link> : <Link className="link" href={`${href}${sep}plain=1`}>Code</Link>)}
          {githubUrl && <a className="link inline-flex items-center gap-1" href={githubUrl} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={12} aria-hidden /></a>}
        </span>
      </div>
      {b.binary ? (
        <p className="p-6 text-[13px] text-ink-3">This is a binary file, so there is no text to show.</p>
      ) : b.tooLarge ? (
        <p className="p-6 text-[13px] text-ink-3">This file is larger than 1 MB, so it is not loaded here. {githubUrl && <a className="link" href={githubUrl} target="_blank" rel="noopener noreferrer">Open it on GitHub</a>}.</p>
      ) : showMd ? (
        <div className="md p-6 sm:p-8" dangerouslySetInnerHTML={{ __html: view.markdown! }} />
      ) : (
        <div className="code-scroll">
          <table className="src hl">
            <tbody>
              {lines.map((tok, i) => (
                <tr key={i} id={`L${i + 1}`}>
                  <td className="no"><a href={`#L${i + 1}`} aria-label={`Line ${i + 1}`}>{i + 1}</a></td>
                  <td className="tx"><Tokens tok={tok} palette={b.palette} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {b.lines.length > MAX_SHOWN_LINES && <p className="border-t border-[var(--code-border)] p-3 text-[12.5px] text-ink-3">Showing the first {MAX_SHOWN_LINES} of {b.lines.length} lines. {githubUrl && <a className="link" href={githubUrl} target="_blank" rel="noopener noreferrer">Open the whole file on GitHub</a>}.</p>}
        </div>
      )}
    </div>
  );
}
