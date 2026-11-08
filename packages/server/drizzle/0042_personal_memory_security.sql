-- Personal and workspace memory (docs/specs/user-and-workspace-memory.md).
-- Applied by the migration role, like 0001_security.
--
-- A row with `private_to_user` set belongs to one person's personal memory:
-- their profile, its facts and sources, the internal notes `remember`
-- created for it, and stored idempotent responses that read or changed it.
-- A restrictive policy next to `workspace_isolation` hides such a row from
-- every transaction whose `app.user_id` is not that person, and refuses to
-- write one for anybody else. Without `app.user_id`, no private row is
-- visible or writable.

-- The person of the current transaction, or NULL when none is set.
CREATE FUNCTION "public"."retainer_current_user_id"() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- The role that owns the one function allowed to erase other people's
-- private derivatives of a forgotten record (spec 4.6). It logs in as
-- nobody, bypasses nothing and holds only what that cleanup needs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retainer_erasure') THEN
    CREATE ROLE retainer_erasure NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- So the migration role can make it own the function below.
GRANT retainer_erasure TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO retainer_erasure;
--> statement-breakpoint
GRANT SELECT ON "records", "event_records" TO retainer_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "facts", "fact_sources", "idempotency_keys" TO retainer_erasure;
--> statement-breakpoint

-- The privacy policy. The erasure role sees every private row of the
-- workspace it runs in (workspace_isolation still applies to it), and only
-- ever deletes.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'records', 'facts', 'fact_sources', 'field_assertions', 'event_records', 'event_links',
    'idempotency_keys'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY private_to_user ON public.%I AS RESTRICTIVE '
      'USING (private_to_user IS NULL '
      '  OR private_to_user = public.retainer_current_user_id() '
      '  OR current_user = %L) '
      'WITH CHECK (private_to_user IS NULL '
      '  OR private_to_user = public.retainer_current_user_id())',
      t, 'retainer_erasure'
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- A row of a private record or fact is private to the same person. The
-- server never sets these columns: each row copies its parent's when it is
-- written or moved to another parent, so the policy is one comparison per
-- row. A parent the writer cannot see is someone else's private row, and
-- the write fails rather than store a shared child of it.
CREATE FUNCTION "public"."retainer_private_from_record"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  parent_id uuid;
BEGIN
  -- One branch runs per table: the other names a column this table lacks.
  IF TG_TABLE_NAME = 'event_links' THEN
    parent_id := NEW.event_id;
  ELSE
    parent_id := NEW.record_id;
  END IF;
  SELECT r.private_to_user INTO NEW.private_to_user FROM public.records AS r WHERE r.id = parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record % is not visible here', parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."retainer_private_from_fact"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  SELECT f.private_to_user INTO NEW.private_to_user FROM public.facts AS f WHERE f.id = NEW.fact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fact % is not visible here', NEW.fact_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "facts_private"
  BEFORE INSERT OR UPDATE OF "record_id", "private_to_user" ON "facts"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_from_record"();
--> statement-breakpoint
CREATE TRIGGER "field_assertions_private"
  BEFORE INSERT OR UPDATE OF "record_id", "private_to_user" ON "field_assertions"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_from_record"();
--> statement-breakpoint
CREATE TRIGGER "event_records_private"
  BEFORE INSERT OR UPDATE OF "record_id", "private_to_user" ON "event_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_from_record"();
--> statement-breakpoint
CREATE TRIGGER "event_links_private"
  BEFORE INSERT OR UPDATE OF "event_id", "private_to_user" ON "event_links"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_from_record"();
--> statement-breakpoint
CREATE TRIGGER "fact_sources_private"
  BEFORE INSERT OR UPDATE OF "fact_id", "private_to_user" ON "fact_sources"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_from_fact"();
--> statement-breakpoint

-- A record's privacy is set when it is created and never changes.
CREATE FUNCTION "public"."retainer_private_fixed"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.private_to_user IS DISTINCT FROM OLD.private_to_user THEN
    RAISE EXCEPTION 'records.private_to_user cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "records_private_fixed"
  BEFORE UPDATE OF "private_to_user" ON "records"
  FOR EACH ROW EXECUTE FUNCTION "public"."retainer_private_fixed"();
--> statement-breakpoint

