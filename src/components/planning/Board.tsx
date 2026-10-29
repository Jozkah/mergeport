"use client";

import { Select } from "@/components/ui/Select";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Ban, Hourglass, CalendarDays, GripVertical } from "@/components/ui/icons";
import { useToast } from "@/components/ui/ToastProvider";
import { Metric } from "@/components/ui/Metric";
import { SMOOTH_OUT_GSAP, seconds, useReducedMotion } from "@/lib/motion";
import { LabelChip, Mono } from "@/components/ui/primitives";
import { moveCardAction } from "@/app/actions";
import { positionBetween } from "@/lib/domain/planning";
import type { CardView } from "@/lib/services/planning-view";

type Col = { id: string; key: string; name: string };

function CardBody({ c, move, handle }: { c: CardView; move?: React.ReactNode; handle?: React.ReactNode }) {
  return (
    <div className="relative rounded-[10px] border border-line bg-surface p-3 text-[13px] shadow-hair">
      {handle}
      <p className={`font-medium leading-[1.35] [overflow-wrap:anywhere] ${handle ? "pr-6" : ""}`}>{c.href ? <a href={c.href} className="hover:underline">{c.title}</a> : c.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
        {c.isDraft ? <span>Internal task</span> : <Mono title={c.repoFullName ?? ""}>{c.repoFullName}#{c.number}</Mono>}
        {c.priority > 0 && <span className="tnum">P{c.priority}</span>}
        {c.milestoneName && <span className="truncate" title={c.milestoneName}>{c.milestoneName}</span>}
      </div>
      {c.labels.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{c.labels.slice(0, 3).map((l) => <LabelChip key={l.name} {...l} />)}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
        {c.due && <span className={`inline-flex items-center gap-1 tnum ${c.overdue ? "text-blocked" : "text-ink-3"}`}><CalendarDays size={12} aria-hidden />{c.overdue ? "Overdue " : "Due "}{c.dueLabel}</span>}
        {c.assignee && <span className="text-ink-3">@{c.assignee}</span>}
        {c.waitingOn && <span className="inline-flex items-center gap-1 text-waiting" title={c.waitingSince ?? undefined}><Hourglass size={12} aria-hidden />Waiting on {c.waitingOn}</span>}
        {c.blockedBy > 0 && <span className="inline-flex items-center gap-1 text-blocked"><Ban size={12} aria-hidden />Blocked by {c.blockedBy}{c.hiddenBlockers > 0 ? ` (${c.hiddenBlockers} not visible to you)` : ""}</span>}
      </div>
      {move}
    </div>
  );
}

type Fx = { enter: Set<string>; ring: Set<string>; ghosts: { card: CardView; key: string; index: number }[] };
const NO_FX: Fx = { enter: new Set(), ring: new Set(), ghosts: [] };

function SortableCard({ c, cols, onMove, disabled, fx }: { c: CardView; cols: Col[]; onMove: (id: string, key: string) => void; disabled: boolean; fx: Fx }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: c.id, disabled: !c.canMove || disabled, data: { columnKey: c.columnKey } });
  return (
    <li ref={setNodeRef} data-flip-id={c.id} data-col={c.columnKey} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition: transition ?? undefined, opacity: isDragging ? 0.4 : 1 }}>
      {/* Pointer dragging works from anywhere on the card. Keyboard and assistive-technology dragging live on the handle, so the card's link and Move select stay ordinary, readable controls. */}
      <div onPointerDown={c.canMove ? (listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined) : undefined} className={`${c.canMove ? "cursor-grab active:cursor-grabbing" : ""} ${fx.enter.has(c.id) ? "card-enter" : ""} ${fx.ring.has(c.id) ? "card-landed" : ""}`}>
        <CardBody
          c={c}
          handle={
            c.canMove ? (
              <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} className="btn btn-quiet btn-icon absolute right-1 top-1 !h-7 !w-7 cursor-grab touch-none" aria-label={`Drag “${c.title}” with the keyboard: press Space to lift, arrow keys to move, Space to drop`}>
                <GripVertical size={14} aria-hidden />
              </button>
            ) : undefined
          }
          move={
            c.canMove ? (
              <div className="mt-2" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <label className="sr-only" htmlFor={`mv-${c.id}`}>Move “{c.title}” to column</label>
                <Select id={`mv-${c.id}`} className="select !h-7 !text-[12px]" value={c.columnKey} onChange={(e) => { if (!disabled) onMove(c.id, e.target.value); }} aria-busy={disabled}>
                  {cols.map((col) => <option key={col.key} value={col.key}>Move to: {col.name}</option>)}
                </Select>
              </div>
            ) : (
              <p className="mt-2 text-[11.5px] text-ink-3">Moving needs a grant that includes managing work in this repository.</p>
            )
          }
        />
      </div>
    </li>
  );
}

