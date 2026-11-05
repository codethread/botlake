-- Stop the lake and back up its SQLite database before running:
-- sqlite3 -bail "$DATABASE" < backfill-ended.sql
-- Restart the lake afterward. This offline repair does not emit runtime events.
-- Observation attributes and provenance remain unchanged; reruns are harmless.
BEGIN IMMEDIATE;

UPDATE nodes
SET state = 'closed',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    revision = revision + 1
WHERE state = 'active'
  AND id IN (
    SELECT node_id FROM attributes
    WHERE key = 'identity/session' AND value = 'true'
  )
  AND id IN (
    SELECT node_id FROM attributes
    WHERE key = 'identity/activity' AND value = '"ended"'
  )
  AND NOT EXISTS (
    SELECT 1 FROM node_references
    WHERE node_id = nodes.id
  );

SELECT changes() AS closed_identities;

COMMIT;
