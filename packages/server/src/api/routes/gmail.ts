import {
  deleteNangoGmailConnection,
  GmailProviderError,
  gmailRegistrationId,
  nangoId,
  nangoOrigin,
  nangoRequest,
  readResponse,
} from '@retainer/extension/nango-gmail';
import { isoDateTimeSchema } from '@retainer/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Caller } from '../../caller.js';
import type { Sql } from '../../db/client.js';
import type { Tx } from '../../db/tx.js';
import { inWorkspace, lockSchemaShared } from '../../db/tx.js';
import { AppError, forbidden } from '../../errors.js';
import { admitRun } from '../../extension-runtime/admission.js';
import type { StoredBindingPlan } from '../../extension-runtime/bindings.js';
import type { ExtensionCatalog } from '../../extensions/catalog.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { normalizeEmail } from '../../records/derive.js';
import { withRead, withWrite } from '../../records/service.js';
import { getSchema } from '../../schema/compiled.js';
import {
  appendGmailMessage,
  gmailAddressesSchema,
  gmailConversationSchema,
  gmailMessageSchema,
  matchGmailPeople,
} from '../../sources/gmail.js';

async function gmailRun(
  tx: Tx,
  catalog: ExtensionCatalog,
  caller: Caller,
  installationId: string,
  purpose: 'ingest' | 'scan' | 'profile' | 'release' = 'ingest',
) {
  const run = caller.run;
  if (run?.installationId !== installationId || !run.connectionId)
    throw forbidden('a live Gmail mailbox run is required');
  const [installation] = await tx<
    { connection_settings: Record<string, unknown>; bindings: StoredBindingPlan | null }[]
  >`
    select c.settings as connection_settings, i.bindings
    from extension_installations i join extension_connections c on c.installation_id=i.id
    where i.id=${installationId} and c.id=${run.connectionId}`;
  if (!installation) throw forbidden('a live Gmail mailbox run is required');
  const release = catalog.forRun(run);
  const policy = release.manifest.source;
  const permissions = {
    ingest: policy?.syncFunctionIds ?? [],
    scan: policy?.scanFunctionIds ?? [],
    profile: [policy?.verifyFunctionId, ...(policy?.scanFunctionIds ?? [])],
    release: release.manifest.functions
      .filter((fn) => fn.trigger.kind === 'disconnect')
      .map((fn) => fn.universalId),
  };
  if (
    run.registrationId !== gmailRegistrationId ||
    policy?.provider !== 'gmail' ||
    !permissions[purpose].includes(run.functionId) ||
    release.manifest.createPeople !== 'never'
  )
    throw forbidden('this function has no Gmail ingestion grant');
  return {
    installationId,
    plan: installation.bindings,
    connectionId: run.connectionId,
    isSetup: run.functionId === policy.verifyFunctionId,
    // The integration the member authorized through, even if the server's has changed since.
    integrationId: nangoId.parse(installation.connection_settings.boundNangoIntegrationId),
    nangoConnectionId: nangoId.parse(installation.connection_settings.nangoConnectionId),
  };
}

const pageToken = z.string().min(1).max(8000);
const proxyInput = z.strictObject({
  path: z.string().regex(/^(profile|history|messages(?:\/[a-zA-Z0-9_-]{1,200})?)$/),
  query: z.array(z.tuple([z.string().max(32), z.string().max(8000)])).max(8),
});
const metadataHeaders = ['From', 'To', 'Subject', 'Date', 'Message-ID'];

