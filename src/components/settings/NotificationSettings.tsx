"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { savePrefsAction } from "@/app/notify-actions";
import { KINDS, type Prefs } from "@/lib/domain/notify-prefs";

const permission = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);
const subscribe = () => () => {};

/**
 * Per-event controls, quiet hours and optional desktop pop-ups. Preferences stay on this computer. Pop-ups only appear while
 * Mergeport is open in a browser: nothing runs when it is closed, so nothing can be delivered then.
 */
export function NotificationSettings({ initial }: { initial: Prefs }) {
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const perm = useSyncExternalStore(subscribe, permission, () => "default");
  const [asked, setAsked] = useState<string | null>(null);
  const state = asked ?? perm;

  const save = () =>
    start(async () => {
      const r = await savePrefsAction(prefs);
      setMessage(r.ok ? "Saved" : r.error);
    });

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <fieldset>
        <legend className="label">Tell me when</legend>
        <table className="w-full text-left">
          <thead className="text-[12px] text-ink-3"><tr><th className="py-1 pr-3 font-medium">Event</th><th className="px-3 py-1 font-medium">In the app</th><th className="px-3 py-1 font-medium">On the desktop</th></tr></thead>
          <tbody className="divide-y divide-line">
            {KINDS.map((k) => (
              <tr key={k.key}>
                <td className="py-2 pr-3">{k.label}</td>
                <td className="px-3 py-2"><input type="checkbox" aria-label={`${k.label}: in the app`} checked={prefs.kinds[k.key].inApp} onChange={(e) => setPrefs({ ...prefs, kinds: { ...prefs.kinds, [k.key]: { ...prefs.kinds[k.key], inApp: e.target.checked } } })} /></td>
                <td className="px-3 py-2"><input type="checkbox" aria-label={`${k.label}: on the desktop`} checked={prefs.kinds[k.key].desktop} onChange={(e) => setPrefs({ ...prefs, kinds: { ...prefs.kinds, [k.key]: { ...prefs.kinds[k.key], desktop: e.target.checked } } })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="label">Quiet hours</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.quiet.enabled} onChange={(e) => setPrefs({ ...prefs, quiet: { ...prefs.quiet, enabled: e.target.checked } })} /> Hold desktop pop-ups</label>
        <label className="flex items-center gap-1.5">from <input type="time" className="input !h-8 w-36" value={prefs.quiet.start} onChange={(e) => e.target.value && setPrefs({ ...prefs, quiet: { ...prefs.quiet, start: e.target.value } })} /></label>
        <label className="flex items-center gap-1.5">until <input type="time" className="input !h-8 w-36" value={prefs.quiet.end} onChange={(e) => e.target.value && setPrefs({ ...prefs, quiet: { ...prefs.quiet, end: e.target.value } })} /></label>
        <p className="w-full text-[12px] text-ink-3">Quiet hours follow your time zone and only hold desktop pop-ups. Everything still appears in the app.</p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        {state === "unsupported" ? (
          <p className="text-[12.5px] text-ink-3">This browser cannot show desktop notifications.</p>
        ) : state === "granted" ? (
          <p className="text-[12.5px] text-ink-2">Desktop notifications are allowed in this browser.</p>
        ) : state === "denied" ? (
          <p className="text-[12.5px] text-ink-3">Desktop notifications are blocked for this site. Allow them in your browser&rsquo;s site settings to use them.</p>
        ) : (
          <button type="button" className="btn" onClick={() => void Notification.requestPermission().then(setAsked)}>Allow desktop notifications</button>
        )}
        <p className="text-[12px] text-ink-3">Pop-ups only appear while Mergeport is open in a browser. When it is closed, nothing can be delivered.</p>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={save}>Save preferences</button>
        {message && <span role="status" className="text-[12.5px] text-ink-3">{message}</span>}
      </div>
    </div>
  );
}
