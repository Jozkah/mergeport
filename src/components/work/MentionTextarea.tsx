"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { mentionSuggestionsAction } from "@/app/actions";
import { Avatar } from "@/components/ui/Avatar";
import { CircleDot, GitPullRequest } from "@/components/ui/icons";
import { insertMention, mentionToken, mentionTrigger, type MentionSuggestion, type MentionTrigger } from "@/lib/mentions";

const DEBOUNCE_MS = 200;

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange"> & {
  /** Suggestions come from this repository only; none while it is not chosen. */
  repositoryId: string | null;
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
};

/**
 * A GitHub text box with mentions: `@` and a few letters suggests people known for the repository, `#` and digits or words its
 * issues and pull requests. Arrows move, Enter or Tab inserts `@login ` / `#123 ` at the caret, Escape closes, a click works too.
 * The textarea keeps its own multi-line textbox role (a combobox role would turn it into a one-line field for screen readers); the
 * listbox is tied to it with aria-controls / aria-activedescendant and a status line announces the suggestions.
 * Controlled (`value` + `onValueChange`) or not (then it follows its form's reset).
 */
export function MentionTextarea({ repositoryId, value, defaultValue, onValueChange, onKeyDown, onBlur, ...rest }: Props) {
  const listId = `${useId()}-mentions`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [inner, setInner] = useState(defaultValue ?? "");
  const text = value ?? inner;
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [found, setFound] = useState<{ key: string; items: MentionSuggestion[] }>({ key: "", items: [] });
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null); // Escape closes the list for this one mention
  const caretAfter = useRef<number | null>(null);
  const seq = useRef(0);

  const key = trigger && repositoryId ? `${repositoryId}|${trigger.kind}|${trigger.query}` : "";
  const items = key && found.key === key ? found.items : [];
  const open = !!trigger && items.length > 0 && closedAt !== trigger.start;
  const activeId = open ? `${listId}-${Math.min(active, items.length - 1)}` : undefined;

  const setText = (v: string) => {
    if (value === undefined) setInner(v);
    onValueChange?.(v);
  };

  // Uncontrolled inside a form (the demo comment box): the form's reset after posting empties it.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form || value !== undefined) return;
    const reset = () => setInner(defaultValue ?? "");
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [value, defaultValue]);

  // After an insertion the caret goes right after it, not to the end where the re-render leaves it.
  useLayoutEffect(() => {
    if (caretAfter.current === null || !ref.current) return;
    ref.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  useEffect(() => {
    if (!key || !trigger || !repositoryId) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      mentionSuggestionsAction({ repositoryId, kind: trigger.kind, query: trigger.query })
        .then((r) => {
          if (mine !== seq.current) return; // an older answer arriving late
          setFound({ key, items: r.ok && Array.isArray(r.data?.items) ? (r.data.items as MentionSuggestion[]) : [] });
          setActive(0);
        })
        .catch(() => {
          if (mine === seq.current) setFound({ key, items: [] });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, trigger, repositoryId]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const look = (el: HTMLTextAreaElement) => {
    const t = el.selectionStart === el.selectionEnd ? mentionTrigger(el.value, el.selectionStart) : null;
    setTrigger((prev) => (prev && t && prev.kind === t.kind && prev.query === t.query && prev.start === t.start ? prev : t));
  };

  const choose = (s: MentionSuggestion) => {
    const el = ref.current;
    if (!el || !trigger) return;
    const r = insertMention(text, trigger.start, el.selectionStart, mentionToken(s));
    caretAfter.current = r.caret;
    setTrigger(null);
    setText(r.text);
    el.focus();
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.nativeEvent.isComposing) {
      const last = items.length - 1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setActive((a) => (a >= last ? 0 : a + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setActive((a) => (a <= 0 ? last : a - 1));
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return choose(items[Math.min(active, last)]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // a surrounding sheet must not close as well
        return setClosedAt(trigger.start);
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <textarea
        {...rest}
        ref={ref}
        value={text}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeId}
        onChange={(e) => {
          setText(e.target.value);
          look(e.target);
        }}
        onSelect={(e) => look(e.currentTarget)}
        onKeyDown={keys}
        onBlur={(e) => {
          setTrigger(null);
          onBlur?.(e);
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={trigger?.kind === "item" ? "Issues and pull requests" : "People"}
        hidden={!open}
        className="absolute left-0 right-0 top-full z-[70] mt-1 max-h-[18rem] overflow-y-auto overscroll-contain rounded-[10px] border border-line bg-surface p-1 text-[13px] text-ink shadow-pop sm:right-auto sm:w-[26rem] sm:max-w-full"
      >
        {open &&
          items.map((s, i) => (
            <li
              key={s.kind === "user" ? s.login : s.number}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: the textarea keeps focus and its blur does not close the list first
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseMove={() => setActive(i)}
              className={`flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 pointer-coarse:min-h-11 ${i === active ? "bg-hover" : ""}`}
            >
              {s.kind === "user" ? (
                <>
                  <Avatar login={s.login} url={s.avatar} size={18} />
                  <span className="min-w-0 flex-1 truncate">{s.login}</span>
                </>
              ) : (
                <>
                  {s.type === "PULL_REQUEST" ? <GitPullRequest size={14} aria-hidden className="shrink-0 text-ink-3" /> : <CircleDot size={14} aria-hidden className="shrink-0 text-ink-3" />}
                  <span className="tnum shrink-0 text-ink-3">#{s.number}</span>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-3">
                    {s.type === "PULL_REQUEST" ? "PR" : "Issue"}, {s.state.toLowerCase()}
                  </span>
                </>
              )}
            </li>
          ))}
      </ul>
      <p role="status" className="sr-only">{open ? `${items.length} suggestion${items.length === 1 ? "" : "s"}. Arrow keys to move, Enter to insert, Escape to close.` : ""}</p>
    </div>
  );
}
