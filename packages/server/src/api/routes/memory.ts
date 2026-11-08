import type { Hono } from 'hono';
import { missingScope, requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { idParam, readBody, recordParam } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { addLinksInputSchema } from '../../memory/event-links.js';
import { logEventInputSchema } from '../../memory/events.js';
import { rememberInputSchema } from '../../memory/facts.js';
import { moveEventsInputSchema } from '../../memory/move.js';
import {
  addEventLinksFor,
  logEventFor,
  moveEventsFor,
  readEvent,
  remember,
  removeEventLinkFor,
  retractEventFor,
  retractFactFor,
} from '../../memory/service.js';
import { queryInputSchema } from '../../records/query.js';
import { findEvents } from '../../records/service.js';

/** Events and facts (6.2, 6.4), on the same services as the MCP tools. */
export function memoryRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/events', requireScope('write'), async (c) => {
    const input = await readBody(c, logEventInputSchema);
    const result = await logEventFor(sql, c.get('caller'), input);
    return c.json(result, result.created ? 201 : 200);
  });

  app.post('/events/query', requireScope('read'), async (c) => {
    const input = await readBody(c, queryInputSchema);
    return c.json(await findEvents(sql, c.get('caller'), input));
  });

  /**
   * Moves events to another event type (1.3). schema:write may run it as a
   * dry run; moving needs a user with admin, checked by the service.
   */
  app.post('/events/move', requireScope('schema:write'), async (c) => {
    const input = await readBody(c, moveEventsInputSchema);
    return c.json(await moveEventsFor(sql, c.get('caller'), input));
  });

  app.get('/events/:id', requireScope('read'), async (c) =>
    c.json(await readEvent(sql, c.get('caller'), idParam(c))),
  );

  // `added.participants.matched` includes stored participants resolved in place.
  app.post('/events/:id/links', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, addLinksInputSchema);
    return c.json(await addEventLinksFor(sql, c.get('caller'), id, input));
  });

  app.delete('/events/:id/participants/:participantId', requireScope('write'), async (c) =>
    c.json(
      await removeEventLinkFor(sql, c.get('caller'), idParam(c), {
        participant: idParam(c, 'participantId'),
      }),
    ),
  );

  app.delete('/events/:id/about/:recordId', requireScope('write'), async (c) =>
    c.json(
      await removeEventLinkFor(sql, c.get('caller'), idParam(c), {
        about: idParam(c, 'recordId'),
      }),
    ),
  );

  app.delete('/events/:id', requireScope('write'), async (c) =>
    c.json(await retractEventFor(sql, c.get('caller'), idParam(c))),
  );

  // `workspace` and `me` name workspace and personal memory (personal memory 4.4).
  app.post('/records/:id/facts', requireScope('write'), async (c) => {
    const id = recordParam(c);
    const input = await readBody(c, rememberInputSchema);
    const key = c.req.header('idempotency-key');
    return c.json(await remember(sql, c.get('caller'), id, input, key), 201);
  });

  /**
   * Removes a fact. A shared one needs `write`; a person removes their own
   * personal fact signed in, whatever their role, as "Remove" on Settings →
   * Memory does (personal memory spec 4.8).
   */
  app.delete('/facts/:id', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    return c.json(
      await retractFactFor(sql, caller, idParam(c), (personal) => {
        const own = personal && caller.userId !== undefined;
        const missing = own ? undefined : missingScope(caller, 'write');
        if (missing) throw missing;
      }),
    );
  });
}
