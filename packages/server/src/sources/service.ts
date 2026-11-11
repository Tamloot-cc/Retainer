import type { ExtensionManifest } from '@retainer/extension';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import type { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, jsonValue, lockForWrite, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitRun } from '../extension-runtime/admission.js';
import { cancelRuns, lockExtension } from '../extension-runtime/locks.js';
import { requestHash } from '../idempotency.js';
import { logEvent, retractEventClaims } from '../memory/events.js';
import { isEventIdentitySuppressed, isSuppressed, suppressedOf } from '../privacy/suppression.js';
import { withRead, withWrite } from '../records/service.js';
import { normalizeFieldValue } from '../records/values.js';
import { insertRecord, markDeleted, type WriteContext, writeFields } from '../records/write.js';
import {
  prepareSourceSchema,
  reserveSourceSchema,
  type SourceEventInput,
  type SourceResult,
  sourceBindingSchema,
  sourceEventSchema,
  sourceUnavailableSchema,
} from './contract.js';
import { compareRevision, type SourcePolicy, sourceIdentityChannel } from './policy.js';

type Resolve = (registration: string, version: string, digest: string) => ExtensionManifest;
type Binding = {
  account_id: string;
  namespace: string;
  provider: string;
  registration_id: string;
  version: string;
  release_digest: string;
  settings: Record<string, unknown>;
};
type Item = {
  id: string;
  account_id: string;
  external_id: string | null;
  state: string;
  provider_revision: string | null;
};
type Revision = { id: string; event_id: string; content_digest: string };
const conflict = (code: string, message: string) => new AppError(409, code, message);
const emptyInvalidation = () => ({
  retractedAssertions: 0,
  recomputedRecordIds: [] as string[],
  hiddenFactIds: [] as string[],
});

