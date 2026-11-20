-- Extension tools (docs/specs/extensions-tools.md §4): a tool call runs in a
-- lane of its own, so it never waits behind a long sync of the same
-- installation. Discovery returns one candidate per installation, connection
-- and lane, and a running job blocks only its own lane.
CREATE OR REPLACE FUNCTION public.retainer_extension_jobs_due(batch_limit integer,runnable_registrations uuid[],runnable_digests text[])
RETURNS TABLE(workspace_id uuid,job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH candidates AS (
    SELECT DISTINCT ON(j.workspace_id,j.installation_id,j.connection_id,j.trigger_kind='tool')
      j.workspace_id,j.id,j.available_at,i.last_claimed_at as installation_claimed,c.last_claimed_at as connection_claimed
    FROM public.extension_jobs j
    JOIN public.extension_installations i ON i.id=j.installation_id AND i.workspace_id=j.workspace_id
    JOIN public.workspaces w ON w.id=j.workspace_id AND (w.deletion_scheduled_at IS NULL OR j.trigger_kind IN ('uninstall','disconnect'))
    LEFT JOIN public.extension_connections c ON c.id=j.connection_id AND c.installation_id=j.installation_id AND c.workspace_id=j.workspace_id
    WHERE (i.registration_id,j.release_digest) IN (SELECT * FROM unnest($2,$3))
      AND j.generation=i.generation AND (j.release_digest=i.release_digest OR
        (j.trigger_kind='configure' AND i.state='active' AND EXISTS(SELECT 1 FROM public.extension_access_approvals a
          WHERE a.workspace_id=j.workspace_id AND a.installation_id=i.id AND a.release_digest=j.release_digest
          AND a.generation=i.generation AND a.settings_revision=i.settings_revision)))
      AND (
        (j.connection_id IS NULL AND (
          (i.state='configuring' AND j.trigger_kind='configure')
          OR (i.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state IN ('installing','upgrading') AND j.trigger_kind='install')
          OR (i.state='uninstalling' AND i.cleanup_deadline>now() AND j.trigger_kind='uninstall')))
        OR (j.connection_id IS NOT NULL AND j.connection_generation=c.generation AND (
          (i.state='active' AND c.state='active' AND j.trigger_kind NOT IN ('install','uninstall','connect','disconnect'))
          OR (i.state='active' AND c.state='connecting' AND j.trigger_kind='connect')
          OR (c.state='disconnected' AND c.disconnected_at+interval '24 hours'>now() AND j.trigger_kind='disconnect'
            AND NOT public.retainer_partial_release_job(j.trigger_kind,j.input))
          OR (i.state='active' AND w.deletion_scheduled_at IS NULL AND c.state IN ('setup_failed','needs_reconnect')
            AND public.retainer_partial_release_job(j.trigger_kind,j.input) AND j.expires_at>now()
            AND NOT EXISTS(SELECT 1 FROM public.extension_authorizations a WHERE a.workspace_id=j.workspace_id
              AND a.installation_id=j.installation_id AND a.connection_id=j.connection_id
              AND a.consumed_at IS NULL AND a.expires_at>now()))))
      )
      AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<=now()))
      AND NOT EXISTS(SELECT 1 FROM public.extension_jobs r WHERE r.workspace_id=j.workspace_id
        AND r.installation_id=j.installation_id AND r.connection_id IS NOT DISTINCT FROM j.connection_id
        AND (r.trigger_kind='tool')=(j.trigger_kind='tool')
        AND r.status='running' AND r.lease_until>now() AND r.id<>j.id)
    ORDER BY j.workspace_id,j.installation_id,j.connection_id,j.trigger_kind='tool',
      CASE WHEN j.status='running' THEN 0 ELSE 1 END,j.available_at,j.id
  ) SELECT c.workspace_id,c.id FROM candidates c
    ORDER BY c.installation_claimed NULLS FIRST,c.connection_claimed NULLS FIRST,c.available_at,c.id
    LIMIT least(greatest(batch_limit,1),1000)
$$;
