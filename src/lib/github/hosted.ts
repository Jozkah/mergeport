import { isHosted } from "@/lib/public-url";

/**
 * A hosted deployment has no GitHub credential of its own yet: the server's `gh` login belongs to whoever installed it, not to
 * any workspace. Every code path that would use it (the gh process, the profile runner, discovery, writes, the scheduler's GitHub
 * jobs) therefore stops here until each workspace has its own connection. The text is what a person reads, so it names no development phase.
 */
export const GITHUB_NOT_CONNECTED = "GitHub is not connected yet. Repository sync and GitHub actions are off. Your workspace data is still here.";

export class GithubNotConnectedError extends Error {
  readonly code = "github-not-connected";
  constructor() {
    super(GITHUB_NOT_CONNECTED);
    this.name = "GithubNotConnectedError";
  }
}

/** Hosted workspaces read GitHub through the App's installation (read-only permissions); nothing writes to GitHub yet. */
export const GITHUB_WRITES_DISABLED = "GitHub writes are not enabled yet";

export class GithubWritesDisabledError extends Error {
  readonly code = "github-writes-disabled";
  constructor() {
    super(GITHUB_WRITES_DISABLED);
    this.name = "GithubWritesDisabledError";
  }
}

/** Throws GithubNotConnectedError on a hosted deployment. Call before anything that would reach for the local gh credential. */
export function assertGithubAvailable(): void {
  if (isHosted()) throw new GithubNotConnectedError();
}
