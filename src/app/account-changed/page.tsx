import { checkProfile } from "@/lib/local/identity";
import Link from "next/link";
import { AuthShell } from "@/components/ui/AuthShell";
import { redirect } from "next/navigation";

export const metadata = { title: "Account changed" };
export const dynamic = "force-dynamic";

export default async function AccountChanged() {
  const p = await checkProfile();
  if (p.kind !== "mismatch") redirect("/");
  return (
    <AuthShell title="A different GitHub account is selected">
      <div role="alert">
        <p className="mt-2 text-[13px] text-ink-3">This Mergeport profile belongs to <strong>@{p.profileLogin}</strong>, but the GitHub CLI now has <strong>@{p.ghLogin}</strong> selected. That does not change who Mergeport acts as: every request uses @{p.profileLogin}&apos;s own sign-in, checked against that account&apos;s numeric id, and nothing is ever sent as @{p.ghLogin}.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink-2">
          <li>If @{p.profileLogin} is still signed in to the CLI, Mergeport simply carries on as @{p.profileLogin}.</li>
          <li>If it is not, requests are blocked and you are asked to reconnect: <span className="mono">gh auth login</span> as @{p.profileLogin}.</li>
          <li>To work as @{p.ghLogin} instead, run this app against a separate database (its own DATABASE_URL) for @{p.ghLogin}: one database holds one GitHub account.</li>
        </ul>
        <Link className="btn btn-lg mt-4 w-full" href="/">Continue</Link>
      </div>
    </AuthShell>
  );
}
