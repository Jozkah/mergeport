import { vi } from "vitest";
import type { Db } from "@/lib/db";
import { resetInstallationTokenCache } from "@/lib/github/app-auth";
import { resetGithubAppConfigCache } from "@/lib/github/app-config";
import { FakeGitHubServer } from "@/lib/github/fake-server";
import { setGithubAppFetchForTests } from "@/lib/github/transport";

/**
 * Shared set-up of the hosted GitHub tests: an in-memory GitHub with one registered App, the App's variables in the environment (what a
 * real deployment sets), and the App-traffic `fetch` pointed at the fake. No test reaches the network.
 */
export function hostedGithub() {
  const server = new FakeGitHubServer();
  const app = server.registerApp("4242");
  server.addUser("acme-owner");
  server.addOrg("acme", ["acme-owner"]);
  const create = (name: string, isPrivate: boolean) => server.fetchFor("acme-owner")("https://api.github.com/orgs/acme/repos", { method: "POST", body: JSON.stringify({ name, private: isPrivate }) });
  return { server, app, create };
}

export function useApp(server: FakeGitHubServer, app: { appId: string; privateKeyPem: string }) {
  vi.stubEnv("MERGEPORT_GITHUB_APP_ID", app.appId);
  vi.stubEnv("MERGEPORT_GITHUB_APP_PRIVATE_KEY", app.privateKeyPem);
  vi.stubEnv("MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", "w".repeat(32));
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_ID", "Iv1.testclient0001");
  vi.stubEnv("MERGEPORT_GITHUB_APP_CLIENT_SECRET", "s".repeat(40));
  vi.stubEnv("MERGEPORT_GITHUB_APP_SLUG", "mergeport-test");
  resetGithubAppConfigCache();
  resetInstallationTokenCache();
  setGithubAppFetchForTests(server.appFetch());
}

export function releaseApp() {
  setGithubAppFetchForTests(null);
  resetGithubAppConfigCache();
  resetInstallationTokenCache();
}

/**
 * Records a proved binding of a workspace to an installation, the way the connect flow leaves it (proof columns set). The row is the
 * tenant record; tracking a repository through it goes through `src/lib/github/binding.ts`, as in production.
 */
export async function bind(db: Db, workspaceId: string, installation: { id: number; accountLogin: string; accountId: number }) {
  await db.githubInstallation.upsert({
    where: { installationId: BigInt(installation.id) },
    create: { installationId: BigInt(installation.id), accountGithubId: BigInt(installation.accountId), accountLogin: installation.accountLogin, accountType: "ORGANIZATION" },
    update: {},
  });
  await db.workspaceInstallation.create({ data: { workspaceId, installationId: BigInt(installation.id), verifiedAt: new Date(), verifiedGithubUserId: 77n, proofMethod: "user-installations" } });
}
