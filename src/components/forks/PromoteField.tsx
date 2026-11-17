"use client";

import { useState } from "react";
import { Select } from "@/components/ui/Select";
import { CircleAlert } from "@/components/ui/icons";

/**
 * "What happens when the merge is ready". The safe choice gets a plain one-line note; the riskier choice swaps in a bordered warning
 * of its own, so the consequence is read at the moment it is picked and not before. The note is a polite live region: a keyboard or
 * screen-reader user choosing the option hears it too.
 */
export function PromoteField({ id, name, defaultValue, forkBranch }: { id: string; name: string; defaultValue: string; forkBranch: string }) {
  const [mode, setMode] = useState(defaultValue === "push" ? "push" : "pr");
  return (
    <div>
      <label className="label" htmlFor={id}>When the merge is ready</label>
      <Select id={id} name={name} className="select" defaultValue={defaultValue} onChange={(e) => setMode(e.target.value === "push" ? "push" : "pr")}>
        <option value="pr">Open a pull request (recommended)</option>
        <option value="push">Push to {forkBranch} (riskier)</option>
      </Select>
      <div aria-live="polite" className="mt-1.5">
        {mode === "push" ? (
          <p className="flex items-start gap-1.5 rounded-[10px] border border-blocked-line bg-blocked-bg p-2.5 text-[12.5px] text-blocked text-pretty">
            <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
            <span><strong>This changes {forkBranch} on GitHub without anyone reviewing it.</strong> It is a plain fast-forward (never forced), only after the check passed, so a check command is required.</span>
          </p>
        ) : (
          <p className="text-[12px] text-ink-3 text-pretty">Opens a pull request into <span className="mono">{forkBranch}</span>. Nothing on that branch changes until someone merges it.</p>
        )}
      </div>
    </div>
  );
}
