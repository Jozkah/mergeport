"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Select } from "@/components/ui/Select";
import { ActionForm } from "@/components/forms/ActionForm";
import { listAiModelsAction, saveAiSettingsAction } from "@/app/ai-actions";

/**
 * Address, key and model of an OpenAI-compatible endpoint. The model list is asked from the endpoint on request, because
 * the models behind it change over time; a name can also be typed when the endpoint does not list it.
 */
export function AiSettingsPanel({ baseUrl, hasKey, model }: { baseUrl: string; hasKey: boolean; model: string | null }) {
  const form = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [pref, setPref] = useState(model ?? "");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      const fd = new FormData();
      for (const name of ["baseUrl", "apiKey"]) fd.set(name, form.current?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "");
      const r = await listAiModelsAction(fd);
      if (r.ok) {
        setModels((r.data?.models as string[]) ?? []);
        setNote({ ok: true, text: r.message ?? "" });
      } else setNote({ ok: false, text: r.error });
    });

  // With a key saved, ask the endpoint what it offers as soon as the panel opens, so the list is ready.
  useEffect(() => {
    if (hasKey) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gone = pref && models.length > 0 && !models.includes(pref);

  return (
    <div className="p-4">
      <ActionForm action={saveAiSettingsAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
        <div ref={form} className="flex flex-col gap-3">
          <div>
            <label className="label" htmlFor="ai-url">Address</label>
            <input id="ai-url" name="baseUrl" className="input" defaultValue={baseUrl} inputMode="url" autoComplete="off" spellCheck={false} />
            <p className="mt-1 text-[12px] text-ink-3">The OpenAI-compatible base, ending in /v1.</p>
          </div>
          <div>
            <label className="label" htmlFor="ai-key">API key</label>
            <input id="ai-key" name="apiKey" type="password" className="input" autoComplete="off" placeholder={hasKey ? "Saved. Type to replace it." : "Paste your key"} />
            <p className="mt-1 text-[12px] text-ink-3">Stored encrypted on this computer, next to the database. It leaves only in requests to the address above.</p>
            {hasKey && <label className="-my-1 mt-1 flex min-h-8 w-fit cursor-pointer items-center gap-2 text-[12.5px]"><input type="checkbox" name="clearKey" /> Remove the saved key</label>}
          </div>
          <div>
            <label className="label" htmlFor="ai-model">Preferred model (optional)</label>
            <Select id="ai-model" name="model" className="select" value={pref} onChange={(e) => setPref(e.target.value)}>
              <option value="">Automatic</option>
              {gone || (pref && models.length === 0) ? <option value={pref}>{pref}{gone ? " (not offered now)" : ""}</option> : null}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn" onClick={load} disabled={pending}>{pending ? "Asking…" : "Load models"}</button>
              {note && <span role="status" className={`text-[12.5px] ${note.ok ? "text-ok" : "text-blocked"}`}>{note.text}</span>}
            </div>
            <p className="mt-1 text-[12px] text-ink-3">Leave empty and Mergeport asks the endpoint which models it serves each time and uses an available one. A preferred model is used only while the endpoint still offers it.</p>
          </div>
        </div>
      </ActionForm>
    </div>
  );
}
