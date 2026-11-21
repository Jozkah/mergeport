import { Banner, Panel, SimplePill } from "@/components/ui/primitives";
import { KeyRound, Unplug } from "@/components/ui/icons";
import { formatInstant } from "@/lib/format";
import { LINK_PURPOSE, NO_KEY_TEXT, type LinkMessage } from "@/lib/github/link-messages";
import { CheckAccessForm, LinkGithubForm, UnlinkGithubButton } from "./GithubLinkForms";

export type GithubAccountView = {
  /** The server can link accounts: the GitHub App is set up and an encryption key is configured. */
  available: boolean;
  /** Null: not linked. `relink`: GitHub no longer accepts the link. */
  link: { login: string | null; state: "ok" | "relink"; checkedAt: Date | null } | null;
  timezone: string;
};

/** Settings > Account > GitHub account (hosted). Pure data in, so it renders the same in tests. The result message comes from a fixed table, never from the query. */
export function GithubAccountBody({ view, result }: { view: GithubAccountView; result: LinkMessage | null }) {
  const { available, link } = view;
  return (
    <div className="flex flex-col gap-3 p-4 text-[13px]">
      {result && <Banner tone={result.tone} title={result.title}>{result.body}</Banner>}
      {link === null && (
        <>
          <p className="max-w-[70ch] text-pretty">{LINK_PURPOSE}</p>
          {available ? <div><LinkGithubForm /></div> : <p className="text-ink-3">{NO_KEY_TEXT}</p>}
        </>
      )}
      {link?.state === "ok" && (
        <>
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span>Linked as</span>
            <span className="inline-block max-w-full truncate align-bottom font-medium" translate="no" title={link.login ?? undefined}><bdi>{link.login ? `@${link.login}` : "your GitHub account"}</bdi></span>
            <SimplePill tone="ok">Linked</SimplePill>
          </p>
          <p className="text-ink-3">{link.checkedAt ? <>Access checked <span className="tnum">{formatInstant(link.checkedAt, view.timezone)}</span></> : "Access not checked yet"}</p>
          <p className="max-w-[70ch] text-ink-3 text-pretty">{LINK_PURPOSE}</p>
          <div className="flex flex-wrap items-center gap-2">
            <CheckAccessForm />
            <UnlinkGithubButton login={link.login} />
          </div>
        </>
      )}
      {link?.state === "relink" && (
        <>
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span>GitHub account</span>
            <span className="inline-block max-w-full truncate align-bottom font-medium" translate="no" title={link.login ?? undefined}><bdi>{link.login ? `@${link.login}` : ""}</bdi></span>
            <SimplePill tone="waiting" icon={Unplug}>Needs relinking</SimplePill>
          </p>
          <p className="max-w-[70ch] text-pretty">GitHub no longer accepts the link, so repositories that came to you through GitHub are hidden for now. Link again to restore them.</p>
          <div className="flex flex-wrap items-center gap-2">
            {available ? <LinkGithubForm /> : <p className="text-ink-3">{NO_KEY_TEXT}</p>}
            <UnlinkGithubButton login={link.login} />
          </div>
        </>
      )}
    </div>
  );
}

export function GithubAccountPanel({ view, result }: { view: GithubAccountView; result: LinkMessage | null }) {
  const summary = view.link === null ? "Not linked" : view.link.state === "relink" ? "Needs relinking" : view.link.login ? `@${view.link.login}` : "Linked";
  return (
    <Panel title="GitHub account" icon={KeyRound} id="github-account" summary={summary}>
      <GithubAccountBody view={view} result={result} />
    </Panel>
  );
}
