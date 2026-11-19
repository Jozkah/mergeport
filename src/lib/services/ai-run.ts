import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { ValidationError } from "@/lib/errors";
import type { Vault } from "@/lib/hub/session-vault";
import { todayIn } from "@/lib/domain/planning";
import { answerQuestion, draftTasks, loadAiConfig, rememberModel, type Step } from "./ai";
import { gatherFacts } from "./ai-facts";
import { listProjects } from "./queries";
import { assigneeCandidates } from "./tasks";

/** The two AI jobs, with a `step` callback that says what is happening so the page can show it while it waits. */
export async function runDraft(db: Db, v: Viewer, vault: Vault, input: { text: string; projectId?: string }, step: Step) {
  const cfg = await loadAiConfig(db, vault);
  if (!cfg) throw new ValidationError("Set up the AI endpoint in Settings first.");
  step("Collecting your projects and people");
  const projects = (await listProjects(db, v)).map((p) => ({ id: p.id, name: p.name }));
  const ordered = [...projects.filter((p) => p.id === input.projectId), ...projects.filter((p) => p.id !== input.projectId)];
  const people = [...new Set((await Promise.all(projects.map((p) => assigneeCandidates(db, v, p.id)))).flat())];
  const { drafts, model } = await draftTasks(cfg, input.text, { projects: ordered, people, today: todayIn(v.timezone), me: v.login }, fetch, step);
  await rememberModel(db, model);
  return { drafts, model };
}

export async function runAsk(db: Db, v: Viewer, vault: Vault, input: { question: string }, step: Step) {
  const cfg = await loadAiConfig(db, vault);
  if (!cfg) throw new ValidationError("Set up the AI endpoint in Settings first.");
  step("Looking for the items you mention");
  const facts = await gatherFacts(db, v, input.question);
  step(facts.length ? `Found ${facts.length} matching item${facts.length === 1 ? "" : "s"}: ${facts.map((x) => x.label).join(", ")}` : "No matching items found, the model will be told so");
  const { answer, model } = await answerQuestion(cfg, input.question, facts, fetch, step);
  await rememberModel(db, model);
  return { answer, model, sources: facts.map((x) => ({ label: x.label, href: x.href })) };
}
