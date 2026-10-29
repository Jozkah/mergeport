"use client";

import { useState } from "react";
import type { RestorePreview } from "@/lib/services/backup";

/** Download a backup, or choose one to restore. Restoring always shows what it would change first and needs a confirmation. */
export function BackupPanel() {
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (url: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, { method: "POST", body: text ?? "", headers: { "content-type": "text/plain" } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { error?: string }).error ?? "That did not work");
      return body as RestorePreview;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "That did not work" });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <div>
        <p className="font-medium">Back up</p>
        <p className="mt-0.5 text-ink-3">A file of everything Mergeport owns: planning, rules, views, preferences and edits still waiting to be sent. It contains no credentials, no folder paths and nothing that GitHub owns.</p>
        <a className="btn mt-2 inline-flex" href="/api/backup/export" download>Download a backup</a>
      </div>
      <div className="border-t border-line pt-4">
        <p className="font-medium">Restore</p>
        <p className="mt-0.5 text-ink-3">Adds what is missing and updates what differs. It never deletes. You see exactly what would change before anything is written.</p>
        <label className="label mt-2" htmlFor="restore-file">Backup file</label>
        <input id="restore-file" type="file" accept="application/json,.json" className="input !h-auto py-1.5" onChange={(e) => { const f = e.target.files?.[0]; setPreview(null); setMsg(null); if (!f) return setText(null); setName(f.name); void f.text().then(setText); }} />
        {text && !preview && <button type="button" className="btn mt-2" disabled={busy} onClick={async () => setPreview(await call("/api/backup/preview"))}>{busy ? "Reading…" : "Preview the restore"}</button>}
        {preview && (
          <div className="mt-3 rounded-[10px] border border-line p-3">
            <p className="font-medium">{name} · made {new Date(preview.exportedAt).toLocaleString()} by {preview.from}</p>
            <table className="mt-2 w-full text-left text-[12.5px]"><thead className="text-ink-3"><tr><th className="py-1 pr-3 font-medium">Records</th><th className="px-2 font-medium">New</th><th className="px-2 font-medium">Changed</th><th className="px-2 font-medium">Same</th><th className="px-2 font-medium">Skipped</th></tr></thead>
              <tbody className="divide-y divide-line">{preview.tables.map((t) => <tr key={t.table}><td className="py-1 pr-3">{t.table}</td><td className="tnum px-2">{t.create}</td><td className="tnum px-2">{t.update}</td><td className="tnum px-2">{t.same}</td><td className="tnum px-2">{t.skipped}</td></tr>)}</tbody></table>
            {preview.skipped.length > 0 && <ul className="mt-2 list-disc pl-5 text-waiting">{preview.skipped.map((s) => <li key={s.table + s.why}>{s.count} {s.table} skipped: {s.why}</li>)}</ul>}
            <p className="mt-2 text-ink-3">Unsent edits in this backup: {preview.unsentEdits}. {preview.outbox.restorable} can be restored here{preview.outbox.skipped ? `, ${preview.outbox.skipped} cannot (their team space is not set up on this computer)` : ""}.</p>
            {preview.notes.map((n) => <p key={n} className="mt-1 text-ink-3">{n}</p>)}
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { const r = await call("/api/backup/restore"); if (r) { setMsg({ ok: true, text: "Restored." }); setPreview(null); setText(null); } }}>{busy ? "Restoring…" : "Restore this backup"}</button>
              <button type="button" className="btn btn-quiet" onClick={() => { setPreview(null); setText(null); }}>Cancel</button>
            </div>
          </div>
        )}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 ${msg.ok ? "text-ok" : "text-blocked"}`}>{msg.text}</p>}
      </div>
    </div>
  );
}
