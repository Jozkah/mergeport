"use client";

import type { ComponentProps } from "react";

/**
 * A checkbox that saves by being toggled: it submits its form (an ActionForm with `hideSubmit`) as soon as it changes, so a row of
 * settings has no per-row Save button. A rejected save resets the form, which puts the box back to what is stored.
 */
export function AutoCheckbox(props: Omit<ComponentProps<"input">, "type" | "onChange">) {
  return <input {...props} type="checkbox" onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
