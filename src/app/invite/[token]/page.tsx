import { acceptInviteAction } from "../actions";
import { AuthShell, ErrorScreen, OrDivider } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { RoleChip } from "@/components/ui/identity";
import { RedirectLink, SubmitButton } from "@/components/forms/SubmitButton";
import { getAuth } from "@/lib/auth/current";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { mailConfigured } from "@/lib/auth/mailer";
import { oidcProviders } from "@/lib/auth/oidc";
import { db } from "@/lib/db";
import { previewInvitation } from "@/lib/services/invitations";

/** "same-origin": nothing is sent to other sites, but a same-origin form post keeps a real Origin header ("no-referrer" makes browsers send "Origin: null"). */
export const metadata = { title: "Invitation", referrer: "same-origin" };
export const dynamic = "force-dynamic";

/**
 * /invite/<token>. Nothing happens on GET: the page only shows the invitation and, for the right person, a Join button. Missing, used,
 * revoked and expired tokens all look the same. The invited address is the identity proof: a magic link sent to it signs the person
 * in as that address, and an OIDC login only counts when the provider says the address is verified.
 * (The invitation preview carries no inviter name, so none is shown; nothing is invented.)
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await previewInvitation(db, token);
  const a = await getAuth();
  if (!inv) {
    return (
      <ErrorScreen title="This invitation is not valid" href={a ? "/" : "/sign-in"} label={a ? "Back to Mergeport" : "Go to sign in"}>
        It may have expired, been used, or been withdrawn. Ask the person who invited you to send a new one.
      </ErrorScreen>
    );
  }
  const next = `/invite/${token}`;
  const title = <>Join <bdi>{inv.workspaceName}</bdi></>;
  const lead = (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-3">
      <span>You were invited as</span> <RoleChip role={inv.role} />
    </p>
  );
  const address = (
    <p className="mt-2 text-[13px] text-ink-3">
      Invited address: <strong className="break-all font-medium text-ink-2"><bdi>{inv.email}</bdi></strong>
    </p>
  );
  const mine = a?.user.email?.toLowerCase() === inv.email;

  if (a && mine && a.user.emailVerifiedAt) {
    return (
      <AuthShell title={title}>
        {lead}
        {address}
        <form action={acceptInviteAction} className="mt-4">
          <input type="hidden" name="token" value={token} />
          <SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Joining…">Join workspace</SubmitButton>
        </form>
      </AuthShell>
    );
  }

  const canMail = hostedConfigProblems().length === 0 && (await mailConfigured());
  const providers = oidcProviders();
  const signInForm = canMail ? (
    <form action="/auth/magic/request" method="post" className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="email" value={inv.email} />
      <SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Sending…">Email me a sign-in link</SubmitButton>
    </form>
  ) : (
    <p className="mt-4 text-[13px] text-ink-3">Email sign-in is not set up on this server.</p>
  );
  const oidc = providers.length > 0 && (
    <>
      {canMail ? <OrDivider /> : <div className="mt-4" />}
      <div className="flex flex-col gap-2">
        {providers.map((p) => <RedirectLink key={p.name} className="btn btn-lg w-full" href={`/auth/oidc/${p.name}/start?next=${encodeURIComponent(next)}`}>Continue with {p.label}</RedirectLink>)}
        <p className="text-[12px] text-ink-3">The provider must confirm that you own <bdi className="break-all">{inv.email}</bdi>.</p>
      </div>
    </>
  );
  const signOut = (
    <form action="/auth/signout" method="post" className="mt-4"><SubmitButton className="btn btn-quiet" pendingLabel="Signing out…">Sign out and use another account</SubmitButton></form>
  );

  if (a && mine) {
    // Signed in as the invited address, but the address was never confirmed: a link sent to it (or a verifying provider) confirms it.
    return (
      <AuthShell title="Confirm your email first">
        <div className="mt-4"><Banner tone="warn" title={`Your address is not confirmed yet`}>You are signed in as <bdi className="break-all">{inv.email}</bdi>, but it has not been confirmed. Confirm it by signing in with a link, then come back to join <bdi>{inv.workspaceName}</bdi>.</Banner></div>
        {signInForm}
        {oidc}
      </AuthShell>
    );
  }

  if (a) {
    return (
      <AuthShell title={title}>
        {lead}
        {address}
        <div className="mt-4"><Banner tone="error" title="This invitation is for a different address">You are signed in as <bdi className="break-all">{a.user.email ?? `@${a.user.login}`}</bdi>, which is not the address it was sent to. Nothing was joined. Sign in with the invited address to continue.</Banner></div>
        {signInForm}
        {oidc}
        {signOut}
      </AuthShell>
    );
  }
  return (
    <AuthShell title={title}>
      {lead}
      {address}
      <p className="mt-3 text-[13px] text-ink-2">Sign in with that address to continue. You will review the invitation and press Join afterwards.</p>
      {signInForm}
      {oidc}
    </AuthShell>
  );
}
