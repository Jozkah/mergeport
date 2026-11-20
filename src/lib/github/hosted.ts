import { isHosted } from "@/lib/public-url";

/**
 * A hosted deployment has no GitHub credential of its own yet: the server's `gh` login belongs to whoever installed it, not to
 * any workspace. Every code path that would use it (the gh process, the profile runner, discovery, writes, the scheduler's GitHub
 * jobs) therefore stops here until the GitHub App phase gives each workspace its own connection.
 */
export const GITHUB_NOT_CONNECTED = "GitHub is not connected for this workspace (arrives with the GitHub App phase).";

export class GithubNotConnectedError extends Error {
  readonly code = "github-not-connected";
  constructor() {
    super(GITHUB_NOT_CONNECTED);
    this.name = "GithubNotConnectedError";
  }
}

/** Throws GithubNotConnectedError on a hosted deployment. Call before anything that would reach for the local gh credential. */
export function assertGithubAvailable(): void {
  if (isHosted()) throw new GithubNotConnectedError();
}
