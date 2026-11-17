import Link from "next/link";
import { requireViewer } from "@/lib/authz-page";
import { db } from "@/lib/db";
import { isDay } from "@/lib/domain/digest";
import { formatDateOnly, formatInstant } from "@/lib/format";
import { getDigest, latestDigest, listDigestDays } from "@/lib/services/digest";
import { getPrefs } from "@/lib/services/notification-prefs";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { ArrowLeft, ArrowRight, Newspaper } from "@/components/ui/icons";
import { DigestActions } from "@/components/digest/DigestActions";
import { DigestView } from "@/components/digest/DigestView";

export const metadata = { title: "Daily digest" };
export const dynamic = "force-dynamic";

const label = (day: string) => formatDateOnly(new Date(day + "T00:00:00Z"));

export default async function DigestPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const { viewer } = await requireViewer();
  const sp = await searchParams;
  await latestDigest(db, viewer); // in demo mode (no scheduler) this makes the first digest
  const days = await listDigestDays(db, viewer.userId);
  const day = isDay(sp.day) && days.some((d) => d.day === sp.day) ? sp.day : days[0]?.day;
  const digest = day ? await getDigest(db, viewer.userId, day) : null;
  if (!digest) {
    const { digest: s } = await getPrefs(db, viewer.userId);
    return (
      <>
        <PageHeader title="Daily digest" subtitle="What you did yesterday, what was left undone, and what needs you or other people." />
        <EmptyState icon={Newspaper} title="No digest yet">
          {s.enabled ? `The first one is made on a day Mergeport is open after ${String(s.hour).padStart(2, "0")}:00. It is built only from the data on this computer.` : "The daily digest is turned off. You can turn it on in Settings."}
        </EmptyState>
      </>
    );
  }
  const i = days.findIndex((d) => d.day === digest.day);
  const older = days[i + 1]?.day;
  const newer = days[i - 1]?.day;
  return (
    <>
      <PageHeader
        title={`Digest for ${label(digest.day)}`}
        subtitle={<>Built {formatInstant(digest.generatedAt, viewer.timezone)} from the data on this computer: nothing was fetched or sent. What is open and what needs attention is as of that moment.</>}
        actions={
          <>
            {older ? <Link href={`/digest?day=${older}`} className="btn" aria-label={`Older digest, ${label(older)}`}><ArrowLeft size={14} aria-hidden /> {label(older)}</Link> : <button type="button" className="btn" disabled>Older</button>}
            {newer ? <Link href={`/digest?day=${newer}`} className="btn" aria-label={`Newer digest, ${label(newer)}`}>{label(newer)} <ArrowRight size={14} aria-hidden /></Link> : <button type="button" className="btn" disabled>Newer</button>}
            <DigestActions day={digest.day} read={!!digest.readAt} />
          </>
        }
      />
      <DigestView payload={digest.payload} />
    </>
  );
}
