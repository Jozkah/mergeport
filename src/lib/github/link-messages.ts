/**
 * What Settings says after a person links GitHub. The callback redirects with ONE of these fixed codes (`/settings?githublink=<code>`);
 * the page looks the code up here and ignores anything else, so no query value is ever shown. No message contains a token, a code,
 * a GitHub account name or any other detail from GitHub.
 */
export const LINK_RESULTS = ["linked", "invalid-link", "github-taken", "other-account", "no-key", "cannot-verify", "unavailable", "app-problem", "rate-limited", "error"] as const;
export type LinkResult = (typeof LINK_RESULTS)[number];

export type LinkMessage = { tone: "info" | "warn" | "error"; title: string; body: string };

export const LINK_MESSAGES: Record<LinkResult, LinkMessage> = {
  linked: { tone: "info", title: "GitHub account linked", body: "Mergeport now uses it to see which repositories you can open on GitHub. It does not post anything." },
  "invalid-link": { tone: "error", title: "That link is no longer valid", body: "It expired, was already used, or was started by someone else or in another browser. Nothing was linked. Start again from this page." },
  "github-taken": { tone: "error", title: "That GitHub account is already linked to someone else here", body: "A GitHub account can be linked to one person. Nothing was linked. If it is yours, ask the other person to unlink it first." },
  "other-account": { tone: "error", title: "A different GitHub account is already linked to you", body: "Nothing was changed. Unlink the current one first, then link the one you want." },
  "no-key": { tone: "warn", title: "Linking GitHub is not available on this server yet", body: "Nothing was linked. Tell the person who runs this server." },
  "cannot-verify": { tone: "error", title: "Could not confirm your GitHub account", body: "The sign-in on GitHub was cancelled or GitHub did not accept it. Nothing was linked. Try again." },
  unavailable: { tone: "warn", title: "GitHub did not answer", body: "Nothing was linked. Try again in a minute." },
  "app-problem": { tone: "error", title: "GitHub rejected this server’s App settings", body: "Nothing was linked. Tell the person who runs this server." },
  "rate-limited": { tone: "warn", title: "Too many attempts", body: "Wait a few minutes, then try again." },
  error: { tone: "error", title: "Something went wrong", body: "Nothing was linked. Try again." },
};

export const isLinkResult = (v: unknown): v is LinkResult => typeof v === "string" && (LINK_RESULTS as readonly string[]).includes(v);

/** The plain sentence next to the Link GitHub button, and on the attention and inbox pages. */
export const LINK_PURPOSE = "Mergeport uses it to see which repositories you can open on GitHub; it does not post anything.";
export const NO_KEY_TEXT = "Linking GitHub is not available on this server yet. Tell the person who runs this server.";
