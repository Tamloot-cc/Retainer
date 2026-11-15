import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type ExtensionManifest, functionSecrets } from '@retainer/extension';
import { z } from 'zod';
import { type Caller, canApproveDestructive } from '../caller.js';
import type { Sql } from '../db/client.js';
import { stampSchema } from '../db/pagination.js';
import {
  inWorkspace,
  lockForWrite,
  lockMemberShared,
  lockSchemaShared,
  type Tx,
} from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { disconnectConnection } from '../extension-runtime/connections.js';
import { isPartialReleaseJob, supersedePartialRelease } from '../extension-runtime/lifecycle.js';
import { lockExtension, lockQueue } from '../extension-runtime/locks.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import type { SecretBroker } from '../extension-runtime/secrets.js';
import { recheckPerson } from '../memory/profiles.js';
import type { ExtensionCatalog } from './catalog.js';
import { type ExtensionOAuthClients, oauthClientFor } from './oauth-clients.js';

export const connectionInputSchema = z.strictObject({
  settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()])),
  secretRefs: z.record(z.string(), z.uuid()).default({}),
  expectedGeneration: z.number().int().positive().optional(),
});
type Input = z.infer<typeof connectionInputSchema>;
const settingsSchema = connectionInputSchema.shape.settings;
export const authorizeInputSchema = z.strictObject({
  settings: settingsSchema,
  connectionId: z.uuid().optional(),
  expectedGeneration: z.number().int().positive().optional(),
  loginHint: z.email().max(254).optional(),
});
export const completeAuthorizationSchema = z
  .strictObject({
    state: z.string().min(1).max(512),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.error === undefined), {
    message: 'send exactly one of code and error',
  });
export const dismissNoticeSchema = z.strictObject({ at: z.string().max(200) });

/** How a connection holds its credential, fixed when it is created (spec 2). */
export type ConnectionCredential = 'key' | 'oauth';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const base64url = (bytes: Buffer) => bytes.toString('base64url');
const expired = () =>
  new AppError(409, 'authorization_expired', 'this connection request expired or was used');
/** `v1.<workspaceId>.<installationId>.<nonce>`; the IDs only route the callback (spec 4.4). */
function stateIds(state: string) {
  const parts = state.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return undefined;
  const ids = z.tuple([z.uuid(), z.uuid()]).safeParse([parts[1], parts[2]]);
  if (!ids.success || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? '')) return undefined;
  return { workspaceId: ids.data[0], installationId: ids.data[1] };
}

export function validateConnectionSettings(
  manifest: Pick<ExtensionManifest, 'settings'>,
  settings: Input['settings'],
) {
  if (Buffer.byteLength(JSON.stringify(settings)) > 65536)
    throw new AppError(413, 'quota_exceeded', 'connection settings exceed 64 KiB');
  for (const [key, value] of Object.entries(settings)) {
    const definition = manifest.settings[key];
    if (
      definition?.level !== 'connection' ||
      definition.secret ||
      typeof value !== definition.type ||
      (definition.options && !definition.options.includes(String(value)))
    )
      throw new AppError(
        422,
        'invalid_settings',
        'unknown, installation-level, secret or incorrectly typed connection setting',
        { key },
      );
  }
  for (const [key, definition] of Object.entries(manifest.settings))
    if (
      definition.level === 'connection' &&
      !definition.secret &&
      definition.required &&
      !Object.hasOwn(settings, key)
    )
      throw new AppError(422, 'invalid_settings', 'required connection setting missing', { key });
}
const ownerId = (caller: Caller) =>
  caller.person?.id ?? (caller.actor.type === 'user' ? caller.actor.id : null);
function human(caller: Caller) {
  if (caller.actor.type !== 'user' || caller.run || caller.installation)
    throw forbidden('only a person can manage a member connection');
}
async function membership(tx: Tx, caller: Caller) {
  if (caller.person) {
    await lockMemberShared(tx, caller.workspaceId, caller.person.id);
    await recheckPerson(tx, caller.workspaceId, caller.person);
  }
}

