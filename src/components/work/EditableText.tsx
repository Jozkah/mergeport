"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { editTextAction } from "@/app/actions";
import { CircleAlert, LoaderCircle, Pencil } from "@/components/ui/icons";
import { BODY_MAX } from "@/lib/github/write-text";

/**
 * A description or conversation comment with an Edit button: the rendered text, or (while editing) a textarea prefilled with the stored
 * markdown and Save / Cancel. Save sends exactly the text in the box (no footer is added) as the person; GitHub's refusal is shown here.
 */
export function EditableText({ id, commentId, markdown, what, children }: { id: string; commentId?: string; markdown: string; what: "description" | "comment"; children: ReactNode }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(markdown);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing)
    return (
      <div>
        {children}
        <div className="mt-2 flex justify-end">
          <button type="button" className="btn btn-quiet !h-7 !px-2.5 !text-[12.5px]" aria-label={`Edit ${what}`} onClick={() => { setText(markdown); setErr(null); setEditing(true); }}>
            <Pencil size={13} aria-hidden /> Edit
          </button>
        </div>
      </div>
    );

  const save = () =>
    start(async () => {
      setErr(null);
      const r = await editTextAction({ id, commentId, body: text }).catch(() => ({ ok: false as const, error: "Could not reach the server. Check GitHub before trying again." }));
      if (!r.ok) return setErr(r.error);
      setEditing(false);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor={`edit-${commentId ?? id}`}>Edit {what}</label>
      <textarea id={`edit-${commentId ?? id}`} className="textarea min-h-40" value={text} maxLength={BODY_MAX} onChange={(e) => setText(e.target.value)} autoFocus />
      <p className="text-[12px] text-ink-3">Saved on GitHub as you. GitHub decides whether your account may change it.</p>
      {err && <p role="alert" className="flex items-start gap-2 text-[12.5px] text-blocked"><CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />{err}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" onClick={save} disabled={pending || (what === "comment" && !text.trim())} data-loading={pending}>
          {pending && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Save
        </button>
        <button type="button" className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
      </div>
    </div>
  );
}
