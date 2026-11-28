-- The built-in routine builder is gone (routines-in-chat spec §8): the chat
-- agent drafts routines. Its runs are deleted, as retention deletes a finished
-- run, so the next migration can drop `build` as a run mode and trigger.
-- One still queued or running would only end as `builder_removed`.
DELETE FROM "routine_runs" WHERE "mode"='build' OR "trigger_kind"='build';
