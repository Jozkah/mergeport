import type { EntityFile } from "@/lib/sync/engine";
import type { CoordinationStore } from "@/lib/sync/store";

export type Op = { opId: string; type: string; entityId: string; kind: "UPSERT" | "DELETE"; baseVersion: number; data?: Record<string, unknown> };
export type EntityJson = EntityFile;
export type EventJson = EntityJson & { seq: string; opId: string };
export type EntityEvent = Omit<EventJson, "seq"> & { seq: bigint };
export type OpResult = { opId: string; status: "applied" | "duplicate" | "stale"; version: number; current?: EntityJson };

export type Me = {
  member: { githubId: string; login: string; name: string | null; avatarUrl: string | null; role: string; status: string };
  team: { id: string; name: string };
  members: unknown[];
  spaces: { id: string; kind: "COMMON" | "RESTRICTED"; name: string; canWrite: boolean; seq: string }[];
};

export interface HubClient {
  me(): Promise<Me>;
  pull(spaceId: string, since: bigint): Promise<{ seq: bigint; events: EntityEvent[]; more?: boolean } | "gone">;
  snapshot(spaceId: string): Promise<{ seq: bigint; entities: EntityFile[] }>;
  push(spaceId: string, ops: Op[]): Promise<{ results: OpResult[]; seq: bigint }>;
}

export type Backend = { kind: "github"; store: CoordinationStore } | { kind: "hub"; client: HubClient };

export type HubErrorKind = "network" | "auth" | "forbidden" | "not-found" | "rate-limited" | "schema" | "unknown";

export class HubError extends Error {
  readonly kind: HubErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(kind: HubErrorKind, message?: string, extra: { status?: number; retryAfterSeconds?: number } = {}) {
    super(message ?? kind);
    this.name = "HubError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}
