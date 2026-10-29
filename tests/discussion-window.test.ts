import { describe, expect, it } from "vitest";
import { DISCUSSION_WINDOW_DAYS, discussionDownloaded } from "@/lib/sync/discussion-window";

const now = new Date(Date.UTC(2026, 9, 29));
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe("discussion window", () => {
  it("always downloads open items, however old", () => expect(discussionDownloaded("OPEN", ago(900), now)).toBe(true));
  it("downloads recently active closed and merged items", () => {
    expect(discussionDownloaded("CLOSED", ago(DISCUSSION_WINDOW_DAYS - 1), now)).toBe(true);
    expect(discussionDownloaded("MERGED", ago(DISCUSSION_WINDOW_DAYS), now)).toBe(true);
  });
  it("skips old closed items", () => expect(discussionDownloaded("MERGED", ago(DISCUSSION_WINDOW_DAYS + 1), now)).toBe(false));
});