function proxyQuery(path: string, params: URLSearchParams) {
  if (path === 'profile') return new URLSearchParams({ fields: 'emailAddress,historyId' });
  const query = new URLSearchParams();
  if (path.startsWith('messages/')) {
    const format = z.enum(['METADATA', 'FULL']).parse(params.get('format'));
    query.set('format', format);
    query.set(
      'fields',
      format === 'FULL'
        ? 'id,threadId,labelIds,internalDate,payload'
        : 'id,threadId,labelIds,internalDate,payload/headers(name,value)',
    );
    if (format === 'METADATA')
      for (const header of metadataHeaders) query.append('metadataHeaders', header);
    return query;
  }
  if (path === 'history') {
    query.set(
      'startHistoryId',
      z
        .string()
        .regex(/^\d{1,30}$/)
        .parse(params.get('startHistoryId')),
    );
    query.set(
      'fields',
      'historyId,nextPageToken,history(messagesAdded/message/id,labelsAdded/message/id,labelsRemoved/message/id)',
    );
  } else {
    query.set(
      'q',
      z
        .string()
        .regex(/^(after:\d+ )?before:\d+( \{from:[^\s{}"]+ to:[^\s{}"]+\})?$/)
        .max(800)
        .parse(params.get('q')),
    );
    query.set('includeSpamTrash', 'false');
    query.set('fields', 'messages(id,threadId),nextPageToken');
  }
  query.set('maxResults', '30');
  const token = params.get('pageToken');
  if (token !== null) query.set('pageToken', pageToken.parse(token));
  return query;
}

async function messageReservation(
  tx: Tx,
  caller: Caller,
  binding: { connectionId: string; installationId: string },
  messageId: string,
  sourceItemId?: string,
) {
  const [reservation] = await tx<{ id: string; prepared: boolean | null }[]>`
    select s.id,s.prepared_job_id=j.id and s.prepared_fence=j.fence as prepared from extension_jobs j
    join source_items s on s.id=j.source_item_id and s.workspace_id=j.workspace_id
    join source_bindings b on b.account_id=s.account_id and b.workspace_id=s.workspace_id
    where j.id=${caller.run?.jobId ?? null} and s.external_id=${messageId}
      and (${sourceItemId ?? null}::uuid is null or s.id=${sourceItemId ?? null}::uuid)
      and s.state in ('reserved','live')
      and b.connection_id=${binding.connectionId} and b.installation_id=${binding.installationId}
      and b.generation=j.generation`;
  if (!reservation) throw forbidden('this run cannot access this Gmail message');
  return reservation;
}

async function importWindow(tx: Tx, caller: Caller) {
  const [job] = await tx<{ dedupe_key: string }[]>`
    select dedupe_key from extension_jobs where id=${caller.run?.jobId ?? null}`;
  const parts = /^gmail:(\d+):(\d*):([a-f0-9-]*):[a-f0-9]{64}$/.exec(job?.dedupe_key ?? '');
  if (!parts) throw forbidden('this Gmail message has no admitted import window');
  return {
    from: Number(parts[1]),
    ...(parts[2] ? { through: Number(parts[2]) } : {}),
    targetId: parts[3] ? z.uuid().parse(parts[3]) : null,
  };
}

async function targetForRun(tx: Tx, caller: Caller, targetId: string | null) {
  if (!targetId) return { kind: 'ordinary' as const };
  const [target] = await tx<{ email: string; record_id: string }[]>`
    select a.email,a.record_id from gmail_contact_additions a
    join extension_connections c on c.id=${caller.run?.connectionId ?? null}
    where a.id=${targetId} and a.workspace_id=${caller.workspaceId} and a.created_at>=c.created_at`;
  return target ? { kind: 'targeted' as const, ...target } : { kind: 'missing' as const };
}

