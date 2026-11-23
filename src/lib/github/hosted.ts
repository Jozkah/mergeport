/**
 * Mergeport holds no GitHub credential of its own: every workspace reaches GitHub through its own App installation, and a workspace
 * without one gets this typed error. The text is what a person reads, so it names no development phase.
 */
export const GITHUB_NOT_CONNECTED = "GitHub is not connected yet. Repository sync and GitHub actions are off. Your workspace data is still here.";

export class GithubNotConnectedError extends Error {
  readonly code = "github-not-connected";
  constructor() {
    super(GITHUB_NOT_CONNECTED);
    this.name = "GithubNotConnectedError";
  }
}

/** Workspaces read GitHub through the App's installation (read-only permissions); nothing writes to GitHub yet. */
export const GITHUB_WRITES_DISABLED = "GitHub writes are not enabled yet";

export class GithubWritesDisabledError extends Error {
  readonly code = "github-writes-disabled";
  constructor() {
    super(GITHUB_WRITES_DISABLED);
    this.name = "GithubWritesDisabledError";
  }
}
