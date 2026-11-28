import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createApiKey, revokeApiKey } from '../../src/auth/keys.js';
import {
  createOrganization,
  moveWorkspace,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { addPerson } from '../helpers/people.js';

/**
 * A stopped routine whose approver loses admin is stored as `approver_left`
 * (routines spec §5.3, #167), in the same transaction, however admin was lost.
 */
const db = useTestDatabase();
const actor = { type: 'user', id: 'builder', name: 'Builder' };

async function fixture() {
  const organization = await createOrganization(db.owner, { name: `Org ${randomUUID()}` });
  const workspace = await createWorkspace(db.owner, {
    name: `Approver ${randomUUID().slice(0, 8)}`,
    organization: organization.id,
  });
  const ada = await addPerson(db, 'Ada');
  const ben = await addPerson(db, 'Ben');
  for (const who of [ada, ben])
    await setOrganizationMember(db.owner, {
      organization: organization.id,
      email: who.email,
      role: 'admin',
    });
  return { organization, workspace: workspace.id, ada, ben };
}

/** A routine with an approved version by `approver`, in `status`. */
async function routine(
  workspace: string,
  approver: string,
  status = 'paused',
  reason: string | null = 'paused',
) {
  const [r] = await db.owner<{ id: string }[]>`insert into routines
    (workspace_id, name, description, status, created_by)
    values (${workspace}, 'Routine', 'A routine', 'draft', ${db.owner.json(actor)}) returning id`;
  if (!r) throw new Error('no routine');
  const hash = randomUUID().replaceAll('-', '').padEnd(64, '0');
  const [source] = await db.owner<{ id: string }[]>`insert into routine_sources
    (workspace_id, hash, manifest, code)
    values (${workspace}, ${hash}, '{}'::jsonb, '') returning id`;
  if (!source) throw new Error('no source');
  const [v] = await db.owner<{ id: string }[]>`insert into routine_versions
    (workspace_id, routine_id, source_id, number, state, summary, report, types_fingerprint,
     built_by, approver_user_id, approved_at)
    values (${workspace}, ${r.id}, ${source.id}, 1, 'approved', 'Summary', '{}'::jsonb, 'f',
      ${db.owner.json(actor)}, ${approver}, now()) returning id`;
  if (!v) throw new Error('no version');
  await db.owner`update routines set active_version_id=${v.id}, status=${status},
    paused_reason=${reason} where id=${r.id}`;
  return r.id;
}

async function reason(id: string) {
  const [row] = await db.owner<
    { status: string; paused_reason: string | null }[]
  >`select status, paused_reason from routines where id=${id}`;
  return row;
}

describe('a stopped routine whose approver loses admin', () => {
  it('is marked when the organization role drops, and only theirs', async () => {
    const f = await fixture();
    const paused = await routine(f.workspace, f.ada.id);
    const attention = await routine(f.workspace, f.ada.id, 'needs_attention', 'failing');
    const running = await routine(f.workspace, f.ada.id, 'active', null);
    const archived = await routine(f.workspace, f.ada.id, 'archived', null);
    const bens = await routine(f.workspace, f.ben.id);
    await setOrganizationMember(db.owner, {
      organization: f.organization.id,
      email: f.ada.email,
      role: 'member',
    });
    expect(await reason(paused)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
    expect(await reason(attention)).toEqual({
      status: 'needs_attention',
      paused_reason: 'approver_left',
    });
    // An active routine pauses at its next run; an archived one stays as it is.
    expect(await reason(running)).toEqual({ status: 'active', paused_reason: null });
    expect(await reason(archived)).toEqual({ status: 'archived', paused_reason: null });
    expect(await reason(bens)).toEqual({ status: 'paused', paused_reason: 'paused' });
  });

  it('is left alone while a workspace role keeps them an admin', async () => {
    const f = await fixture();
    await db.owner`insert into workspace_members (organization_id, workspace_id, user_id, role)
      values (${f.organization.id}, ${f.workspace}, ${f.ada.id}, 'admin')`;
    const id = await routine(f.workspace, f.ada.id);
    await setOrganizationMember(db.owner, {
      organization: f.organization.id,
      email: f.ada.email,
      role: 'member',
    });
    expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'paused' });
    // Then the workspace role drops too.
    await setWorkspaceMember(db.owner, {
      workspace: f.workspace,
      email: f.ada.email,
      role: 'editor',
    });
    expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
  });

  it('is marked when they leave the organization or their account is deleted', async () => {
    const f = await fixture();
    const left = await routine(f.workspace, f.ada.id);
    const deleted = await routine(f.workspace, f.ben.id);
    await db.owner`delete from organization_members where user_id=${f.ada.id}`;
    await db.owner`delete from users where id=${f.ben.id}`;
    expect(await reason(left)).toMatchObject({ paused_reason: 'approver_left' });
    expect(await reason(deleted)).toMatchObject({ paused_reason: 'approver_left' });
  });

  it('is marked when the approving API key is revoked or loses its admin scope', async () => {
    const f = await fixture();
    const make = async (id: string) =>
      createApiKey(db.owner, {
        workspace: f.workspace,
        name: id,
        scopes: ['admin'],
        actor: { type: 'user', id, name: id },
      });
    const revoked = await make('revoked');
    const narrowed = await make('narrowed');
    const a = await routine(f.workspace, 'key:revoked');
    const b = await routine(f.workspace, 'key:narrowed');
    await revokeApiKey(db.owner, revoked.id);
    expect(await reason(a)).toMatchObject({ paused_reason: 'approver_left' });
    expect(await reason(b)).toMatchObject({ paused_reason: 'paused' });
    await db.owner`update api_keys set scopes='{read,write}' where id=${narrowed.id}`;
    expect(await reason(b)).toMatchObject({ paused_reason: 'approver_left' });
  });

  it('is marked when the workspace moves to an organization they are not in', async () => {
    const f = await fixture();
    const id = await routine(f.workspace, f.ada.id);
    const other = await createOrganization(db.owner, { name: `Other ${randomUUID()}` });
    await moveWorkspace(db.owner, { workspace: f.workspace, organization: other.id });
    expect(await reason(id)).toMatchObject({ paused_reason: 'approver_left' });
  });

  it('keeps a reason that says what must change before it runs again', async () => {
    const f = await fixture();
    const failed = await routine(f.workspace, f.ada.id, 'needs_attention', 'check_failed');
    const large = await routine(f.workspace, f.ada.id, 'paused', 'schedule_too_large');
    const later = await routine(f.workspace, f.ada.id, 'active', null);
    await db.owner`delete from organization_members where user_id=${f.ada.id}`;
    expect(await reason(failed)).toMatchObject({ paused_reason: 'check_failed' });
    expect(await reason(large)).toMatchObject({ paused_reason: 'schedule_too_large' });
    await db.owner`update routines set status='needs_attention', paused_reason='tool_changed'
      where id=${later}`;
    expect(await reason(later)).toMatchObject({ paused_reason: 'tool_changed' });
  });

  it('is stored as approver_left when it pauses after they left', async () => {
    const f = await fixture();
    const id = await routine(f.workspace, f.ada.id, 'active', null);
    await db.owner`delete from organization_members where user_id=${f.ada.id}`;
    await db.owner`update routines set status='paused', paused_reason='failing' where id=${id}`;
    expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
  });

  it('is stored as approver_left when its approver was never an admin here', async () => {
    const f = await fixture();
    const id = await routine(f.workspace, 'someone-who-left');
    expect(await reason(id)).toMatchObject({ paused_reason: 'approver_left' });
  });
});

