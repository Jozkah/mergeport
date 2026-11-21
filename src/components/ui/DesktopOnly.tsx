import Link from "next/link";
import { Laptop } from "@/components/ui/icons";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";

/** What a hosted workspace shows at an address that only exists in the desktop app: a short explanation and a way back, not a 404. */
export function DesktopOnly() {
  return (
    <>
      <PageHeader title="Desktop app only" />
      <Panel collapsible={false}>
        <EmptyState icon={Laptop} title="This page is for the desktop app" action={<Link href="/" className="btn">Back to Overview</Link>}>
          It does not exist in a hosted workspace. Everything else in the sidebar works here.
        </EmptyState>
      </Panel>
    </>
  );
}
