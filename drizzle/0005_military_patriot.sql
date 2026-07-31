ALTER TABLE `teams` ADD `is_home` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `team_home_unique` ON `teams` (`is_home`) WHERE is_home = 1;