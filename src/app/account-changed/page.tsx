import { checkProfile } from "@/lib/local/identity";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = { title: "Account changed" };
export const dynamic = "force-dynamic";

export default async function AccountChanged() {
  const p = await checkProfile();
  if (p.kind !== "mismatch") redirect("/");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-4 px-4 py-10">
      <div className="panel"><div className="panel-body p-6" role="alert">
        <h1 className="text-[20px] font-medium">A different GitHub account is selected</h1>
        <p className="mt-2 text-[13px] text-ink-3">This Mergeport profile belongs to <strong>@{p.profileLogin}</strong>, but the GitHub CLI now has <strong>@{p.ghLogin}</strong> selected. That does not change who Mergeport acts as: every request uses @{p.profileLogin}&apos;s own sign-in, checked against that account&apos;s numeric id, and nothing is ever sent as @{p.ghLogin}.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-ink-2">
          <li>If @{p.profileLogin} is still signed in to the CLI, Mergeport simply carries on as @{p.profileLogin}.</li>
          <li>If it is not, requests are blocked and you are asked to reconnect: <span className="mono">gh auth login</span> as @{p.profileLogin}.</li>
          <li>To work as @{p.ghLogin} instead, stop Mergeport and start it again with <span className="mono">npm run local</span>: it opens @{p.ghLogin}&apos;s own, separate profile.</li>
        </ul>
        <Link className="btn mt-4" href="/">Continue</Link>
      </div></div>
    </main>
  );
}
