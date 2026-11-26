import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLiveRefresh, type StreamLike } from "@/lib/sync/live-refresh";
import { beginSwitch, endSwitch, isSwitching } from "@/lib/local/switching";

/** A fake event stream the test drives by hand. */
function fakeStreams() {
  const opened: (StreamLike & { emit: (data: unknown) => void; fail: () => void; closed: boolean })[] = [];
  const open = () => {
    const s = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((e: { data: string }) => void),
      onerror: null as null | (() => void),
      closed: false,
      close() {
        this.closed = true;
      },
      emit(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
      },
      fail() {
        this.onerror?.();
      },
    };
    opened.push(s);
    return s;
  };
  return { opened, open };
}

describe("live refresh while the app switches workspace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    endSwitch();
    vi.useRealTimers();
  });

  it("refreshes the page when a change event arrives (baseline)", () => {
    const { opened, open } = fakeStreams();
    const refresh = vi.fn();
    const stop = startLiveRefresh({ open, refresh, isVisible: () => true });
    opened[0].emit({ reason: "pulled" });
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not refresh, and does not reconnect to the restarted server, once a switch has begun", () => {
    const { opened, open } = fakeStreams();
    const refresh = vi.fn();
    const stop = startLiveRefresh({ open, refresh, isVisible: () => true });
    beginSwitch();
    expect(isSwitching()).toBe(true);
    expect(opened[0].closed).toBe(true);
    // The old server dies: the stream errors. It must not reconnect, because the new server would answer the refresh with a sign-in redirect.
    opened[0].fail();
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(1);
    // A late event that was already in flight must not trigger a refresh either.
    opened[0].emit({ reason: "state" });
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("drops a refresh that was already scheduled when the switch begins", () => {
    const { opened, open } = fakeStreams();
    const refresh = vi.fn();
    const stop = startLiveRefresh({ open, refresh, isVisible: () => true });
    opened[0].emit({ reason: "state" });
    beginSwitch();
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("resumes live updates when the switch request fails and the old app keeps running", () => {
    const { opened, open } = fakeStreams();
    const refresh = vi.fn();
    const stop = startLiveRefresh({ open, refresh, isVisible: () => true });
    beginSwitch();
    endSwitch();
    expect(opened).toHaveLength(2);
    opened[1].emit({ reason: "pulled" });
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
