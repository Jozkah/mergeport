import { AuthShell, OrDivider } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { oidcProviders } from "@/lib/auth/oidc";
import { mailConfigured } from "@/lib/auth/mailer";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { safeReturnTo } from "@/lib/http";
import { RedirectLink, SubmitButton } from "./SubmitButton";

const ERRORS: Record<string, string> = {
  "email-invalid": "That does not look like an email address.",
  "mail-unconfigured": "Email sign-in is not set up on this server. Ask its administrator to configure outgoing mail.",
  "mail-failed": "The email could not be sent right now. Try again in a minute.",
  "link-invalid": "That sign-in link has expired or was already used. Ask for a new one.",
  "link-browser": "Open this link in the browser where you asked for it. If you opened it somewhere else, nothing was used up: go back to that browser, or ask for a new link here.",
  "oidc-unavailable": "That provider could not be reached. Try again, or use email.",
  "oidc-flow": "The sign-in took too long or was started in another browser. Start again.",
  "oidc-state": "The sign-in could not be verified. Start again.",
  "oidc-nonce": "The sign-in could not be verified. Start again.",
  "oidc-exchange": "The provider did not confirm your sign-in. Start again.",
  "oidc-provider-error": "The provider declined the sign-in.",
  "oidc-claims": "The provider did not identify you. Try another way to sign in.",
};

/** Sign-in for a hosted deployment: an email link and any configured OIDC providers. Plain forms and links. */
export function AccountSignIn({ error, sent, next, email }: { error?: string; sent?: boolean; next?: string; email?: string }) {
  const providers = oidcProviders();
  const misconfigured = hostedConfigProblems().length > 0; // the request route refuses too; say so here instead of failing after a click
  const canMail = !misconfigured && mailConfigured();
  const nothing = !canMail && providers.length === 0;
  const dest = safeReturnTo(next);
  const q = dest !== "/" ? `?next=${encodeURIComponent(dest)}` : "";
  const typed = typeof email === "string" ? email.slice(0, 254) : "";
  return (
    <AuthShell title="Sign in">
      {error && <div className="mt-4"><Banner tone="error" title="Could not sign you in">{ERRORS[error] ?? "Something went wrong. Try again."}</Banner></div>}
      {misconfigured ? (
        <div className="mt-4"><Banner tone="error" title="Sign-in is not configured">This server is missing part of its hosted configuration. Ask its administrator; the details are in the server log.</Banner></div>
      ) : nothing ? (
        <div className="mt-4"><Banner tone="error" title="Sign-in is not set up">This server has no email or provider sign-in configured. Ask its administrator to set one up.</Banner></div>
      ) : null}
      {sent && <div className="result-in mt-4"><Banner tone="info" title="Check your email">If the address is valid, a sign-in link is on its way. It works once and expires in 15 minutes.</Banner></div>}

      {canMail && (
        <form action="/auth/magic/request" method="post" className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="next" value={dest} />
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium text-ink-2">Email</span>
            <input className="input" name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" defaultValue={typed} />
          </label>
          <SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Sending…">Email me a sign-in link</SubmitButton>
        </form>
      )}
      {!canMail && !nothing && !misconfigured && <p className="mt-4 text-[13px] text-ink-3">Email sign-in is not set up on this server. Use a provider below.</p>}

      {providers.length > 0 && (
        <>
          {canMail ? <OrDivider /> : <div className="mt-4" />}
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <RedirectLink key={p.name} className="btn btn-lg w-full" href={`/auth/oidc/${p.name}/start${q}`}>Continue with {p.label}</RedirectLink>
            ))}
          </div>
        </>
      )}
    </AuthShell>
  );
}
