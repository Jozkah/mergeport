import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { repoWhere } from "@/lib/authz/viewer";
import { taxonomy } from "@/lib/services/label-taxonomy";
import { addMappingAction, deleteMappingAction } from "@/app/phase4-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Tag } from "@/components/ui/icons";

export const metadata = { title: "Label taxonomy" };

export default async function Labels() {
  const { viewer } = await requireViewer();
  const [t, repos] = await Promise.all([taxonomy(db, viewer), db.repository.findMany({ where: repoWhere(viewer), select: { id: true, fullName: true }, orderBy: { fullName: "asc" } })]);
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  return (
    <>
      <PageHeader title="Label taxonomy" subtitle="Optional. Scoped labels look like priority::high. A mapping says that a repository's own spelling (for example P1) means the same thing, so lists can filter by the concept. Labels on GitHub are never changed." />
      <div className="flex flex-col gap-5">
        <Panel title="Families in use" icon={Tag} id="families">
          {t.families.length === 0 ? <EmptyState icon={Tag} title="No scoped labels yet">Use labels like priority::high or type::bug on GitHub, or map a spelling below.</EmptyState> : (
            <ul className="divide-y divide-line">{t.families.map((f) => <li key={f.family} className="flex flex-wrap items-baseline gap-2 px-4 py-2.5 text-[13px]"><span className="font-medium">{f.family}</span><span className="text-ink-3">{f.values.join(", ")}</span></li>)}</ul>
          )}
        </Panel>

        <Panel title="Mappings" icon={Tag} id="mappings">
          {t.mappings.length === 0 ? <p className="p-4 text-[13px] text-ink-3">No mappings.</p> : (
            <ul className="divide-y divide-line">
              {t.mappings.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <span><span className="font-mono">{m.spelling}</span> means <span className="font-medium">{m.concept}</span> <span className="text-ink-3">· {m.repositoryId ? (repoName.get(m.repositoryId) ?? "one repository") : "every repository"}</span></span>
                  {viewer.isAdmin && <ActionForm action={deleteMappingAction} submitLabel="Remove" submitClassName="btn btn-danger"><input type="hidden" name="id" value={m.id} /></ActionForm>}
                </li>
              ))}
            </ul>
          )}
          {viewer.isAdmin && (
            <ActionForm action={addMappingAction} submitLabel="Add mapping" className="grid gap-3 border-t border-line p-4 md:grid-cols-3" submitClassName="btn btn-primary">
              <div><label className="label" htmlFor="lm-sp">Label as spelled</label><input id="lm-sp" name="spelling" className="input" required placeholder="P1" /></div>
              <div><label className="label" htmlFor="lm-co">Means</label><input id="lm-co" name="concept" className="input" required placeholder="priority::high" /></div>
              <div><label className="label" htmlFor="lm-re">Where</label><Select id="lm-re" name="repositoryId" className="select" defaultValue=""><option value="">Every repository</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
            </ActionForm>
          )}
        </Panel>

        <Panel title="Preview: how existing items would read" icon={Tag} id="preview">
          {t.preview.length === 0 ? <p className="p-4 text-[13px] text-ink-3">No existing label is affected by a mapping.</p> : (
            <ul className="divide-y divide-line">{t.preview.map((p) => <li key={`${p.spelling}${p.repositoryId}`} className="px-4 py-2.5 text-[13px]"><span className="font-mono">{p.spelling}</span> on <span className="tnum font-medium">{p.items}</span> item{p.items === 1 ? "" : "s"} would read as <span className="font-medium">{p.concept}</span>.</li>)}</ul>
          )}
          <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3">This is a preview of how Mergeport reads labels. It never edits a label in a repository.</p>
        </Panel>
      </div>
    </>
  );
}
