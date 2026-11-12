import { createHash, randomUUID } from 'node:crypto';
import {
  decodeVerification,
  type ExtensionManifest,
  MAX_WEBHOOK_BYTES,
  type VerificationResult,
  verificationResultSchema,
} from '@retainer/extension';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockForWrite, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitRun } from '../extension-runtime/admission.js';
import { releaseAvailability } from '../extension-runtime/availability.js';
import { lockExtension, lockQueue } from '../extension-runtime/locks.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import type { SecretBroker } from '../extension-runtime/secrets.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import { reserveSourceItem, type SourceIdentityBinding } from '../sources/reserve.js';
import type { ExecutionRegistry } from '../worker/extensions.js';
import type { VerificationDriver } from '../worker/verifier-driver.js';
import { IngressLimiter } from './limiter.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const name = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,99}$/);
export const prepareWebhookInput = z.strictObject({ route: name });
export const bindWebhookInput = z.strictObject({
  route: name,
  accountHint: z.string().min(1).max(500).optional(),
  subscriptionId: z.string().min(1).max(500).optional(),
});
type Candidate = {
  binding_id: string;
  workspace_id: string;
  installation_id: string;
  registration_id: string;
  generation: number;
  release_digest: string;
  version: string;
  source_account_id: string | null;
  state: string;
  binding_state: string;
};
type Hook = NonNullable<ExtensionManifest['webhooks']>[number];
export type HookTarget = {
  route: string;
  bindingId?: string;
  registrationId?: string;
  /** The caller's address as the edge saw it; only keys the in-memory limiter. */
  clientIp?: string | undefined;
};

async function rawBytes(request: Request) {
  if (request.signal.aborted)
    throw new AppError(408, 'request_timeout', 'webhook body was not received');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES)
    throw new AppError(413, 'payload_too_large', 'webhook body exceeds 256 KiB');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0,
    timedOut = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 10000);
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (timedOut || request.signal.aborted)
        throw new AppError(408, 'request_timeout', 'webhook body was not received');
      if (part.done) return Buffer.concat(chunks);
      bytes += part.value.byteLength;
      if (bytes > MAX_WEBHOOK_BYTES)
        throw new AppError(413, 'payload_too_large', 'webhook body exceeds 256 KiB');
      chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const rateLimited = () =>
  new AppError(429, 'rate_limited', 'webhook verification rate limit exceeded', {
    retryAfterSeconds: 60,
  });

