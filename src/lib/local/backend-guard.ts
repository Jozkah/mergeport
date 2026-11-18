import type { Backend } from "@/lib/local/backends";
import { isHubBackend } from "@/lib/local/backends";
import { ValidationError } from "@/lib/errors";

/** A space of one backend type reached through a profile of the other. Refused before any network call or write. */
export class BackendMismatchError extends ValidationError {
  constructor() {
    super("This workspace belongs to a different kind of connection.");
    this.name = "BackendMismatchError";
  }
}

/** A workspace of one backend type must never be read or written through the other. */
export function assertBackendMatch(config: { backend: Backend }, space: { backend: "GITHUB" | "HUB" }): void {
  const ok = space.backend === "GITHUB" ? config.backend === "github" : isHubBackend(config.backend);
  if (!ok) throw new BackendMismatchError();
}
