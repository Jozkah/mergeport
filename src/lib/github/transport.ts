/**
 * The `fetch` used for GitHub App traffic (installation tokens and the installation-backed port). Production uses the global fetch.
 * Tests install an in-memory GitHub here (`FakeGitHubServer.appFetch()`), so no test ever reaches the network. The seam refuses to
 * exist in production, like `unsafeBoundInstallationForTests`.
 */
let override: typeof fetch | null = null;

export function setGithubAppFetchForTests(f: typeof fetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setGithubAppFetchForTests is not available in production");
  override = f;
}

/** The fetch for App traffic, or undefined for the runtime's own. */
export const githubAppFetch = (): typeof fetch | undefined => override ?? undefined;
