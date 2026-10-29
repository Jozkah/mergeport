"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "@/components/ui/icons";
import { startGhLoginAction } from "@/app/sign-in/actions";

export function GhLogin() {
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setErr(null);
            const r = await startGhLoginAction().catch(() => ({ ok: false as const, error: "Could not start the login." }));
            if (r.ok) setOut(r.output);
            else setErr(r.error);
          })
        }
      >
        {pending && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Start GitHub sign-in
      </button>
      {out && <pre className="mono mt-3 whitespace-pre-wrap rounded-[8px] border border-line bg-canvas p-3 text-[12px]" role="status">{out}</pre>}
      {err && <p role="alert" className="mt-2 text-[12.5px] text-blocked">{err}</p>}
      {out && <p className="mt-2 text-[12px] text-ink-3">Finish in the browser window GitHub opened, then <a className="underline" href="/sign-in">check again</a>.</p>}
    </div>
  );
}
