-- Custom data migration, scaffolded with drizzle-kit generate --custom.
-- The old UI only used grouping for boards. Views converted from boards
-- could retain settings that were invisible, and a schema repair could
-- leave the dependent settings behind after removing the grouping field.
UPDATE "views"
SET "config" = "config" - ARRAY['groupBy', 'hiddenGroups', 'groupAggregate']
WHERE "config" ?| ARRAY['groupBy', 'hiddenGroups', 'groupAggregate']
  AND ("kind" <> 'board' OR "config" ->> 'groupBy' IS NULL);
