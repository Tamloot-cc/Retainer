-- Custom privilege migration, scaffolded with drizzle-kit generate --custom.
-- Seeding and template application run as retainer_app under workspace RLS.
-- Let those transactions stamp the definitions they actually installed.
GRANT UPDATE ("definitions_digest") ON "workspaces" TO retainer_app;
