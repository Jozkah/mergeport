import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { AuthShell, ErrorScreen } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { Disclosure } from "@/components/ui/Disclosure";
import { Host } from "@/components/ui/identity";
import { ConsentForms } from "@/components/federation/FederationForms";
import { getAuth } from "@/lib/auth/current";
import { liveCtx } from "@/lib/federation/context";
import { eligibleWorkspaces, parseAuthorizeRequest } from "@/lib/federation/provider";

/** The page that asks a person to share. It must never be framed (also CSP frame-ancestors and X-Frame-Options from proxy.ts). */
export const metadata = { title: "Approve linked instance", referrer: "same-origin" };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A plain-http origin is only unremarkable on the same machine. */
function insecure(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol === "https:") return false;
    const h = u.hostname;
    return !(h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h));
  } catch {
    return true;
  }
}

/**
 * /federation/authorize. Step 2 of linking, shown to the person who owns the data. The request is validated first (the return
 * address must be exactly <instance>/federation/callback), then the person must be signed in HERE, then they see who asks and what
 * read-only means, and choose a workspace. Nothing is granted by loading this page; only the Approve button (a POST) does that.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = liveCtx();
  if (!ctx) notFound();
  const sp = await searchParams;
  const flat: Record<string, string | undefined> = {};
  for (const k of ["response_type", "client_origin", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]) flat[k] = first(sp[k]);
  const parsed = parseAuthorizeRequest(ctx, flat);
  if (!parsed.ok) {
    return (
      <ErrorScreen title="This request cannot be approved">
        {parsed.error} Nothing was shared. Go back to the other instance and start the link again.
      </ErrorScreen>
    );
  }
  const req = parsed.req;
  const a = await getAuth();
  if (!a) {
    const back = `/federation/authorize?${new URLSearchParams(Object.entries(flat).filter((e): e is [string, string] => typeof e[1] === "string")).toString()}`;
    redirect(`/sign-in?next=${encodeURIComponent(back)}`);
  }
  const { eligible, refused } = await eligibleWorkspaces(ctx, a.user.id, req.clientOrigin);
  const host = req.clientOrigin.replace(/^https?:\/\//, "");
  if (eligible.length === 0) {
    return (
      <AuthShell title={<>Nothing can be shared with <bdi>{host}</bdi></>}>
        <div className="mt-3">
          <Banner tone="warn" title="Linking is not allowed">
            {refused > 0 ? "No workspace of yours accepts links from this instance. An administrator of the workspace can allow it in Settings, Linked instances." : "You are not a member of any workspace yet."}
          </Banner>
        </div>
        <Link href="/" className="btn btn-lg mt-4 w-full">Back to Mergeport</Link>
      </AuthShell>
    );
  }
  const fields = { clientOrigin: req.clientOrigin, redirectUri: req.redirectUri, state: req.state, codeChallenge: req.codeChallenge, csrf: a.session.csrfToken };
  const one = eligible.length === 1 ? eligible[0] : null;
  return (
    <AuthShell
      title={<span className="text-balance"><bdi>{host}</bdi> wants read-only access to your projects as you</span>}
    >
      {/* The full origin with its scheme: this is what the person is trusting. */}
      <p className="mt-2 text-[12.5px] text-ink-2"><Host origin={req.clientOrigin} showScheme className="!block !whitespace-normal wrap-any" /></p>
      {insecure(req.clientOrigin) && (
        <div className="mt-3"><Banner tone="warn" title="This address is not secure">It does not use https, so what it shows you could be read or changed on the way. Only continue if you trust this network and know this instance.</Banner></div>
      )}
      {one ? (
        <p className="mt-3 text-[13px] text-ink-2">Workspace shared: <strong className="wrap-any font-medium"><bdi>{one.name}</bdi></strong></p>
      ) : null}
      <p className="mt-2 text-[12.5px] text-ink-3">Signed in as <bdi className="break-all">{a.user.email ?? `@${a.user.login}`}</bdi>. That instance shows your projects to you, there. This instance keeps the data and checks your access on every request.</p>
      <h2 className="mt-3 border-t border-line pt-3 text-[12px] font-medium text-ink-3">Read-only includes</h2>
      <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-2">
        <li>Names and descriptions of the projects you can see in the workspace you choose.</li>
        <li>Their boards: columns, and each task&apos;s title, description, priority, due date, assignee name and labels.</li>
        <li>Only what you can see here. Projects in spaces you are not part of stay hidden.</li>
      </ul>
      <div className="mt-2 border-t border-line pt-1">
        <Disclosure summary="What it never includes, and how long it lasts">
          <ul className="list-disc pl-5 text-[13px] text-ink-2">
            <li>It never includes the ability to change, move, create or delete anything.</li>
            <li>It never includes email addresses, GitHub access, settings, other workspaces, or other people&apos;s accounts.</li>
            <li>Access ends after 30 days without use (180 days at most).</li>
            <li>
              You can revoke it at any time under Linked instances
              {eligible.some((e) => e.role === "OWNER" || e.role === "ADMIN") ? <> (<Link href="/settings/linked" className="underline underline-offset-2">Settings, Linked instances</Link>)</> : null}
              , and so can your administrators.
            </li>
          </ul>
        </Disclosure>
      </div>
      <ConsentForms fields={fields} workspaces={eligible.map((e) => ({ id: e.workspaceId, name: e.name, role: e.role }))} />
    </AuthShell>
  );
}
