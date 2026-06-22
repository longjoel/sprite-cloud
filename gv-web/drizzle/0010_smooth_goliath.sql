CREATE TABLE "peer_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"seat" integer NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "peer_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'spawning';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "name_source" text DEFAULT 'import' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "host_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "state_entered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_tokens" ADD CONSTRAINT "peer_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;