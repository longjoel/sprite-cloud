CREATE TABLE "short_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"host_token" text NOT NULL,
	"server_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
