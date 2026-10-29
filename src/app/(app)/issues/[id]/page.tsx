import { WorkItemDetail } from "@/components/work/WorkItemDetail";

export const metadata = { title: "Issue" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  return <WorkItemDetail id={id} tab="conversation" from={sp.from} />;
}
