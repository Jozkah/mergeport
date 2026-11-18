/** The exit code a child app uses to ask the launcher to reopen it on the profile's (new) active context. Kept apart from launcher.ts, which reads files and must stay out of the app bundle. */
export const RESTART_EXIT_CODE = 75;