const COLUMN_PAGE = 40;

function Column({ col, cards: allCards, cols, onMove, busy, fx }: { col: Col; cards: CardView[]; cols: Col[]; onMove: (id: string, key: string) => void; busy: boolean; fx: Fx }) {
  const { setNodeRef, isOver } = useDroppable({ id: "col:" + col.key });
  const [limit, setLimit] = useState(COLUMN_PAGE);
  const cards = allCards.slice(0, limit); // a long column renders in pages; the count in the header is the real one
  return (
    <section aria-labelledby={`col-${col.key}`} className="flex min-h-0 min-w-[272px] flex-1 basis-[272px] flex-col rounded-[12px] border border-line bg-canvas p-2">
      <h3 id={`col-${col.key}`} className="mb-2 flex items-center justify-between px-1.5 text-[13px] font-medium text-ink-2">{col.name}<span className="rounded-full bg-muted px-2 text-[11.5px] leading-5"><Metric value={allCards.length} /></span></h3>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={`flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-[8px] p-1 transition-colors duration-[var(--duration-feedback)] ${isOver ? "bg-muted" : ""}`}>
          {(() => {
            // A card that left (a teammate removed it) lingers for one short exit, in its old place, so the list does not jump.
            const rows: React.ReactNode[] = cards.map((c) => <SortableCard key={c.id} c={c} cols={cols} onMove={onMove} disabled={busy} fx={fx} />);
            for (const g of fx.ghosts.filter((x) => x.key === col.key)) rows.splice(Math.min(g.index, rows.length), 0, <li key={"ghost-" + g.card.id} aria-hidden inert className="card-ghost"><div><CardBody c={g.card} /></div></li>);
            return rows;
          })()}
          {allCards.length > limit && <li><button type="button" className="btn w-full" onClick={() => setLimit((n) => n + COLUMN_PAGE)}>Show {Math.min(COLUMN_PAGE, allCards.length - limit)} more ({allCards.length - limit} hidden)</button></li>}
          {cards.length === 0 && fx.ghosts.every((g) => g.key !== col.key) && <li className="rounded-[8px] border border-dashed border-line-strong px-3 py-5 text-center text-[12px] text-ink-3">No cards</li>}
        </ul>
      </SortableContext>
    </section>
  );
}

/**
 * Board with optimistic moves. Every move is sent with the card's version; a conflict or failure rolls the card
 * back to where it was and tells the person. Keyboard: the per-card "Move to" select, or dnd-kit's keyboard drag.
 */
