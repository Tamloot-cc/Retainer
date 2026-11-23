-- Hosted opt-in. Compose and deployments using the timed drain leave generation null.
CREATE SCHEMA retainer_deploy;
--> statement-breakpoint
REVOKE ALL ON SCHEMA retainer_deploy FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE retainer_deploy.admission (
  singleton boolean PRIMARY KEY CHECK (singleton),
  generation uuid,
  builds text[] NOT NULL DEFAULT '{}',
  deployment uuid,
  candidate text,
  migrated boolean NOT NULL DEFAULT false,
  timed boolean NOT NULL DEFAULT false,
  closed_at timestamptz
);
--> statement-breakpoint
INSERT INTO retainer_deploy.admission (singleton) VALUES (true);
--> statement-breakpoint
CREATE TABLE retainer_deploy.retired_builds (build text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE retainer_deploy.writer_leases (
  id uuid PRIMARY KEY,
  build text NOT NULL,
  until timestamptz NOT NULL,
  effect text,
  peer_build text
);
--> statement-breakpoint
CREATE INDEX writer_leases_until ON retainer_deploy.writer_leases (until);
--> statement-breakpoint
CREATE TABLE retainer_deploy.effect_reconciliations (
  id uuid PRIMARY KEY,
  build text NOT NULL,
  effect text NOT NULL,
  evidence text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
-- The lock and check run on the mutating connection, including implicit transactions.
-- A VOLATILE function gets a fresh snapshot under READ COMMITTED after acquiring the lock.
-- Reject a stronger isolation level in managed mode: it could see an old generation.
CREATE FUNCTION retainer_deploy.admit_writer()
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  gate retainer_deploy.admission%ROWTYPE;
  previous_timeout text;
BEGIN
  -- Keep in step with WRITER_ADMISSION_LOCK in db/writer-lease.ts.
  IF NOT pg_try_advisory_xact_lock_shared(1381256713::bigint) THEN
    -- A close can back out if a lease committed as it obtained the lock.
    -- Give that short transition time to finish before denying a writer.
    previous_timeout := current_setting('lock_timeout');
    BEGIN
      IF previous_timeout = '0' OR previous_timeout::interval > interval '250 ms' THEN
        PERFORM set_config('lock_timeout', '250ms', true);
      END IF;
      PERFORM pg_advisory_xact_lock_shared(1381256713::bigint);
    EXCEPTION WHEN lock_not_available THEN
      RETURN false;
    END;
    PERFORM set_config('lock_timeout', previous_timeout, true);
  END IF;
  SELECT * INTO STRICT gate FROM retainer_deploy.admission WHERE singleton;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN false;
  END IF;
  RETURN gate.generation IS NULL OR (
    gate.deployment IS NULL AND
    coalesce(current_setting('retainer.writer_build', true) = ANY(gate.builds), false)
  );
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_deploy.admit_writer() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION retainer_deploy.guard_write()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Only the schema owner can use the migration bypass. A SECURITY DEFINER
  -- application function does not change session_user or the role setting.
  IF nullif(current_setting('retainer.migration_owner', true), '') IS NOT NULL
    AND session_user = current_user AND current_setting('role') = 'none' AND EXISTS (
    SELECT 1 FROM retainer_deploy.admission
    WHERE singleton AND deployment::text = current_setting('retainer.migration_owner', true)
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT retainer_deploy.admit_writer() THEN
    RAISE EXCEPTION 'retainer writer admission denied' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_deploy.guard_write() FROM PUBLIC;
--> statement-breakpoint
-- Called by the migration runner in the same transaction as the journal and
-- DDL, so future tables are covered before any writer can see them.
CREATE FUNCTION retainer_deploy.install_guards()
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT c.oid, n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid
          AND t.tgname = 'retainer_writer_admission'
          AND t.tgfoid = 'retainer_deploy.guard_write()'::regprocedure
          AND t.tgenabled IN ('O', 'A')
      )
    ORDER BY c.oid
  LOOP
    EXECUTE format(
      'CREATE TRIGGER retainer_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION retainer_deploy.guard_write()',
      relation.nspname, relation.relname
    );
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_deploy.install_guards() FROM PUBLIC;
--> statement-breakpoint
SELECT retainer_deploy.install_guards();
--> statement-breakpoint
CREATE FUNCTION retainer_deploy.acquire_writer(lease_id uuid, remaining_ms integer, peer_build text, external_effect text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT retainer_deploy.admit_writer() THEN
    RETURN 'denied';
  END IF;
  IF (SELECT generation IS NULL FROM retainer_deploy.admission WHERE singleton) THEN
    RETURN 'unmanaged';
  END IF;
  IF peer_build IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM retainer_deploy.admission WHERE singleton AND peer_build = ANY(builds)
  ) THEN
    RETURN 'denied';
  END IF;
  IF remaining_ms IS NULL OR remaining_ms < 1 OR remaining_ms > 910000 THEN
    RAISE EXCEPTION 'invalid writer lease duration';
  END IF;
  INSERT INTO retainer_deploy.writer_leases (id, build, until, effect, peer_build)
  VALUES (lease_id, current_setting('retainer.writer_build'),
    clock_timestamp() + remaining_ms * interval '1 millisecond', external_effect, peer_build);
  RETURN 'leased';
END
$$;
--> statement-breakpoint
CREATE FUNCTION retainer_deploy.release_writer(lease_id uuid, releasing_peer text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM retainer_deploy.writer_leases
  WHERE id = lease_id AND (
    (releasing_peer IS NULL AND peer_build IS NULL AND build = current_setting('retainer.writer_build', true))
    OR (releasing_peer IS NOT NULL AND peer_build = releasing_peer)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retainer_deploy.acquire_writer(uuid, integer, text, text), retainer_deploy.release_writer(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA retainer_deploy TO retainer_app, retainer_control;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retainer_deploy.acquire_writer(uuid, integer, text, text), retainer_deploy.release_writer(uuid, text) TO retainer_app, retainer_control;