/** Provider I/O runs in pinned isolated functions; this service validates their scoped attestations. */
export class Sources {
  constructor(
    private readonly sql: Sql,
    private readonly resolve: Resolve,
  ) {}
  private runtime(caller: Caller, id: string) {
    if (!caller.run || caller.run.installationId !== id) throw notFound('installation source');
    if (!caller.scopes.includes('write')) throw forbidden('source ingestion requires write scope');
    return caller.run;
  }
  private async release(tx: Tx, caller: Caller) {
    const run = caller.run;
    if (!run) throw forbidden('source operation requires an installation credential');
    const [i] = await tx<
      { version: string; release_digest: string; settings: Record<string, unknown> }[]
    >`select version,release_digest,settings from extension_installations where id=${run.installationId}`;
    if (!i) throw notFound('installation source');
    const manifest = this.resolve(run.registrationId, i.version, i.release_digest);
    if (!manifest.source) throw forbidden('release has no managed source capability');
    return { manifest, policy: manifest.source, settings: i.settings };
  }
  private async binding(tx: Tx, caller: Caller): Promise<Binding> {
    const run = caller.run;
    if (!run) throw forbidden('source operation requires an installation credential');
    const [binding] = await tx<
      Binding[]
    >`select b.account_id,a.namespace,a.provider,a.registration_id,i.version,i.release_digest,i.settings
      from source_bindings b join source_accounts a on a.id=b.account_id join extension_installations i on i.id=b.installation_id
      where b.installation_id=${run.installationId} and b.generation=${run.generation} and a.registration_id=${run.registrationId}`;
    if (!binding)
      throw conflict(
        'source_connection_required',
        'the source connection has not been verified for this generation',
      );
    return binding;
  }
  /** Only the pinned setup verifier may bind a provider identity, after explicit workspace-sharing approval. */
  async verify(caller: Caller, id: string, raw: z.input<typeof sourceBindingSchema>) {
    const run = this.runtime(caller, id),
      input = sourceBindingSchema.parse(raw);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const { policy } = await this.release(tx, caller);
      const [job] =
        await tx`select function_id,trigger_kind from extension_jobs where id=${run.jobId}`;
      if (job?.trigger_kind !== 'install' || job.function_id !== policy.verifyFunctionId)
        throw forbidden('only the registered source verifier may attest a connection');
      if ((policy.identity === 'account') !== (input.accountId !== undefined))
        throw new AppError(
          422,
          'invalid_source_identity',
          'supply a provider account ID only for an account-scoped provider',
        );
      const identity =
        policy.identity === 'global-resource' ? 'global' : (input.accountId as string);
      const namespace = requestHash({ identity, strategy: policy.identity });
      const [prior] =
        await tx`select a.namespace,a.provider from source_bindings b join source_accounts a on a.id=b.account_id where b.installation_id=${id}`;
      if (prior && (prior.namespace !== namespace || prior.provider !== policy.provider))
        throw conflict(
          'source_account_changed',
          'disconnect the retained source connection before replacing its account',
        );
      const [account] = await tx<
        { id: string }[]
      >`insert into source_accounts(workspace_id,registration_id,provider,namespace,identity)
        values(${caller.workspaceId},${run.registrationId},${policy.provider},${namespace},${identity})
        on conflict(workspace_id,registration_id,provider,namespace) do update set namespace=excluded.namespace returning id`;
      if (!account) throw new Error('source account insert returned no row');
      await tx`insert into source_bindings(workspace_id,installation_id,account_id,generation)
        values(${caller.workspaceId},${id},${account.id},${run.generation})
        on conflict(workspace_id,installation_id) do update set account_id=excluded.account_id,generation=excluded.generation,verified_at=clock_timestamp()`;
      return {
        sourceAccountId: account.id,
        provider: policy.provider,
        identity: policy.identity,
        sharing: input.sharing,
      };
    });
  }
  async disconnect(caller: Caller, id: string) {
    if (!canApproveDestructive(caller.actor, caller.scopes) || caller.run)
      throw forbidden('only a human admin may disconnect a source');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      const [i] = await tx`select registration_id from extension_installations where id=${id}`;
      if (!i) throw notFound('installation source');
      await lockExtension(tx, caller.workspaceId, i.registration_id);
      await cancelRuns(tx, id);
      await tx`delete from source_bindings where installation_id=${id}`;
      await tx`update extension_installations set state='disabled',generation=generation+1,connection_health='needs_reconnect',last_error=null where id=${id}`;
      return { disconnected: true };
    });
  }
  private async usable(tx: Tx, caller: Caller, binding: Binding, item: Item) {
    if (item.account_id !== binding.account_id) throw notFound('source item');
    if (
      item.state === 'erased' ||
      !item.external_id ||
      (await isEventIdentitySuppressed(
        tx,
        caller.workspaceId,
        sourceIdentityChannel(binding.registration_id, binding.provider, binding.namespace),
        item.external_id,
      ))
    )
      throw conflict(
        'source_erased',
        'this source identity was erased and cannot be imported again',
      );
  }
  async reserve(caller: Caller, id: string, raw: z.input<typeof reserveSourceSchema>) {
    this.runtime(caller, id);
    const input = reserveSourceSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller);
        if (binding.account_id !== input.sourceAccountId) throw notFound('source account');
        const channel = sourceIdentityChannel(
          binding.registration_id,
          binding.provider,
          binding.namespace,
        );
        if (await isEventIdentitySuppressed(tx, caller.workspaceId, channel, input.externalId))
          throw conflict(
            'source_erased',
            'this source identity was erased and cannot be imported again',
          );
        const [item] = await tx<
          Item[]
        >`insert into source_items(workspace_id,account_id,external_id)
        values(${caller.workspaceId},${binding.account_id},${input.externalId})
        on conflict(workspace_id,account_id,external_id) do update set external_id=excluded.external_id returning *`;
        if (!item) throw new Error('source item insert returned no row');
        await this.usable(tx, caller, binding, item);
        return { sourceItemId: item.id };
      },
      {},
      { asPerson: false },
    );
  }
  async get(caller: Caller, id: string, itemId: string) {
    this.runtime(caller, id);
    return withRead(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId}`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${itemId} and is_current`;
        return {
          sourceItemId: item.id,
          sourceAccountId: item.account_id,
          externalId: item.external_id,
          state: item.state,
          providerRevision: item.provider_revision,
          revisionId: current?.id ?? null,
          eventId: current?.event_id ?? null,
          contentDigest: current?.content_digest ?? null,
        };
      },
      { privacy: true },
    );
  }
  private async ingestionJob(tx: Tx, caller: Caller, policy: SourcePolicy, itemId: string) {
    const [job] =
      await tx`select function_id,source_item_id from extension_jobs where id=${caller.run?.jobId ?? null}`;
    if (!policy.syncFunctionIds.includes(job?.function_id) || job?.source_item_id !== itemId)
      throw forbidden("only this item's registered ingestion job may change its evidence");
  }
  /** Stage ownership before bytes: an erasure can find uploads even before the first event revision. */
  async prepare(
    caller: Caller,
    id: string,
    itemId: string,
    raw: z.input<typeof prepareSourceSchema>,
  ) {
    const run = this.runtime(caller, id),
      input = prepareSourceSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx) => {
        const binding = await this.binding(tx, caller),
          { policy } = await this.release(tx, caller);
        await this.ingestionJob(tx, caller, policy, itemId);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['retracted', 'deleted'].includes(item.state))
          throw conflict(
            'source_retracted',
            'deleted source identities cannot be silently recreated',
          );
        const handles = input.participants.map((value) => ({ kind: 'email' as const, value }));
        const suppressed = await suppressedOf(tx, caller.workspaceId, handles);
        if (handles.some((h) => isSuppressed(suppressed, h)))
          throw conflict('suppressed', 'a staged participant was erased');
        await tx`delete from source_participants where item_id=${itemId}`;
        for (const email of new Set(input.participants))
          await tx`insert into source_participants(workspace_id,item_id,email) values(${caller.workspaceId},${itemId},${email})`;
        await tx`update source_items set prepared_job_id=${run.jobId},prepared_fence=${run.fence}::bigint where id=${itemId}`;
        return { prepared: true };
      },
      {},
      { asPerson: false },
    );
  }
  async unavailable(
    caller: Caller,
    id: string,
    itemId: string,
    raw: z.input<typeof sourceUnavailableSchema>,
  ) {
    this.runtime(caller, id);
    const input = sourceUnavailableSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx, context) => {
        const binding = await this.binding(tx, caller),
          { policy, manifest } = await this.release(tx, caller);
        await this.ingestionJob(tx, caller, policy, itemId);
        const [item] = await tx<Item[]>`select * from source_items where id=${itemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['deleted', 'retracted'].includes(item.state))
          return { state: item.state, invalidated: emptyInvalidation() };
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${itemId} and is_current`;
        let invalidated = emptyInvalidation();
        const retract = input.status === 'deleted' && manifest.onSourceDelete === 'retract';
        if (retract && current) {
          await tx`select id from records where id=${current.event_id} for update`;
          await markDeleted(tx, context, [current.event_id]);
          invalidated = await retractEventClaims(tx, context, [current.event_id]);
        }
        const state = retract
          ? 'retracted'
          : input.status === 'deleted'
            ? 'deleted'
            : 'unavailable';
        await tx`update source_items set state=${state},updated_at=clock_timestamp() where id=${itemId}`;
        return { state, invalidated };
      },
      {},
      { asPerson: false },
    );
  }
  private async normalize(
    tx: Tx,
    context: WriteContext,
    policy: SourcePolicy,
    input: SourceEventInput,
  ) {
    if (!policy.eventTypeIds.includes(input.event.type))
      throw forbidden('event type is outside the registered source binding');
    const object = context.schema.objectsByUniversalId.get(input.event.type);
    if (!object || object.hidden || !object.isEvent || object.state.status !== 'active')
      throw notFound('source event type');
    const fields: Record<string, unknown> = {},
      canonicalFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.event.fields)) {
      const field = object.activeFields.find((f) => f.key === key);
      if (!field || field.coreRole || field.settings.isInverse)
        throw new AppError(
          422,
          'invalid_source_field',
          'source fields must use writable permanent field keys',
          { key },
        );
      const normalized = normalizeFieldValue(field, value);
      fields[field.name] = normalized;
      if (field.type === 'files') {
        const ids = (normalized ?? []) as string[];
        const rows = ids.length
          ? await tx<
              { id: string; metadata: unknown }[]
            >`select id,metadata from files where id=any(${ids}::uuid[]) and state='ready' and installation_id=${context.run?.installationId ?? null} and source_item_id=${input.sourceItemId}`
          : [];
        if (rows.length !== ids.length)
          throw new AppError(
            422,
            'invalid_files',
            'source files must be ready uploads bound to this source item',
          );
        canonicalFields[key] =
          normalized === null ? null : ids.map((id) => rows.find((r) => r.id === id)?.metadata);
      } else canonicalFields[key] = normalized;
    }
    const participants = [
      ...new Map(input.event.participants.map((p) => [p.email, p])).values(),
    ].sort((a, b) => a.email.localeCompare(b.email));
    const handles = participants.map((p) => ({ kind: 'email' as const, value: p.email }));
    const suppressed = await suppressedOf(tx, context.workspaceId, handles);
    if (handles.some((h) => isSuppressed(suppressed, h)))
      throw conflict('suppressed', 'a source participant was erased and cannot be stored again');
    const canonical = {
      type: input.event.type,
      occurredAt: new Date(input.event.occurredAt).toISOString(),
      title: input.event.title,
      summary: input.event.summary ?? '',
      fields: canonicalFields,
      participants,
      about: [...new Set(input.event.about)].sort(),
    };
    return { object, fields, participants, canonical, digest: requestHash(canonical) };
  }
  private async createParticipants(
    tx: Tx,
    context: WriteContext,
    manifest: ExtensionManifest,
    participants: SourceEventInput['event']['participants'],
    settings: Record<string, unknown>,
  ) {
    const requested = settings.createPeople ?? manifest.createPeople;
    const ranks = { never: 0, contacted_first: 1, everyone: 2 };
    if (
      typeof requested !== 'string' ||
      !(requested in ranks) ||
      ranks[requested as keyof typeof ranks] > ranks[manifest.createPeople]
    )
      throw forbidden('create-people setting exceeds the approved source policy');
    if (requested === 'never') return;
    const person = context.schema.objectsByUniversalId.get(BASE_OBJECT_IDS.person);
    const email = person?.activeFields.find((f) => f.type === 'emails' && f.isUnique);
    if (!person || !email)
      throw conflict('source_schema_changed', 'the base person email binding is unavailable');
    const name = person.activeFields.find((f) => f.type === 'full_name');
    for (const participant of participants) {
      if (requested === 'contacted_first' && !participant.contacted) continue;
      const [hit] =
        await tx`select 1 from record_identifiers where kind='email' and value=${participant.email} limit 1`;
      if (hit) continue; // Ambiguous and soft-deleted matches never cause another person to be created.
      const record = await insertRecord(tx, context, person);
      const writes = new Map([
        [email, normalizeFieldValue(email, { primary: participant.email, additional: [] })],
      ]);
      if (name && participant.name)
        writes.set(name, normalizeFieldValue(name, { first: participant.name, last: '' }));
      await writeFields(tx, context, person, record, writes);
    }
  }
  async sync(
    caller: Caller,
    id: string,
    raw: z.input<typeof sourceEventSchema>,
  ): Promise<SourceResult> {
    const run = this.runtime(caller, id),
      input = sourceEventSchema.parse(raw);
    return withWrite(
      this.sql,
      caller,
      async (tx, context) => {
        const binding = await this.binding(tx, caller),
          { manifest, policy, settings } = await this.release(tx, caller);
        const [job] =
          await tx`select function_id,source_item_id from extension_jobs where id=${run.jobId}`;
        if (
          !policy.syncFunctionIds.includes(job?.function_id) ||
          job?.source_item_id !== input.sourceItemId
        )
          throw forbidden("only this item's registered ingestion job may import its evidence");
        // The per-item row precedes any event/participant/claim record locks.
        const [item] = await tx<
          Item[]
        >`select * from source_items where id=${input.sourceItemId} for update`;
        if (!item) throw notFound('source item');
        await this.usable(tx, caller, binding, item);
        if (['retracted', 'deleted'].includes(item.state))
          throw conflict(
            'source_retracted',
            'retracted source identities cannot be silently recreated',
          );
        const normalized = await this.normalize(tx, context, policy, input);
        if (input.contentDigest && input.contentDigest !== normalized.digest)
          throw new AppError(
            422,
            'invalid_content_digest',
            'source content digest does not match canonical content',
          );
        const key = requestHash(
          input.providerRevision !== undefined
            ? { providerRevision: input.providerRevision }
            : { digest: normalized.digest, expected: input.expectedRevisionId },
        );
        const [receipt] = await tx<
          { content_digest: string; response: SourceResult }[]
        >`select content_digest,response from source_receipts where item_id=${item.id} and key=${key}`;
        if (receipt) {
          if (receipt.content_digest !== normalized.digest)
            throw conflict(
              'source_revision_conflict',
              'provider revision was already imported with different content',
            );
          return receipt.response;
        }
        const [current] = await tx<
          Revision[]
        >`select id,event_id,content_digest from source_revisions where item_id=${item.id} and is_current`;
        const order = compareRevision(
          policy.revisionOrder,
          input.providerRevision,
          item.provider_revision,
        );
        if (order !== null && order < 0 && current)
          return {
            sourceItemId: item.id,
            revisionId: current.id,
            eventId: current.event_id,
            created: false,
            unchanged: true,
            stale: true,
            contentDigest: current.content_digest,
            invalidated: emptyInvalidation(),
          };
        if ((current?.id ?? null) !== input.expectedRevisionId)
          throw conflict(
            'source_revision_conflict',
            'source changed; refetch provider state and current revision before retrying',
          );
        if (order === 0 && current && current.content_digest !== normalized.digest)
          throw conflict(
            'source_revision_conflict',
            'the same provider revision cannot contain different content',
          );
        let result: SourceResult;
        if (current?.content_digest === normalized.digest) {
          result = {
            sourceItemId: item.id,
            revisionId: current.id,
            eventId: current.event_id,
            created: false,
            unchanged: true,
            contentDigest: current.content_digest,
            invalidated: emptyInvalidation(),
          };
        } else {
          for (const participant of normalized.participants)
            await tx`select pg_advisory_xact_lock(21066::int4,hashtext(${JSON.stringify([caller.workspaceId, participant.email])}))`;
          // Writers cite source records before taking target locks. Block new citations before retracting old claims.
          if (current) await tx`select id from records where id=${current.event_id} for update`;
          await this.createParticipants(tx, context, manifest, normalized.participants, settings);
          const event = await logEvent(
            tx,
            { ...context, sourceItemId: item.id },
            {
              type: normalized.object.name,
              channel: `source:${manifest.universalId}`,
              occurredAt: input.event.occurredAt,
              title: input.event.title,
              ...(input.event.summary !== undefined ? { summary: input.event.summary } : {}),
              fields: normalized.fields,
              participants: normalized.participants.map((p) => ({ handle: p.email })),
              about: input.event.about,
            },
          );
          if (current)
            await tx`update source_revisions set is_current=false where id=${current.id}`;
          const [revision] = await tx<
            { id: string }[]
          >`insert into source_revisions(workspace_id,item_id,event_id,content_digest,provider_revision,previous_event_id)
          values(${caller.workspaceId},${item.id},${event.id},${normalized.digest},${input.providerRevision ?? null},${current?.event_id ?? null}) returning id`;
          if (!revision) throw new Error('source revision insert returned no row');
          const invalidated = current
            ? await retractEventClaims(tx, context, [current.event_id])
            : emptyInvalidation();
          result = {
            sourceItemId: item.id,
            revisionId: revision.id,
            eventId: event.id,
            created: true,
            unchanged: false,
            contentDigest: normalized.digest,
            ...(current ? { previousEventId: current.event_id } : {}),
            invalidated,
          };
        }
        await tx`update source_items set state='live',provider_revision=${input.providerRevision ?? item.provider_revision},updated_at=clock_timestamp() where id=${item.id}`;
        await tx`insert into source_receipts(workspace_id,item_id,key,content_digest,response) values(${caller.workspaceId},${item.id},${key},${normalized.digest},${tx.json(jsonValue(result))})`;
        return result;
      },
      {},
      { asPerson: false },
    );
  }
}
