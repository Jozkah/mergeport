import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { derivedDetail, listWorkItems } from "./queries";
import { formatDuration } from "@/lib/format";
import type { Fact } from "./ai";

/**
 * Looks up what the question is about in the local database, as the asking person is allowed to see it. The model is only
 * given these facts, so an answer can be checked against the linked items and cannot reach anything the person cannot open.
 */

const NUMBER = /(?:\b(?:pr|pull\s*request|pull|issue|bug|ticket)s?\s*#?\s*|#)(\d{1,6})\b|\b[\w.-]+\/[\w.-]+#(\d{1,6})\b/gi;
const HINT = /\b(?:from|by|in|on|of|for)\s+@?([A-Za-z0-9][\w.\/-]{1,60})/gi;
const STOP = new Set(["the", "a", "an", "my", "me", "this", "that", "it", "them", "now", "today", "status", "please", "pr", "issue", "pull", "request"]);

export function parseQuestion(q: string): { numbers: number[]; hints: string[]; type: "ISSUE" | "PULL_REQUEST" | undefined } {
  const numbers = [...new Set([...q.matchAll(NUMBER)].map((m) => Number(m[1] ?? m[2])))].slice(0, 5);
  const hints = [...new Set([...q.matchAll(HINT)].map((m) => m[1].replace(/[.,;:!?]+$/, "").toLowerCase()).filter((h) => !STOP.has(h) && !/^(?:pr|pull|issue|bug|ticket)s?\d*$/.test(h)))].slice(0, 4);
  const issue = /\b(?:issue|bug|ticket)s?(?![a-z])/i.test(q);
  const pr = /\b(?:pr|prs|pull)(?![a-z])/i.test(q);
  return { numbers, hints, type: issue && !pr ? "ISSUE" : pr && !issue ? "PULL_REQUEST" : undefined };
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "unknown");

export async function gatherFacts(db: Db, v: Viewer, question: string, now = new Date()): Promise<(Fact & { id: string })[]> {
  const { numbers, hints, type } = parseQuestion(question);
  const out: (Fact & { id: string })[] = [];
  const seen = new Set<string>();

  const found: Awaited<ReturnType<typeof listWorkItems>>["rows"] = [];
  for (const n of numbers) {
    const rows = (await listWorkItems(db, v, { type, state: "ALL", q: String(n), pageSize: 25 })).rows.filter((r) => r.number === n);
    const narrowed = hints.length ? rows.filter((r) => hints.some((h) => r.repository.fullName.toLowerCase().includes(h) || (r.authorLogin ?? "").toLowerCase().includes(h))) : rows;
    found.push(...(narrowed.length ? narrowed : rows).slice(0, 3));
  }
  // No number: look for the hint words in titles of open items.
  if (numbers.length === 0) {
    for (const h of hints.slice(0, 2)) found.push(...(await listWorkItems(db, v, { type, state: "OPEN", q: h, pageSize: 5 })).rows);
  }

  for (const r of found) {
    if (seen.has(r.id) || out.length >= 5) continue;
    seen.add(r.id);
    const kind = r.type === "PULL_REQUEST" ? "Pull request" : "Issue";
    const lines = [
      `${kind} ${r.repository.fullName}#${r.number}: ${r.title}`,
      `State: ${r.state}${r.draft ? " (draft)" : ""}. Author: ${r.authorLogin ?? "unknown"}. Opened ${day(r.createdAtGh)}, last updated ${day(r.updatedAtGh)}.`,
    ];
    if (r.type === "PULL_REQUEST") {
      lines.push(`Checks: ${r.checksState}. Merge conflicts: ${r.mergeable === "CONFLICTING" ? "yes" : r.mergeable === "MERGEABLE" ? "no" : "unknown"}.`);
      if (r.state === "OPEN") {
        try {
          const { derivation: d, dependencyBlockers } = await derivedDetail(db, v, r.id, now);
          lines.push(`Review status: ${String(d.primary).toLowerCase().replace(/_/g, " ")}.${d.waiting ? ` Waiting ${formatDuration(d.waiting.elapsedMs)}.` : ""}`);
          for (const x of d.explanation.slice(0, 3)) lines.push(x);
          if (dependencyBlockers) lines.push(`Blocked by ${dependencyBlockers} unfinished planning dependenc${dependencyBlockers === 1 ? "y" : "ies"}.`);
        } catch {
          // an item that cannot be derived is still reported with the facts above
        }
      }
    }
    out.push({ id: r.id, label: `${r.repository.fullName}#${r.number}`, href: `/${r.type === "PULL_REQUEST" ? "pull-requests" : "issues"}/${r.id}`, text: lines.join("\n") });
  }
  return out;
}
