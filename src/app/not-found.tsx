import { ErrorScreen } from "@/components/ui/AuthShell";

/** One page for "missing" and "not allowed". Hidden resources are indistinguishable from nonexistent ones. */
export default function NotFound() {
  return (
    <ErrorScreen title="Not found" label="Back to the overview">
      This page does not exist, or you do not have access to it.
    </ErrorScreen>
  );
}
