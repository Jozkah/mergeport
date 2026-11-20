import { redirect } from "next/navigation";
import { createWorkspaceAction } from "@/app/account-actions";
import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { getAuth } from "@/lib/auth/current";

export const metadata = { title: "Create a workspace" };
export const dynamic = "force-dynamic";

/** First stop after a first email or OIDC sign-in: the person belongs to no workspace yet. */
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  if (a.viewer) redirect("/");
  const sp = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-5 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <Logo size={36} />
        <span className="text-[18px] font-medium">Mergeport</span>
      </div>
      <div className="panel">
        <div className="panel-body p-5">
          <h1 className="text-[20px] font-medium">Create your workspace</h1>
          <p className="mt-2 text-[13px] text-ink-3">A workspace holds your team&apos;s projects and repositories. You will be its administrator.</p>
          {sp.error && <div className="mt-4"><Banner tone="error" title="Could not create it">{sp.error === "limit" ? "You have created several workspaces today. Try again tomorrow." : "Give the workspace a name of up to 80 characters."}</Banner></div>}
          <form action={createWorkspaceAction} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium text-ink-2">Workspace name</span>
              <input className="input" name="name" required maxLength={80} autoComplete="organization" placeholder="Acme engineering" />
            </label>
            <button className="btn btn-primary !h-10 w-full">Create workspace</button>
          </form>
          <p className="mt-3 text-[12.5px] text-ink-3">Signed in as {a.user.email ?? a.user.login}.</p>
        </div>
      </div>
      <form action="/auth/signout" method="post"><button className="btn btn-quiet">Sign out</button></form>
    </main>
  );
}
