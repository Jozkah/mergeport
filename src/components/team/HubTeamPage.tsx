import { requireViewer } from "@/lib/authz-page";
import { HubForbidden, HubUnauthorized, type HubLinkStatus } from "@/lib/hub/ports";
import { hubLinkStatus } from "@/lib/hub/ports-stub";
import { getHubTeamService } from "@/lib/local/runtime";
import type { HubOverview } from "@/lib/team/hub-service";
import { HubTeamPanel, type HubTeamError } from "@/components/team/HubTeamPanel";

/** The Team page of a hub profile. Loads what the hub says; a failure is shown in the page, never thrown. Only hub services are touched. */
export async function HubTeamPage({ backend }: { backend: string }) {
  await requireViewer();
  const { svc, dbFile, origin } = await getHubTeamService(backend);
  const status: HubLinkStatus = await hubLinkStatus(dbFile).catch(() => ({ state: "offline", pendingOps: 0, needsSignIn: false }));
  let overview: HubOverview | null = null;
  let error: HubTeamError | null = null;
  try {
    overview = await svc.overview();
  } catch (e) {
    error = e instanceof HubUnauthorized ? { kind: "unauthorized" } : e instanceof HubForbidden ? { kind: "forbidden" } : { kind: "request", message: e instanceof Error && e.name === "HubRequestError" ? e.message : "The server did not answer. What is shown may be out of date." };
  }
  return <HubTeamPanel origin={origin} status={status} overview={overview} error={error} />;
}
