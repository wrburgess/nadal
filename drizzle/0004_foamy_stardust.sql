ALTER TABLE `player_aliases` ADD `name_key` text;--> statement-breakpoint
CREATE INDEX `player_aliases_name_key_idx` ON `player_aliases` (`name_key`);--> statement-breakpoint
ALTER TABLE `players` ADD `name_key` text;--> statement-breakpoint
ALTER TABLE `players` ADD `name_key_length` integer GENERATED ALWAYS AS (length(name_key)) VIRTUAL;--> statement-breakpoint
CREATE INDEX `players_name_key_idx` ON `players` (`name_key`);--> statement-breakpoint
CREATE INDEX `players_name_key_length_idx` ON `players` (`name_key_length`);--> statement-breakpoint
ALTER TABLE `teams` ADD `name_key` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `name_key_length` integer GENERATED ALWAYS AS (length(name_key)) VIRTUAL;--> statement-breakpoint
CREATE INDEX `teams_name_key_idx` ON `teams` (`name_key`);--> statement-breakpoint
CREATE INDEX `teams_name_key_length_idx` ON `teams` (`name_key_length`);