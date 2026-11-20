import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { ConsentForms } from "@/components/federation/FederationForms";
import { getAuth } from "@/lib/auth/current";
import { liveCtx } from "@/lib/federation/context";
import { eligibleWorkspaces, parseAuthorizeRequest } from "@/lib/federation/provider";

/** The page that asks a person to share. It must never be framed (also CSP frame-ancestors and X-Frame-Options from proxy.ts). */
export const metadata = { title: "Approve linked instance", referrer: "same-origin" };
export const dynamic = "force-dynamic";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-[520px] flex-col justify-center gap-5 px-4 py-10">
    <div className="flex items-center gap-2.5">
      <Logo size={36} />
      <span className="text-[18px] font-medium">Mergeport</span>
    </div>
    <div className="panel"><div className="panel-body p-5">{children}</div></div>
  </main>
);

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

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
      <Shell>
        <h1 className="text-[20px] font-medium">This request cannot be approved</h1>
        <p className="mt-2 text-[13px] text-ink-3">{parsed.error} Nothing was shared. Go back to the other instance and start the link again.</p>
      </Shell>
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
      <Shell>
        <h1 className="text-[20px] font-medium">Nothing can be shared with {host}</h1>
        <div className="mt-3">
          <Banner tone="warn" title="Linking is not allowed">
            {refused > 0 ? "No workspace of yours accepts links from this instance. An administrator of the workspace can allow it in Settings, Linked instances." : "You are not a member of any workspace yet."}
          </Banner>
        </div>
        <Link href="/" className="btn mt-4 !h-10">Back to Mergeport</Link>
      </Shell>
    );
  }
  const fields = { clientOrigin: req.clientOrigin, redirectUri: req.redirectUri, state: req.state, codeChallenge: req.codeChallenge, csrf: a.session.csrfToken };
  const one = eligible.length === 1 ? eligible[0] : null;
  return (
    <Shell>
      <h1 className="text-[20px] font-medium text-balance">
        <span className="[overflow-wrap:anywhere]">{host}</span> wants read-only access to {one ? <>your <strong>{one.name}</strong> projects</> : "your projects"} as you
      </h1>
      <p className="mt-2 text-[13px] text-ink-3">Signed in as {a.user.email ?? `@${a.user.login}`}. After you approve, that instance shows your projects to you, there. It is you looking, not a copy: this instance keeps the data and checks your access on every request.</p>
      <h2 className="mt-4 text-[13px] font-medium">Read-only includes</h2>
      <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-2">
        <li>Names and descriptions of the projects you can see in the workspace you choose.</li>
        <li>Their boards: columns, and each task&apos;s title, description, priority, due date, assignee name and labels.</li>
        <li>Only what you can see here. Projects in spaces you are not part of stay hidden.</li>
      </ul>
      <h2 className="mt-4 text-[13px] font-medium">It never includes</h2>
      <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-2">
        <li>The ability to change, move, create or delete anything.</li>
        <li>Email addresses, GitHub access, settings, other workspaces, or other people&apos;s accounts.</li>
      </ul>
      <p className="mt-3 text-[12.5px] text-ink-3">Access ends after 30 days without use (180 days at most). You can revoke it at any time under Linked instances, and so can your administrators.</p>
      <ConsentForms fields={fields} workspaces={eligible.map((e) => ({ id: e.workspaceId, name: e.name, role: e.role }))} />
    </Shell>
  );
}
