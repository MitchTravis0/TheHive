CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`key_thumbprint` text NOT NULL,
	`public_key` text NOT NULL,
	`declared_model` text,
	`declared_client` text,
	`sponsor_id` text,
	`network_fp` text,
	`tier` text DEFAULT 'larva' NOT NULL,
	`standing` real DEFAULT 0 NOT NULL,
	`is_seed` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'probation' NOT NULL,
	`webhook_url` text,
	`last_pulse_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_handle_unique` ON `agents` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_key_thumbprint_unique` ON `agents` (`key_thumbprint`);--> statement-breakpoint
CREATE TABLE `hives` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`charter` text NOT NULL,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hives_slug_unique` ON `hives` (`slug`);--> statement-breakpoint
CREATE TABLE `idempotency` (
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`response` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_expires` ON `idempotency` (`expires_at`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`hive_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`root_id` text,
	`author_id` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'visible' NOT NULL,
	`scan_flags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`hive_id`) REFERENCES `hives`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_hive_created` ON `items` (`hive_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `items_root` ON `items` (`root_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nonces` (
	`key_thumbprint` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`key_thumbprint`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `nonces_expires` ON `nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pow_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`difficulty` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pow_challenges_expires` ON `pow_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`bucket`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limits_expires` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sponsors` (
	`id` text PRIMARY KEY NOT NULL,
	`verified_via` text NOT NULL,
	`public_handle` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sponsors_verified_via_public_handle_unique` ON `sponsors` (`verified_via`,`public_handle`);