/** Human-owned credentials beneath an admin-approved installation. No owner is accepted in a payload. */
export class MemberConnections {
  constructor(
    private readonly sql: Sql,
    private readonly catalog: ExtensionCatalog,
    private readonly broker?: SecretBroker,
    private readonly oauthClients: ExtensionOAuthClients = new Map(),
  ) {}
  private oauthClient(manifest: ExtensionManifest) {
    return oauthClientFor(manifest, this.oauthClients, !!this.broker);
  }
  /**
   * Starts an OAuth handshake (spec 4.4). The verifier is staged in the broker
   * and never leaves the server; only the hash of the state is stored.
   */
  async authorize(caller: Caller, id: string, input: z.infer<typeof authorizeInputSchema>) {
    human(caller);
    const nonce = base64url(randomBytes(32)),
      verifier = base64url(randomBytes(32)),
      challenge = base64url(createHash('sha256').update(verifier).digest()),
      state = `v1.${caller.workspaceId}.${id}.${nonce}`;
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      const i = await this.installation(tx, caller, id);
      const manifest = this.catalog.get(i.registration_id, i.version).manifest;
      const client = this.oauthClient(manifest);
      if (!client || !manifest.oauth || !this.broker)
        throw new AppError(409, 'oauth_unavailable', 'this extension cannot connect with OAuth here');
      validateConnectionSettings(manifest, input.settings);
      const reconnect = input.connectionId !== undefined;
      if (reconnect) {
        const [prior] =
          await tx`select * from extension_connections where id=${input.connectionId ?? null} and installation_id=${id}`;
        if (!prior || prior.owner_id !== caller.actor.id || prior.state === 'disconnected')
          throw notFound('connection');
        if (prior.credential !== 'oauth')
          throw new AppError(409, 'credential_mismatch', 'this connection uses another method');
        if (input.expectedGeneration !== prior.generation)
          throw new AppError(409, 'stale_plan', 'connection generation changed');
        // A queued partial release job stays queued and is deferred while the
        // request is open; one that is running refuses the start (spec 4.7).
        const running = await tx<
          { trigger_kind: string; input: unknown }[]
        >`select trigger_kind,input from extension_jobs where connection_id=${prior.id} and status='running'`;
        if (running.some(isPartialReleaseJob))
          throw new AppError(
            409,
            'cleanup_running',
            'Retainer is finishing an earlier attempt; try again in a moment',
          );
      } else if (
        await tx`select 1 from extension_connections where installation_id=${id} and owner_id=${caller.actor.id} and state<>'disconnected'`.then(
          (rows) => rows.length > 0,
        )
      )
        throw new AppError(
          409,
          'connection_exists',
          'you already have a connection; reconnect or disconnect it',
        );
      const connectionId = input.connectionId ?? randomUUID();
      const staged = await (this.broker as SecretBroker).stage(caller, {
        registrationId: manifest.universalId,
        installationId: id,
        connectionId,
        name: manifest.oauth.verifierSetting,
        value: verifier,
      });
      await tx`delete from extension_authorizations where installation_id=${id} and owner_id=${caller.actor.id} and consumed_at is null`;
      await tx`delete from extension_authorizations where expires_at<clock_timestamp()-interval '1 hour'`;
      await tx`insert into extension_authorizations(workspace_id,installation_id,connection_id,owner_id,state_hash,verifier_ref,
        settings,reconnect,expected_generation,expires_at)
        values(${caller.workspaceId},${id},${connectionId},${caller.actor.id},${sha256(state)},${staged.pendingSecretId},
        ${tx.json(input.settings)},${reconnect},${input.expectedGeneration ?? null},${staged.expiresAt})`;
      const url = new URL(client.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', client.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (client.scope) url.searchParams.set('scope', client.scope);
      if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
      return { authorizationUrl: url.toString(), state, expiresAt: staged.expiresAt };
    });
  }
  /**
   * Finishes the round trip with the provider's code, or its refusal (spec
   * 4.5). Every failure answers the same `409 authorization_expired`.
   */
  async completeAuthorization(
    caller: Caller,
    id: string,
    input: z.infer<typeof completeAuthorizationSchema>,
  ): Promise<{ id: string; state: 'connecting' } | { cancelled: true }> {
    human(caller);
    const ids = stateIds(input.state);
    if (!ids || ids.workspaceId !== caller.workspaceId || ids.installationId !== id) throw expired();
    const hash = sha256(input.state);
    if (input.error !== undefined)
      return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
        await lockForWrite(tx, caller.workspaceId);
        await membership(tx, caller);
        await this.installation(tx, caller, id, false);
        const deleted =
          await tx`delete from extension_authorizations where workspace_id=${caller.workspaceId} and installation_id=${id}
          and state_hash=${hash} and owner_id=${caller.actor.id} and consumed_at is null and expires_at>clock_timestamp() returning id`;
        if (deleted.length !== 1) throw expired();
        return { cancelled: true as const };
      });
    const request = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await membership(tx, caller);
      const [row] = await tx<
        {
          id: string;
          connection_id: string;
          verifier_ref: string;
          settings: Input['settings'];
          reconnect: boolean;
          expected_generation: number | null;
        }[]
      >`select id,connection_id,verifier_ref,settings,reconnect,expected_generation from extension_authorizations
        where workspace_id=${caller.workspaceId} and installation_id=${id} and state_hash=${hash}
        and owner_id=${caller.actor.id} and consumed_at is null and expires_at>clock_timestamp()`;
      if (!row) throw expired();
      const [i] = await tx`select registration_id,version from extension_installations where id=${id}`;
      if (!i) throw expired();
      return { ...row, manifest: this.catalog.get(i.registration_id, i.version).manifest };
    });
    const oauth = request.manifest.oauth;
    if (!oauth || !this.broker) throw expired();
    const code = await this.broker.stage(caller, {
      registrationId: request.manifest.universalId,
      installationId: id,
      connectionId: request.connection_id,
      name: oauth.codeSetting,
      value: input.code as string,
    });
    return this.connect(
      caller,
      id,
      {
        settings: request.settings,
        secretRefs: {
          [oauth.verifierSetting]: request.verifier_ref,
          [oauth.codeSetting]: code.pendingSecretId,
        },
        ...(request.expected_generation !== null
          ? { expectedGeneration: request.expected_generation }
          : {}),
      },
      request.reconnect ? request.connection_id : undefined,
      { credential: 'oauth', authorizationId: request.id },
    );
  }
  /** Hides exactly the notice the member saw; `at` is the stored stamp, sent back unchanged (spec 4.7). */
  async dismissReleaseNotice(caller: Caller, id: string, cid: string, at: string) {
    human(caller);
    const changed = () =>
      new AppError(409, 'notice_changed', 'the notice changed; reload it before dismissing');
    if (!stampSchema.safeParse(at).success) throw changed();
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await membership(tx, caller);
      const [c] =
        await tx`select id,release_incomplete_at=${at}::timestamptz as matches from extension_connections
        where id=${cid} and installation_id=${id} and owner_id=${caller.actor.id} for update`;
      if (!c) throw notFound('connection');
      if (!c.matches) throw changed();
      await tx`update extension_connections set release_notice_dismissed_at=release_incomplete_at where id=${cid}`;
      return { dismissed: true as const };
    });
  }
  private async installation(tx: Tx, caller: Caller, id: string, active = true) {
    const [candidate] = await tx`select * from extension_installations where id=${id}`;
    if (!candidate) throw notFound('extension installation');
    await lockExtension(tx, caller.workspaceId, candidate.registration_id);
    await lockQueue(tx, caller.workspaceId, id);
    const [current] =
      await tx`select i.* from extension_installations i join workspaces w on w.id=i.workspace_id
      where i.id=${id} and w.deletion_scheduled_at is null`;
    if (!current) throw notFound('extension installation');
    if (active && current.state !== 'active')
      throw new AppError(409, 'installation_disabled', 'connect only to an active installation');
    return current;
  }
  async stage(
    caller: Caller,
    id: string,
    input: { connectionId?: string; name: string; value: string },
  ) {
    human(caller);
    const scope = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      const i = await this.installation(tx, caller, id);
      const manifest = this.catalog.get(i.registration_id, i.version).manifest;
      const definition = manifest.settings[input.name];
      if (
        manifest.connection !== 'member' ||
        definition?.level !== 'connection' ||
        !definition.secret ||
        definition.generated
      )
        throw new AppError(422, 'invalid_secret', 'setting is not a declared member credential');
      if (input.connectionId) {
        const [c] =
          await tx`select owner_id,state from extension_connections where id=${input.connectionId} and installation_id=${id}`;
        if (c && (c.owner_id !== caller.actor.id || c.state === 'disconnected'))
          throw notFound('connection');
      }
      return {
        registrationId: manifest.universalId,
        installationId: id,
        connectionId: input.connectionId ?? randomUUID(),
      };
    });
    if (!this.broker)
      throw new AppError(503, 'connection_required', 'secret broker is not configured');
    return this.broker.stage(caller, { ...scope, name: input.name, value: input.value });
  }
  async connect(
    caller: Caller,
    id: string,
    input: Input,
    reconnect?: string,
    method: { credential: ConnectionCredential; authorizationId?: string } = { credential: 'key' },
  ) {
    human(caller);
    const { credential } = method;
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      const i = await this.installation(tx, caller, id);
      // The request is consumed only while unexpired under the queue lock, which
      // `installation` holds: clock_timestamp, since a lock wait can cross the expiry.
      const [request] = method.authorizationId
        ? await tx<
            { created_at: Date }[]
          >`update extension_authorizations set consumed_at=clock_timestamp() where id=${method.authorizationId}
            and consumed_at is null and expires_at>clock_timestamp() returning created_at`
        : [];
      if (method.authorizationId && !request) throw expired();
      const manifest = this.catalog.get(i.registration_id, i.version).manifest;
      if (manifest.connection !== 'member')
        throw new AppError(
          422,
          'invalid_connection',
          'this installation connects at workspace level',
        );
      validateConnectionSettings(manifest, input.settings);
      const refs = Object.values(input.secretRefs);
      const pending = refs.length
        ? await tx`select * from retainer_member_pending_secrets(${refs}::uuid[],${caller.actor.id})`
        : [];
      if (pending.length !== refs.length)
        throw new AppError(
          409,
          'connection_required',
          'a member secret reference is invalid or expired',
        );
      const cid = reconnect ?? pending[0]?.connection_id ?? randomUUID();
      const [prior] =
        await tx`select * from extension_connections where id=${cid} and installation_id=${id}`;
      if (
        reconnect &&
        (!prior || prior.owner_id !== caller.actor.id || prior.state === 'disconnected')
      )
        throw notFound('connection');
      if (reconnect && input.expectedGeneration !== prior?.generation)
        throw new AppError(409, 'stale_plan', 'connection generation changed');
      if (reconnect && prior && prior.credential !== credential)
        throw new AppError(409, 'credential_mismatch', 'this connection uses another method');
      const oauth = manifest.oauth;
      const handshake = oauth ? [oauth.verifierSetting, oauth.codeSetting] : [];
      if (credential === 'oauth' && (!oauth || !method.authorizationId)) throw expired();
      if (credential === 'key' && oauth && this.oauthClient(manifest)?.keyFallback === false)
        throw new AppError(422, 'invalid_connection', 'this extension connects with OAuth only');
      if (
        !reconnect &&
        (await tx`select 1 from extension_connections where installation_id=${id} and owner_id=${caller.actor.id} and state<>'disconnected'`.then(
          (rows) => rows.length > 0,
        ))
      )
        throw new AppError(
          409,
          'connection_exists',
          'you already have a connection; reconnect or disconnect it',
        );
      for (const [name, ref] of Object.entries(input.secretRefs)) {
        const definition = manifest.settings[name];
        const row = pending.find((p) => p.id === ref);
        // Handshake material is generated, so only the server stages it (spec 4.2).
        const handshakeRef = credential === 'oauth' && handshake.includes(name);
        if (
          !definition?.secret ||
          (definition.generated && !handshakeRef) ||
          (credential === 'oauth' && name === oauth?.keySetting) ||
          definition.level !== 'connection' ||
          !row ||
          row.name !== name ||
          row.connection_id !== cid ||
          row.draft_installation_id !== id ||
          row.registration_id !== manifest.universalId
        )
          throw new AppError(
            422,
            'invalid_secret',
            'secret reference belongs to another connection or setting',
            { key: name },
          );
      }
      const [stored] = reconnect
        ? await tx`select retainer_connection_secret_names(${id}::uuid,${cid}::uuid) as names`
        : [];
      // With OAuth in the manifest the method decides which secrets a connection needs.
      const required = oauth
        ? credential === 'oauth'
          ? handshake
          : oauth.keySetting
            ? [oauth.keySetting]
            : []
        : Object.entries(manifest.settings)
            .filter(([, d]) => d.level === 'connection' && d.secret && d.required)
            .map(([name]) => name);
      if (oauth && credential === 'key' && !oauth.keySetting)
        throw new AppError(422, 'invalid_connection', 'this extension connects with OAuth only');
      for (const name of required)
        if (
          !input.secretRefs[name] &&
          (credential === 'oauth' || !stored?.names.includes(name))
        )
          throw new AppError(422, 'invalid_secret', 'required connection secret missing', {
            key: name,
          });
      const disconnectHook = manifest.functions.find((f) => f.trigger.kind === 'disconnect');
      const disconnect = disconnectHook?.universalId ?? null;
      const disconnectSecrets = disconnectHook ? functionSecrets(manifest, disconnectHook) : [];
      if (reconnect) {
        // The new connect gives the sessions up (spec 4.7, table).
        await supersedePartialRelease(tx, cid);
        await tx`update extension_attempts set status='cancelled',code='connection_reconnected',finished_at=clock_timestamp()
          where finished_at is null and job_id in(select id from extension_jobs where connection_id=${cid})`;
        await tx`update extension_jobs set status='cancelled',code='connection_reconnected',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
          where connection_id=${cid} and status in ('queued','running')`;
        await tx`delete from extension_schedules where connection_id=${cid}`;
        await tx`delete from source_sync_state where connection_id=${cid}`;
        await tx`update extension_connections set state='connecting',health='ok',last_error=null,generation=generation+1,settings_revision=settings_revision+1,
          owner=${tx.json(caller.actor)},settings=${tx.json(input.settings)},disconnect_function_id=${disconnect},
          disconnect_secrets=${disconnectSecrets}::text[],
          authorization_started_at=coalesce(${request?.created_at ?? null}::timestamptz,authorization_started_at) where id=${cid}`;
      } else {
        await tx`insert into extension_connections(id,workspace_id,installation_id,owner,owner_id,settings,disconnect_function_id,
          disconnect_secrets,credential,authorization_started_at)
          values(${cid},${caller.workspaceId},${id},${tx.json(caller.actor)},${caller.actor.id},${tx.json(input.settings)},${disconnect},
          ${disconnectSecrets}::text[],${credential},${request?.created_at ?? null})`;
      }
      for (const [name, ref] of Object.entries(input.secretRefs)) {
        const [adopted] =
          await tx`select retainer_adopt_member_secret(${ref}::uuid,${id}::uuid,${manifest.universalId}::uuid,${cid}::uuid,${caller.actor.id},${name}) as ok`;
        if (!adopted?.ok)
          throw new AppError(409, 'connection_required', 'member secret could not be adopted');
      }
      await new ExtensionQueue(this.sql, this.catalog.runtime).enqueueConnectionLifecycle(
        tx,
        caller.workspaceId,
        id,
        cid,
        reconnect ? i.version : null,
      );
      return { id: cid, state: 'connecting' as const };
    });
  }
  async disconnect(caller: Caller, id: string, cid: string) {
    human(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockForWrite(tx, caller.workspaceId);
      await membership(tx, caller);
      await this.installation(tx, caller, id, false);
      const [c] =
        await tx`select owner_id from extension_connections where id=${cid} and installation_id=${id}`;
      if (
        !c ||
        (c.owner_id !== caller.actor.id && !canApproveDestructive(caller.actor, caller.scopes))
      )
        throw notFound('connection');
      await disconnectConnection(tx, caller.workspaceId, cid);
      return { disconnected: true };
    });
  }
  async list(caller: Caller, id: string) {
    if (caller.run || caller.installation)
      throw forbidden('runtime credentials cannot list member connections');
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await membership(tx, caller);
      const [i] = await tx`select id from extension_installations where id=${id}`;
      if (!i) throw notFound('extension installation');
      const all = canApproveDestructive(caller.actor, caller.scopes);
      const rows =
        await tx`select c.*,retainer_connection_secret_names(c.installation_id,c.id) as secret_names,
        s.last_successful_scan_at,
        exists(select 1 from source_bindings b join source_items si on si.account_id=b.account_id and si.workspace_id=b.workspace_id
          where b.connection_id=c.id and b.installation_id=c.installation_id and si.state<>'reserved') as has_imported_items,
        (select count(*)::int from extension_jobs j where j.connection_id=c.id and j.connection_generation=c.generation and j.generation=i.generation and j.source_item_id is not null and j.status='failed') as failed_items
        from extension_connections c join extension_installations i on i.id=c.installation_id left join source_sync_state s on s.connection_id=c.id and s.installation_id=c.installation_id
        where c.installation_id=${id} ${all ? tx`` : tx`and c.owner_id=${ownerId(caller)}`} order by c.created_at,c.id`;
      return {
        connections: rows.map((c) => ({
          id: c.id,
          installationId: c.installation_id,
          owner: c.owner,
          state: c.state,
          health: c.health,
          lastError: c.last_error,
          generation: c.generation,
          settings: c.settings,
          settingsRevision: c.settings_revision,
          secrets: c.secret_names,
          createdAt: c.created_at.toISOString(),
          connectedAt: c.connected_at?.toISOString() ?? null,
          disconnectedAt: c.disconnected_at?.toISOString() ?? null,
          lastSuccessfulScanAt: c.last_successful_scan_at?.toISOString() ?? null,
          failedItems: c.failed_items,
          credential: c.credential,
          hasImportedItems: c.has_imported_items,
          releaseIncompleteAt: c.release_incomplete_at?.toISOString() ?? null,
        })),
      };
    });
  }
}
