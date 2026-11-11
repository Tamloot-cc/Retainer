import {
  decodeInvocation,
  type ExecutionResult,
  executionResultSchema,
  type Invocation,
} from '@retainer/extension';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { type ClaimedJob, ExtensionQueue } from '../extension-runtime/queue.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';

const executableSchema = z.strictObject({
  registrationId: z.uuid(),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  functionId: z.uuid(),
  handlerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeVersion: z.literal('node24'),
  driverTarget: z.string().regex(/^[a-zA-Z0-9_:/@.-]{1,500}$/),
});
export type Executable = z.infer<typeof executableSchema>;
export type ExecutionDriver = {
  /** Must launch a fresh isolated execution; target is from the release registry, never invocation JSON. */
  invoke: (
    executable: Executable,
    invocation: Invocation,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>;
};
export class ExecutionRegistry {
  private readonly entries = new Map<string, Executable>();
  constructor(entries: readonly Executable[]) {
    for (const entry of entries) {
      const value = executableSchema.parse(entry),
        key = `${value.registrationId}:${value.releaseDigest}:${value.functionId}`;
      if (this.entries.has(key)) throw new Error('duplicate executable registration');
      this.entries.set(key, structuredClone(value));
    }
  }
  lookup(registrationId: string, releaseDigest: string, functionId: string) {
    const value = this.entries.get(`${registrationId}:${releaseDigest}:${functionId}`);
    if (!value)
      throw new AppError(
        409,
        'incompatible_runtime',
        'no immutable executable is deployed for this release',
      );
    return structuredClone(value);
  }
  get(job: ClaimedJob) {
    return this.lookup(job.registrationId, job.releaseDigest, job.functionId);
  }
}

/** Trusted coordinator only. It holds no DB transaction while an execution is running. */
export class ExtensionExecutor {
  readonly queue: ExtensionQueue;
  private readonly active = new Set<AbortController>();
  private stopped = false;
  constructor(
    private readonly options: {
      sql: Sql;
      discoverySql: Sql;
      catalog: ExtensionCatalog;
      registry: ExecutionRegistry;
      tokens: RunTokens;
      driver: ExecutionDriver;
      apiOrigin: string;
      owner: string;
      concurrency?: number;
    },
  ) {
    const origin = new URL(options.apiOrigin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    )
      throw new Error('executor API origin must be an origin without credentials or path');
    if (!options.owner || options.owner.length > 200) throw new Error('invalid executor owner');
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw new Error('executor concurrency must be 1–32');
    this.queue = new ExtensionQueue(options.sql, options.catalog.runtime);
  }
  async execute(job: ClaimedJob) {
    if (job.system) return this.acknowledge(job, { status: 'succeeded' });
    const controller = new AbortController();
    this.active.add(controller);
    if (this.stopped) controller.abort();
    let heartbeat: ReturnType<typeof setInterval> | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined;
    let result: ExecutionResult;
    try {
      if (controller.signal.aborted) throw new Error('executor stopped');
      const executable = this.options.registry.get(job);
      const release = this.options.catalog
        .list()
        .find(
          (r) => r.digest === job.releaseDigest && r.manifest.universalId === job.registrationId,
        );
      const fn = release?.manifest.functions.find((f) => f.universalId === job.functionId);
      if (
        !release ||
        !fn ||
        release.manifest.packageDigest !== executable.packageDigest ||
        fn.handlerDigest !== executable.handlerDigest ||
        release.manifest.runtimeVersion !== executable.runtimeVersion
      )
        throw new AppError(
          409,
          'incompatible_runtime',
          'executable metadata differs from pinned release',
        );
      const runToken = await this.options.tokens.issue(
        this.options.sql,
        job,
        job.registrationId,
        job.scopes,
      );
      const invocation = decodeInvocation(
        JSON.stringify({
          protocolVersion: 1,
          runId: job.jobId,
          attempt: job.attempt,
          installationId: job.installationId,
          releaseDigest: job.releaseDigest,
          functionId: job.functionId,
          input: job.input,
          apiOrigin: new URL(this.options.apiOrigin).origin,
          runToken,
          deadline: job.deadline.toISOString(),
        }),
      );
      timeout = setTimeout(
        () => controller.abort(),
        Math.max(0, job.deadline.getTime() - Date.now()),
      );
      let renewing = false;
      heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void this.queue
          .renew(job)
          .catch(() => controller.abort())
          .finally(() => {
            renewing = false;
          });
      }, 20000);
      const stopped = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('execution stopped')), {
          once: true,
        }),
      );
      result = executionResultSchema.parse(
        await Promise.race([
          Promise.resolve().then(() =>
            this.options.driver.invoke(executable, invocation, controller.signal),
          ),
          stopped,
        ]),
      );
    } catch (error) {
      result =
        error instanceof AppError && error.code === 'incompatible_runtime'
          ? { status: 'failed', code: 'incompatible_runtime' }
          : {
              status: 'retry',
              code: controller.signal.aborted ? 'execution_timeout' : 'execution_unavailable',
            };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      controller.abort();
      this.active.delete(controller);
    }
    return this.acknowledge(job, result);
  }
  private async acknowledge(job: ClaimedJob, result: ExecutionResult) {
    try {
      const completed = await this.queue.complete(job, result);
      if (completed.activated) await this.queue.scheduleTick(job.workspaceId, job.installationId);
      return result.status;
    } catch (error) {
      if (
        error instanceof AppError &&
        ['lease_expired', 'installation_disabled'].includes(error.code)
      )
        return 'fenced';
      // Persistence outage leaves the lease reclaimable; never pretend the acknowledgement succeeded.
      throw error;
    }
  }
  stop() {
    this.stopped = true;
    for (const controller of this.active) controller.abort();
  }
  async tick(limit = 1000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('executor pass limit must be 1–1000');
    if (this.stopped) return { executed: 0, fenced: 0 };
    await this.queue.maintain(this.options.discoverySql);
    const due = await this.queue.discover(this.options.discoverySql, limit);
    let next = 0,
      executed = 0,
      fenced = 0;
    let firstFailure: unknown;
    let hasFailure = false;
    const worker = async () => {
      for (;;) {
        if (this.stopped) return;
        const item = due[next++];
        if (!item) return;
        try {
          const job = await this.queue.claim(item.workspace_id, item.job_id, this.options.owner);
          if (!job) continue;
          const status = await this.execute(job);
          executed++;
          if (status === 'fenced') fenced++;
        } catch (error) {
          // Keep this worker draining peers; report an operational failure only after the pass.
          if (!hasFailure) firstFailure = error;
          hasFailure = true;
        }
      }
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(this.options.concurrency ?? 4, due.length) }, worker),
    );
    const failure = outcomes.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (hasFailure) throw firstFailure;
    return { executed, fenced };
  }
}
