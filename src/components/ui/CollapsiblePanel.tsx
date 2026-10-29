"use client";

import { usePathname } from "next/navigation";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { Collapse } from "@/components/ui/Collapse";
import { ChevronDown } from "@/components/ui/icons";

const EVENT = "mp:panels";
const read = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};

/** A panel whose body can be folded away. The choice is remembered per page and panel on this device. */
export function CollapsiblePanel({ id, defaultOpen = true, head, actions, className, bodyClassName, children }: { id: string; defaultOpen?: boolean; head: ReactNode; actions?: ReactNode; className?: string; bodyClassName?: string; children: ReactNode }) {
  const key = `mp.panel.${usePathname()}.${id}`;
  const sub = useCallback((fn: () => void) => {
    window.addEventListener(EVENT, fn);
    return () => window.removeEventListener(EVENT, fn);
  }, []);
  const open = useSyncExternalStore(sub, () => read(key, defaultOpen), () => defaultOpen);
  const toggle = () => {
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      // not remembered
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return (
    <section className={`panel ${className ?? ""}`} aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <h2 id={`${id}-title`} className="min-w-0 text-[14px] font-medium text-ink-2">
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls={`${id}-body`} className="flex min-w-0 max-w-full items-center gap-2 rounded-[6px] py-1 pr-2 text-left hover:text-ink">
            <ChevronDown size={15} aria-hidden className={`shrink-0 text-ink-3 transition-transform duration-[var(--duration-fast)] ${open ? "" : "-rotate-90"}`} />
            {head}
          </button>
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-2 [&_form>div]:!mt-0">{actions}</div>}
      </div>
      <Collapse open={open} id={`${id}-body`}>
        <div className={`panel-body ${bodyClassName ?? ""}`}>{children}</div>
      </Collapse>
    </section>
  );
}
