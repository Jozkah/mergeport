import { EventEmitter } from "node:events";

/**
 * Per-process event bus the browser listens to (the SSE route at /api/sync/events). A web process emits when a change it made
 * should redraw the open pages; the worker is a separate process, so its changes reach pages through the next render instead.
 */

type G = typeof globalThis & { __mp?: { bus: EventEmitter; version: number } };
const g = globalThis as G;
const state: NonNullable<G["__mp"]> = (g.__mp ??= { bus: new EventEmitter(), version: 0 });
state.bus.setMaxListeners(50);

export const bus = state.bus;
/** Monotonic counter bumped on every data change; the browser compares it to know when to refresh. */
export const dataVersion = () => state.version;

/** Tells the open page that something changed (a background refresh finished, a pull landed). */
export function notifyChange(reason: "pulled" | "pushed" | "state" = "state") {
  state.version++;
  // A burst (a sync finishing dozens of jobs) becomes one event per second: every event makes each open page re-render on the
  // server, so unthrottled bursts would keep the app busy refreshing itself.
  if (reason === "state") {
    if (throttle.timer) return void (throttle.pending = true);
    throttle.timer = setTimeout(() => {
      throttle.timer = undefined;
      if (throttle.pending) {
        throttle.pending = false;
        state.bus.emit("change", { version: state.version, spaceId: "", reason });
      }
    }, 1000);
    throttle.timer.unref?.();
  }
  state.bus.emit("change", { version: state.version, spaceId: "", reason });
}
const throttle: { timer?: ReturnType<typeof setTimeout>; pending: boolean } = { pending: false };
