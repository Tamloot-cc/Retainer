import { EVENT_ATTACHMENTS } from '@retainer/shared';
import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { AppError, notFound } from '../../errors.js';
import { idParam, limitParam, recordParam } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { attachedEventPage } from '../../memory/events.js';
import { resolveTarget } from '../../memory/profiles.js';
import { assertionById, assertions, enrichedRecord } from '../../reads/records.js';
import { factsPage, reviewPage } from '../../reads/review.js';
import { findLiveRecord, getRecord } from '../../records/read.js';
import { withRead } from '../../records/service.js';

export function webReadRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/review', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) =>
      c.json(
        await reviewPage(
          tx,
          c.get('caller').workspaceId,
          schema,
          limitParam(c, 100, 500),
          c.req.query(),
        ),
      ),
    ),
  );
  app.get('/assertions/:id', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) =>
      c.json(await assertionById(tx, schema, idParam(c))),
    ),
  );
  app.get('/records/:id', requireScope('read'), async (c, next) => {
    if (!c.req.query('include')) return next();
    return withRead(sql, c.get('caller'), async (tx, schema) =>
      c.json(
        await enrichedRecord(
          tx,
          c.get('caller').workspaceId,
          schema,
          idParam(c),
          (c.req.query('include') ?? '').split(','),
        ),
      ),
    );
  });
  app.get('/records/:id/assertions', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) => {
      const record = await findLiveRecord(tx, c.get('caller').workspaceId, schema, idParam(c));
      const field = c.req.query('field');
      return c.json(
        await assertions(
          tx,
          schema,
          tx`a.record_id = ${record.id} ${field ? tx`and a.field_id in (select id from fields where name = ${field})` : tx``}`,
          limitParam(c, 50, 200),
          c.req.query('cursor'),
          true,
        ),
      );
    }),
  );
  app.get('/records/:id/events', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) => {
      const record = await findLiveRecord(tx, c.get('caller').workspaceId, schema, idParam(c));
      const link = c.req.query('link');
      if (link !== undefined && !(EVENT_ATTACHMENTS as readonly string[]).includes(link)) {
        throw new AppError(
          400,
          'invalid_query',
          `link must be one of ${EVENT_ATTACHMENTS.join(', ')}`,
        );
      }
      return c.json(
        await attachedEventPage(
          tx,
          schema,
          c.get('caller').workspaceId,
          record.id,
          limitParam(c, 50, 200),
          c.req.query('cursor'),
          link as (typeof EVENT_ATTACHMENTS)[number] | undefined,
        ),
      );
    }),
  );
  // `workspace` and `me` list workspace and personal memory (personal memory
  // 4.4, 4.8); `me` before anything was written to it has no facts.
  app.get('/records/:id/facts', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) => {
      const caller = c.get('caller');
      const target = await resolveTarget(
        tx,
        { workspaceId: caller.workspaceId, schema, person: caller.person },
        recordParam(c),
      );
      const limit = limitParam(c, 100, 500);
      if (target.kind === 'profile') {
        const { alias, id } = target.profile;
        const page = id
          ? await factsPage(tx, schema, tx`f.record_id = ${id}`, limit, c.req.query('cursor'))
          : { facts: [], nextCursor: null };
        return c.json({ profile: alias, ...page });
      }
      const record = await findLiveRecord(tx, caller.workspaceId, schema, target.id);
      return c.json({
        record: record.id,
        ...(await factsPage(
          tx,
          schema,
          tx`f.record_id = ${record.id}`,
          limit,
          c.req.query('cursor'),
        )),
      });
    }),
  );
  app.get('/events/:id/claims', requireScope('read'), (c) =>
    withRead(sql, c.get('caller'), async (tx, schema) => {
      const event = await getRecord(tx, c.get('caller').workspaceId, schema, idParam(c));
      if (!event.event) throw notFound('event', { id: event.id });
      const id = event.id;
      const limit = limitParam(c, 50, 200);
      // The event's own logged values cite it too; `own=false` leaves them
      // out, for what the rest of memory rests on it.
      const own = c.req.query('own') === 'false' ? tx`and a.record_id <> ${id}` : tx``;
      const [a, f] = await Promise.all([
        assertions(
          tx,
          schema,
          tx`a.source_record_id = ${id} ${own}`,
          limit,
          c.req.query('assertionsCursor'),
          true,
        ),
        factsPage(
          tx,
          schema,
          tx`exists (select 1 from fact_sources s where s.fact_id = f.id and s.source_record_id = ${id})`,
          limit,
          c.req.query('factsCursor'),
          true,
        ),
      ]);
      return c.json({
        assertions: a.items,
        facts: f.facts,
        nextCursors: { assertions: a.nextCursor, facts: f.nextCursor },
      });
    }),
  );
}
