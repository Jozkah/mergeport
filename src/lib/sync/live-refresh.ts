import { isSwitching, onSwitchChange } from "@/lib/local/switching";

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 4000;
const MIN_GAP_MS = 3000;
/**
 * A teammate's edit that just arrived (reason "pulled") is what a person is waiting to see, and on a hub server it comes in over the
 * live link within milliseconds. It gets a much shorter debounce and gap than the "state" bursts of background jobs, which stay throttled.
 */
const PULLED_DEBOUNCE_MS = 100;
const PULLED_MIN_GAP_MS = 600;

export type StreamLike = { onopen: null | (() => void); onmessage: null | ((e: { data: string }) => void); onerror: null | (() => void); close(): void };

/**
 * The event-stream half of LiveRefresh, kept free of React and the DOM so it can be tested: listens for change events from the
 * local server and calls `refresh` (debounced, with a maximum wait and a minimum gap), marks the page stale while it is hidden,
 * and reconnects with backoff if the stream drops. While a workspace switch is in progress it closes the stream, drops any
 * scheduled refresh and does not reconnect (see `switching.ts`); if the switch is called off, it reconnects.
 * Returns a stop function; `catchUp` refreshes once if an event arrived while the page was hidden.
 */
export function startLiveRefresh(deps: { open: () => StreamLike; refresh: () => void; isVisible: () => boolean }): (() => void) & { catchUp: () => void } {
  let es: StreamLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let closed = false;
  let firstEvent = 0;
  let lastRefresh = 0;
  let stale = false;

  const cancelTimers = () => {
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
    timer = null;
    retry = null;
    firstEvent = 0;
  };
  const refreshNow = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstEvent = 0;
    if (closed || isSwitching()) return;
    if (!deps.isVisible()) {
      stale = true;
      return;
    }
    stale = false;
    lastRefresh = Date.now();
    deps.refresh();
  };
  const schedule = (urgent = false) => {
    if (isSwitching()) return;
    const now = Date.now();
    if (!firstEvent) firstEvent = now;
    if (timer) clearTimeout(timer);
    const debounce = urgent ? PULLED_DEBOUNCE_MS : DEBOUNCE_MS;
    const gap = urgent ? PULLED_MIN_GAP_MS : MIN_GAP_MS;
    const wait = Math.min(Math.max(debounce, lastRefresh + gap - now), Math.max(0, firstEvent + MAX_WAIT_MS - now));
    timer = setTimeout(refreshNow, wait);
  };
  const connect = () => {
    if (closed || isSwitching() || es) return;
    const s = deps.open();
    es = s;
    s.onopen = () => {
      backoff = 1000;
    };
    s.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { hello?: boolean; reason?: string };
        if (msg.hello) return;
        if (msg.reason === "pulled") schedule(true);
        else if (msg.reason === "pushed" || msg.reason === "state") schedule();
      } catch {
        /* ignore malformed event */
      }
    };
    s.onerror = () => {
      s.close();
      if (es === s) es = null;
      if (closed || isSwitching()) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };
  const disconnect = () => {
    es?.close();
    es = null;
    cancelTimers();
  };
  const unsubscribe = onSwitchChange((switching) => {
    if (switching) disconnect();
    else connect();
  });
  connect();

  const stop = (() => {
    closed = true;
    unsubscribe();
    disconnect();
  }) as (() => void) & { catchUp: () => void };
  stop.catchUp = () => {
    if (stale) refreshNow();
  };
  return stop;
}
