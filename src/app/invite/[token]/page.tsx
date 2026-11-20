import { acceptInviteAction } from "../actions";
import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth/current";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { mailConfigured } from "@/lib/auth/mailer";
import { oidcProviders } from "@/lib/auth/oidc";
import { ROLE_LABEL } from "@/lib/authz/roles";
import { db } from "@/lib/db";
import { previewInvitation } from "@/lib/services/invitations";

export const metadata = { title: "Invitation", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-5 px-4 py-10">
    <div className="flex items-center gap-2.5">
      <Logo size={36} />
      <span className="text-[18px] font-medium">Mergeport</span>
    </div>
    <div className="panel"><div className="panel-body p-5">{children}</div></div>
  </main>
);

/**
 * /invite/<token>. Nothing happens on GET: the page only shows the invitation and, for the right person, a Join button. Missing, used,
 * revoked and expired tokens all look the same. The invited address is the identity proof: a magic link sent to it signs the person
 * in as that address, and an OIDC login only counts when the provider says the address is verified.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await previewInvitation(db, token);
  if (!inv) {
    return (
      <Shell>
        <h1 className="text-[20px] font-medium">This invitation is not valid</h1>
        <p className="mt-2 text-[13px] text-ink-3">It may have expired, been used, or been withdrawn. Ask the person who invited you to send a new one.</p>
      </Shell>
    );
  }
  const a = await getAuth();
  const next = `/invite/${token}`;
  const title = <h1 className="text-[20px] font-medium">Join {inv.workspaceName}</h1>;
  const lead = <p className="mt-2 text-[13px] text-ink-3">You were invited as <strong className="text-ink-2">{ROLE_LABEL[inv.role]}</strong>, at <strong className="text-ink-2">{inv.email}</strong>.</p>;

  if (a && a.user.email === inv.email && a.user.emailVerifiedAt) {
    return (
      <Shell>
        {title}
        {lead}
        <form action={acceptInviteAction} className="mt-4">
          <input type="hidden" name="token" value={token} />
          <button className="btn btn-primary !h-10 w-full">Join workspace</button>
        </form>
      </Shell>
    );
  }

  const canMail = hostedConfigProblems().length === 0 && mailConfigured();
  const providers = oidcProviders();
  const signInForm = canMail ? (
    <form action="/auth/magic/request" method="post" className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="email" value={inv.email} />
      <button className="btn btn-primary !h-10 w-full">Email me a sign-in link for {inv.email}</button>
    </form>
  ) : (
    <p className="mt-4 text-[13px] text-ink-3">Email sign-in is not set up on this server.</p>
  );
  const oidc = providers.length > 0 && (
    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
      {providers.map((p) => <a key={p.name} className="btn !h-10 w-full justify-center" href={`/auth/oidc/${p.name}/start?next=${encodeURIComponent(next)}`}>Continue with {p.label}</a>)}
      <p className="text-[12px] text-ink-3">The provider must confirm that you own {inv.email}.</p>
    </div>
  );

  if (a) {
    return (
      <Shell>
        {title}
        <div className="mt-4"><Banner tone="error" title="This invitation is for a different address">You are signed in as {a.user.email ?? `@${a.user.login}`}, which is not the address it was sent to. Nothing was joined. Sign in with the invited address to continue.</Banner></div>
        {signInForm}
        {oidc}
        <form action="/auth/signout" method="post" className="mt-4"><button className="btn btn-quiet">Sign out</button></form>
      </Shell>
    );
  }
  return (
    <Shell>
      {title}
      {lead}
      <p className="mt-3 text-[13px] text-ink-2">Sign in with that address to continue. You will review the invitation and press Join afterwards.</p>
      {signInForm}
      {oidc}
    </Shell>
  );
}
