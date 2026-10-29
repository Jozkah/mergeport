import Link from "next/link";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { BellRing, CircleHelp, FolderGit2, GitFork, Kanban, ListChecks, Route, Users } from "@/components/ui/icons";

export const metadata = { title: "Help" };

const WORDS: { term: string; plain: string }[] = [
  { term: "Repository", plain: "A project's code folder on GitHub. “Tracking” one only means this app watches it; nothing changes on GitHub." },
  { term: "Project", plain: "A group of repositories you plan together, like “Website”. It has its own board and tasks." },
  { term: "Task", plain: "A thing to do. It has an owner, a status (Backlog, Ready, In progress, In review, Blocked, Done), a due date and a discussion." },
  { term: "Needs my review", plain: "Pull requests where GitHub, or a rule you set, expects you to review." },
  { term: "Waiting on others", plain: "Work that is stuck until someone else decides. It shows who and for how long." },
  { term: "Who reviews what", plain: "Rules that say which people must review which work, so “Needs my review” is right for everyone." },
  { term: "Fork and upstream", plain: "A fork is your copy of someone else's repository. The upstream is the original. Forks shows how far your copy is behind." },
  { term: "Watchlist", plain: "A list of repositories to keep an eye on. Paste addresses and Mergeport sets up the comparisons." },
  { term: "Team and space", plain: "A team shares projects and tasks through a private GitHub repository (a space). Only people you invite can see it." },
  { term: "Sync", plain: "Your changes are saved on this computer first, then sent to your team. Sync status shows what has arrived." },
];

const STEPS = [
  { icon: FolderGit2, title: "Connect your repositories", text: "Choose the repositories you work in.", href: "/repositories/connect", cta: "Choose repositories" },
  { icon: Kanban, title: "Make a project", text: "Group repositories you plan together.", href: "/admin/projects", cta: "Projects" },
  { icon: ListChecks, title: "Add tasks", text: "Create tasks, give them to people, and talk about them.", href: "/tasks", cta: "Tasks" },
  { icon: BellRing, title: "Check My attention", text: "See what needs your review and what is waiting on others.", href: "/attention", cta: "My attention" },
  { icon: Users, title: "Invite your team", text: "Optional. Share projects and tasks with teammates.", href: "/team", cta: "Team" },
  { icon: Route, title: "Say who reviews what", text: "Optional. Make “Needs my review” accurate.", href: "/admin/rules", cta: "Who reviews what" },
  { icon: GitFork, title: "Watch forks", text: "Optional. Paste repositories to see what upstream has that you lack.", href: "/forks", cta: "Forks" },
];

export default function Help() {
  return (
    <>
      <PageHeader title="Help" subtitle="Mergeport keeps your repositories, reviews, tasks and forks in one place. It runs on your computer and uses your own GitHub sign-in." />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Your first minutes" icon={CircleHelp}>
          <ol className="divide-y divide-line">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-[12px] text-ink-3">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{s.title}</p>
                  <p className="text-[12.5px] text-ink-3">{s.text}</p>
                </div>
                <Link href={s.href} className="btn shrink-0">{s.cta}</Link>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="Words used in the app" icon={CircleHelp}>
            <dl className="divide-y divide-line">
              {WORDS.map((w) => (
                <div key={w.term} className="px-4 py-2.5">
                  <dt className="text-[13.5px] font-medium">{w.term}</dt>
                  <dd className="text-[12.5px] text-ink-3">{w.plain}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="Good to know" icon={CircleHelp}>
            <ul className="flex list-disc flex-col gap-2 p-4 pl-8 text-[13px] text-ink-2">
              <li><strong className="font-medium">Nothing is sent to GitHub unless you press a button</strong> that says so, and the button names what it will do.</li>
              <li>Changes you make are saved on this computer first, so the app works while you are offline.</li>
              <li>Right-click almost anything for useful actions. Hold Shift while right-clicking for the browser&apos;s own menu.</li>
              <li>Use <strong className="font-medium">Search anything</strong> (top left) to jump to a repository, pull request, issue or task.</li>
              <li>If a page says you need to sign in, run <code>gh auth login</code> in a terminal, then reload.</li>
              <li>Something looks out of date? Open <Link className="link" href="/sync">Sync status</Link> to see what has arrived and what is waiting.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
