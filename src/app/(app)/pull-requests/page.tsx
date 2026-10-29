import { WorkListPage } from "@/components/work/WorkListPage";

export const metadata = { title: "Pull requests" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <WorkListPage type="PULL_REQUEST" searchParams={await searchParams} />;
}
