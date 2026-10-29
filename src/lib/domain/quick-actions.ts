/**
 * Quick actions: short commands typed on a line of their own, in the command palette or a comment box.
 *
 *   /assign @alice   /assign me   /unassign
 *   /priority high   (none, low, medium, high, urgent, or 0-4)
 *   /due 2026-11-05  (or "none")
 *   /label bug, ~ui  /unlabel bug
 *   /move in-progress   (a column key or its name)
 *
 * Pure: this only reads text into a list of intended changes. Nothing is applied here; the caller previews every change first and runs
 * each one through the same authorization as the matching button.
 */
export type QuickOp =
  | { kind: "assign"; login: string | "me" }
  | { kind: "unassign" }
  | { kind: "priority"; value: number }
  | { kind: "due"; date: string | null }
  | { kind: "label"; names: string[] }
  | { kind: "unlabel"; names: string[] }
  | { kind: "move"; column: string };

export type ParsedQuick = { ops: QuickOp[]; errors: string[]; rest: string };

const PRIORITY: Record<string, number> = { none: 0, low: 1, medium: 2, med: 2, high: 3, urgent: 4 };
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const names = (arg: string) => arg.split(/[,\s]+/).map((s) => s.replace(/^~/, "").trim()).filter(Boolean).slice(0, 20);

export function parseQuickActions(text: string): ParsedQuick {
  const ops: QuickOp[] = [];
  const errors: string[] = [];
  const rest: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(line);
    if (!m) {
      rest.push(raw);
      continue;
    }
    const cmd = m[1].toLowerCase();
    const arg = (m[2] ?? "").trim();
    if (cmd === "assign") {
      const who = arg.replace(/^@/, "");
      if (who.toLowerCase() === "me") ops.push({ kind: "assign", login: "me" });
      else if (LOGIN.test(who)) ops.push({ kind: "assign", login: who });
      else errors.push(`/assign needs a GitHub username, like /assign @alice (got "${arg}")`);
    } else if (cmd === "unassign") ops.push({ kind: "unassign" });
    else if (cmd === "priority") {
      const key = arg.toLowerCase();
      const n = key in PRIORITY ? PRIORITY[key] : /^[0-4]$/.test(key) ? Number(key) : NaN;
      if (Number.isNaN(n)) errors.push(`/priority takes none, low, medium, high, urgent or 0 to 4 (got "${arg}")`);
      else ops.push({ kind: "priority", value: n });
    } else if (cmd === "due") {
      if (arg.toLowerCase() === "none") ops.push({ kind: "due", date: null });
      else if (/^\d{4}-\d{2}-\d{2}$/.test(arg) && !Number.isNaN(Date.parse(arg + "T00:00:00Z"))) ops.push({ kind: "due", date: arg });
      else errors.push(`/due takes a date like 2026-11-05, or "none" (got "${arg}")`);
    } else if (cmd === "label" || cmd === "unlabel") {
      const n = names(arg);
      if (n.length === 0) errors.push(`/${cmd} needs at least one label`);
      else ops.push({ kind: cmd, names: n });
    } else if (cmd === "move") {
      if (!arg) errors.push("/move needs a column, like /move in-progress");
      else ops.push({ kind: "move", column: arg });
    } else errors.push(`Unknown command /${cmd}. Try /assign, /priority, /due, /label, /unlabel or /move`);
  }
  if (ops.length > 12) errors.push("At most 12 commands at a time");
  return { ops: ops.slice(0, 12), errors, rest: rest.join("\n").trim() };
}
