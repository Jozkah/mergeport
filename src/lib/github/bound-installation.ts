/**
 * A GitHub App installation that a workspace has PROVED it controls and that is usable (not suspended, not deleted).
 *
 * `mintInstallationToken` accepts only this type, so no code path can mint a token for an installation id taken straight from a webhook,
 * a callback or a request. The only producer is `loadBoundInstallation` in `binding.ts` (it loads a `WorkspaceInstallation` row with its
 * proof). The brand is checked at run time too: every issued value is remembered in a WeakSet, so a forged object literal is refused.
 */

declare const boundBrand: unique symbol;

export type BoundInstallation = {
  readonly installationId: bigint;
  readonly workspaceId: string;
  readonly [boundBrand]: true;
};

const issued = new WeakSet<object>();

/** Only `binding.ts` calls this (tests/github-app-bindings.test.ts enforces it). */
export function makeBoundInstallation(installationId: bigint, workspaceId: string): BoundInstallation {
  const b = Object.freeze({ installationId, workspaceId }) as unknown as BoundInstallation;
  issued.add(b);
  return b;
}

export const isBoundInstallation = (x: unknown): x is BoundInstallation => typeof x === "object" && x !== null && issued.has(x);

/** Test double that skips the database. Refuses to run in production. */
export function unsafeBoundInstallationForTests(installationId: bigint | number, workspaceId = "test-workspace"): BoundInstallation {
  if (process.env.NODE_ENV === "production") throw new Error("unsafeBoundInstallationForTests is not available in production");
  return makeBoundInstallation(BigInt(installationId), workspaceId);
}
