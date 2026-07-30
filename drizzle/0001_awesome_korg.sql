-- Hand-added ahead of the generated CREATE UNIQUE INDEX below (drizzle-kit generate does not
-- emit data-reconciliation DML): a database migrated before this point could already contain
-- duplicate (team_id, player_id, NULL) rows, since the prior 3-column UNIQUE index let SQLite
-- treat NULLs as distinct. Without this, CREATE UNIQUE INDEX fails on any such database. Keeps
-- the lowest id per duplicate pair; touches nothing with a non-NULL event_id.
DELETE FROM `team_memberships` WHERE `event_id` IS NULL AND `id` NOT IN (SELECT MIN(`id`) FROM `team_memberships` WHERE `event_id` IS NULL GROUP BY `team_id`, `player_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `membership_unique_no_event` ON `team_memberships` (`team_id`,`player_id`) WHERE event_id IS NULL;