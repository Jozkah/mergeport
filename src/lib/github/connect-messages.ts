/**
 * What the settings page says after the callback. The callback redirects with ONE of these fixed codes (`/settings/github?github=<code>`);
 * the page looks the code up here and ignores anything else, so no query value is ever shown. No message contains a token, a code,
 * an installation id or any other GitHub detail beyond what the person already sees on the page.
 */
export const CONNECT_RESULTS = [
  "connected",
  "already",
  "invalid-link",
  "not-allowed",
  "cannot-verify",
  "not-owner",
  "not-yours",
  "no-authorization",
  "request-pending",
  "not-found",
  "several",
  "suspended",
  "unavailable",
  "app-problem",
  "rate-limited",
  "error",
] as const;
export type ConnectResult = (typeof CONNECT_RESULTS)[number];

export type ResultMessage = { tone: "info" | "warn" | "error"; title: string; body: string };

export const RESULT_MESSAGES: Record<ConnectResult, ResultMessage> = {
  connected: { tone: "info", title: "GitHub is connected", body: "This workspace can now use that GitHub account. Nothing was changed on GitHub." },
  already: { tone: "info", title: "Already connected", body: "That GitHub account was already connected to this workspace. Its check was refreshed." },
  "invalid-link": { tone: "error", title: "That connection link is no longer valid", body: "It expired, was already used, or was started by someone else or in another browser. Nothing was connected. Start again from this page." },
  "not-allowed": { tone: "error", title: "You cannot connect GitHub for this workspace", body: "Only the owner and administrators can. Ask one of them." },
  "cannot-verify": { tone: "error", title: "Could not confirm access with your GitHub account", body: "GitHub did not show that installation to your account, or the sign-in was cancelled. Nothing was connected. Try again." },
  "not-owner": { tone: "error", title: "Could not verify that you are an owner of the organization", body: "Ask an owner of the organization to connect it, or install the App yourself." },
  "not-yours": { tone: "error", title: "That installation belongs to a different GitHub account", body: "You can only connect an installation on your own GitHub account, or on an organization you own." },
  "no-authorization": { tone: "warn", title: "GitHub did not ask you to sign in during the install", body: "Use “Use an existing installation” below to finish connecting. If this keeps happening, tell your administrator." },
  "request-pending": { tone: "info", title: "Waiting for an organization owner", body: "GitHub sent the install request to an owner of the organization. After they approve it, come back and choose “Use an existing installation”." },
  "not-found": { tone: "error", title: "No matching installation was found", body: "Install the App on that GitHub account first, then try again. Check the account name if you typed one." },
  several: { tone: "warn", title: "More than one installation matched", body: "Type the name of the GitHub account you want to connect, then choose “Use an existing installation” again." },
  suspended: { tone: "warn", title: "That installation is suspended on GitHub", body: "An owner of the GitHub account has to unsuspend it. Then try again." },
  unavailable: { tone: "warn", title: "GitHub did not answer", body: "Nothing was connected. Try again in a minute." },
  "app-problem": { tone: "error", title: "GitHub rejected this server’s App settings", body: "Nothing was connected. Tell the person who runs this server." },
  "rate-limited": { tone: "warn", title: "Too many attempts", body: "Wait a few minutes, then try again." },
  error: { tone: "error", title: "Something went wrong", body: "Nothing was connected. Try again." },
};

export const isConnectResult = (v: unknown): v is ConnectResult => typeof v === "string" && (CONNECT_RESULTS as readonly string[]).includes(v);
