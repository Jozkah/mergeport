/**
 * The deployment ceiling for GitHub writes (docs/github-app.md, "Writing to GitHub as you"). Off unless the person who runs the server sets
 * MERGEPORT_GITHUB_WRITES=on. A workspace switch can only narrow it: with the ceiling off nothing in the app writes to GitHub, whatever a
 * workspace chose. Kept free of imports so config validation and pages can read it anywhere.
 */
export function githubWritesCeiling(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MERGEPORT_GITHUB_WRITES ?? "").trim().toLowerCase() === "on";
}

/** A problem with the variable, as a sentence for the start-up check; null when it is fine. `hasKey`: the encryption key for stored GitHub tokens is configured. */
export function githubWritesSettingProblem(raw: string | undefined, hasKey: boolean): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return null;
  if (v !== "on") return "MERGEPORT_GITHUB_WRITES must be on or off (it is off when unset).";
  if (!hasKey) return "MERGEPORT_GITHUB_WRITES=on needs MERGEPORT_ENCRYPTION_KEY: writes use each person's own stored GitHub token.";
  return null;
}
