import { randomUUID } from 'node:crypto';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createRecord, requireObject, withWrite } from '../../src/records/service.js';
import { prepareValues } from '../../src/records/values.js';
import { insertRecord, writeFields } from '../../src/records/write.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const functionId = randomUUID();
const manifest = extensionFixture({
  scopes: ['read', 'write'],
  functions: [
    {
      universalId: functionId,
      name: 'sync',
      description: 'Fixture sync',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      timeoutSeconds: 300,
      inputSchema: {
        type: 'object',
        properties: { sourceId: { type: 'string', maxLength: 100 } },
        required: ['sourceId'],
        additionalProperties: false,
      },
    },
  ],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
let t: TestApp, tokens: RunTokens, signingKey: CryptoKey;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  signingKey = keys.privateKey;
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test-key',
    signingKey,
    verificationKey: keys.publicKey,
  });
  t = startTestApp(db, { extensionCatalog: catalog, runTokens: tokens });
});
async function setup(scopes: ('read' | 'write')[] = ['read', 'write']) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Run ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': 'install' },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  await db.owner`update extension_installations set state='active' where id=${id}`;
  const queue = new ExtensionQueue(t.sql, catalog.runtime);
  const { id: jobId } = await queue.enqueue(workspace.id, id, {
    functionId,
    input: { sourceId: 'fixture' },
    dedupeKey: 'fixture',
  });
  const lease = await queue.claim(workspace.id, jobId, 'worker');
  if (!lease) throw new Error('missing lease');
  const token = await tokens.issue(t.sql, lease, manifest.universalId, scopes);
  return { workspace: workspace.id, id, key: keys.admin, queue, lease, token };
}
describe('signed run credentials and transactional admission', () => {
  it('derives actor and scopes from the installation, keeps a five-minute bound and supports run-only checkpointing', async () => {
    const { id, token, key } = await setup();
    const decoded = decodeJwt(token.slice('rt_run_'.length));
    expect((decoded.exp ?? 0) - (decoded.iat ?? 0)).toBeLessThanOrEqual(300);
    const response = await t.request('/v1/objects/company/records', {
      key: token,
      body: { values: { name: 'Run-owned company' } },
    });
    expect(response.status).toBe(201);
    const [assertion] =
      await db.owner`select actor from field_assertions where record_id=${response.body.id} limit 1`;
    expect(assertion?.actor).toEqual({ type: 'integration', id });
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/checkpoint`, { key, body: { children: [] } }))
        .status,
    ).toBe(403);
    expect(
      (
        await t.request(`/v1/extensions/${id}/runtime/checkpoint`, {
          key: token,
          body: { children: [], kv: { key: 'cursor', expectedRevision: null, value: 'page-2' } },
        })
      ).body.revision,
    ).toBe(1);
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/kv/cursor`, { key: token })).body,
    ).toEqual({ value: 'page-2', revision: 1 });
    expect(
      (await t.request(`/v1/extensions/${randomUUID()}/runtime/kv/cursor`, { key: token })).status,
    ).toBe(404);
    const list = await t.request('/v1/extensions', { key: token });
    expect(list.body.installations.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(
      (await t.request('/v1/schema/changes', { key: token, body: { operations: [] } })).status,
    ).toBe(403);
  });
  it('refuses scope escalation, wrong audience, invalid signatures and personal-memory delegation', async () => {
    const { workspace, id, token, lease } = await setup(['read']);
    expect(
      (
        await t.request('/v1/objects/company/records', {
          key: token,
          body: { values: { name: 'Forbidden' } },
        })
      ).status,
    ).toBe(403);
    const caller = await tokens.authenticate(t.sql, token);
    expect(caller.person).toBeUndefined();
    expect(caller.userId).toBeUndefined();
    const forged = await new SignJWT({ workspace, run: { ...caller.run, scopes: ['admin'] } })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'retainer-run+jwt', kid: 'test-key' })
      .setIssuer('https://retainer.test')
      .setAudience('retainer:extension-run')
      .setIssuedAt()
      .setExpirationTime('1m')
      .setJti(randomUUID())
      .sign(signingKey);
    expect((await t.request('/v1/extensions', { key: `rt_run_${forged}` })).status).toBe(401);
    const wrongAudience = await new SignJWT({ workspace, run: caller.run })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'retainer-run+jwt', kid: 'test-key' })
      .setIssuer('https://retainer.test')
      .setAudience('mcp')
      .setIssuedAt()
      .setExpirationTime('1m')
      .setJti(randomUUID())
      .sign(signingKey);
    expect((await t.request('/v1/extensions', { key: `rt_run_${wrongAudience}` })).status).toBe(
      401,
    );
    await db.owner`update extension_jobs set lease_until=clock_timestamp()-interval '1 second' where id=${lease.jobId}`;
    expect((await t.request(`/v1/extensions/${id}`, { key: token })).body.error.code).toBe(
      'lease_expired',
    );
  });
  it('drains an admitted write before disable returns, and checks revocation before idempotency replay', async () => {
    const { id, token, key } = await setup();
    const caller = await tokens.authenticate(t.sql, token);
    const original = await createRecord(
      t.sql,
      caller,
      'company',
      { name: 'Idempotent company' },
      { idempotencyKey: 'run-create' },
    );
    let enter: () => void = () => {},
      release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = withWrite(t.sql, caller, async (tx, context) => {
      const object = requireObject(context.schema, 'company');
      const record = await insertRecord(tx, context, object);
      await writeFields(
        tx,
        context,
        object,
        record,
        prepareValues(object, { name: 'Before disable' }, 'create'),
      );
      enter();
      await barrier;
      return record.id;
    });
    await entered;
    let disabled = false;
    const disable = t
      .request(`/v1/extensions/${id}/disable`, { key, method: 'POST' })
      .then((result) => {
        disabled = true;
        return result;
      });
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [row] =
          await db.owner`select count(*)::int as count from pg_locks where locktype='advisory' and classid=21061 and not granted`;
        if (Number(row?.count) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      expect(disabled).toBe(false);
    } finally {
      release();
    }
    const [recordId, disabledResponse] = await Promise.all([write, disable]);
    expect(disabledResponse.status).toBe(200);
    const rows = await db.owner`select id from records where id=${recordId}`;
    expect(rows).toHaveLength(1);
    await expect(
      createRecord(
        t.sql,
        caller,
        'company',
        { name: 'Idempotent company' },
        { idempotencyKey: 'run-create' },
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
    expect((await t.request(`/v1/records/${original.id}`, { key: token })).body.error.code).toBe(
      'installation_disabled',
    );
  });
  it('enforces the shared installation write budget under competing writes, without mixing normal-key idempotency', async () => {
    const { id, token, key } = await setup();
    const body = { values: { name: 'Credential scope' } };
    const normal = await t.request('/v1/objects/company/records', {
      key,
      body,
      headers: { 'Idempotency-Key': 'shared-key' },
    });
    const run = await t.request('/v1/objects/company/records', {
      key: token,
      body,
      headers: { 'Idempotency-Key': 'shared-key' },
    });
    expect(normal.status).toBe(201);
    expect(run.status).toBe(201);
    expect(run.body.id).not.toBe(normal.body.id);
    await db.owner`update extension_write_budgets set window_start=date_trunc('minute',clock_timestamp()),count=59 where installation_id=${id}`;
    const writes = await Promise.all(
      [1, 2].map((n) =>
        t.request('/v1/objects/company/records', {
          key: token,
          body: { values: { name: `Budget ${n}` } },
        }),
      ),
    );
    expect(writes.map((r) => r.status).sort()).toEqual([201, 429]);
    expect(writes.find((r) => r.status === 429)?.body.error.code).toBe('quota_exceeded');
  });
});
