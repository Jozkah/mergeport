"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Select } from "@/components/ui/Select";
import { ActionForm } from "@/components/forms/ActionForm";
import { listAiModelsAction, saveAiSettingsAction } from "@/app/ai-actions";

const LEVELS: Record<string, string> = {
  off: "Nothing runs by itself.",
  suggest: "Once a day it reviews your pull requests and tasks and leaves suggestions for you to accept.",
  create: "As Suggest, and it also makes tasks for clear cases: a review waiting on you, changes requested on your pull request.",
};

/**
 * Address, key, model and autopilot of an OpenAI-compatible endpoint, in two groups: how to reach it, and how it behaves. The model
 * list is asked from the endpoint, because the models behind it change over time.
 */
export function AiSettingsPanel({ baseUrl, hasKey, model, autopilot, hosted = false }: { baseUrl: string; hasKey: boolean; model: string | null; autopilot: "off" | "suggest" | "create"; hosted?: boolean }) {
  const form = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [pref, setPref] = useState(model ?? "");
  const [level, setLevel] = useState<string>(autopilot);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const load = () => {
    if (pending) return;
    start(async () => {
      const fd = new FormData();
      for (const name of ["baseUrl", "apiKey"]) fd.set(name, form.current?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "");
      const r = await listAiModelsAction(fd);
      if (r.ok) {
        setModels((r.data?.models as string[]) ?? []);
        const on = (r.data?.loaded as string[]) ?? [];
        setLoaded(on);
        setNote({ ok: true, text: `${r.message ?? ""}${on.length ? ` · loaded now: ${on.join(", ")}` : ""}` });
      } else setNote({ ok: false, text: r.error });
    });
  };

  // With a key saved, ask the endpoint what it offers as soon as the panel opens, so the list is ready.
  useEffect(() => {
    if (hasKey) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gone = pref && models.length > 0 && !models.includes(pref);

  return (
    <div className="p-4">
      <ActionForm action={saveAiSettingsAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
        <div ref={form} className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-[13px] font-medium">Connection</legend>
            <div>
              <label className="label" htmlFor="ai-url">Address</label>
              <input id="ai-url" name="baseUrl" className="input" defaultValue={baseUrl} inputMode="url" autoComplete="off" spellCheck={false} />
              <p className="mt-1 text-[12px] text-ink-3">The OpenAI-compatible base, ending in /v1.</p>
            </div>
            <div>
              <label className="label" htmlFor="ai-key">API key</label>
              <input id="ai-key" name="apiKey" type="password" className="input" autoComplete="off" placeholder={hasKey ? "Saved. Type to replace it." : "Paste your key"} />
              <p className="mt-1 text-[12px] text-ink-3 text-pretty">{hosted ? "Stored encrypted on the server. It is only sent to the address above." : "Stored encrypted on this computer. It is only sent to the address above."}</p>
              {hasKey && <label className="mt-1 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-[12.5px]"><input type="checkbox" name="clearKey" /> Remove the saved key</label>}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-[13px] font-medium">Behaviour</legend>
            <div>
              <label className="label" htmlFor="ai-model">Model</label>
              <Select id="ai-model" name="model" className="select" value={pref} onChange={(e) => setPref(e.target.value)}>
                <option value="">{loaded.length ? "Automatic (the loaded model)" : "Automatic"}</option>
                {gone || (pref && models.length === 0) ? <option value={pref}>{pref}{gone ? " (not offered now)" : ""}</option> : null}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <button type="button" className="btn" onClick={load} aria-disabled={pending}>{pending ? "Asking…" : "Load models"}</button>
                {note && <span role="status" className={`text-[12.5px] text-pretty ${note.ok ? "text-ok" : "text-blocked"}`}>{note.text}</span>}
              </div>
              <p className="mt-1 text-[12px] text-ink-3 text-pretty">Automatic uses a model the server already has loaded, so it never makes the server swap. Pick one only if you want that model even when it has to load.</p>
            </div>
            <div>
              <label className="label" htmlFor="ai-autopilot">Autopilot</label>
              <Select id="ai-autopilot" name="autopilot" className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="off">Off</option>
                <option value="suggest">Suggest</option>
                <option value="create">Create</option>
              </Select>
              <p className="mt-1 text-[12px] text-ink-3 text-pretty" aria-live="polite">{LEVELS[level]}</p>
              {level !== "off" && <p className="mt-1 text-[12px] text-ink-3 text-pretty">{hosted ? "It runs each morning after 7:00" : "It runs while Mergeport is open, after 7:00"}, and sends titles and status of what it reads to the address above. It only writes local tasks and suggestions, never anything on GitHub.</p>}
            </div>
          </fieldset>
        </div>
      </ActionForm>
    </div>
  );
}
