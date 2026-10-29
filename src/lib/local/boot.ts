/** When this server process started. A job still marked RUNNING from before that belongs to a process that died. */
export function processStartedAt(): Date {
  return new Date(Date.now() - process.uptime() * 1000);
}
