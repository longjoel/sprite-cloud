CREATE TABLE "game_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"rom_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" bigint,
	"file_hash" text,
	"discovered_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "game_files_server_path" UNIQUE("server_id","rom_path")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"platform" text NOT NULL,
	"max_players" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "games_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "game_files" ADD CONSTRAINT "game_files_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_files" ADD CONSTRAINT "game_files_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_game_files_game" ON "game_files" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "idx_game_files_server" ON "game_files" USING btree ("server_id");