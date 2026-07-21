ALTER TABLE "commands" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "last_error" text;