import { AuthShell } from "@/components/ui/AuthShell";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { AccountSignIn } from "@/components/forms/AccountSignIn";
import { isHosted } from "@/lib/public-url";
import { env, isDemo } from "@/lib/env";
import { currentGhStatus } from "@/lib/local/identity";
import { loginCommand, REQUIRED_SCOPES } from "@/lib/github/gh";
import { Banner } from "@/components/ui/primitives";
import { ShieldCheck } from "@/components/ui/icons";
import { GhLogin } from "@/components/forms/GhLogin";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "gh-missing": "The GitHub CLI (gh) is not installed. Install it from cli.github.com, then reload this page.",
  "gh-login": "gh is not signed in to GitHub yet. Sign in with the button below, then try again.",
  "gh-error": "gh could not reach GitHub. Check your connection and try again.",
  mismatch: "gh is signed in as a different account than this profile belongs to. Switch with gh auth switch, or start Mergeport again to use that account's own profile.",
  "demo-unseeded": "Demo data has not been seeded. Run npm run local:demo, then reload this page.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string; next?: string; email?: string }> }) {
  const sp = await searchParams;
  // A hosted deployment (MERGEPORT_PUBLIC_URL) signs people in with email or OIDC. The GitHub CLI and demo sections below belong to the local app.
  if (isHosted()) return <AccountSignIn error={sp.error} sent={sp.sent === "1"} next={sp.next} email={sp.email} />;
  const demo = isDemo();
  const st = demo ? null : await currentGhStatus(true);
  const launched = Boolean(env().MERGEPORT_LAUNCH_TOKEN);
  return (
    <AuthShell
      title="Sign in with GitHub"
      badge={<span className="pill pill-neutral ml-auto">Runs on this computer</span>}
      aside={
        <>
          {demo && (
            <div className="panel">
              <div className="panel-head"><h2 className="text-[13px] font-medium text-ink-2">Demo people (synthetic)</h2></div>
              <form action="/api/local/demo" method="post" className="panel-body flex flex-col gap-2 p-3">
                <SubmitButton name="as" value="admin" className="btn justify-start" pendingLabel="Signing in…">Owner · owner-demo (sees everything)</SubmitButton>
                <SubmitButton name="as" value="alice" className="btn justify-start" pendingLabel="Signing in…">Member A · alice-demo (3 repositories)</SubmitButton>
                <SubmitButton name="as" value="bram" className="btn justify-start" pendingLabel="Signing in…">Member B · bram-demo (2 repositories)</SubmitButton>
              </form>
            </div>
          )}
        </>
      }
    >
      <>
          {sp.error && <div className="mt-4"><Banner tone="error" title="Could not sign you in">{ERRORS[sp.error] ?? "Something went wrong."}</Banner></div>}

          {demo && <p className="mt-2 text-[13px] text-ink-3">Demo mode uses synthetic data and never contacts GitHub.</p>}

          {st?.state === "missing-gh" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>Mergeport signs in through the official GitHub CLI so no secret has to be shared or stored by this app.</p>
              <ol className="list-decimal space-y-1 pl-5 text-ink-2">
                <li>Install <strong>gh</strong> from <a className="underline" href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">cli.github.com</a> (Windows: <span className="mono">winget install GitHub.cli</span>).</li>
                <li>Reopen this page.</li>
              </ol>
              <a className="btn w-fit" href="/sign-in">Check again</a>
            </div>
          )}

          {st?.state === "not-logged-in" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>The GitHub CLI is installed but not signed in.</p>
              <GhLogin />
              <p className="text-ink-3">Or run this yourself:</p>
              <pre className="mono overflow-x-auto rounded-[8px] border border-line bg-canvas p-2.5 text-[12px]">{loginCommand()}</pre>
              <p className="flex items-start gap-2 text-[12.5px] text-ink-3"><ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0" />This asks GitHub for the scopes <span className="mono">{REQUIRED_SCOPES.join(", ")}</span>. <strong className="font-medium text-ink-2">repo</strong> is broad read and write access to the repositories you can reach, not a read-only permission; it is what private coordination repositories and private source repositories need. gh keeps the token in your operating system&apos;s credential store. Mergeport never reads it and never sends it anywhere.</p>
            </div>
          )}

          {st?.state === "error" && <div className="mt-3"><Banner tone="error" title="Could not ask GitHub who you are">{st.message}</Banner></div>}

          {st?.state === "ok" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>gh is signed in as <strong>@{st.identity.login}</strong> (GitHub id {st.identity.id.toString()}). Your data is stored only in a profile for this exact account on this computer.</p>
              {launched ? (
                <p className="text-ink-3">Open Mergeport with the link the launcher opened (<span className="mono">npm run local</span>). That one-time link ties this browser to this process.</p>
              ) : (
                <form action="/api/local/signin" method="post"><SubmitButton className="btn btn-primary btn-lg w-full" pendingLabel="Signing in…">Continue as @{st.identity.login}</SubmitButton></form>
              )}
            </div>
          )}
      </>
    </AuthShell>
  );
}