export function gmailRuntimeRoutes(app: Hono<AppEnv>, sql: Sql, catalog: ExtensionCatalog) {
  app.post('/extensions/:id/runtime/gmail/proxy', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    const run = caller.run;
    if (!run) throw forbidden('a live Gmail mailbox run is required');
    const id = idParam(c);
    const { path, query: params } = await readBody(c, proxyInput);
    const query = proxyQuery(path, new URLSearchParams(params));
    const messageId = path.startsWith('messages/') ? path.slice('messages/'.length) : null;
    const binding = await inWorkspace(sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const binding = await gmailRun(
        tx,
        catalog,
        caller,
        id,
        messageId ? 'ingest' : path === 'profile' ? 'profile' : 'scan',
      );
      if (binding.isSetup)
        gmailConversationSchema(await getSchema(tx, caller.workspaceId), binding.plan);
      if (messageId) {
        const full = query.get('format') === 'FULL';
        const reservation = await messageReservation(tx, caller, binding, messageId);
        if (full && !reservation.prepared)
          throw new AppError(
            409,
            'source_revision_conflict',
            'the message preparation was replaced',
          );
      }
      return binding;
    });
    const apiKey = process.env.RETAINER_GMAIL_NANGO_PROXY_KEY ?? process.env.NANGO_API_KEY;
    if (!apiKey) throw new AppError(503, 'gmail_unavailable', 'Nango Gmail is not configured');
    const url = new URL(`/proxy/gmail/v1/users/me/${path}`, nangoOrigin);
    url.search = query.toString();
    try {
      const upstream = await nangoRequest(
        url,
        {
          authorization: `Bearer ${apiKey}`,
          'provider-config-key': binding.integrationId,
          'connection-id': binding.nangoConnectionId,
        },
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20000)]),
        fetch,
      );
      if (path === 'profile' && binding.isSetup && upstream.ok) {
        const profile = await readResponse(
          upstream,
          z.object({
            emailAddress: z.email(),
            historyId: z.string().regex(/^\d{1,30}$/),
          }),
          c.req.raw.signal,
          16 * 1024,
        );
        await inWorkspace(sql, caller.workspaceId, async (tx) => {
          await lockSchemaShared(tx, caller.workspaceId);
          await admitRun(tx, caller.workspaceId, run, false, 'runtime');
          await tx`update extension_connections set settings=settings||${tx.json({ gmailAddress: profile.emailAddress })}::jsonb
            where id=${binding.connectionId} and installation_id=${id}`;
        });
        return c.json(profile, 200, { 'cache-control': 'no-store' });
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      if (!(error instanceof GmailProviderError)) throw error;
      throw new AppError(503, 'gmail_unavailable', 'Nango Gmail is temporarily unavailable');
    }
  });
  app.post('/extensions/:id/runtime/gmail/release', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    const run = caller.run;
    if (!run) throw forbidden('a live Gmail mailbox run is required');
    const binding = await inWorkspace(sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      return gmailRun(tx, catalog, caller, idParam(c), 'release');
    });
    const apiKey = process.env.RETAINER_GMAIL_NANGO_CONTROL_KEY ?? process.env.NANGO_API_KEY;
    if (!apiKey) throw new AppError(503, 'gmail_unavailable', 'Nango Gmail is not configured');
    try {
      await deleteNangoGmailConnection(
        {
          apiKey,
          integrationId: binding.integrationId,
          connectionId: binding.nangoConnectionId,
        },
        c.req.raw.signal,
      );
    } catch (error) {
      if (!(error instanceof GmailProviderError)) throw error;
      throw new AppError(503, 'gmail_unavailable', 'Nango could not release the Gmail connection');
    }
    return c.json({ released: true });
  });
  app.post('/extensions/:id/runtime/gmail/target', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    const id = idParam(c);
    const input = await readBody(
      c,
      z.strictObject({
        additionId: z.uuid().nullable(),
        complete: z.boolean().default(false),
      }),
    );
    return c.json(
      await withRead(sql, caller, async (tx, schema) => {
        const binding = await gmailRun(tx, catalog, caller, id, 'scan');
        gmailConversationSchema(schema, binding.plan);
        if (input.complete && input.additionId) {
          await tx`insert into gmail_contact_scans(workspace_id,installation_id,connection_id,addition_id)
          select a.workspace_id,${id},${binding.connectionId},a.id
          from gmail_contact_additions a join extension_connections c on c.id=${binding.connectionId}
          where a.workspace_id=${caller.workspaceId} and a.id=${input.additionId} and a.created_at>=c.created_at
          on conflict do nothing`;
          return { target: null };
        }
        const [target] = await tx<
          { id: string; email: string; created_at: Date; history_days: number }[]
        >`
        select a.id,a.email,a.created_at,a.history_days
        from gmail_contact_additions a join extension_connections c on c.id=${binding.connectionId}
        where a.workspace_id=${caller.workspaceId} and a.created_at>=c.created_at and a.history_days>0
          and (${input.additionId}::uuid is null or a.id=${input.additionId}::uuid)
          and not exists(select 1 from gmail_contact_scans s
            where s.workspace_id=a.workspace_id and s.connection_id=c.id and s.addition_id=a.id)
        order by a.created_at,a.id limit 1`;
        return {
          target: target
            ? {
                id: target.id,
                email: target.email,
                through: target.created_at.getTime(),
                from: Math.max(0, target.created_at.getTime() - target.history_days * 86_400_000),
              }
            : null,
        };
      }),
    );
  });
  app.get('/extensions/:id/runtime/gmail/window', requireScope('read'), async (c) => {
    const caller = c.get('caller');
    return c.json(
      await withRead(sql, caller, async (tx) => {
        await gmailRun(tx, catalog, caller, idParam(c));
        const { from, through } = await importWindow(tx, caller);
        return { from, through };
      }),
    );
  });
  app.post('/extensions/:id/runtime/gmail/prepare', requireScope('write'), async (c) => {
    const caller = c.get('caller');
    const id = idParam(c);
    const input = await readBody(
      c,
      gmailAddressesSchema.extend({
        occurredAt: isoDateTimeSchema,
        messageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
        sourceItemId: z.uuid(),
      }),
    );
    return c.json(
      await withWrite(
        sql,
        caller,
        async (tx, context) => {
          const binding = await gmailRun(tx, catalog, caller, id);
          gmailConversationSchema(context.schema, binding.plan);
          const item = await messageReservation(
            tx,
            caller,
            binding,
            input.messageId,
            input.sourceItemId,
          );
          const { from, through, targetId } = await importWindow(tx, caller);
          const occurredAt = Date.parse(input.occurredAt);
          if (occurredAt < from || (through !== undefined && occurredAt >= through))
            return { prepared: false };
          const target = await targetForRun(tx, caller, targetId);
          if (target.kind === 'missing') return { prepared: false };
          const people = await matchGmailPeople(tx, context, input, binding.plan, {
            connectionId: binding.connectionId,
            occurredAt: input.occurredAt,
          });
          if (
            !people.length ||
            (target.kind === 'targeted' &&
              !people.some((p) => p.handle === target.email && p.recordId === target.record_id))
          )
            return { prepared: false };
          // Anchor every envelope address so erasure can fence this job while a body is in transit.
          const emails = [...new Set([...input.from, ...input.to].map(normalizeEmail))];
          await tx`update source_items set prepared_job_id=${caller.run?.jobId ?? null},
        prepared_fence=${caller.run?.fence ?? null}::bigint where id=${item.id}`;
          await tx`delete from source_participants where item_id=${item.id}`;
          await tx`insert into source_participants(workspace_id,item_id,email)
        select ${caller.workspaceId},${item.id},email from unnest(${emails}::text[]) as handles(email)`;
          return { prepared: true };
        },
        {},
        { asPerson: false },
      ),
    );
  });
  app.post('/extensions/:id/runtime/gmail/messages', requireScope('write'), async (c) => {
    const caller = c.get('caller');
    const id = idParam(c);
    const { sourceItemId, ...input } = await readBody(
      c,
      gmailMessageSchema.safeExtend({ sourceItemId: z.uuid() }),
    );
    return c.json(
      await withWrite(
        sql,
        caller,
        async (tx, context) => {
          const binding = await gmailRun(tx, catalog, caller, id);
          const reservation = await messageReservation(
            tx,
            caller,
            binding,
            input.messageId,
            sourceItemId,
          );
          if (!reservation.prepared)
            throw new AppError(
              409,
              'source_revision_conflict',
              'the message preparation was replaced',
            );
          const { from, through, targetId } = await importWindow(tx, caller);
          const occurredAt = Date.parse(input.occurredAt);
          if (occurredAt < from || (through !== undefined && occurredAt >= through))
            return { kind: 'no_match' as const };
          const target = await targetForRun(tx, caller, targetId);
          if (target.kind === 'missing') return { kind: 'no_match' as const };
          const result = await appendGmailMessage(tx, context, binding, {
            ...input,
            targetEmail: target.kind === 'targeted' ? target.email : undefined,
            targetPersonId: target.kind === 'targeted' ? target.record_id : undefined,
          });
          if (result.kind === 'imported')
            await tx`update source_items set state='live',updated_at=clock_timestamp() where id=${sourceItemId}`;
          return result;
        },
        { schema: 'exclusive' },
        { asPerson: false },
      ),
    );
  });
}
