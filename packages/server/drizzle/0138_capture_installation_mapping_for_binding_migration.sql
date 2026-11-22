-- Preserve choices until the binding migration can resolve the rebuilt releases.
-- Keep this durable across a failed or interrupted deployment.
UPDATE extension_installations
SET bindings = jsonb_build_object('legacyMapping', mapping)
WHERE state <> 'uninstalled' AND bindings IS NULL AND mapping <> '{"outputs": {}}'::jsonb;
