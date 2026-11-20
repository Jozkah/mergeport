import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { oidcProviders } from "@/lib/auth/oidc";
import { mailConfigured } from "@/lib/auth/mailer";
import { safeReturnTo } from "@/lib/http";

const ERRORS: Record<string, string> = {
  "email-invalid": "That does not look like an email address.",
  "mail-unconfigured": "Email sign-in is not set up on this server. Ask its administrator to configure outgoing mail.",
  "mail-failed": "The email could not be sent right now. Try again in a minute.",
  "link-invalid": "That sign-in link has expired or was already used. Ask for a new one.",
  "oidc-unavailable": "That provider could not be reached. Try again, or use email.",
  "oidc-flow": "The sign-in took too long or was started in another browser. Start again.",
  "oidc-state": "The sign-in could not be verified. Start again.",
  "oidc-nonce": "The sign-in could not be verified. Start again.",
  "oidc-exchange": "The provider did not confirm your sign-in. Start again.",
  "oidc-provider-error": "The provider declined the sign-in.",
  "oidc-claims": "The provider did not identify you. Try another way to sign in.",
};

/** Sign-in for a hosted deployment: an email link and any configured OIDC providers. Plain forms and links, no client code. */
export function AccountSignIn({ error, sent, next }: { error?: string; sent?: boolean; next?: string }) {
  const providers = oidcProviders();
  const canMail = mailConfigured();
  const dest = safeReturnTo(next);
  const q = dest !== "/" ? `?next=${encodeURIComponent(dest)}` : "";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-5 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <Logo size={36} />
        <span className="text-[18px] font-medium">Mergeport</span>
      </div>
      <div className="panel">
        <div className="panel-body p-5">
          <h1 className="text-[20px] font-medium">Sign in</h1>
          {error && <div className="mt-4"><Banner tone="error" title="Could not sign you in">{ERRORS[error] ?? "Something went wrong."}</Banner></div>}
          {sent && <div className="mt-4"><Banner tone="info" title="Check your email">If the address is valid, a sign-in link is on its way. It works once and expires in 15 minutes.</Banner></div>}

          {canMail ? (
            <form action="/auth/magic/request" method="post" className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="next" value={dest} />
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="font-medium text-ink-2">Email</span>
                <input className="input" name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" />
              </label>
              <button className="btn btn-primary !h-10 w-full">Email me a sign-in link</button>
            </form>
          ) : (
            <p className="mt-4 text-[13px] text-ink-3">Email sign-in is not set up on this server.</p>
          )}

          {providers.length > 0 && (
            <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
              {providers.map((p) => (
                <a key={p.name} className="btn !h-10 w-full justify-center" href={`/auth/oidc/${p.name}/start${q}`}>Continue with {p.label}</a>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
