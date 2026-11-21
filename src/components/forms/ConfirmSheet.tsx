"use client";

import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
import { Sheet, useSheetClose } from "@/components/ui/dialog";
import { ActionForm } from "./ActionForm";

function Cancel() {
  const close = useSheetClose();
  return <button type="button" className="btn" data-cancel onClick={() => close?.()}>Cancel</button>;
}

/**
 * Confirmation for an action that removes, revokes or hands over something. The trigger opens a sheet that names the consequence
 * in words, offers an explicit Cancel next to the (danger) submit, and closes with a toast once the action succeeded. A failure
 * keeps it open with the message. Hidden inputs the action needs go in `children`.
 */
export function ConfirmSheet({
  trigger,
  title,
  consequence,
  action,
  submitLabel,
  pendingLabel = "Working…",
  danger = true,
  children,
  submitDisabled,
  onDone,
  open,
  onOpenChange,
}: {
  trigger?: ReactNode;
  title: string;
  /** What will happen, in plain words. Shown as the dialog description. Wrap any user-supplied name or address in <bdi> so it stays readable inside the sentence. */
  consequence: ReactNode;
  action: (fd: FormData) => Promise<ActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  danger?: boolean;
  children?: ReactNode;
  submitDisabled?: boolean;
  onDone?: (r: ActionResult) => void;
  /** Controlled use: the caller opens it (a Select that needs a confirmation before it saves). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Sheet title={title} description={consequence} trigger={trigger} initialFocus="[data-cancel]" open={open} onOpenChange={onOpenChange}>
      <ActionForm action={action} submitLabel={submitLabel} pendingLabel={pendingLabel} submitClassName={danger ? "btn btn-danger" : "btn btn-primary"} closeOnSuccess secondary={<Cancel />} submitDisabled={submitDisabled} onDone={onDone}>
        {children}
      </ActionForm>
    </Sheet>
  );
}
