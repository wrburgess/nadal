ALTER TABLE `court_matches` ADD `source_match_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `court_match_source_unique` ON `court_matches` (`source_match_id`,`slot`) WHERE source_match_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `tennisrecord_url` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `tennisrecord_url` text;--> statement-breakpoint
CREATE UNIQUE INDEX `team_match_source_unique` ON `team_matches` (`source_match_id`) WHERE source_match_id IS NOT NULL;