-- A stopped routine whose approver is no longer an admin is stored as
-- `approver_left` (routines spec §5.3, #167), so every reader agrees with the
-- web app. Losing admin happens in Postgres rows (organization and workspace
-- roles, API keys, a workspace's organization), so triggers record it in the
-- same transaction, whichever code path or cascade made the change. An active
-- routine still pauses with `approver_left` at its next run. A reason that
-- says what must change before it runs again (`check_failed`, `tool_changed`,
-- `schedule_too_large`) outranks `approver_left` and is kept.
--
-- The rule lives in one place, the BEFORE trigger `routines_stopped`: when a
-- routine is stored as stopped, it checks the approver afresh (so a loss that
-- committed while it waited for the lock is seen). When admin rows change,
-- `retainer_routines_approver_left` locks the routines that approver approved
-- (so a pause committing meanwhile is seen once locked) and touches the
-- stopped ones, which runs that trigger.
CREATE FUNCTION public.retainer_routines_approver_left(workspaces uuid[],who text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.routines r JOIN public.routine_versions v ON v.id=r.active_version_id
    WHERE r.workspace_id=ANY(workspaces) AND (who IS NULL OR v.approver_user_id=who)
      AND r.status IN ('active','paused','needs_attention')
    ORDER BY r.id FOR NO KEY UPDATE OF r;
  UPDATE public.routines r SET paused_reason=r.paused_reason FROM public.routine_versions v
    WHERE v.id=r.active_version_id AND r.workspace_id=ANY(workspaces)
      AND (who IS NULL OR v.approver_user_id=who) AND r.status IN ('paused','needs_attention');
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routines_approver_left(uuid[],text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.retainer_admin_lost() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='organization_members' THEN
    PERFORM public.retainer_routines_approver_left(
      ARRAY(SELECT w.id FROM public.workspaces w WHERE w.organization_id=OLD.organization_id),
      OLD.user_id::text);
  ELSIF TG_TABLE_NAME='workspace_members' THEN
    PERFORM public.retainer_routines_approver_left(ARRAY[OLD.workspace_id],OLD.user_id::text);
  ELSIF TG_TABLE_NAME='api_keys' THEN
    PERFORM public.retainer_routines_approver_left(ARRAY[OLD.workspace_id],'key:'||(OLD.actor->>'id'));
  ELSIF TG_TABLE_NAME='workspaces' THEN
    PERFORM public.retainer_routines_approver_left(ARRAY[OLD.id],NULL);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_admin_lost() FROM PUBLIC;
--> statement-breakpoint
-- Each trigger fires only when the old row could have made someone an admin
-- and the change could end that. An organization member removed can have been
-- a workspace admin, so that delete is never filtered.
CREATE TRIGGER routines_admin_lost_role AFTER UPDATE OF role ON public.organization_members
  FOR EACH ROW WHEN (OLD.role IN ('owner','admin') AND NEW.role NOT IN ('owner','admin'))
  EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost_role AFTER UPDATE OF role ON public.workspace_members
  FOR EACH ROW WHEN (OLD.role='admin' AND NEW.role<>'admin')
  EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost AFTER DELETE ON public.workspace_members
  FOR EACH ROW WHEN (OLD.role='admin') EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost_key AFTER UPDATE OF revoked_at,scopes,actor ON public.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND 'admin'=ANY(OLD.scopes) AND OLD.actor->>'type'='user'
    AND (NEW.revoked_at IS NOT NULL OR NOT coalesce('admin'=ANY(NEW.scopes),false)
      OR NEW.actor IS DISTINCT FROM OLD.actor))
  EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost AFTER DELETE ON public.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND 'admin'=ANY(OLD.scopes) AND OLD.actor->>'type'='user')
  EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE TRIGGER routines_admin_lost AFTER UPDATE OF organization_id ON public.workspaces
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
CREATE FUNCTION public.retainer_routine_stopped() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT coalesce((SELECT public.retainer_routine_admin(NEW.workspace_id,v.approver_user_id)
      FROM public.routine_versions v WHERE v.id=NEW.active_version_id),true) THEN
    NEW.paused_reason := 'approver_left';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retainer_routine_stopped() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER routines_stopped BEFORE INSERT OR UPDATE OF status,paused_reason,active_version_id
  ON public.routines
  FOR EACH ROW WHEN (NEW.status IN ('paused','needs_attention') AND NEW.active_version_id IS NOT NULL
    AND coalesce(NEW.paused_reason,'') NOT IN ('approver_left','check_failed','tool_changed','schedule_too_large'))
  EXECUTE FUNCTION public.retainer_routine_stopped();
--> statement-breakpoint
-- Routines that stopped before this migration and whose approver has left.
SELECT public.retainer_routines_approver_left(ARRAY(SELECT id FROM public.workspaces),NULL);
