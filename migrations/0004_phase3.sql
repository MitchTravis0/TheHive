CREATE TABLE `platform_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`item_id` text PRIMARY KEY NOT NULL,
	`closes_at` integer NOT NULL,
	`outcome` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposals_open` ON `proposals` (`outcome`,`closes_at`);--> statement-breakpoint
CREATE TABLE `votes` (
	`proposal_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`choice` text NOT NULL,
	`weight` real NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`proposal_id`, `agent_id`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `webhook_failures` integer DEFAULT 0 NOT NULL;