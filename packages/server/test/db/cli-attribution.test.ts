import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const actor = { type: 'user', id: 'dana', name: 'Dana', via: 'Retainer CLI' };

it('clears attribution after an unrelated state change and retains it on uninstall completion', async () => {
  const workspace = await createWorkspace(db.owner, { name: 'CLI attribution' });
  const [routine] = await db.owner<{ id: string }[]>`insert into routines
    (workspace_id, name, description, status, created_by, state_changed_by)
    values (${workspace.id}, 'Routine', 'A routine', 'active', ${db.owner.json(actor)}, ${db.owner.json(actor)}) returning id`;
  const [extension] = await db.owner<{ id: string }[]>`insert into extension_installations
    (workspace_id, registration_id, version, release_digest, state, granted_actor, granted_scopes, created_by, state_changed_by)
    values (${workspace.id}, ${randomUUID()}, '1.0.0', ${'a'.repeat(64)}, 'disabled', 'agent',
      '["read"]'::jsonb, ${db.owner.json(actor)}, ${db.owner.json(actor)}) returning id`;
  if (!routine || !extension) throw new Error('missing state fixtures');

  const [paused] = await db.owner`update routines set status='paused', paused_reason='failing'
    where id=${routine.id} returning state_changed_by`;
  expect(paused?.state_changed_by).toBeNull();
  const [enabled] = await db.owner`update extension_installations set state='active'
    where id=${extension.id} returning state_changed_by`;
  expect(enabled?.state_changed_by).toBeNull();

  await db.owner`update extension_installations set state='uninstalling' where id=${extension.id}`;
  await db.owner`update extension_installations set state_changed_by=${db.owner.json(actor)}
    where id=${extension.id}`;
  const [removed] = await db.owner`update extension_installations set state='uninstalled'
    where id=${extension.id} returning state_changed_by`;
  expect(removed?.state_changed_by).toEqual(actor);
});
