-- Attribution belongs to the current state. A later transition clears it
-- unless it is the completion of an uninstall that is already in progress.
CREATE FUNCTION retainer_clear_state_attribution()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  NEW.state_changed_by := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER routines_clear_state_attribution
BEFORE UPDATE OF status ON routines
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION retainer_clear_state_attribution();
--> statement-breakpoint
CREATE TRIGGER extensions_clear_state_attribution
BEFORE UPDATE OF state ON extension_installations
FOR EACH ROW WHEN (
  OLD.state IS DISTINCT FROM NEW.state
  AND NOT (OLD.state = 'uninstalling' AND NEW.state = 'uninstalled')
)
EXECUTE FUNCTION retainer_clear_state_attribution();
