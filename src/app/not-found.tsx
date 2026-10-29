import Link from "next/link";

/** One page for "missing" and "not allowed". Hidden resources are indistinguishable from nonexistent ones. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-4 px-4 py-10">
      <div className="panel"><div className="panel-body p-6">
        <h1 className="text-[20px] font-medium">Not found</h1>
        <p className="mt-2 text-[13px] text-ink-3">This page does not exist, or you do not have access to it.</p>
        <Link href="/" className="btn mt-4">Back to the overview</Link>
      </div></div>
    </main>
  );
}
