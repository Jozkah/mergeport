"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { createIssueAction, previewMarkdownAction } from "@/app/actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner } from "@/components/ui/primitives";
import { Check, ChevronDown } from "@/components/ui/icons";
import { BODY_MAX, TITLE_MAX } from "@/lib/github/write-text";

export type NewIssueRepo = { id: string; fullName: string; isDemo: boolean; /** Why an issue cannot be written there from here, or null. */ refusal: string | null };
type Draft = { repoId: string; title: string; body: string; labels: string };

const SAVE_MS = 600;

/** localStorage may be missing or throw (private mode, blocked site data): a draft is a convenience, never required. */
function readDraft(key: string): Partial<Draft> | null {
  try {
    const raw = window.localStorage.getItem(key);
    const d = raw ? (JSON.parse(raw) as unknown) : null;
    return d && typeof d === "object" ? (d as Partial<Draft>) : null;
  } catch {
    return null;
  }
}
function writeDraft(key: string, d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(key, JSON.stringify(d));
    else window.localStorage.removeItem(key);
  } catch {
    // storage unavailable: the form still works, the draft is just not kept
  }
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The new issue page. A searchable repository picker (combobox + listbox), title, body with Write / Preview, labels for demo repositories.
 * While typing, the form is kept as a draft in this browser (per signed-in person); nothing reaches GitHub until Create issue.
 */
