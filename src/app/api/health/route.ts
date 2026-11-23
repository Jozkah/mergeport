import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workerStatus, type WorkerStatus } from "@/lib/worker-heartbeat";

/**
 * Deployer health check (docs/deploy.md). No session, no secrets, no tenant data: {ok, worker} and nothing else.
 *   200 {"ok":true,"worker":"fresh"|"stale"|"unknown"}  the database answered SELECT 1. `worker` is the age of the worker's heartbeat,
 *                                                       it never changes the status code (a web replica is healthy without a worker).
 *   503 {"ok":false}                                    the database did not answer within DB_TIMEOUT_MS.
 * One probe result is shared for CACHE_MS, so a flood of checks costs the database one query per window, not one per request.
 * proxy.ts lets GET and HEAD on this path through with any Host (platform probes use the container address).
 */
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3_000;
const CACHE_MS = 2_000;

type Result = { ok: true; worker: WorkerStatus } | { ok: false };
let cached: { at: number; value: Promise<Result> } | null = null;

async function probe(): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("timeout")), DB_TIMEOUT_MS);
    });
    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);
    return { ok: true, worker: await workerStatus(db) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function answer(): Promise<NextResponse> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, value: probe() };
  const r = await cached.value;
  return NextResponse.json(r, { status: r.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

export const GET = answer;
export const HEAD = answer;
