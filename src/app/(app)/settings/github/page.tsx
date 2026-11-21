import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { can } from "@/lib/authz/roles";
import { isDemo } from "@/lib/env";
import { isHosted } from "@/lib/public-url";
import { githubAppConfigured } from "@/lib/github/app-config";
import { listWorkspaceInstallations } from "@/lib/github/binding";
import { RESULT_MESSAGES, isConnectResult } from "@/lib/github/connect-messages";
import { PageHeader } from "@/components/ui/primitives";
import { GithubSettingsBody } from "@/components/settings/GithubPanels";

export const metadata = { title: "GitHub settings" };
export const dynamic = "force-dynamic";

/**
 * Settings > GitHub (hosted workspaces). Owners and administrators connect and disconnect; everyone else sees the status read-only.
 * The `github` query value is only ever looked up in a fixed table of messages, never shown.
 */
export default async function GithubSettings({ searchParams }: { searchParams: Promise<{ github?: string | string[] }> }) {
  const { viewer } = await requireViewer();
  if (isDemo() || !isHosted()) notFound();
  const raw = (await searchParams).github;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const rows = await listWorkspaceInstallations(db, viewer.workspaceId);
  return (
    <>
      <PageHeader
        title="GitHub"
        subtitle="The GitHub accounts this workspace reads from."
        help={<>Connecting lets Mergeport read repositories, issues and pull requests from a GitHub account through the Mergeport GitHub App, with read-only access. You prove on GitHub that you control the account; Mergeport does not keep your GitHub sign-in. Disconnecting never deletes tasks, projects or history.</>}
      />
      <GithubSettingsBody
        view={{ configured: githubAppConfigured(), manage: can(viewer, "manageGithub"), installations: rows.map((r) => ({ ...r, installationId: String(r.installationId) })) }}
        result={isConnectResult(code) ? RESULT_MESSAGES[code] : null}
      />
    </>
  );
}
