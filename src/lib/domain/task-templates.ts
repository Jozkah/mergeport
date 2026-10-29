/** Reusable starting points for a task: its title prefix, description, labels, priority and checklist. Built in; nothing here is sent anywhere. */
export type TaskTemplate = { key: string; name: string; titlePrefix: string; description: string; labels: string[]; priority: number; checklist: string[] };

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "bug",
    name: "Bug report",
    titlePrefix: "Bug: ",
    description: "What happened:\n\nWhat you expected:\n\nHow to reproduce:\n1. \n2. \n\nVersion or commit:",
    labels: ["bug"],
    priority: 2,
    checklist: ["Reproduce it", "Write a failing test", "Fix it", "Verify the fix", "Note it in the changelog"],
  },
  {
    key: "feature",
    name: "Feature",
    titlePrefix: "Feature: ",
    description: "Why this is needed:\n\nWhat done looks like:\n\nOut of scope:",
    labels: ["enhancement"],
    priority: 1,
    checklist: ["Agree the approach", "Implement", "Add tests", "Update the docs", "Review"],
  },
  {
    key: "review",
    name: "Review follow-up",
    titlePrefix: "Review: ",
    description: "The pull request or change to follow up:\n\nWhat the reviewer asked for:",
    labels: ["review"],
    priority: 2,
    checklist: ["Answer every comment", "Push the changes", "Ask for a new review"],
  },
  {
    key: "release",
    name: "Release checklist",
    titlePrefix: "Release: ",
    description: "Version:\n\nTarget date:\n\nNotes:",
    labels: ["release"],
    priority: 3,
    checklist: ["Freeze the scope", "All checks green on the release branch", "Update the changelog", "Tag the release", "Publish the release", "Announce it", "Close the milestone"],
  },
];

export const templateByKey = (k: string) => TASK_TEMPLATES.find((t) => t.key === k) ?? null;
