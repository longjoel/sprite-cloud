ALTER TABLE "sessions" ADD COLUMN "room_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_seats" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_room_token_unique" UNIQUE("room_token");