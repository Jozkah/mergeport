import { WorkListPage } from "@/components/work/WorkListPage";

export const metadata = { title: "Issues" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <WorkListPage type="ISSUE" searchParams={await searchParams} />;
}
