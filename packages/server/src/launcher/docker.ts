import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  decodeInvocation,
  decodeVerification,
  type ExecutionResult,
  executionResultSchema,
  type Invocation,
  type VerificationInvocation,
  type VerificationResult,
  verificationResultSchema,
} from '@retainer/extension';
import { z } from 'zod';

export const bundleSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  image: z.string().regex(/^(?:sha256:|[a-zA-Z0-9._:/-]+@sha256:)[a-f0-9]{64}$/),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  functionIds: z.array(z.uuid()).max(100),
  verifierFunctionIds: z.array(z.uuid()).max(100).default([]),
});
export type Bundle = z.infer<typeof bundleSchema>;

/** Only the trusted launcher can reach this Unix socket. No execution receives it. */
class DockerEngine {
  constructor(
    private readonly socketPath: string,
    private readonly version = 'v1.47',
  ) {}
  call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10000,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/${this.version}${path}`,
          method,
          headers: bytes
            ? { 'content-type': 'application/json', 'content-length': bytes.length }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) {
              res.destroy();
              reject(new Error('Docker response exceeds limit'));
            } else chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }),
          );
          res.on('error', () => reject(new Error('Docker response failed')));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy());
      req.on('error', () => reject(new Error('Docker request failed')));
      req.end(bytes);
    });
  }
  async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const result = await this.call(method, path, body, timeoutMs);
    if (result.status < 200 || result.status >= 300) throw new Error('Docker operation failed');
    try {
      return JSON.parse(result.body.toString()) as T;
    } catch {
      throw new Error('invalid Docker response');
    }
  }
  attach(id: string): Promise<{ socket: Duplex; output: Promise<Buffer> }> {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: `/${this.version}/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        method: 'POST',
        headers: { connection: 'Upgrade', upgrade: 'tcp' },
      });
      req.setTimeout(10000, () => req.destroy());
      req.on('error', () => reject(new Error('Docker attachment failed')));
      req.on('response', (res) => {
        res.resume();
        reject(new Error('Docker did not upgrade attachment'));
      });
      req.on('upgrade', (_res, socket, head) => {
        socket.setTimeout(0);
        let buffered = Buffer.alloc(0),
          outBytes = 0,
          errBytes = 0;
        const stdout: Buffer[] = [];
        const output = new Promise<Buffer>((complete, fail) => {
          const consume = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 8) {
              const stream = buffered[0],
                length = buffered.readUInt32BE(4);
              if (length > 65536) {
                socket.destroy();
                fail(new Error('execution frame exceeds limit'));
                return;
              }
              if (buffered.length < 8 + length) return;
              const bytes = buffered.subarray(8, 8 + length);
              buffered = buffered.subarray(8 + length);
              if (stream === 1) {
                outBytes += bytes.length;
                stdout.push(bytes);
              } else if (stream === 2) errBytes += bytes.length;
              else {
                socket.destroy();
                fail(new Error('invalid execution frame'));
                return;
              }
              if (outBytes > 65536 || errBytes > 65536) {
                socket.destroy();
                fail(new Error('execution output exceeds limit'));
                return;
              }
            }
          };
          socket.on('data', consume);
          socket.on('end', () =>
            buffered.length
              ? fail(new Error('incomplete execution frame'))
              : complete(Buffer.concat(stdout)),
          );
          socket.on('error', () => fail(new Error('execution stream failed')));
          if (head.length) consume(head);
        });
        resolve({ socket, output });
      });
      req.end();
    });
  }
}

