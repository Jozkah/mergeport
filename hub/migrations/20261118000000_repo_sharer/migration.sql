-- Webhook relay provenance: every member who wrote a `repo` entity (the first publisher and each later writer). A private repository
-- counts as shared only when one of its writers is the repository's GitHub owner or is an ACTIVE hub ADMIN/OWNER at delivery time.
CREATE TABLE repo_sharer (
  space_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  PRIMARY KEY (space_id, entity_id, github_id)
);
-- Existing shares: the writers still in the event log, plus each entity's last writer.
INSERT OR IGNORE INTO repo_sharer (space_id, entity_id, github_id) SELECT space_id, entity_id, actor_github_id FROM entity_event WHERE type = 'repo';
INSERT OR IGNORE INTO repo_sharer (space_id, entity_id, github_id) SELECT space_id, entity_id, updated_by FROM entity WHERE type = 'repo';
