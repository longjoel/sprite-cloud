-- DESTRUCTIVE: deploy and health-check sc-web code that no longer reads these
-- tables before applying this migration. Never apply this migration first.
-- Remove legacy commands that can upload private filesystem/library metadata.
DELETE FROM "commands" WHERE "type" IN ('browse_files', 'scan_paths');
UPDATE "commands"
SET "payload" = "payload" - 'rom_path' - 'platform' - 'game_name' - 'path' - 'paths';
UPDATE "servers"
SET "metadata" = "metadata" - 'rom_roots'
WHERE "metadata" ? 'rom_roots';

-- sc-server is the sole owner of ROM inventory and shared library preferences.
-- Child tables must be removed before games because their foreign keys use NO ACTION.
DROP TABLE IF EXISTS "favorites";
DROP TABLE IF EXISTS "pinned_games";
DROP TABLE IF EXISTS "recent_plays";
DROP TABLE IF EXISTS "game_files";
DROP TABLE IF EXISTS "games";

-- Configured ROM roots are private sc-server state and must not remain in sc-web.
DROP TABLE IF EXISTS "server_rom_roots";
