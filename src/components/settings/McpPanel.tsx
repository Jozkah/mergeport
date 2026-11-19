import { CopyField } from "@/components/forms/CopyField";

/**
 * How to let an AI app on this computer use Mergeport. The server runs only while the app that started it runs, as the signed-in
 * person, and can create, change and list tasks and read stored pull request status. It cannot reach GitHub.
 */
export function McpPanel({ launcher }: { launcher: string }) {
  const q = (s: string) => `"${s}"`; // always quoted: backslashes and spaces survive PowerShell, cmd and Git Bash
  const desktop = JSON.stringify({ mcpServers: { mergeport: { command: "node", args: [launcher] } } });
  const opencode = JSON.stringify({ mcp: { mergeport: { type: "local", command: ["node", launcher], enabled: true } } });
  return (
    <div className="flex max-w-2xl flex-col gap-4 p-4 text-[13px]">
      <p className="text-ink-2">
        Any app that supports MCP can then create or update tasks (&ldquo;add a task to review paymentgateway#22, high priority, assign kewai&rdquo;), list them, and look up pull request status. It acts as you, only on this computer, and never touches GitHub.
      </p>
      <CopyField label="Claude Code (run once in a terminal)" value={`claude mcp add mergeport -- node ${q(launcher)}`} />
      <CopyField label="Claude Desktop, Cursor and similar (JSON for the app's MCP settings)" value={desktop} hint="Merge it into the existing mcpServers object if there is one, then restart the app." />
      <CopyField label="opencode (add to opencode.json)" value={opencode} />
      <p className="text-[12px] text-ink-3">
        The server needs Mergeport to have been opened and signed in once. ChatGPT cannot start programs on your computer, so it cannot use this; apps that run local MCP servers can.
      </p>
    </div>
  );
}
