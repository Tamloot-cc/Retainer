import { routineEffectRequestSchema } from '@retainer/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import { AppError } from '../../errors.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { validTimeZone } from '../../routines/cron.js';
import type { RoutineRuntime } from '../../routines/runtime.js';
import { proposeInputSchema, type Routines, sourceInputSchema } from '../../routines/service.js';

/** Waits briefly for a sandbox job, within the hosted API's 30 seconds (§5.1). */
async function settle<T extends { status?: string }>(read: () => Promise<T>, waitMs: number) {
  const until = Date.now() + waitMs;
  let job = await read();
  while (['queued', 'running'].includes(job.status ?? '') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = await read();
  }
  return job;
}
const waitMs = (value: string | undefined) =>
  value === undefined ? 0 : Math.min(20000, Math.max(0, Number(value) * 1000 || 0));

/** Routines for people and their agents (routines spec §5, §6). */
export function routineRoutes(app: Hono<AppEnv>, routines: Routines) {
  app.get('/routines/capabilities', requireScope('read'), async (c) =>
    c.json(await routines.capabilities(c.get('caller'))),
  );
  app.post('/routines/validate', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    const result = await routines.validate(caller, await readBody(c, sourceInputSchema));
    if (!('jobId' in result) || result.valid !== null) return c.json(result);
    const job = await settle(
      () => routines.getJob(caller, result.jobId),
      waitMs(c.req.query('wait')),
    );
    return c.json(checkResult(job));
  });
  app.post('/routines/preview', requireScope('read'), async (c) =>
    c.json(await routines.preview(c.get('caller'), await readBody(c, sourceInputSchema))),
  );
  app.get('/routines/previews/:id', requireScope('read'), async (c) =>
    c.json(await routines.getPreview(c.get('caller'), idParam(c))),
  );
  app.get('/routines/jobs/:id', requireScope('read'), async (c) => {
    const job = await routines.getJob(c.get('caller'), idParam(c));
    return c.json(job.mode === 'check' ? { ...job, ...checkResult(job) } : job);
  });
  app.post('/routines/build', requireScope('write'), async (c) =>
    c.json(
      await routines.build(
        c.get('caller'),
        await readBody(
          c,
          z.strictObject({
            description: z.string().trim().min(1).max(10000),
            routineId: z.uuid().optional(),
          }),
        ),
      ),
      202,
    ),
  );
  app.post('/routines', requireScope('write'), async (c) =>
    c.json(await routines.propose(c.get('caller'), await readBody(c, proposeInputSchema)), 201),
  );
  app.get('/routines', requireScope('read'), async (c) =>
    c.json(await routines.list(c.get('caller'))),
  );
  app.get('/routines/buttons', requireScope('read'), async (c) =>
    c.json(await routines.buttons(c.get('caller'), c.req.query('object') ?? '')),
  );
  app.put('/workspace/time-zone', requireScope('admin'), async (c) => {
    const { timeZone } = await readBody(
      c,
      z.strictObject({ timeZone: z.string().min(1).max(100) }),
    );
    if (!validTimeZone(timeZone))
      throw new AppError(422, 'invalid_time_zone', `${timeZone} is not an IANA time zone`);
    return c.json(await routines.setTimeZone(c.get('caller'), timeZone));
  });
  app.get('/routines/:id', requireScope('read'), async (c) =>
    c.json(await routines.get(c.get('caller'), idParam(c))),
  );
  app.get('/routines/:id/runs/:run', requireScope('read'), async (c) =>
    c.json(await routines.getRun(c.get('caller'), idParam(c), idParam(c, 'run'))),
  );
  app.post('/routines/:id/versions/:version/approve', requireScope('admin'), async (c) =>
    c.json(await routines.approve(c.get('caller'), idParam(c), idParam(c, 'version'))),
  );
  app.post('/routines/:id/versions/:version/reject', requireScope('admin'), async (c) =>
    c.json(await routines.reject(c.get('caller'), idParam(c), idParam(c, 'version'))),
  );
  app.post('/routines/:id/versions/:version/test', requireScope('admin'), async (c) => {
    const { recordId } = await readBody(
      c,
      z.strictObject({ recordId: z.uuid().nullable().optional() }),
    );
    return c.json(
      await routines.test(c.get('caller'), idParam(c), idParam(c, 'version'), recordId ?? null),
      202,
    );
  });
  app.post('/routines/:id/pause', requireScope('admin'), async (c) =>
    c.json(await routines.pause(c.get('caller'), idParam(c))),
  );
  app.post('/routines/:id/resume', requireScope('admin'), async (c) =>
    c.json(await routines.resume(c.get('caller'), idParam(c))),
  );
  app.post('/routines/:id/archive', requireScope('admin'), async (c) =>
    c.json(await routines.archive(c.get('caller'), idParam(c))),
  );
  app.post('/routines/:id/held', requireScope('admin'), async (c) => {
    const { action } = await readBody(c, z.strictObject({ action: z.enum(['run', 'discard']) }));
    return c.json(await routines.releaseHeld(c.get('caller'), idParam(c), action));
  });
  app.post('/routines/:id/run-now', requireScope('admin'), async (c) =>
    c.json(await routines.runNow(c.get('caller'), idParam(c)), 202),
  );
  app.post('/routines/:id/run', requireScope('write'), async (c) => {
    const { recordIds } = await readBody(
      c,
      z.strictObject({ recordIds: z.array(z.uuid()).min(1).max(50) }),
    );
    return c.json(await routines.runManual(c.get('caller'), idParam(c), recordIds), 202);
  });
}

