import { HostedConnect } from "@/components/repos/HostedConnect";
import { requireViewer } from "@/lib/authz-page";

export const metadata = { title: "Connect repositories" };
export const dynamic = "force-dynamic";

/** The list comes from this workspace's own GitHub connection (the App's installation), not from a person's credential. */
export default async function Connect() {
  const { viewer } = await requireViewer();
  return <HostedConnect viewer={viewer} />;
}
