"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Copy } from "@/components/ui/icons";

type App = { key: string; name: string; hint: string; value: string };

/**
 * How to let an AI app on this computer use Mergeport. One app at a time, with the setup text wrapped (a long path stays readable) and a
 * clear Copied state. The server runs only while the app that started it runs, as the signed-in person, and can create, change and
 * list tasks and read stored pull request status. It cannot change GitHub: what it proposes waits for your approval in Mergeport.
 */
export function McpPanel({ launcher }: { launcher: string }) {
  const uid = useId();
  const apps: App[] = [
    { key: "claude-code", name: "Claude Code", hint: "Run this once in a terminal.", value: `claude mcp add mergeport -- node "${launcher}"` },
    { key: "desktop", name: "Claude Desktop or Cursor", hint: "Add it to the app's MCP settings (merge it into mcpServers if there is one), then restart the app.", value: JSON.stringify({ mcpServers: { mergeport: { command: "node", args: [launcher] } } }, null, 2) },
    { key: "opencode", name: "opencode", hint: "Add it to opencode.json.", value: JSON.stringify({ mcp: { mergeport: { type: "local", command: ["node", launcher], enabled: true } } }, null, 2) },
  ];
  const [sel, setSel] = useState(apps[0].key);
  const [copied, setCopied] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const app = apps.find((a) => a.key === sel)!;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(app.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the text is selectable below; people can copy it by hand */
    }
  };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = apps.findIndex((a) => a.key === sel);
    const to = e.key === "ArrowRight" ? apps[(i + 1) % apps.length] : e.key === "ArrowLeft" ? apps[(i + apps.length - 1) % apps.length] : null;
    if (!to) return;
    e.preventDefault();
    setSel(to.key);
    refs.current[to.key]?.focus();
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-4 text-[13px]">
      <p className="text-ink-2 text-pretty">
        An AI app that supports MCP can then add and update tasks (&ldquo;add a task to review paymentgateway#22, high priority&rdquo;), list them and look up pull request status. It acts as you on this computer. It cannot change anything on GitHub by itself: a comment or review it proposes waits under AI assistant, Approvals until you approve it.
      </p>
      <div className="seg self-start" role="tablist" aria-label="Which app">
        {apps.map((a) => (
          <button key={a.key} ref={(el) => void (refs.current[a.key] = el)} type="button" role="tab" id={`${uid}-t-${a.key}`} aria-selected={sel === a.key} aria-controls={`${uid}-p`} tabIndex={sel === a.key ? 0 : -1} onClick={() => setSel(a.key)} onKeyDown={keys}>{a.name}</button>
        ))}
      </div>
      <div id={`${uid}-p`} role="tabpanel" aria-labelledby={`${uid}-t-${sel}`} className="flex flex-col gap-2">
        <p className="text-[12.5px] text-ink-3 text-pretty">{app.hint}</p>
        <div className="relative">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-faint p-3 pr-24 font-mono text-[12px] leading-5 [overflow-wrap:anywhere]"><code>{app.value}</code></pre>
          <button type="button" className="btn btn-quiet absolute right-1.5 top-1.5 !h-8" onClick={copy}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p role="status" className="sr-only">{copied ? "Copied to the clipboard" : ""}</p>
      </div>
      <p className="text-[12px] text-ink-3 text-pretty">Mergeport must have been opened and signed in once. ChatGPT cannot start programs on your computer, so it cannot use this; apps that run local MCP servers can.</p>
    </div>
  );
}
