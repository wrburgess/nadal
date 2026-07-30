CREATE TABLE `availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_unique` ON `availability` (`player_id`,`event_id`,`day`);--> statement-breakpoint
CREATE TABLE `captain_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`pair_player_id` integer,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pair_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `court_match_players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`court_match_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`side` text NOT NULL,
	FOREIGN KEY (`court_match_id`) REFERENCES `court_matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `court_match_player_unique` ON `court_match_players` (`court_match_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `court_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_match_id` integer,
	`slot` text NOT NULL,
	`discipline` text NOT NULL,
	`winner_side` text,
	`score` text,
	`league_context` text,
	`played_on` text,
	FOREIGN KEY (`team_match_id`) REFERENCES `team_matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`format` text,
	`starts_on` text,
	`ends_on` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_name_unique` ON `events` (`name`);--> statement-breakpoint
CREATE TABLE `player_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`alias` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_alias_unique` ON `player_aliases` (`player_id`,`alias`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_name` text NOT NULL,
	`usta_uaid` text,
	`wtn_tennis_id` text,
	`tr_name_key` text,
	`age_range` text,
	`gender` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_usta_uaid_unique` ON `players` (`usta_uaid`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_wtn_tennis_id_unique` ON `players` (`wtn_tennis_id`);--> statement-breakpoint
CREATE TABLE `rating_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`source` text NOT NULL,
	`value` real NOT NULL,
	`rating_type` text,
	`observed_on` text NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rating_obs_unique` ON `rating_observations` (`player_id`,`source`,`observed_on`);--> statement-breakpoint
CREATE TABLE `request_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`surface` text NOT NULL,
	`command` text NOT NULL,
	`args` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`outcome` text
);
--> statement-breakpoint
CREATE TABLE `team_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer,
	`home_team_id` integer NOT NULL,
	`visiting_team_id` integer NOT NULL,
	`played_on` text,
	`source_match_id` text,
	`home_courts_won` integer,
	`visiting_courts_won` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visiting_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`event_id` integer,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_unique` ON `team_memberships` (`player_id`,`team_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`section` text,
	`district` text,
	`tennislink_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_name_unique` ON `teams` (`name`);