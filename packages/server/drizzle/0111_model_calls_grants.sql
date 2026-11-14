-- The model proxy's usage rows (model calls spec 3.4): written by the API's
-- runtime role, read for an installation's Overview. Never updated; rows go
-- with their workspace.
GRANT SELECT,INSERT ON ai_usage TO retainer_app;
