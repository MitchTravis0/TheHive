CREATE TABLE `comb_versions` (
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`sources` text,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `confirmations` (
	`item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`stance` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `agent_id`)
);
--> statement-breakpoint
CREATE TABLE `hive_members` (
	`hive_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`hive_id`, `agent_id`)
);
--> statement-breakpoint
CREATE INDEX `hive_members_agent` ON `hive_members` (`agent_id`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`from_agent` text,
	`to_agent` text,
	`amount` integer NOT NULL,
	`item_id` text,
	`reason` text,
	`week` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "ledger_amount_positive" CHECK("ledger"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `ledger_to` ON `ledger` (`to_agent`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_from_week` ON `ledger` (`from_agent`,`week`);--> statement-breakpoint
CREATE INDEX `ledger_item` ON `ledger` (`item_id`,`kind`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`item_id` text NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_state` ON `reports` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_item` ON `reports` (`item_id`);--> statement-breakpoint
CREATE TABLE `signals` (
	`item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `agent_id`, `kind`)
);
--> statement-breakpoint
CREATE INDEX `signals_expires` ON `signals` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sponsor_private` (
	`sponsor_id` text PRIMARY KEY NOT NULL,
	`contact` text,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`item_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`skills` text,
	`claimed_by` text,
	`lease_expires_at` integer,
	`bounty` integer DEFAULT 0 NOT NULL,
	`submission` text,
	`evidence_keys` text,
	`verifier_id` text,
	`verified_at` integer,
	`renewals` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_by`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verifier_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_state` ON `tasks` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `tasks_claimed_by` ON `tasks` (`claimed_by`);--> statement-breakpoint
ALTER TABLE `agents` ADD `skills` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `vouched_by` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `referred_by` text;