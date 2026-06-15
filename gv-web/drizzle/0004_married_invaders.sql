CREATE TABLE "server_rom_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "server_rom_roots_server_path" UNIQUE("server_id","path")
);
--> statement-breakpoint
ALTER TABLE "server_rom_roots" ADD CONSTRAINT "server_rom_roots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;