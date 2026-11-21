"use client";

import * as S from "@radix-ui/react-select";
import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Check, ChevronDown } from "@/components/ui/icons";
import { Glide } from "@/components/ui/Glide";

/**
 * Themed dropdown with the markup of a native a native select (<option>, <optgroup>, name, id, defaultValue/value, onChange), so every
 * list in the app looks the same, follows light/dark, scrolls, and works from the keyboard. It still submits through forms
 * (Radix renders a hidden native select for `name`). The browser's own popup cannot be styled, which is why it is replaced.
 */
const EMPTY = "__empty__"; // Radix items cannot have an empty value

type Opt = { value: string; label: ReactNode; disabled?: boolean };
type Group = { label?: string; options: Opt[] };

function collect(children: ReactNode): Group[] {
  const groups: Group[] = [];
  let loose: Opt[] = [];
  const flush = () => {
    if (loose.length) groups.push({ options: loose });
    loose = [];
  };
  const option = (el: ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>): Opt => ({ value: String(el.props.value ?? textOf(el.props.children)), label: el.props.children, disabled: el.props.disabled });
  // React.Children does not look inside a Fragment (a shared `<>…</>` list of options), so it is walked here.
  const walk = (nodes: ReactNode) =>
    Children.forEach(nodes, (c) => {
      if (!isValidElement(c)) return;
      const el = c as ReactElement<{ value?: string | number; label?: string; children?: ReactNode; disabled?: boolean }>;
      if (el.type === Fragment) walk(el.props.children);
      else if (el.type === "optgroup") {
        flush();
        groups.push({ label: el.props.label, options: Children.toArray(el.props.children).filter(isValidElement).map((o) => option(o as never)) });
      } else if (el.type === "option") loose.push(option(el as never));
    });
  walk(children);
  flush();
  return groups;
}
const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : "");
const enc = (v: string) => (v === "" ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? "" : v);

/** Layout utilities (width, flex, min/max width, with any breakpoint prefix and `!`) go on the wrapper; the rest stays on the trigger. */
const LAYOUT = /^(?:[a-z0-9-]+:)*!?(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-)/;
export function splitClass(className: string): { outer: string; inside: string } {
  const parts = className.split(/\s+/).filter(Boolean);
  const outer = parts.filter((c) => LAYOUT.test(c));
  const inside = parts.filter((c) => !LAYOUT.test(c));
  return { outer: outer.join(" "), inside: [...inside, "w-full"].join(" ") };
}

export function Select({ children, className, id, name, defaultValue, value, onChange, autoSubmit, required, disabled, "aria-label": ariaLabel, "aria-busy": ariaBusy, "aria-invalid": ariaInvalid }: {
  children: ReactNode;
  className?: string;
  id?: string;
  name?: string;
  defaultValue?: string | number;
  value?: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  /** Submit the closest form as soon as a different option is chosen (no separate Save button). A function decides per change (return false to hold the submit, e.g. while a confirmation is open). */
  autoSubmit?: boolean | ((next: string, prev: string) => boolean);
  /** An empty choice blocks the form (the browser names the missing field) and is announced as required. */
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-busy"?: boolean;
  "aria-invalid"?: boolean;
}) {
  const view = useRef<HTMLDivElement>(null);
  const groups = collect(children);
  const all = groups.flatMap((g) => g.options);
  const initial = defaultValue !== undefined ? String(defaultValue) : (all[0]?.value ?? "");
  const [inner, setInner] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  // form.reset() (ActionForm does it after a success) puts native controls back to their default; this one is React state, so it
  // listens for the same event. Without it the hidden input would keep posting the old choice.
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const onReset = () => setInner(initial);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initial]);
  const current = value !== undefined ? String(value) : inner;
  const match = all.find((o) => o.value === current);
  // A stored value that is not among the options (a space the viewer cannot see, a removed choice) is never shown as the first option.
  const unavailable = !match && all.length > 0;
  const label = match ? match.label : unavailable ? "Unavailable" : undefined;
  const muted = unavailable || (current === "" && !!match);
  // Width and flex utilities belong to the wrapper (it is what sits in the page's row); the trigger fills it.
  const { outer, inside } = splitClass(className ?? "select");
  return (
    <span className={`relative block ${outer}`}>
      {/* Radix would post its internal stand-in for an empty value; this posts what the person chose. */}
      {name && required ? (
        // A hidden input is never validated; an invisible, unfocusable text input covering the trigger is, so an empty required select blocks the submit and the browser's bubble points at the trigger.
        <input ref={field} type="text" name={name} value={current} disabled={disabled} required tabIndex={-1} aria-hidden onChange={() => {}} className="pointer-events-none absolute inset-0 size-full opacity-0" />
      ) : (
        <input ref={field} type="hidden" name={name} value={current} disabled={disabled || !name} />
      )}
    <S.Root
      value={enc(current)}
      required={required}
      disabled={disabled}
      onValueChange={(v) => {
        const changed = dec(v) !== current;
        flushSync(() => setInner(dec(v)));
        onChange?.({ target: { value: dec(v), name: name ?? "" }, currentTarget: { value: dec(v), name: name ?? "" } } as ChangeEvent<HTMLSelectElement>);
        // The hidden input is not a native control the browser edits, so tell the form (dirty tracking, "clear the result on edit") it changed.
        if (changed) field.current?.dispatchEvent(new Event("input", { bubbles: true }));
        if (autoSubmit && changed && (typeof autoSubmit !== "function" || autoSubmit(dec(v), current))) field.current?.form?.requestSubmit();
      }}
    >
      <S.Trigger id={id} aria-label={ariaLabel} aria-busy={ariaBusy} aria-invalid={ariaInvalid || undefined} aria-required={required || undefined} className={`${inside} flex items-center justify-between gap-2 text-left aria-[invalid=true]:border-blocked`}>
        <span className={`min-w-0 flex-1 truncate ${muted ? "text-ink-3" : ""}`}><S.Value>{label}</S.Value></span>
        <S.Icon asChild><ChevronDown size={14} aria-hidden className="shrink-0 text-ink-3" /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} collisionPadding={8} className="select-pop z-[70] max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[var(--radix-select-trigger-width)] max-w-[min(32rem,calc(100vw-16px))] overflow-hidden overscroll-contain rounded-[10px] border border-line bg-surface text-[13px] text-ink shadow-pop">
          <S.Viewport ref={view} className="relative max-h-[inherit] overflow-y-auto overscroll-contain p-1">
            <Glide for={view} />
            {groups.map((g, gi) => (
              <S.Group key={gi}>
                {g.label && <S.Label className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-3">{g.label}</S.Label>}
                {g.options.map((o) => (
                  <S.Item key={o.value} value={enc(o.value)} disabled={o.disabled} className={`relative z-[1] flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-7 outline-none data-[disabled]:opacity-50 data-[state=checked]:font-medium pointer-coarse:min-h-11 ${o.value === "" ? "text-ink-3" : ""}`}>
                    <S.ItemText>{o.label}</S.ItemText>
                    <S.ItemIndicator className="absolute right-2 inline-flex"><Check size={14} aria-hidden /></S.ItemIndicator>
                  </S.Item>
                ))}
              </S.Group>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
    </span>
  );
}
