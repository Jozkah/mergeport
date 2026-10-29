"use client";

import * as S from "@radix-ui/react-select";
import { Children, isValidElement, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from "react";
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
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; label?: string; children?: ReactNode; disabled?: boolean }>;
    if (el.type === "optgroup") {
      flush();
      groups.push({ label: el.props.label, options: Children.toArray(el.props.children).filter(isValidElement).map((o) => option(o as never)) });
    } else if (el.type === "option") loose.push(option(el as never));
    else if (el.type && typeof el.type !== "string") Children.forEach((el.props as { children?: ReactNode }).children, () => {}); // fragments are flattened by React.Children
  });
  flush();
  return groups;
}
const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : "");
const enc = (v: string) => (v === "" ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? "" : v);

export function Select({ children, className, id, name, defaultValue, value, onChange, required, disabled, "aria-label": ariaLabel, "aria-busy": ariaBusy }: {
  children: ReactNode;
  className?: string;
  id?: string;
  name?: string;
  defaultValue?: string | number;
  value?: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-busy"?: boolean;
}) {
  const view = useRef<HTMLDivElement>(null);
  const groups = collect(children);
  const all = groups.flatMap((g) => g.options);
  const [inner, setInner] = useState(defaultValue !== undefined ? String(defaultValue) : (all[0]?.value ?? ""));
  const current = value !== undefined ? String(value) : inner;
  const label = all.find((o) => o.value === current)?.label ?? all[0]?.label;
  return (
    <S.Root
      name={name}
      value={enc(current)}
      required={required}
      disabled={disabled}
      onValueChange={(v) => {
        setInner(dec(v));
        onChange?.({ target: { value: dec(v), name: name ?? "" }, currentTarget: { value: dec(v), name: name ?? "" } } as ChangeEvent<HTMLSelectElement>);
      }}
    >
      <S.Trigger id={id} aria-label={ariaLabel} aria-busy={ariaBusy} className={`${className ?? "select"} flex items-center justify-between gap-2 text-left`}>
        <span className="min-w-0 flex-1 truncate"><S.Value>{label}</S.Value></span>
        <S.Icon asChild><ChevronDown size={14} aria-hidden className="shrink-0 text-ink-3" /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} collisionPadding={8} className="select-pop z-[70] max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[var(--radix-select-trigger-width)] max-w-[min(32rem,calc(100vw-16px))] overflow-hidden rounded-[10px] border border-line bg-surface text-[13px] text-ink shadow-pop">
          <S.Viewport ref={view} className="relative max-h-[inherit] overflow-y-auto p-1">
            <Glide for={view} />
            {groups.map((g, gi) => (
              <S.Group key={gi}>
                {g.label && <S.Label className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-3">{g.label}</S.Label>}
                {g.options.map((o) => (
                  <S.Item key={o.value} value={enc(o.value)} disabled={o.disabled} className="relative z-[1] flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-7 outline-none data-[disabled]:opacity-50 data-[state=checked]:font-medium">
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
  );
}
