import { AuthShell, OrDivider } from "@/components/ui/AuthShell";
import { Banner } from "@/components/ui/primitives";
import { oidcProviders } from "@/lib/auth/oidc";
import { mailConfigured } from "@/lib/auth/mailer";
import { hostedConfigProblems } from "@/lib/auth/hosted-config";
import { githubSignInEnabled, SIGNIN_START_PATH } from "@/lib/github/sign-in";
import { safeReturnTo } from "@/lib/http";
import { RedirectLink, SubmitButton } from "./SubmitButton";

const ERRORS: Record<string, string> = {
  "email-invalid": "That does not look like an email address. Check it and try again.",
  "mail-unconfigured": "Email sign-in is not set up on this server. Ask its administrator to configure outgoing mail.",
  "mail-failed": "The email could not be sent right now. Try again in a minute.",
  "link-invalid": "That sign-in link has expired or was already used. Ask for a new one.",
  "link-browser": "Open this link in the browser where you asked for it. If you opened it somewhere else, nothing was used up: go back to that browser, or ask for a new link here.",
  "oidc-unavailable": "That provider could not be reached. Try again, or use email.",
  "oidc-flow": "The sign-in took too long or was started in another browser. Start again.",
  "oidc-state": "The sign-in could not be verified. Start again.",
  "oidc-nonce": "The sign-in could not be verified. Start again.",
  "oidc-exchange": "The provider did not confirm your sign-in. Start again.",
  "oidc-provider-error": "The provider declined the sign-in. Try again, or use email.",
  "oidc-claims": "The provider did not identify you. Try another way to sign in.",
  "github-invalid": "The GitHub sign-in took too long or was started in another browser. Start again.",
  "github-declined": "GitHub did not confirm your sign-in. Try again, or use email.",
  "github-no-email": "Your GitHub account has no verified primary email address, so Mergeport cannot tell who you are. Verify an address on GitHub and make it your primary one, then try again, or use email.",
  "github-email-taken": "An account with the verified email address of that GitHub account already exists, so nothing was linked and you are not signed in. Sign in with an email link to that address first, then link GitHub from Settings.",
  "github-no-key": "GitHub sign-in is not available on this server yet. Use email, or ask its administrator.",
  "github-unavailable": "GitHub did not answer. Try again in a minute.",
  "github-app-problem": "GitHub refused this server's App settings. Use email, and tell its administrator.",
  "github-rate-limited": "Too many attempts. Wait a few minutes and try again.",
  "github-error": "Something went wrong with GitHub sign-in. Try again, or use email.",
};
/** Errors that are not a failure of the person's attempt but an instruction: they get their own title. */
const TITLES: Record<string, string> = { "github-email-taken": "Sign in with your email first" };

/** Sign-in for a hosted deployment: an email link and any configured OIDC providers. Plain forms and links. */
export function AccountSignIn({ error, sent, next, email }: { error?: string; sent?: boolean; next?: string; email?: string }) {
  const providers = oidcProviders();
  const misconfigured = hostedConfigProblems().length > 0; // the request route refuses too; say so here instead of failing after a click
  const canMail = !misconfigured && mailConfigured();
  const github = !misconfigured && githubSignInEnabled(); // the deployment's own GitHub App; the button exists only when it is fully set up
  const nothing = !canMail && providers.length === 0 && !github;
  const dest = safeReturnTo(next);
  const q = dest !== "/" ? `?next=${encodeURIComponent(dest)}` : "";
  const typed = typeof email === "string" ? email.slice(0, 254) : "";
  return (
    <AuthShell title="Sign in">
      {error && <div className="mt-4"><Banner tone="error" title={TITLES[error] ?? "Could not sign you in"}>{ERRORS[error] ?? "Something went wrong. Try again."}</Banner></div>}
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
            <input className="input input-lg" name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" defaultValue={typed} autoFocus={!!error} aria-invalid={error === "email-invalid" || undefined} />
          </label>
          <SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Sending…">Email me a sign-in link</SubmitButton>
        </form>
      )}
      {!canMail && !nothing && !misconfigured && <p className="mt-4 text-[13px] text-ink-3">Email sign-in is not set up on this server. Use a provider below.</p>}

      {(providers.length > 0 || github) && (
        <>
          {canMail ? <OrDivider /> : <div className="mt-4" />}
          <div className="flex flex-col gap-2">
            {github && <RedirectLink className="btn btn-lg w-full" href={`${SIGNIN_START_PATH}${q}`}>Continue with GitHub</RedirectLink>}
            {providers.map((p) => (
              <RedirectLink key={p.name} className="btn btn-lg w-full" href={`/auth/oidc/${p.name}/start${q}`}>Continue with {p.label}</RedirectLink>
            ))}
          </div>
        </>
      )}
    </AuthShell>
  );
}