export function NewIssueForm({ repos, preselect, draftKey }: { repos: NewIssueRepo[]; preselect: string | null; draftKey: string }) {
  const router = useRouter();
  const uid = useId();
  const fallbackRepo = preselect ?? (repos.length === 1 ? repos[0].id : "");
  const [repoId, setRepoId] = useState(fallbackRepo);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [restored, setRestored] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState<{ html: string } | { error: string } | null>(null);
  const [previewing, startPreview] = useTransition();
  const loaded = useRef(false); // no autosave before the stored draft was read (it would overwrite it with the empty form)
  const stopped = useRef(false); // after a successful submit nothing is saved again
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabs = useRef<Record<"write" | "preview", HTMLButtonElement | null>>({ write: null, preview: null });

  // Restore after mount (localStorage does not exist on the server). ?repo= wins for the repository; the draft fills the rest.
  useEffect(() => {
    if (loaded.current) return; // once per visit: a refresh of the page's data must not replace what is being typed
    const d = readDraft(draftKey);
    if (d) {
      const draftRepo = str(d.repoId);
      /* eslint-disable react-hooks/set-state-in-effect */
      if (!preselect && repos.some((r) => r.id === draftRepo)) setRepoId(draftRepo);
      setTitle(str(d.title));
      setBody(str(d.body));
      setLabels(str(d.labels));
      if (str(d.title) || str(d.body) || str(d.labels)) setRestored(true);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
    loaded.current = true;
  }, [draftKey, preselect, repos]);

  const empty = !title.trim() && !body.trim() && !labels.trim();
  const latest = useRef<Draft | null>(null); // what the pending save would write
  useEffect(() => {
    if (!loaded.current || stopped.current) return;
    if (timer.current) clearTimeout(timer.current);
    latest.current = empty ? null : { repoId, title, body, labels };
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!stopped.current) writeDraft(draftKey, latest.current);
    }, SAVE_MS);
  }, [draftKey, repoId, title, body, labels, empty]);
  // Leaving the page (a link, closing the tab) right after typing must not lose the last keystrokes: a pending save is written now.
  useEffect(() => {
    const flush = () => {
      if (!timer.current || stopped.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      writeDraft(draftKey, latest.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [draftKey]);

  const dropDraft = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    writeDraft(draftKey, null);
  };
  const discard = () => {
    dropDraft();
    setRepoId(fallbackRepo);
    setTitle("");
    setBody("");
    setLabels("");
    setRestored(false);
    setPreview(null);
    setTab("write");
  };

  const repo = repos.find((r) => r.id === repoId) ?? null;
  const pick = (t: "write" | "preview") => {
    setTab(t);
    if (t === "preview") {
      setPreview(null);
      startPreview(async () => {
        try {
          const r = await previewMarkdownAction(body);
          setPreview(r.ok ? { html: String(r.data?.html ?? "") } : { error: r.error });
        } catch {
          setPreview({ error: "Could not reach the server to render the preview." });
        }
      });
    }
  };
  const tabKeys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const to = tab === "write" ? "preview" : "write";
    const target = e.key === "Home" ? "write" : e.key === "End" ? "preview" : to;
    pick(target);
    tabs.current[target]?.focus();
  };

  const why = !repo ? "Choose a repository" : repo.refusal ? repo.refusal : !title.trim() ? "Give the issue a title" : undefined;

  return (
    <div className="max-w-3xl">
      {restored && (
        <div className="mb-4">
          <Banner tone="info" title="Draft restored">Your unsent issue from earlier is back. It is only in this browser; nothing was posted to GitHub.</Banner>
        </div>
      )}
      <ActionForm
        action={createIssueAction}
        submitLabel="Create issue"
        pendingLabel="Creating…"
        resetOnSuccess={false}
        submitDisabled={!!why}
        submitDisabledReason={why}
        secondary={<button type="button" className="btn" onClick={discard} disabled={empty}>Discard draft</button>}
        onDone={(r) => {
          if (!r.ok) return;
          stopped.current = true;
          dropDraft();
          router.push(String(r.data?.href ?? "/issues"));
          return true;
        }}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="label" htmlFor={`${uid}-repo`}>Repository</label>
            <RepoCombobox id={`${uid}-repo`} repos={repos} value={repoId} onChange={setRepoId} />
            <input type="hidden" name="repositoryId" value={repoId} />
          </div>
          {repo?.refusal && (
            <Banner tone="warn" title={`Issues cannot be created in ${repo.fullName} from here right now`}>{repo.refusal}</Banner>
          )}
          <div>
            <label className="label" htmlFor={`${uid}-title`}>Title</label>
            <input id={`${uid}-title`} name="title" className="input" required maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="label !mb-0" id={`${uid}-body-label`}>Description</span>
              <div className="seg" role="tablist" aria-label="Description">
                {(["write", "preview"] as const).map((t) => (
                  <button key={t} ref={(el) => void (tabs.current[t] = el)} type="button" role="tab" id={`${uid}-tab-${t}`} aria-selected={tab === t} aria-controls={`${uid}-panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => pick(t)} onKeyDown={tabKeys}>
                    {t === "write" ? "Write" : "Preview"}
                  </button>
                ))}
              </div>
            </div>
            {/* The textarea stays mounted (only hidden) in Preview, so submitting from there still posts the body. */}
            <div id={`${uid}-panel-write`} role="tabpanel" aria-labelledby={`${uid}-tab-write`} hidden={tab !== "write"}>
              <textarea id={`${uid}-body`} name="body" aria-labelledby={`${uid}-body-label`} className="textarea min-h-56" maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown. A single line break stays a line break, as on GitHub." />
            </div>
            <div id={`${uid}-panel-preview`} role="tabpanel" aria-labelledby={`${uid}-tab-preview`} hidden={tab !== "preview"} tabIndex={0} className="min-h-56 rounded-[10px] border border-line p-4" aria-busy={previewing}>
              {previewing || !preview ? (
                <p className="text-[13px] text-ink-3">Rendering…</p>
              ) : "error" in preview ? (
                <p role="alert" className="text-[13px] text-blocked">{preview.error}</p>
              ) : preview.html ? (
                <div className="md" dangerouslySetInnerHTML={{ __html: preview.html }} />
              ) : (
                <p className="text-[13px] text-ink-3">Nothing to preview.</p>
              )}
            </div>
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-labels`}>Labels (comma separated)</label>
            <input id={`${uid}-labels`} name="labels" className="input" value={labels} onChange={(e) => setLabels(e.target.value)} disabled={!!repo && !repo.isDemo} aria-describedby={`${uid}-labels-note`} />
            <p id={`${uid}-labels-note`} className="mt-1 text-[12px] text-ink-3">
              {repo && !repo.isDemo ? "Labels are not sent to GitHub from Mergeport. Add them on GitHub after the issue is created." : "Applied in demo repositories."}
            </p>
          </div>
        </div>
      </ActionForm>
    </div>
  );
}

/**
 * Type to filter the repositories, arrows to move, Enter to choose, Escape to close. ARIA 1.2 combobox with a listbox popup;
 * focus stays in the input and the active option is announced through aria-activedescendant.
 */
function RepoCombobox({ id, repos, value, onChange }: { id: string; repos: NewIssueRepo[]; value: string; onChange: (id: string) => void }) {
  const listId = `${id}-list`;
  const selected = repos.find((r) => r.id === value) ?? null;
  const [query, setQuery] = useState<string | null>(null); // null: not searching, the input shows the chosen repository
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const q = (query ?? "").trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  const activeId = open && matches[active] ? `${listId}-${matches[active].id}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (r: NewIssueRepo) => {
    onChange(r.id);
    setQuery(null);
    setOpen(false);
  };
  const close = () => {
    setQuery(null);
    setOpen(false);
  };
  const openAt = (i: number) => {
    setOpen(true);
    setActive(Math.max(0, i));
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openAt(Math.max(0, matches.findIndex((r) => r.id === value)));
      else setActive((a) => Math.min(matches.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openAt(Math.max(0, matches.findIndex((r) => r.id === value)));
      else setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(matches.length - 1);
    } else if (e.key === "Enter") {
      // Enter chooses while the list is open; it never submits the form from here.
      if (open || query !== null) e.preventDefault();
      if (open && matches[active]) choose(matches[active]);
    } else if (e.key === "Escape") {
      if (open || query !== null) {
        e.preventDefault();
        close();
      }
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-required
        autoComplete="off"
        spellCheck={false}
        className="input !pr-8"
        placeholder="Type to search repositories"
        value={query ?? selected?.fullName ?? ""}
        onChange={(e) => {
          setQuery(e.target.value);
          openAt(0);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onClick={() => setOpen(true)}
        onBlur={(e) => {
          if (!list.current?.contains(e.relatedTarget as Node | null)) close();
        }}
        onKeyDown={keys}
      />
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2.5 top-[9px] text-ink-3" />
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Repositories"
        hidden={!open}
        className="absolute left-0 right-0 top-full z-[70] mt-1 max-h-[22rem] overflow-y-auto overscroll-contain rounded-[10px] border border-line bg-surface p-1 text-[13px] text-ink shadow-pop"
      >
        {matches.length === 0 && <li className="px-2 py-1.5 text-ink-3">No repository matches. Only repositories you may create issues in are listed.</li>}
        {matches.map((r, i) => (
          <li
            key={r.id}
            id={`${listId}-${r.id}`}
            role="option"
            aria-selected={r.id === value}
            // mousedown, not click: the input keeps focus and its blur does not close the list first
            onMouseDown={(e) => {
              e.preventDefault();
              choose(r);
            }}
            onMouseMove={() => setActive(i)}
            className={`relative flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-7 pointer-coarse:min-h-11 ${i === active ? "bg-hover" : ""} ${r.id === value ? "font-medium" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
            {r.refusal && <span className="shrink-0 text-[11.5px] text-ink-3">cannot write here</span>}
            {r.id === value && <Check size={14} aria-hidden className="absolute right-2" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