/** Public ingress has no caller credential. All authority comes from one pinned candidate and verification. */
export class Webhooks {
  private readonly queue: ExtensionQueue;
  private readonly limiter: IngressLimiter;
  constructor(
    private readonly options: {
      sql: Sql;
      catalog: ExtensionCatalog;
      broker: SecretBroker;
      registry: ExecutionRegistry;
      driver: VerificationDriver;
      publicOrigin: string;
      rateLimit?: number;
      /** Release digests with a deployed executable; undefined when this process does not know. */
      activation?: ReadonlySet<string>;
    },
  ) {
    const origin = new URL(options.publicOrigin);
    if (
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('invalid webhook public origin');
    const limit = options.rateLimit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      throw new Error('invalid webhook rate limit');
    this.limiter = new IngressLimiter(limit);
    this.queue = new ExtensionQueue(
      options.sql,
      options.catalog.runtime,
      undefined,
      options.activation,
    );
  }
  private contract(candidate: Candidate, route: string) {
    const resolution = releaseAvailability(
      this.options.catalog.runtime,
      candidate,
      this.options.activation,
    );
    if (!resolution.available)
      throw new AppError(503, 'incompatible_runtime', 'webhook release is unavailable');
    const manifest = resolution.manifest;
    const hook = manifest.webhooks?.find((entry) => entry.route === route);
    if (!hook) throw new AppError(503, 'incompatible_runtime', 'webhook release is unavailable');
    const fn = manifest.functions.find((entry) => entry.universalId === hook.verifierFunctionId);
    const executable = this.options.registry.lookup(
      candidate.registration_id,
      candidate.release_digest,
      hook.verifierFunctionId,
    );
    if (
      !fn ||
      executable.handlerDigest !== fn.handlerDigest ||
      executable.packageDigest !== manifest.packageDigest ||
      executable.runtimeVersion !== manifest.runtimeVersion
    )
      throw new AppError(
        503,
        'incompatible_runtime',
        'webhook executable differs from pinned release',
      );
    return { hook, executable };
  }
  private address(bindingId: string, route: string) {
    return {
      bindingId,
      url: new URL(
        `/extensions/hooks/installations/${bindingId}/${route}`,
        this.options.publicOrigin,
      ).href,
    };
  }
  private async setup<T>(
    caller: Caller,
    id: string,
    route: string,
    operation: (tx: Tx, hook: Hook, run: NonNullable<Caller['run']>) => Promise<T>,
  ) {
    const run = caller.run;
    if (!run || run.installationId !== id)
      throw forbidden('only the registered setup run may configure a webhook');
    try {
      return await inWorkspace(this.options.sql, caller.workspaceId, async (tx) => {
        await lockSchemaShared(tx, caller.workspaceId);
        await admitRun(tx, caller.workspaceId, run, false, 'runtime');
        await lockQueue(tx, caller.workspaceId, id);
        const [installation] = await tx<
          { version: string }[]
        >`select version from extension_installations where id=${id}`;
        if (!installation) throw notFound('extension installation');
        const release = this.options.catalog.get(run.registrationId, installation.version),
          policy = release.manifest.source,
          hook = release.manifest.webhooks?.find((entry) => entry.route === route);
        const [job] =
          await tx`select trigger_kind,function_id from extension_jobs where id=${run.jobId}`;
        if (
          release.digest !== run.releaseDigest ||
          !hook ||
          !policy ||
          job?.trigger_kind !== 'install' ||
          job.function_id !== policy.verifyFunctionId
        )
          throw forbidden('only the pinned source verifier may configure this route');
        return operation(tx, hook, run);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          409,
          'ambiguous_binding',
          'this provider account already has a route binding',
        );
      throw error;
    }
  }
  /** Reserve a durable callback before provider creation returns its connection proof/signing key. */
  async prepare(caller: Caller, id: string, raw: z.input<typeof prepareWebhookInput>) {
    const input = prepareWebhookInput.parse(raw);
    return this.setup(caller, id, input.route, async (tx, hook, run) => {
      const [existing] = await tx<
        { id: string; state: string }[]
      >`select id,state from webhook_bindings where installation_id=${id} and route=${input.route} and state<>'retired'`;
      if (existing) {
        // Never revive an active address across an explicit disconnect. That transition retires it.
        if (existing.state === 'pending')
          await tx`update webhook_bindings set generation=${run.generation},release_digest=${run.releaseDigest},secret_name=${hook.secretSetting},updated_at=clock_timestamp() where id=${existing.id}`;
        return this.address(existing.id, input.route);
      }
      const bindingId = randomUUID();
      await tx`insert into webhook_bindings(id,workspace_id,installation_id,registration_id,generation,release_digest,route,secret_name)
        values(${bindingId},${caller.workspaceId},${id},${run.registrationId},${run.generation},${run.releaseDigest},${input.route},${hook.secretSetting})`;
      return this.address(bindingId, input.route);
    });
  }
  async bind(caller: Caller, id: string, raw: z.input<typeof bindWebhookInput>) {
    const input = bindWebhookInput.parse(raw);
    return this.setup(caller, id, input.route, async (tx, hook, run) => {
      const [source] = await tx<
        { account_id: string; identity: string }[]
      >`select b.account_id,a.identity from source_bindings b join source_accounts a on a.id=b.account_id
        where b.installation_id=${id} and b.generation=${run.generation} and a.registration_id=${run.registrationId}`;
      if (!source)
        throw new AppError(
          409,
          'source_connection_required',
          'verify the source connection before binding its webhook',
        );
      if (
        (hook.accountHeader !== undefined) !== (input.accountHint !== undefined) ||
        (input.accountHint !== undefined && input.accountHint !== source.identity)
      )
        throw new AppError(
          422,
          'invalid_account_hint',
          'account locator must match the verified provider identity',
        );
      // A different account always gets a fresh opaque address. Old callbacks stay permanently retired.
      await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${id} and route=${input.route} and state='active' and source_account_id<>${source.account_id}`;
      const [existing] = await tx<
        { id: string }[]
      >`select id from webhook_bindings where installation_id=${id} and route=${input.route} and state<>'retired'`;
      const bindingId = existing?.id ?? randomUUID();
      if (existing)
        await tx`update webhook_bindings set state='active',source_account_id=${source.account_id},generation=${run.generation},release_digest=${run.releaseDigest},secret_name=${hook.secretSetting},account_hint_hash=${input.accountHint ? hash(input.accountHint) : null},subscription_id=coalesce(${input.subscriptionId ?? null},subscription_id),updated_at=clock_timestamp() where id=${bindingId}`;
      else
        await tx`insert into webhook_bindings(id,workspace_id,installation_id,registration_id,generation,release_digest,source_account_id,state,route,secret_name,account_hint_hash,subscription_id)
          values(${bindingId},${caller.workspaceId},${id},${run.registrationId},${run.generation},${run.releaseDigest},${source.account_id},'active',${input.route},${hook.secretSetting},${input.accountHint ? hash(input.accountHint) : null},${input.subscriptionId ?? null})`;
      return this.address(bindingId, input.route);
    });
  }
  /** Provider cleanup owns external deletion; this revokes only this installation's local route. */
  async retire(caller: Caller, id: string, raw: z.input<typeof prepareWebhookInput>) {
    const input = prepareWebhookInput.parse(raw);
    return this.setup(caller, id, input.route, async (tx) => {
      const retired =
        await tx`update webhook_bindings set state='retired',updated_at=clock_timestamp() where installation_id=${id} and route=${input.route} and state<>'retired' returning id`;
      return { retired: retired.length };
    });
  }
  async list(caller: Caller, id: string) {
    const run = caller.run;
    if (!run || run.installationId !== id) throw forbidden('live installation credential required');
    return inWorkspace(this.options.sql, caller.workspaceId, async (tx) => {
      await lockSchemaShared(tx, caller.workspaceId);
      await admitRun(tx, caller.workspaceId, run, false, 'runtime');
      const rows = await tx<
        {
          id: string;
          route: string;
          subscription_id: string | null;
          state: 'pending' | 'active' | 'retired';
        }[]
      >`select id,route,subscription_id,state from webhook_bindings where installation_id=${id} order by updated_at desc,id limit 100`;
      return {
        bindings: rows.map((row) => ({
          bindingId: row.id,
          route: row.route,
          subscriptionId: row.subscription_id,
          active: row.state === 'active',
          state: row.state,
          url: new URL(
            `/extensions/hooks/installations/${row.id}/${row.route}`,
            this.options.publicOrigin,
          ).href,
        })),
      };
    });
  }
  private validate(target: HookTarget) {
    if (
      !name.safeParse(target.route).success ||
      (target.bindingId === undefined) === (target.registrationId === undefined) ||
      !z.uuid().safeParse(target.bindingId ?? target.registrationId).success
    )
      throw notFound('webhook binding');
  }
  private async locate(target: HookTarget, headers: Headers) {
    this.validate(target);
    let hint: string | null = null;
    if (target.registrationId) {
      const hook = this.options.catalog
        .list()
        .find(
          (release) =>
            release.manifest.universalId === target.registrationId &&
            release.manifest.webhooks?.some((entry) => entry.route === target.route),
        )
        ?.manifest.webhooks?.find((entry) => entry.route === target.route);
      if (!hook?.accountHeader) throw notFound('webhook binding');
      const value = headers.get(hook.accountHeader);
      if (!value || value.length > 500) throw notFound('webhook binding');
      hint = hash(value);
    }
    const rows = await this.options.sql<
      Candidate[]
    >`select * from retainer_webhook_candidate(${target.bindingId ?? null}::uuid,${target.registrationId ?? null}::uuid,${target.route},${hint})`;
    if (rows.length !== 1 || !rows[0]) throw notFound('webhook binding');
    return rows[0];
  }
  /**
   * The durable per-callback budget counts failed verifications only, so a
   * provider's valid deliveries never use it up. It is read before the
   * verifier runs and written only after a rejection.
   */
  private async failureBudget(candidate: Candidate) {
    const limit = this.options.rateLimit ?? 100;
    const [row] = await inWorkspace(
      this.options.sql,
      candidate.workspace_id,
      (tx) => tx<{ count: number }[]>`select count from webhook_request_counts
        where binding_id=${candidate.binding_id} and window_start>=date_trunc('minute',clock_timestamp())`,
    );
    if (row && row.count >= limit) throw rateLimited();
  }
  private async recordFailure(candidate: Candidate) {
    await inWorkspace(this.options.sql, candidate.workspace_id, async (tx) => {
      await tx`insert into webhook_request_counts as c(workspace_id,binding_id,window_start,count)
        values(${candidate.workspace_id},${candidate.binding_id},date_trunc('minute',clock_timestamp()),1)
        on conflict(workspace_id,binding_id) do update set window_start=greatest(c.window_start,excluded.window_start),count=case when c.window_start>=excluded.window_start then least(c.count+1,2147483647) else 1 end`;
    });
  }
  private async accept(
    tx: Tx,
    candidate: Candidate,
    hook: Hook,
    deliveryId: string,
    externalId: string,
    digest: string,
  ) {
    await lockForWrite(tx, candidate.workspace_id);
    await lockExtension(tx, candidate.workspace_id, candidate.registration_id, true);
    await lockQueue(tx, candidate.workspace_id, candidate.installation_id);
    const [binding] = await tx<
      SourceIdentityBinding[]
    >`select a.id as account_id,a.registration_id,a.provider,a.namespace from webhook_bindings b
      join extension_installations i on i.id=b.installation_id and i.generation=b.generation and i.release_digest=b.release_digest and i.registration_id=b.registration_id and i.state='active'
      join source_bindings s on s.installation_id=i.id and s.generation=b.generation and s.account_id=b.source_account_id join source_accounts a on a.id=s.account_id
      join workspaces w on w.id=i.workspace_id and w.deletion_scheduled_at is null
      where b.id=${candidate.binding_id} and b.state='active' and b.generation=${candidate.generation} and b.release_digest=${candidate.release_digest} and b.source_account_id=${candidate.source_account_id} for share of b`;
    if (!binding)
      throw new AppError(410, 'binding_revoked', 'webhook binding was revoked or replaced');
    const deliveryHash = hash(deliveryId);
    const [receipt] = await tx<
      { body_digest: string }[]
    >`select body_digest from webhook_receipts where binding_id=${candidate.binding_id} and delivery_hash=${deliveryHash} and created_at>=clock_timestamp()-interval '7 days'`;
    if (receipt) {
      if (receipt.body_digest !== digest)
        throw new AppError(
          409,
          'delivery_conflict',
          'authenticated delivery identity was reused with another body',
        );
      return;
    }
    const item = await reserveSourceItem(tx, candidate.workspace_id, binding, externalId);
    if (['retracted', 'deleted'].includes(item.state))
      throw new AppError(410, 'source_deleted', 'this source was deleted and cannot be reimported');
    const job = await this.queue.enqueueWebhook(
      tx,
      candidate.workspace_id,
      candidate.installation_id,
      candidate.generation,
      {
        functionId: hook.syncFunctionId,
        input: { sourceItemId: item.id },
        dedupeKey: `webhook:${candidate.binding_id}:${deliveryHash}`,
      },
    );
    await tx`delete from webhook_receipts where binding_id=${candidate.binding_id} and delivery_hash=${deliveryHash}`;
    await tx`insert into webhook_receipts(workspace_id,binding_id,delivery_hash,body_digest,source_item_id,job_id) values(${candidate.workspace_id},${candidate.binding_id},${deliveryHash},${digest},${item.id},${job.id})`;
  }
  async receive(
    target: HookTarget,
    request: Request,
  ): Promise<{ kind: 'accepted' } | { kind: 'challenge'; body: string }> {
    // One source per callback; unknown addresses share one source.
    const source = `${target.clientIp ?? ''}|${target.bindingId ?? target.registrationId}|${target.route}`;
    let admitted = false,
      failed = false;
    try {
      this.validate(target);
      if (!this.limiter.admit(source)) throw rateLimited();
      admitted = true;
      const candidate = await this.locate(target, request.headers),
        { hook, executable } = this.contract(candidate, target.route);
      await this.failureBudget(candidate);
      const headers: Record<string, string> = {};
      for (const key of hook.headers) {
        const value = request.headers.get(key);
        if (value !== null) headers[key] = value;
      }
      if (
        Object.values(headers).some((value) => value.length > 8192) ||
        Buffer.byteLength(JSON.stringify(headers)) > 32768
      )
        throw new AppError(
          400,
          'invalid_headers',
          'webhook verification headers exceed their limit',
        );
      const bytes = await rawBytes(request);
      const secret = await this.options.broker.readWebhook(
        candidate.workspace_id,
        candidate.binding_id,
        candidate.generation,
        candidate.release_digest,
      );
      const controller = new AbortController(),
        signal = AbortSignal.any([request.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), 5000);
      let stop = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new Error('verification cancelled'));
        signal.addEventListener('abort', stop, { once: true });
      });
      let result: VerificationResult;
      try {
        if (signal.aborted) throw new Error('verification cancelled');
        const invocation = decodeVerification(
          JSON.stringify({
            protocolVersion: 1,
            kind: 'webhook',
            verificationId: randomUUID(),
            releaseDigest: candidate.release_digest,
            functionId: hook.verifierFunctionId,
            rawBody: Buffer.from(bytes).toString('base64'),
            headers,
            secret: secret.value,
            deadline: new Date(Date.now() + 5000).toISOString(),
          }),
        );
        result = verificationResultSchema.parse(
          await Promise.race([this.options.driver.verify(executable, invocation, signal), aborted]),
        );
      } catch {
        throw new AppError(503, 'verifier_unavailable', 'webhook verification is unavailable');
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        controller.abort();
      }
      if (result.status === 'rejected') {
        failed = true;
        // The rejection stands even if the count cannot be stored.
        await this.recordFailure(candidate).catch(() => {});
        throw new AppError(401, 'invalid_signature', 'webhook signature is invalid');
      }
      if (result.status === 'challenge') {
        if (!hook.challenge)
          throw new AppError(503, 'invalid_verifier_result', 'webhook challenge is not registered');
        return { kind: 'challenge', body: result.body };
      }
      if (candidate.state !== 'active' || candidate.binding_state !== 'active')
        throw new AppError(503, 'setup_in_progress', 'webhook setup has not completed');
      await inWorkspace(this.options.sql, candidate.workspace_id, (tx) =>
        this.accept(tx, candidate, hook, result.deliveryId, result.externalId, hash(bytes)),
      );
      return { kind: 'accepted' };
    } catch (error) {
      if (!request.bodyUsed) await request.body?.cancel().catch(() => {});
      if (error instanceof AppError) throw error;
      // Never log raw provider bodies, verification material or database diagnostics at ingress.
      throw new AppError(503, 'webhook_unavailable', 'webhook acceptance is unavailable');
    } finally {
      if (admitted) this.limiter.settle(source, failed);
    }
  }
}
