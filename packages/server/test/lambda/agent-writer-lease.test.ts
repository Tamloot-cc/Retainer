import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * The hosted writer lease an agent turn holds (agent spec §10.2): a deploy
 * waits for it while the turn may still write, and after the runtime dies
 * without closing, proceeds once the lease's `until` (the turn's deadline
 * plus the grace) has passed, with no operator step.
 */
const db = useTestDatabase();
const previous = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const ops = (build: string) =>
  createOpsHandler(loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' }), build);

it('holds a deploy for a turn, and lets it proceed after a hard death once `until` passes', async () => {
  const app = startTestApp(
    { ...db, connect: (options) => db.connect({ ...options, writerBuild: previous }) },
    { agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url } },
  );
  const { keys } = await app.setupWorkspace(
    { name: `Agent lease ${randomUUID()}` },
    { writer: { actor: { type: 'agent', id: 'desk' }, scopes: ['read', 'write'] } },
  );
  const chat = await app.request<{ id: string }>('/v1/agent/chats', {
    key: keys.writer,
    method: 'POST',
  });
  // The deployment opts into writer admission; the API runs the previous build.
  await expect(
    ops(previous)({ command: 'writer-admission-open', protocol: 1, candidate: previous }),
  ).resolves.toMatchObject({ phase: 'open' });
  const initial = await ops(candidate)({ command: 'writer-admission-status', protocol: 1 });
  if (!('generation' in initial) || !initial.generation) throw new Error('missing generation');
  const ownership = { generation: initial.generation, deployment: randomUUID(), candidate };
  const close = () =>
    ops(candidate)({
      command: 'writer-admission-close',
      protocol: 1,
      ownership,
      expectedBuilds: [previous],
      timed: false,
    });

  const minted = await app.request<{ token: string }>(`/v1/agent/chats/${chat.body.id}/token`, {
    key: keys.writer,
    method: 'POST',
  });
  const claimed = await app.request(`/v1/agent/runtime/sessions/${chat.body.id}/claim`, {
    key: RUNTIME_SECRET,
    body: { streamToken: minted.body.token, build: previous },
  });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
  const turnId = claimed.body.turnId as string;
  const deadline = new Date(claimed.body.deadline as string).getTime();

  const [lease] = await db.owner<{ until: Date; effect: string | null; build: string }[]>`
    select until, effect, build from retainer_deploy.writer_leases where id = ${turnId}`;
  expect(lease).toMatchObject({ effect: null, build: previous });
  // Its `until` is the deadline plus the 60-second grace.
  expect(Math.abs((lease?.until.getTime() ?? 0) - (deadline + 60_000))).toBeLessThan(5_000);

  // The runtime dies without closing: the deploy waits while the lease runs.
  await expect(close()).resolves.toMatchObject({ phase: 'busy' });

  // Time passes the lease's `until` (moved back here rather than waited for).
  await db.owner`
    update retainer_deploy.writer_leases set until = clock_timestamp() - interval '1 second'
    where id = ${turnId}`;
  await expect(close()).resolves.toMatchObject({ phase: 'closed' });
  expect(
    await db.owner`select id from retainer_deploy.writer_leases where id = ${turnId}`,
  ).toHaveLength(0);
});
