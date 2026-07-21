CREATE TABLE "launch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"command_id" uuid,
	"server_id" uuid,
	"game_id" text,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "launch_events" ADD CONSTRAINT "launch_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "launch_events" ADD CONSTRAINT "launch_events_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "launch_events" ADD CONSTRAINT "launch_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "idx_launch_events_session_created" ON "launch_events" USING btree ("session_id", "created_at");
CREATE INDEX "idx_launch_events_command_created" ON "launch_events" USING btree ("command_id", "created_at");