-- API keys now say whom an agent works for (spec 4.3). The person comes
-- back only while they are not disabled and still have a role in the
-- key's workspace: an organization owner or admin, or a workspace member.
-- Removal also revokes such keys; this keeps a key from reaching a
-- person's memory in between. The return type changes, so the function is
-- dropped and created again, with the grants of 0001_security.
DROP FUNCTION "public"."retainer_lookup_api_key"(text);
--> statement-breakpoint
CREATE FUNCTION "public"."retainer_lookup_api_key"(key_hash text)
  RETURNS TABLE (
    key_id uuid, workspace_id uuid, scopes text[], actor jsonb,
    acts_for_user uuid, acts_for_name text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT k.id, k.workspace_id, k.scopes, k.actor, u.id, u.name
    FROM public.api_keys AS k
    JOIN public.workspaces AS w ON w.id = k.workspace_id AND w.deletion_scheduled_at IS NULL
    LEFT JOIN public.users AS u
      ON u.id = k.acts_for_user AND u.disabled_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.organization_members AS om
          WHERE om.organization_id = w.organization_id AND om.user_id = u.id
            AND om.role IN ('owner', 'admin')
        )
        OR EXISTS (
          SELECT 1 FROM public.workspace_members AS wm
          WHERE wm.workspace_id = w.id AND wm.user_id = u.id
        )
      )
    WHERE k.hash = key_hash AND k.revoked_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_lookup_api_key"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_lookup_api_key"(text) TO retainer_app;
--> statement-breakpoint

-- Erasing a shared record must also erase other people's private facts and
-- quotes that rest on it, which no query under the requester's RLS can see
-- (spec 4.6). `forget` calls this inside its transaction, before deleting
-- the shared records and events, so foreign keys have not yet cleared the
-- citations. It:
--
-- * runs only in the transaction of the workspace it names, while that
--   transaction holds the workspace's privacy lock exclusively, which only
--   `forget` takes;
-- * takes shared record and event IDs, never a person or a private row:
--   IDs of private rows are ignored, so it cannot erase a personal profile;
-- * deletes private citations of those events with their quotes, private
--   facts left without a live source, and private stored responses that
--   mention an erased record, event or fact;
-- * returns nothing, so no private text, ID, owner or count reaches the
--   requester.
CREATE FUNCTION "public"."retainer_erase_private_derivatives"(workspace uuid, erased uuid[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  shared uuid[];
  touched uuid[];
  orphaned uuid[];
BEGIN
  IF workspace IS NULL
    OR workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid THEN
    RAISE EXCEPTION 'erasure runs only in the transaction of its own workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The privacy lock (db/tx.ts: class 0x5250 on the workspace ID's hash).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.locktype = 'advisory' AND l.pid = pg_catalog.pg_backend_pid() AND l.granted
      AND l.mode = 'ExclusiveLock' AND l.objsubid = 2 AND l.classid = 21072
      AND l.objid = pg_catalog.hashtext(workspace::text)::oid
  ) THEN
    RAISE EXCEPTION 'erasure runs only while forget holds the privacy lock'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(array_agg(r.id), '{}') INTO shared
  FROM public.records AS r
  WHERE r.workspace_id = workspace AND r.id = ANY(erased) AND r.private_to_user IS NULL;

  WITH removed AS (
    DELETE FROM public.fact_sources AS s
    WHERE s.workspace_id = workspace AND s.private_to_user IS NOT NULL
      AND s.source_record_id = ANY(shared)
    RETURNING s.fact_id
  )
  SELECT coalesce(array_agg(DISTINCT removed.fact_id), '{}') INTO touched FROM removed;

  WITH gone AS (
    DELETE FROM public.facts AS f
    WHERE f.workspace_id = workspace AND f.private_to_user IS NOT NULL AND f.id = ANY(touched)
      AND NOT EXISTS (
        SELECT 1 FROM public.fact_sources AS s
        JOIN public.records AS src ON src.id = s.source_record_id AND src.deleted_at IS NULL
        WHERE s.fact_id = f.id
      )
    RETURNING f.id
  )
  SELECT coalesce(array_agg(gone.id), '{}') INTO orphaned FROM gone;

  IF cardinality(shared || orphaned) = 0 THEN
    RETURN;
  END IF;
  -- Each cached response is turned into text once, not once per erased ID.
  DELETE FROM public.idempotency_keys AS k
  USING public.idempotency_keys AS c
  CROSS JOIN LATERAL (SELECT c.result::text AS body) AS r
  WHERE k.id = c.id
    AND c.workspace_id = workspace AND c.private_to_user IS NOT NULL AND c.result IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM unnest(shared || orphaned) AS x
      WHERE strpos(r.body, x::text) > 0
    );
END
$$;
--> statement-breakpoint
ALTER FUNCTION "public"."retainer_erase_private_derivatives"(uuid, uuid[]) OWNER TO retainer_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retainer_erase_private_derivatives"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."retainer_erase_private_derivatives"(uuid, uuid[]) TO retainer_app;