export class DockerSandbox {
  private readonly engine: DockerEngine;
  private readonly bundles = new Map<string, Bundle>();
  private readonly active = new Set<string>();
  private slots = 0;
  private stopped = false;
  constructor(
    private readonly options: {
      socketPath: string;
      networkPrefix: string;
      apiContainer: string;
      proxyContainer: string;
      proxyOrigin: string;
      apiOrigin: string;
      bundles: readonly z.input<typeof bundleSchema>[];
    },
  ) {
    if (
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(options.networkPrefix) ||
      ['host', 'bridge', 'none'].includes(options.networkPrefix)
    )
      throw new Error('execution needs a dedicated network prefix');
    if (
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(options.proxyContainer) ||
      (options.apiContainer && !/^[a-zA-Z0-9_.-]{1,128}$/.test(options.apiContainer)) ||
      options.apiContainer === options.proxyContainer
    )
      throw new Error('launcher needs distinct fixed API and proxy containers');
    const proxy = new URL(options.proxyOrigin),
      api = new URL(options.apiOrigin);
    if (!options.apiContainer && api.protocol !== 'https:')
      throw new Error('a remote execution API requires HTTPS through the trusted proxy');
    if (
      proxy.protocol !== 'http:' ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== '/' ||
      proxy.search ||
      proxy.hash
    )
      throw new Error('invalid egress proxy origin');
    if (
      !['http:', 'https:'].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.pathname !== '/' ||
      api.search ||
      api.hash
    )
      throw new Error('invalid execution API origin');
    this.engine = new DockerEngine(options.socketPath);
    for (const input of options.bundles) {
      const bundle = bundleSchema.parse(input);
      if (this.bundles.has(bundle.id)) throw new Error('duplicate bundle');
      const ids = [...bundle.functionIds, ...bundle.verifierFunctionIds];
      if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error('duplicate or empty bundle functions');
      this.bundles.set(bundle.id, structuredClone(bundle));
    }
  }
  async health() {
    const engine = await this.engine.json<{ Version: string }>('GET', '/version');
    const major = Number(engine.Version?.split('.')[0]);
    if (!Number.isInteger(major) || major < 28)
      throw new Error('Docker 28 or later is required for isolated gateway networks');
    for (const container of [this.options.apiContainer, this.options.proxyContainer]) {
      if (!container) continue; // A remote HTTPS API is reached only through the trusted proxy.
      const info = await this.engine.json<{ State: { Running: boolean } }>(
        'GET',
        `/containers/${encodeURIComponent(container)}/json`,
      );
      if (!info.State.Running) throw new Error('trusted API/proxy container is not running');
    }
    for (const bundle of this.bundles.values()) await this.checkImage(bundle);
    return {
      status: 'ok',
      protocolVersion: 1,
      runtimeVersion: 'node24',
      bundles: this.bundles.size,
    };
  }
  private async checkImage(bundle: Bundle) {
    const image = await this.engine.json<{
      Config: { Labels?: Record<string, string>; Env?: string[] };
    }>('GET', `/images/${encodeURIComponent(bundle.image)}/json`);
    const labels = image.Config.Labels ?? {};
    if (
      labels['retainer.extension.protocol'] !== '1' ||
      labels['retainer.extension.runtime'] !== 'node24' ||
      labels['retainer.extension.release'] !== bundle.releaseDigest ||
      labels['retainer.extension.bundle'] !== bundle.id
    )
      throw new Error('runner image does not match registered release/protocol');
    if (
      image.Config.Env?.some((entry) =>
        /(TOKEN|SECRET|PASSWORD|DATABASE|AWS_ACCESS_KEY)/i.test(entry.split('=')[0] ?? ''),
      )
    )
      throw new Error('runner image contains forbidden credential environment');
  }
  async run(bundleId: string, input: Invocation, signal: AbortSignal): Promise<ExecutionResult> {
    const invocation = decodeInvocation(JSON.stringify(input));
    const origin = new URL(invocation.apiOrigin);
    if (
      origin.origin !== new URL(this.options.apiOrigin).origin ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('execution API origin differs from configuration');
    return executionResultSchema.parse(await this.launch(bundleId, invocation, signal, false));
  }
  async verify(
    bundleId: string,
    input: VerificationInvocation,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    return verificationResultSchema.parse(
      await this.launch(bundleId, decodeVerification(JSON.stringify(input)), signal, true),
    );
  }
  private async launch(
    bundleId: string,
    invocation: Invocation | VerificationInvocation,
    signal: AbortSignal,
    verifying: boolean,
  ) {
    const bundle = this.bundles.get(bundleId);
    if (
      !bundle ||
      bundle.releaseDigest !== invocation.releaseDigest ||
      !(verifying ? bundle.verifierFunctionIds : bundle.functionIds).includes(invocation.functionId)
    )
      throw new Error('unknown execution bundle');
    const deadline = new Date(invocation.deadline).getTime();
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0 || remaining > (verifying ? 5000 : 300000))
      throw new Error('invalid execution deadline');
    if (this.stopped || this.slots >= 32) throw new Error('launcher capacity unavailable');
    this.slots++;
    try {
      await this.health();
    } catch (error) {
      this.slots--;
      throw error;
    }
    const nonce = randomUUID(),
      name = `retainer-run-${nonce}`,
      networkName = `${this.options.networkPrefix}-${nonce}`;
    let network = verifying ? '' : networkName;
    let container = name,
      attachment: Duplex | undefined;
    const stop = () => {
      void this.engine.call('DELETE', `/containers/${container}?force=1`).catch(() => {});
    };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', stop, { once: true });
    this.active.add(name);
    try {
      if (!verifying) {
        const createdNetwork = await this.engine.json<{ Id: string }>('POST', '/networks/create', {
          Name: networkName,
          Driver: 'bridge',
          Internal: true,
          EnableIPv6: false,
          Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
          Labels: {
            'retainer.extension.run': '1',
            'retainer.extension.launcher': this.options.networkPrefix,
            'retainer.extension.expires': String(deadline),
          },
        });
        if (!/^[a-f0-9]{64}$/.test(createdNetwork.Id))
          throw new Error('invalid execution network ID');
        network = createdNetwork.Id;
        const inspected = await this.engine.json<{
          Internal: boolean;
          EnableIPv6: boolean;
          Options: Record<string, string>;
        }>('GET', `/networks/${network}`);
        if (
          !inspected.Internal ||
          inspected.EnableIPv6 ||
          inspected.Options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated'
        )
          throw new Error('execution network isolation is unavailable');
        for (const [container, origin] of [
          [this.options.apiContainer, this.options.apiOrigin],
          [this.options.proxyContainer, this.options.proxyOrigin],
        ]) {
          if (!container) continue;
          if (!origin) throw new Error('missing trusted endpoint');
          const connected = await this.engine.call('POST', `/networks/${network}/connect`, {
            Container: container,
            EndpointConfig: { Aliases: [new URL(origin).hostname] },
          });
          if (connected.status !== 200)
            throw new Error('failed to connect trusted execution endpoint');
        }
      }
      if (signal.aborted || Date.now() >= deadline)
        throw new Error('execution expired before launch');
      const created = await this.engine.json<{ Id: string }>(
        'POST',
        `/containers/create?name=${name}`,
        {
          Image: bundle.image,
          User: '65532:65532',
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          OpenStdin: true,
          StdinOnce: true,
          Tty: false,
          Env: verifying
            ? []
            : [
                `HTTP_PROXY=${this.options.proxyOrigin}`,
                `HTTPS_PROXY=${this.options.proxyOrigin}`,
                'NO_PROXY=',
                'NODE_USE_ENV_PROXY=1',
              ],
          Labels: {
            'retainer.extension.run': '1',
            'retainer.extension.launcher': this.options.networkPrefix,
            'retainer.extension.expires': String(deadline),
          },
          HostConfig: {
            NetworkMode: verifying ? 'none' : network,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: 64,
            Memory: 268435456,
            NanoCpus: 1000000000,
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
            LogConfig: { Type: 'none', Config: {} },
            Privileged: false,
          },
        },
      );
      if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new Error('invalid created container ID');
      container = created.Id;
      if (signal.aborted) throw new Error('execution aborted');
      const stream = await this.engine.attach(container);
      attachment = stream.socket;
      // Attach before start, so stdin cannot be lost and stdout cannot race collection.
      const started = await this.engine.call('POST', `/containers/${container}/start`);
      if (started.status !== 204) throw new Error('runner failed to start');
      stream.socket.end(JSON.stringify(invocation));
      const [output, exit] = await Promise.all([
        stream.output,
        this.engine.json<{ StatusCode: number }>(
          'POST',
          `/containers/${container}/wait?condition=not-running`,
          undefined,
          remaining + 5000,
        ),
      ]);
      if (exit.StatusCode !== 0) throw new Error('runner failed');
      try {
        return verifying
          ? verificationResultSchema.parse(JSON.parse(output.toString()))
          : executionResultSchema.parse(JSON.parse(output.toString()));
      } catch {
        throw new Error('invalid runner result');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      attachment?.destroy();
      await this.engine.call('DELETE', `/containers/${container}?force=1`).catch(() => {});
      if (network) await this.removeNetwork(network);
      this.active.delete(name);
      this.slots--;
    }
  }
  private async removeNetwork(network: string) {
    for (const container of [this.options.apiContainer, this.options.proxyContainer])
      await this.engine
        .call('POST', `/networks/${network}/disconnect`, { Container: container, Force: true })
        .catch(() => {});
    await this.engine.call('DELETE', `/networks/${network}`).catch(() => {});
  }

  async collectExpired() {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          'retainer.extension.run=1',
          `retainer.extension.launcher=${this.options.networkPrefix}`,
        ],
      }),
    );
    const rows = await this.engine.json<{ Id: string; Labels: Record<string, string> }[]>(
      'GET',
      `/containers/json?all=1&filters=${filters}`,
    );
    for (const row of rows) {
      const expires = Number(row.Labels['retainer.extension.expires']);
      if (Number.isFinite(expires) && expires <= Date.now() && /^[a-f0-9]{64}$/.test(row.Id))
        await this.engine.call('DELETE', `/containers/${row.Id}?force=1`);
    }
    const networks = await this.engine.json<{ Id: string; Labels: Record<string, string> }[]>(
      'GET',
      `/networks?filters=${filters}`,
    );
    for (const network of networks) {
      const expires = Number(network.Labels['retainer.extension.expires']);
      if (Number.isFinite(expires) && expires <= Date.now() && /^[a-f0-9]{64}$/.test(network.Id))
        await this.removeNetwork(network.Id);
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.all(
      [...this.active].map((name) =>
        this.engine.call('DELETE', `/containers/${name}?force=1`).catch(() => {}),
      ),
    );
  }
}
