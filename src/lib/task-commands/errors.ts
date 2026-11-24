/** A problem with the environment the command runs in (no profile, no user), or an ambiguous name with candidates. Printed as is; exit code 1. Kept apart from locate.ts, whose filesystem access must not be traced into the web server. */
export class CliError extends Error {
  constructor(message: string, readonly candidates?: string[]) {
    super(message);
  }
}