/** A check job's answer: valid, invalid with problems, or still running. */
function checkResult(job: {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  code: string | null;
}) {
  if (job.status === 'succeeded' && job.output)
    return {
      valid: job.output.valid === true,
      problems: (job.output.problems as unknown[]) ?? [],
      jobId: job.id,
      status: job.status,
    };
  if (['queued', 'running'].includes(job.status))
    return { valid: null, problems: [], jobId: job.id, status: job.status };
  return {
    valid: false,
    problems: [
      { part: 'code', code: job.code ?? 'check_failed', message: 'the type-check could not run' },
    ],
    jobId: job.id,
    status: job.status,
  };
}

/**
 * The routine runtime (§3.3, §6.2): what the routine runner and the code in
 * its sandbox call, with the run's token. The token reaches nothing else.
 */
export function routineRuntimeRoutes(app: Hono<AppEnv>, runtime: RoutineRuntime) {
  app.use('/routines/runtime/*', async (c, next) => {
    if (!c.get('caller').routine)
      throw new AppError(403, 'forbidden', 'this endpoint requires a routine run credential');
    await next();
  });
  app.get('/routines/runtime/run', async (c) => c.json(await runtime.context(c.get('caller'))));
  app.get('/routines/runtime/capabilities', async (c) =>
    c.json(await runtime.capabilities(c.get('caller'))),
  );
  app.post('/routines/runtime/read', async (c) => {
    const { operation, args } = await readBody(
      c,
      z.strictObject({
        operation: z.enum(['record.get', 'record.query', 'record.aggregate', 'files.text']),
        args: z.record(z.string(), z.unknown()),
      }),
    );
    return c.json({ result: await runtime.read(c.get('caller'), operation, args) });
  });
  app.post('/routines/runtime/effects', async (c) =>
    c.json(
      await runtime.effect(c.get('caller'), await readBody(c, routineEffectRequestSchema, 70000)),
    ),
  );
  app.get('/routines/runtime/effects/:position', async (c) =>
    c.json(await runtime.poll(c.get('caller'), positionParam(c.req.param('position')))),
  );
  app.post('/routines/runtime/effects/:position/result', async (c) => {
    const body = await readBody(
      c,
      z.union([
        z.strictObject({ result: z.json() }),
        // The provider refused the call or its answer was unusable (§11.4).
        z.strictObject({
          error: z.strictObject({
            code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            message: z.string().max(2000),
          }),
        }),
      ]),
      70000,
    );
    const position = positionParam(c.req.param('position'));
    return c.json(
      'error' in body
        ? await runtime.modelFailed(c.get('caller'), position, body.error)
        : await runtime.modelResult(c.get('caller'), position, body.result),
    );
  });
  app.post('/routines/runtime/build/check', async (c) =>
    c.json(await runtime.buildCheck(c.get('caller'), await readBody(c, sourceInputSchema))),
  );
  app.post('/routines/runtime/build/propose', async (c) => {
    const { proposal, typesFingerprint } = await readBody(
      c,
      z.strictObject({
        proposal: z.unknown(),
        typesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    );
    return c.json(await runtime.buildPropose(c.get('caller'), proposal, typesFingerprint), 201);
  });
}

function positionParam(value: string | undefined) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 1 || position > 100000)
    throw new AppError(400, 'invalid_request', 'position must be a positive integer');
  return position;
}
