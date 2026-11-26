/**
 * Browser-side "a workspace switch is in progress" flag. While the app restarts on another workspace, the page must not ask
 * the server for fresh data: the new process does not know this browser's session yet, answers a page refresh with a
 * redirect to /sign-in, and the client router would follow it and tear down the switching overlay before it can open the
 * new process's sign-in link. Background refreshers check this flag and stop until the overlay navigates away.
 */
let switching = false;
const listeners = new Set<(switching: boolean) => void>();

export function isSwitching(): boolean {
  return switching;
}

/** Called just before asking the launcher to switch. */
export function beginSwitch(): void {
  if (switching) return;
  switching = true;
  for (const l of [...listeners]) l(true);
}

/** Called when the switch request failed and the current app keeps running. */
export function endSwitch(): void {
  if (!switching) return;
  switching = false;
  for (const l of [...listeners]) l(false);
}

export function onSwitchChange(fn: (switching: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
