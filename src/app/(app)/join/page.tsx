import { requireViewer } from "@/lib/authz-page";
import { Banner, PageHeader, Panel } from "@/components/ui/primitives";
import { CandidateCard } from "@/components/team/CandidateCard";
import { teamWithDeadline } from "@/lib/local/discovery-jobs";
import { GithubError } from "@/lib/github/port";
import { TeamService, type SpaceCandidate } from "@/lib/team/service";

export const metadata = { title: "Join a space" };
export const dynamic = "force-dynamic";

/**
 * A join link names a repository and nothing else. This page READS that repository (owner, visibility, team, manifest,
 * what it contains) and shows it. Nothing is imported until the person confirms on the card. The one live GitHub call here
 * is what they just asked for and has a hard deadline.
 */
export default async function Join({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  await requireViewer();
  const sp = await searchParams;
  let candidate: SpaceCandidate | null = null;
  let problem: { tone: "error" | "warn"; title: string; text: string } | null = null;
  if (sp.repo) {
    try {
      TeamService.parseRepoRef(sp.repo);
      candidate = await (await teamWithDeadline(12_000)).inspect(sp.repo);
    } catch (e) {
      if (e instanceof GithubError && e.kind === "network") problem = { tone: "warn", title: "GitHub could not be reached", text: "Nothing was joined. Check your connection and open the link again." };
      else if (e instanceof GithubError && e.kind === "auth") problem = { tone: "error", title: "GitHub sign-in needed", text: e.message };
      else if (e instanceof GithubError && e.kind === "rate-limited") problem = { tone: "warn", title: "GitHub rate limit", text: "Try again in a minute." };
      else problem = { tone: "error", title: "That link is not valid", text: e instanceof Error ? e.message : "Use owner/repo or a Mergeport join link." };
    }
  }
  return (
    <>
      <PageHeader title="Join a space" subtitle="A join link names a private repository. It is not an access token, and opening it joins nothing." />
      {problem && <div className="mb-4"><Banner tone={problem.tone} title={problem.title}>{problem.text}</Banner></div>}
      <Panel title="Review before joining" id="join">
        <div className="max-w-[640px] p-4 text-[13px]">
          {candidate ? <ul><CandidateCard c={candidate} /></ul> : !problem && (
            <form method="get" className="flex flex-wrap items-end gap-2">
              <div><label className="label" htmlFor="jr">Repository (owner/repo) or join link</label><input id="jr" name="repo" className="input !w-80" required placeholder="owner/mergeport-team-workspace" /></div>
              <button className="btn">Review</button>
            </form>
          )}
          <ul className="mt-4 list-disc space-y-1 pl-5 text-ink-3">
            <li>You must already have access: accept GitHub&apos;s invitation to the repository first.</li>
            <li>Mergeport checks it is private, that its manifest is valid, and (once you are in a team) that it belongs to your team and the team&apos;s owner.</li>
            <li>Nothing in that repository is ever executed or installed.</li>
            <li>Source-code repositories it mentions still need to be readable by your own GitHub account.</li>
          </ul>
        </div>
      </Panel>
    </>
  );
}
