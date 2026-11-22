-- Gmail message bodies move to the generic event_bodies table. The search
-- text is built as records/search-sql.ts textVector builds it.
INSERT INTO "event_bodies" ("event_id","workspace_id","thread_id","occurred_at","original_date","body","search")
SELECT "event_id","workspace_id","thread_group_id","occurred_at","original_date","body",
  to_tsvector('simple', retainer_fold("body"::text))
FROM "gmail_messages";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "event_bodies" TO retainer_app;
