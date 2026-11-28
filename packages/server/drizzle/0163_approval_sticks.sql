-- An approval sticks (routines spec §5.3, #229): a routine keeps running on
-- its approved version when the approver later loses admin, and a test run
-- keeps running when its initiator does. Nothing re-checks them, so the
-- triggers that stored `approver_left` (0162) and `retainer_routine_admin`
-- (0123) go.
DROP TRIGGER routines_stopped ON public.routines;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost_role ON public.organization_members;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost ON public.organization_members;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost_role ON public.workspace_members;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost ON public.workspace_members;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost_key ON public.api_keys;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost ON public.api_keys;
--> statement-breakpoint
DROP TRIGGER routines_admin_lost ON public.workspaces;
--> statement-breakpoint
DROP FUNCTION public.retainer_routine_stopped();
--> statement-breakpoint
DROP FUNCTION public.retainer_admin_lost();
--> statement-breakpoint
DROP FUNCTION public.retainer_routines_approver_left(uuid[],text);
--> statement-breakpoint
DROP FUNCTION public.retainer_routine_admin(uuid,text);
--> statement-breakpoint
-- Routines stopped because their approver left become plain pauses, so an
-- admin can resume them without approving again. They stay paused, so
-- nothing starts on its own. Runs held as `approver_left` stay held, for an
-- admin to run or discard.
UPDATE public.routines SET status='paused',paused_reason='paused'
  WHERE paused_reason='approver_left';
