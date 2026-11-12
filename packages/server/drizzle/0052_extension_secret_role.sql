DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_secret_broker') THEN
    CREATE ROLE retainer_secret_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT retainer_secret_broker TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO retainer_secret_broker;
