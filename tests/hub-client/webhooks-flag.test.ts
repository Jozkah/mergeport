import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHubWebhooks, readHubWebhooksEnabled, saveHubWebhooks } from "@/lib/hub/github-app-install";
import { HUB_WEBHOOKS_KEY } from "@/lib/hub/webhook-panel";
import { leaveTeamLocally } from "@/lib/team/leave";
import { FakeHub } from "./fake-hub";
import { makeHubClient, type HubTestClient } from "./harness";
import { ManualTimers } from "./manual-timers";

describe("the live link stores whether the hub's webhooks are enabled", () => {
  let hub: FakeHub;
  let c: HubTestClient;

  beforeEach(async () => {
    hub = new FakeHub();
    hub.addMember("2", "alice", "MEMBER");
    hub.createSpace("common", "COMMON", "Common");
    await hub.listen();
    c = await makeHubClient(hub, 2n, "alice");
  });
  afterEach(async () => {
    await c.close();
    await hub.close();
  });

  it("saves webhooks.enabled from me() under github-app-hub-webhooks (hello path)", async () => {
    expect(await readHubWebhooksEnabled(c.db)).toBe(false); // unknown means false
    hub.webhooks = { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null };
    c.startLive({ timers: new ManualTimers() });
    await vi.waitFor(async () => expect(await readHubWebhooksEnabled(c.db)).toBe(true));
    const row = await c.db.discoveryCache.findUnique({ where: { key: HUB_WEBHOOKS_KEY } });
    const saved = row?.payload as unknown as { enabled: boolean; at: string };
    expect(saved.enabled).toBe(true);
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
  });

  it("leaving the team and Turn off clear it", async () => {
    await saveHubWebhooks(c.db, true);
    await leaveTeamLocally(c.db);
    expect(await readHubWebhooksEnabled(c.db)).toBe(false);
    await saveHubWebhooks(c.db, true);
    await clearHubWebhooks(c.db);
    expect(await readHubWebhooksEnabled(c.db)).toBe(false);
  });
});