describe('losing admin while a routine pauses (concurrently)', () => {
  it('marks it when the pause holds the routine first', async () => {
    const f = await fixture();
    const id = await routine(f.workspace, f.ada.id, 'active', null);
    const { promise: held, resolve: release } = deferred();
    const { promise: lockTaken, resolve: locked } = deferred();
    const pause = db.owner.begin(async (tx) => {
      await tx`select id from routines where id=${id} for no key update`;
      await tx`update routines set status='paused', paused_reason='paused' where id=${id}`;
      locked();
      await held;
    });
    await lockTaken;
    const demote = db.owner`delete from organization_members where user_id=${f.ada.id}`.then(
      () => 'demoted',
    );
    // The demotion waits for the routine lock.
    const first = await Promise.race([demote, sleep(200).then(() => 'waiting')]);
    expect(first).toBe('waiting');
    release();
    await pause;
    await demote;
    expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
  });

  it('marks it when the demotion holds the routine first', async () => {
    const f = await fixture();
    const id = await routine(f.workspace, f.ada.id, 'active', null);
    const { promise: held, resolve: release } = deferred();
    const { promise: demoted, resolve: done } = deferred();
    const demote = db.owner.begin(async (tx) => {
      await tx`delete from organization_members where user_id=${f.ada.id}`;
      done();
      await held;
    });
    await demoted;
    const pause =
      db.owner`update routines set status='paused', paused_reason='paused' where id=${id}`.then(
        () => 'paused',
      );
    const first = await Promise.race([pause, sleep(200).then(() => 'waiting')]);
    expect(first).toBe('waiting');
    release();
    await demote;
    await pause;
    expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
  });

  it('never leaves a stopped routine with a live reason, raced many times', async () => {
    for (let i = 0; i < 10; i++) {
      const f = await fixture();
      const id = await routine(f.workspace, f.ada.id, 'active', null);
      await Promise.all([
        db.owner`update routines set status='paused', paused_reason='paused' where id=${id}`,
        db.owner`update organization_members set role='member' where user_id=${f.ada.id}`,
      ]);
      expect(await reason(id)).toEqual({ status: 'paused', paused_reason: 'approver_left' });
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
