/**
 * Synthetic file contents for demo mode, so the code browser and the pull request diff have something real to show. Everything
 * here is made up. A pull request's diff is computed from an old and a new version, so line numbers and context always agree.
 */

const README = `# Atlas

A small web app used to demonstrate Mergeport. Nothing here is real.

## Getting started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Layout

| Folder | What lives there |
| --- | --- |
| \`src/\` | Application code |
| \`docs/\` | Notes |

- [x] Sessions
- [x] Formatting helpers
- [ ] Billing
`;

const PACKAGE_JSON = `{
  "name": "atlas",
  "version": "1.4.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
`;

const SESSION_OLD = `import { randomBytes } from "node:crypto";

export type Session = {
  id: string;
  userId: string;
  expiresAt: number;
};

const store = new Map<string, Session>();
const TTL_MS = 1000 * 60 * 60;

export function createSession(userId: string): Session {
  const session: Session = {
    id: randomBytes(16).toString("hex"),
    userId,
    expiresAt: Date.now() + TTL_MS,
  };
  store.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | null {
  const session = store.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return session;
}

export function destroySession(id: string): void {
  store.delete(id);
}
`;

const SESSION_NEW = `import { randomBytes } from "node:crypto";

export type Session = {
  id: string;
  userId: string;
  expiresAt: number;
  refreshedAt: number;
};

const store = new Map<string, Session>();
const TTL_MS = 1000 * 60 * 60;
const REFRESH_WINDOW_MS = 1000 * 60 * 5;

export function createSession(userId: string): Session {
  const now = Date.now();
  const session: Session = {
    id: randomBytes(32).toString("hex"),
    userId,
    expiresAt: now + TTL_MS,
    refreshedAt: now,
  };
  store.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | null {
  const session = store.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    store.delete(id);
    return null;
  }
  return refresh(session);
}

/** Slides the expiry forward, at most once per refresh window, so a busy session does not rewrite the store on every request. */
function refresh(session: Session): Session {
  const now = Date.now();
  if (now - session.refreshedAt < REFRESH_WINDOW_MS) return session;
  const next = { ...session, expiresAt: now + TTL_MS, refreshedAt: now };
  store.set(session.id, next);
  return next;
}

export function destroySession(id: string): void {
  store.delete(id);
}
`;

const FORMAT_OLD = `export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
`;

const FORMAT_NEW = `const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return \`\${unit === 0 ? value : value.toFixed(1)} \${UNITS[unit]}\`;
}
`;

const BUTTON = `import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" };

export function Button({ tone = "primary", className = "", ...rest }: Props) {
  return <button className={\`btn btn-\${tone} \${className}\`} {...rest} />;
}
`;

const INDEX = `import { createRoot } from "react-dom/client";
import { Button } from "./components/Button";

createRoot(document.getElementById("root")!).render(<Button>Hello</Button>);
`;

const GITIGNORE = `node_modules
dist
.env
`;

const NOTES = `# Notes

Sessions last an hour and slide forward while in use.
`;

/** The files of the demo repositories at their current (head) version. */
export const DEMO_FILES: Record<string, string> = {
  "README.md": README,
  "package.json": PACKAGE_JSON,
  ".gitignore": GITIGNORE,
  "src/index.tsx": INDEX,
  "src/session.ts": SESSION_NEW,
  "src/components/Button.tsx": BUTTON,
  "src/utils/format.ts": FORMAT_NEW,
  "docs/notes.md": NOTES,
};

/** Before and after versions of the files the demo pull request changes. */
export const DEMO_CHANGES: { filename: string; before: string; after: string }[] = [
  { filename: "src/session.ts", before: SESSION_OLD, after: SESSION_NEW },
  { filename: "src/utils/format.ts", before: FORMAT_OLD, after: FORMAT_NEW },
];

type Op = { t: " " | "-" | "+"; text: string };

function lineDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", text: a[i++] });
      j++;
    }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", text: a[i++] });
    else ops.push({ t: "+", text: b[j++] });
  }
  while (i < n) ops.push({ t: "-", text: a[i++] });
  while (j < m) ops.push({ t: "+", text: b[j++] });
  return ops;
}

/** A unified diff with three lines of context, the same shape GitHub returns in a file's `patch`. */
export function makePatch(before: string, after: string, context = 3): { patch: string; additions: number; deletions: number } {
  const ops = lineDiff(before.split("\n").slice(0, -1), after.split("\n").slice(0, -1));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out: string[] = [];
  let oldNo = 1;
  let newNo = 1;
  let k = 0;
  let additions = 0;
  let deletions = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k].t !== "+") oldNo++;
      if (ops[k].t !== "-") newNo++;
      k++;
      continue;
    }
    const startOld = oldNo;
    const startNew = newNo;
    const body: string[] = [];
    let oc = 0;
    let nc = 0;
    while (k < ops.length && keep[k]) {
      const o = ops[k++];
      body.push(o.t + o.text);
      if (o.t !== "+") {
        oc++;
        oldNo++;
      }
      if (o.t !== "-") {
        nc++;
        newNo++;
      }
      if (o.t === "+") additions++;
      if (o.t === "-") deletions++;
    }
    out.push(`@@ -${startOld},${oc} +${startNew},${nc} @@`, ...body);
  }
  return { patch: out.join("\n"), additions, deletions };
}
