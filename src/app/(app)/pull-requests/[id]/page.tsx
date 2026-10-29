import { WorkItemDetail } from "@/components/work/WorkItemDetail";

export const metadata = { title: "Pull request" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; from?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp.tab === "files" || sp.tab === "commits" ? sp.tab : "conversation";
  return <WorkItemDetail id={id} tab={tab} from={sp.from} />;
}
