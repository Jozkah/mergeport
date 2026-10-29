"use client";

import { useRef, useState, useTransition } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useRouter } from "next/navigation";
import { addCheckItemsAction, deleteCheckItemAction, editCheckItemAction, moveCheckItemAction, setCheckItemAction } from "@/app/task-actions";
import { Check, GripVertical, Pencil, Plus, Trash2, X } from "@/components/ui/icons";
import { useToast } from "@/components/ui/ToastProvider";

type Item = { id: string; text: string; done: boolean; doneByLogin: string | null };

/**
 * The checklist of one task. Ticking is optimistic and rolls back with a message if it fails; reordering works by dragging the
 * handle or with the keyboard (focus the handle, Space, arrows, Space). Items are real checkboxes with real labels.
 */
export function Checklist({ taskId, items: initial }: { taskId: string; items: Item[] }) {
  const router = useRouter();
  const { show: say } = useToast();
  const [items, setItems] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    // The server list changed (another computer, a refresh): it wins over what was shown.
    setSeen(initial);
    setItems(initial);
  }
  const [, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const fail = (msg: string, back: Item[]) => {
    setItems(back);
    say("error", msg);
  };

  const toggle = (it: Item) => {
    const before = items;
    setItems(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    start(async () => {
      const r = await setCheckItemAction({ id: it.id, done: !it.done });
      if (!r.ok) fail(r.error, before);
      else router.refresh();
    });
  };

  const remove = (it: Item) => {
    const before = items;
    setItems(items.filter((x) => x.id !== it.id));
    start(async () => {
      const r = await deleteCheckItemAction({ id: it.id, taskId });
      if (!r.ok) fail(r.error, before);
    });
  };

  const saveEdit = (it: Item) => {
    const text = draft.trim();
    setEditing(null);
    if (!text || text === it.text) return;
    const before = items;
    setItems(items.map((x) => (x.id === it.id ? { ...x, text } : x)));
    start(async () => {
      const r = await editCheckItemAction({ id: it.id, text });
      if (!r.ok) fail(r.error, before);
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((x) => x.id === active.id);
    const to = items.findIndex((x) => x.id === over.id);
    if (from < 0 || to < 0) return;
    const before = items;
    const next = arrayMove(items, from, to);
    setItems(next);
    const afterId = to === 0 ? null : next[to - 1].id;
    start(async () => {
      const r = await moveCheckItemAction({ id: String(active.id), afterId, taskId });
      if (!r.ok) fail(r.error, before);
    });
  };

  const add = () => {
    const text = adding;
    if (!text.trim()) return;
    setAdding("");
    start(async () => {
      const fd = new FormData();
      fd.set("id", taskId);
      fd.set("text", text);
      const r = await addCheckItemsAction(fd);
      if (!r.ok) {
        setAdding(text);
        say("error", r.error);
      } else router.refresh();
      addRef.current?.focus();
    });
  };

  return (
    <div className="p-4">
      {items.length > 0 && (
        <div className="mb-3 flex items-center gap-3 text-[12.5px] text-ink-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-label="Checklist progress">
            <div className="h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums">{done} of {items.length}</span>
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col">
            {items.map((it) => (
              <Row key={it.id} it={it} editing={editing === it.id} draft={draft} setDraft={setDraft} onToggle={() => toggle(it)} onEdit={() => { setEditing(it.id); setDraft(it.text); }} onSave={() => saveEdit(it)} onCancel={() => setEditing(null)} onDelete={() => remove(it)} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Plus size={14} aria-hidden className="shrink-0 text-ink-3" />
        <input ref={addRef} value={adding} onChange={(e) => setAdding(e.target.value)} className="input" placeholder="Add an item (paste several lines to add several)" aria-label="Add a checklist item" maxLength={20000} />
        <button className="btn" type="submit" disabled={!adding.trim()}>Add</button>
      </form>
    </div>
  );
}

function Row({ it, editing, draft, setDraft, onToggle, onEdit, onSave, onCancel, onDelete }: { it: Item; editing: boolean; draft: string; setDraft: (s: string) => void; onToggle: () => void; onEdit: () => void; onSave: () => void; onCancel: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: it.id });
  const id = `ck-${it.id}`;
  return (
    <li ref={setNodeRef} style={{ transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }} className={`group flex items-center gap-2 rounded-[8px] py-1 pr-1 ${isDragging ? "bg-hover opacity-80" : "hover:bg-hover"}`}>
      <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7 cursor-grab touch-none text-ink-3" aria-label={`Reorder “${it.text}”`} {...attributes} {...listeners}><GripVertical size={14} aria-hidden /></button>
      <input id={id} type="checkbox" checked={it.done} onChange={onToggle} className="h-4 w-4 shrink-0 accent-[var(--ok,#2ea043)]" />
      {editing ? (
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} className="input !h-8" maxLength={200} aria-label="Edit checklist item" />
          <button className="btn btn-quiet btn-icon !h-7 !w-7" type="submit" aria-label="Save item"><Check size={14} aria-hidden /></button>
          <button className="btn btn-quiet btn-icon !h-7 !w-7" type="button" onClick={onCancel} aria-label="Cancel editing"><X size={14} aria-hidden /></button>
        </form>
      ) : (
        <>
          <label htmlFor={id} className={`min-w-0 flex-1 cursor-pointer break-words text-[13.5px] ${it.done ? "text-ink-3 line-through" : "text-ink"}`}>{it.text}</label>
          <span className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7" onClick={onEdit} aria-label={`Edit “${it.text}”`}><Pencil size={13} aria-hidden /></button>
            <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7" onClick={onDelete} aria-label={`Delete “${it.text}”`}><Trash2 size={13} aria-hidden /></button>
          </span>
        </>
      )}
    </li>
  );
}
