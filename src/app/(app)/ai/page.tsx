import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { getAiView } from "@/lib/services/ai";
import { listProjects } from "@/lib/services/queries";
import { AiAssistant } from "@/components/ai/AiAssistant";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { Sparkles } from "@/components/ui/icons";

export const metadata = { title: "AI assistant" };
export const dynamic = "force-dynamic";

export default async function AiPage() {
  const { viewer } = await requireViewer();
  if (isDemo()) {
    return (
      <>
        <PageHeader title="AI assistant" subtitle="Ask about your pull requests and issues, or turn notes into tasks." />
        <EmptyState icon={Sparkles} title="Not available in the demo">The demo sends nothing to an AI endpoint. Your own Mergeport can.</EmptyState>
      </>
    );
  }
  const ai = await getAiView(db);
  const projects = (await listProjects(db, viewer)).map((p) => ({ id: p.id, name: p.name }));
  return (
    <>
      <PageHeader
        title="AI assistant"
        subtitle="Ask about a pull request or issue, or turn notes into tasks. You confirm before anything is created."
        help={<>Answers use only what Mergeport has stored for repositories you can see, and link the items they come from. The assistant never changes anything by itself. Which model answers is chosen from the endpoint each time (<Link href="/settings#ai" className="underline">Settings</Link>).</>}
      />
      <AiAssistant configured={ai.saved} projects={projects} defaultProjectId={projects[0]?.id ?? ""} />
    </>
  );
}
