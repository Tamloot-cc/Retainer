-- Visible schema now belongs to the workspace. Hidden types and event core
-- fields keep their existing protection.
UPDATE object_types SET is_protected = false WHERE universal_id IN (
  '1f24f94d-6bc5-4955-b6ab-ac946e2b140a',
  '7e87d873-8c93-4786-9a0b-95447310c8d3',
  'd0690d5f-d7f4-47ce-8007-0a81a276a70b'
);
--> statement-breakpoint
UPDATE fields SET is_protected = false WHERE universal_id IN (
  '107158ae-ba0f-482e-afe1-5e45bd6ccfd6',
  '368276ea-604d-4dcd-b6ad-796431a84a06'
);
--> statement-breakpoint
UPDATE workspaces w SET initialized_at = w.created_at
WHERE w.initialized_at IS NULL AND EXISTS (
  SELECT 1 FROM object_types o WHERE o.workspace_id = w.id AND o.status = 'active'
    AND o.universal_id NOT IN (
      '6d2e9a41-c7f3-4b80-9e15-0a3c8d7f2b56',
      '2f8b6c1e-94d7-4a35-b0e2-7c5d1a9f3e64',
      '8a3e5d72-1c6b-4f09-a4d8-e26b0f7c95a1'
    )
);
