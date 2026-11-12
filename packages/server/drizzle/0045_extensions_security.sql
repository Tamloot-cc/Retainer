-- Privileges are separate from the Drizzle-generated table and RLS definitions.
GRANT SELECT, INSERT, UPDATE, DELETE ON extension_installations,
  extension_contributions, extension_receipts TO retainer_app;
