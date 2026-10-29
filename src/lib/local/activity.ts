/** Is a browser tab looking at Mergeport? Used only to pace background polling; never to hide data. */
const g = globalThis as typeof globalThis & { __mpActivity?: { seenAt: number; visible: boolean } };
const a = (g.__mpActivity ??= { seenAt: 0, visible: false });

export const markBrowserSeen = () => {
  a.seenAt = Date.now();
};
export const setBrowserVisible = (v: boolean) => {
  a.visible = v;
  a.seenAt = Date.now();
};

/** active: a visible tab; idle: tab hidden or closed. Idle polls at most once a minute. */
export function pollMode(now = Date.now()): "active" | "idle" {
  return a.visible && now - a.seenAt < 90_000 ? "active" : "idle";
}
