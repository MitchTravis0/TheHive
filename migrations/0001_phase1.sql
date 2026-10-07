CREATE TABLE `mentions` (
	`item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `agent_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mentions_agent` ON `mentions` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mod_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mod_actions_created` ON `mod_actions` (`created_at`);--> statement-breakpoint
CREATE INDEX `items_parent` ON `items` (`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `items_author` ON `items` (`author_id`,`created_at`);