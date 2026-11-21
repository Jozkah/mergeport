import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

/**
 * The frame of every page a signed-out (or not yet placed) person sees: logo header, one panel, one h1, one width. Sign-in,
 * invitation, onboarding and the federation consent page all use it, so they cannot drift apart.
 * `aside` renders after the main panel (a second panel, a sign-out row).
 */
export function AuthShell({ title, children, aside, badge }: { title?: ReactNode; children: ReactNode; aside?: ReactNode; badge?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-5 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <Logo size={36} />
        <span className="text-[18px] font-medium">Mergeport</span>
        {badge}
      </div>
      <div className="panel">
        <div className="panel-body p-5">
          {title ? <h1 className="wrap-any text-[20px] font-medium">{title}</h1> : null}
          {children}
        </div>
      </div>
      {aside}
    </main>
  );
}

/** A dead end that still says what to do next: a message and one link out (home, or sign in). */
export function ErrorScreen({ title, children, href = "/", label = "Back to Mergeport" }: { title: string; children?: ReactNode; href?: string; label?: string }) {
  return (
    <AuthShell title={title}>
      {children ? <p className="mt-2 text-[13px] text-ink-3">{children}</p> : null}
      <Link href={href} className="btn btn-lg mt-4 w-full">{label}</Link>
    </AuthShell>
  );
}

/** "or" between two ways of doing the same thing (an email form and provider buttons). */
export function OrDivider() {
  return (
    <div className="my-4 flex items-center gap-3 text-[12px] text-ink-3" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
