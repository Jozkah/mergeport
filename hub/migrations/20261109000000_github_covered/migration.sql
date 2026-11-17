-- Repositories the GitHub App is known to cover, learned from the deliveries GitHub sends (installation events, or any event for the repository).
CREATE TABLE github_covered (
  repo_id TEXT PRIMARY KEY NOT NULL,
  seen_at INTEGER NOT NULL
);