export function Board({ columns, initial }: { columns: Col[]; initial: CardView[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initial);
  const { show: say } = useToast();
  const reduce = useReducedMotion();
  const [fx, setFx] = useState<Fx>(NO_FX);
  const [ownIds, setOwnIds] = useState<ReadonlySet<string>>(new Set()); // cards this person just moved: their own echo is not a "remote change"
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, { x: number; y: number }>());
  const columnOf = useRef(new Map<string, string>());
  const pointerOwns = useRef(false);
  const dragging = useRef(false);
  const refocus = useRef<string | null>(null);
  const [active, setActive] = useState<CardView | null>(null);
  const [pending, start] = useTransition();
  const inflight = useRef(new Set<string>());

  // A fresh server render replaces local state (e.g. after router.refresh()). Adjusting state during render is the
  // documented alternative to an effect here.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    // What actually changed, so ONLY that moves: new cards rise in, removed cards leave from their old place, and a card a
    // teammate edited shows one ring. Unchanged cards are left completely alone (no replay on a poll or a refresh).
    const before = new Map(cards.map((c) => [c.id, c]));
    const enter = new Set<string>();
    const ring = new Set<string>();
    for (const c of initial) {
      const old = before.get(c.id);
      if (!old) enter.add(c.id);
      else if (!ownIds.has(c.id) && (old.version !== c.version || old.title !== c.title || old.columnKey !== c.columnKey)) ring.add(c.id);
    }
    const ghosts: Fx["ghosts"] = [];
    const kept = new Set(initial.map((c) => c.id));
    for (const c of cards) if (!kept.has(c.id)) ghosts.push({ card: c, key: c.columnKey, index: cards.filter((x) => x.columnKey === c.columnKey && x.position < c.position).length });
    if (enter.size || ring.size || ghosts.length) setFx({ enter, ring, ghosts });
    setCards(initial);
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const byCol = useCallback((key: string, list = cards) => list.filter((c) => c.columnKey === key).sort((a, b) => a.position - b.position), [cards]);

  const commit = useCallback((id: string, toKey: string, index: number | null) => {
    if (inflight.current.has(id)) return;
    const before = cards;
    const card = before.find((c) => c.id === id);
    if (!card) return;
    const target = byCol(toKey, before).filter((c) => c.id !== id);
    const at = index === null ? target.length : Math.min(index, target.length);
    const position = positionBetween(target[at - 1]?.position ?? null, target[at]?.position ?? null);
    if (card.columnKey === toKey && target.findIndex((c) => c.position > card.position) === -1 && index === null) return;
    inflight.current.add(id);
    setOwnIds((s) => new Set(s).add(id));
    setTimeout(() => setOwnIds((s) => { const n = new Set(s); n.delete(id); return n; }), 4000);
    setCards(before.map((c) => (c.id === id ? { ...c, columnKey: toKey, position } : c)));
    start(async () => {
      const r = await moveCardAction({ itemId: id, toColumnKey: toKey, beforePosition: target[at - 1]?.position ?? null, afterPosition: target[at]?.position ?? null, expectedVersion: card.version }).catch(
        () => ({ ok: false as const, error: "Could not reach the server", retryable: false }),
      );
      inflight.current.delete(id);
      if (r.ok) {
        setCards((cur) => cur.map((c) => (c.id === id ? { ...c, version: r.version ?? c.version + 1 } : c)));
        say("ok", `Moved “${card.title}” to ${columns.find((c) => c.key === toKey)?.name}.`);
      } else {
        if (!document.activeElement || document.activeElement === document.body) refocus.current = id; // the roll-back re-mounts the card; keep a keyboard user's place
        setCards(before); // roll back
        say("error", `${r.error.replace(/[.!?]?$/, ".")} ${r.retryable ? "The board was reloaded with the latest state." : "The card was returned to its previous column."}`);
        if (r.retryable) router.refresh();
      }
    });
  }, [cards, byCol, columns, router, say]);

  function onDragStart(e: DragStartEvent) {
    pointerOwns.current = true;
    dragging.current = true;
    setActive(cards.find((c) => c.id === e.active.id) ?? null);
  }
  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    dragging.current = false;
    // dnd-kit owns every transform until the drop has rendered; the layout animation below stays out of its way.
    requestAnimationFrame(() => requestAnimationFrame(() => (pointerOwns.current = false)));
    const { active: a, over } = e;
    if (!over) return;
    const id = String(a.id);
    const overId = String(over.id);
    if (overId.startsWith("col:")) return commit(id, overId.slice(4), null);
    const overCard = cards.find((c) => c.id === overId);
    if (!overCard || overCard.id === id) return;
    const col = byCol(overCard.columnKey).filter((c) => c.id !== id);
    commit(id, overCard.columnKey, col.findIndex((c) => c.id === overId));
  }

  // Positions of every card relative to the board's own content box, so scrolling and page position never count as movement.
  const measure = useCallback(() => {
    const host = content.current;
    const out = new Map<string, { x: number; y: number }>();
    if (!host) return out;
    const origin = host.getBoundingClientRect();
    host.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((li) => {
      const r = li.getBoundingClientRect();
      // A column scrolls on its own; add its scroll offset so scrolling alone never reads as a card moving.
      const list = li.parentElement;
      out.set(li.dataset.flipId as string, { x: r.left - origin.left, y: r.top - origin.top + (list?.scrollTop ?? 0) });
    });
    return out;
  }, []);

  // Cards that changed place for any reason other than the pointer (the Move select, a teammate's edit arriving, a
  // rollback) glide from where they were. Only the inner wrapper is animated: the <li> belongs to dnd-kit.
  const layoutKey = cards.map((c) => `${c.id}:${c.columnKey}:${c.position}`).join("|");
  useGSAP(
    () => {
      const host = content.current;
      if (!host) return;
      if (dragging.current) {
        rects.current = new Map(); // mid-drag rectangles include dnd-kit's transforms; the next change then starts from a fresh measurement
        return;
      }
      const next = measure();
      const reducedNow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      host.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((li) => {
        const id = li.dataset.flipId as string;
        const pos = next.get(id)!;
        const prev = rects.current.get(id);
        const inner = li.firstElementChild as HTMLElement | null;
        const col = li.dataset.col as string;
        const changedColumn = columnOf.current.get(id) !== col;
        columnOf.current.set(id, col);
        if (!prev || !inner || pointerOwns.current) return;
        const dx = prev.x - pos.x + Number(gsap.getProperty(inner, "x"));
        const dy = prev.y - pos.y + Number(gsap.getProperty(inner, "y"));
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        if (reducedNow) {
          // No glide: only a card that really changed column (and was not moved by this person) gets the one-off outline.
          if (!changedColumn || ownIds.has(id)) return;
          inner.classList.remove("card-landed");
          void inner.offsetWidth;
          inner.classList.add("card-landed");
          return;
        }
        gsap.fromTo(inner, { x: dx, y: dy }, { x: 0, y: 0, duration: seconds("--duration-fast", 0.25), ease: SMOOTH_OUT_GSAP, overwrite: "auto", clearProps: "transform" });
      });
      rects.current = next;
    },
    { dependencies: [layoutKey], scope: root, revertOnUpdate: false },
  );

  // The effects end on their own; clear them so a later, unrelated render never replays them. Cards below a collapsed
  // ghost have moved by then, so measure again first: the next glide must start from where they really are.
  useEffect(() => {
    if (fx === NO_FX) return;
    const t = setTimeout(() => {
      if (!dragging.current) rects.current = measure();
      setFx(NO_FX);
    }, 1400);
    return () => clearTimeout(t);
  }, [fx, measure]);

  // Re-measure (without animating) when the board is resized or text rewraps, so the next move glides from where cards really are.
  useEffect(() => {
    const host = content.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!dragging.current) rects.current = measure();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure]);

  // A card that changed column is re-mounted under another list; hand keyboard focus back to its Move select.
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    document.getElementById(`mv-${id}`)?.focus({ preventScroll: true });
  }, [layoutKey]);

  return (
    <div ref={root}>
      <DndContext id="planning-board" sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActive(null); dragging.current = false; pointerOwns.current = false; }}>
        {/* The board scrolls inside its own region; it never widens the page. */}
        <div className="relative h-[calc(100dvh-19rem)] min-h-[22rem] max-w-full overflow-x-auto pb-3" tabIndex={0} role="region" aria-label="Planning board (scrolls horizontally; each column scrolls vertically)">
          <div ref={content} className="flex h-full min-w-max gap-3 xl:min-w-full">
            {columns.map((col) => <Column key={col.key} col={col} cols={columns} cards={byCol(col.key)} onMove={(id, key) => { refocus.current = id; commit(id, key, null); }} busy={pending} fx={fx} />)}
          </div>
        </div>
        <DragOverlay dropAnimation={reduce ? null : { duration: seconds("--duration-fast", 0.25) * 1000, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>{active ? <div className="w-[256px] rotate-0"><CardBody c={active} /></div> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
