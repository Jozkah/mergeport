/**
 * Which items get their conversation downloaded (issue comments, review comments, review submissions, requested reviewers).
 * That is up to four GitHub requests PER item, so a first sync of a repository with a long history would spend the whole
 * hourly request budget on items nobody is waiting on. Open items always get it; closed and merged items only while
 * recent. Older closed items keep their title, state, labels and dates, and the app says their conversation was not
 * downloaded: absence is never shown as "no comments".
 */
export const DISCUSSION_WINDOW_DAYS = 14;

export function discussionDownloaded(state: string, updatedAt: Date, now: Date): boolean {
  if (state === "OPEN") return true;
  return now.getTime() - updatedAt.getTime() <= DISCUSSION_WINDOW_DAYS * 86_400_000;
}
