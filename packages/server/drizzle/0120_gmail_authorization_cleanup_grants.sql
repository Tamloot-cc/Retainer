GRANT SELECT, INSERT, UPDATE (bound_connection_id) ON public.gmail_authorization_cleanups TO retainer_app;
GRANT SELECT, UPDATE (fence, next_attempt_at), DELETE ON public.gmail_authorization_cleanups TO retainer_executor;
