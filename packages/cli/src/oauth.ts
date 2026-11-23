import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CliApprovalRequest } from '@retainer/sdk';
import {
  credentials,
  locked,
  loginFile,
  type Tokens,
  updateCredentials,
  writeJson,
} from './store.js';

const clientId = 'retainer-cli';
const ttl = 600_000;
const requestTimeout = () => AbortSignal.timeout(12_000);
export type LoginStatus = {
  server: string;
  expiresAt: string;
  status: 'pending' | 'done' | 'denied' | 'expired' | 'failed';
};
export type Discovery = { authorization: string; token: string; resource: string };
type Message = { approval: CliApprovalRequest } | { error: string };

export function serverOrigin(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Give an absolute URL with --server.');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
  )
    throw new Error('Use an HTTPS server URL, or HTTP on localhost.');
  return url.origin;
}

export async function discover(server: string): Promise<Discovery> {
  const resource = `${server}/cli`;
  const response = await fetch(`${server}/.well-known/oauth-protected-resource/cli`, {
    signal: requestTimeout(),
    redirect: 'error',
  });
  if (response.status === 404)
    throw new KeyMode('This server has no CLI login. On a server in key mode, use retainer-ops.');
  if (!response.ok)
    throw new Error('The server could not describe CLI login. Retry retainer login.');
  const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
  const issuer = `${server}/account/auth`;
  if (metadata.resource !== resource || !metadata.authorization_servers.includes(issuer))
    throw new Error('The server returned inconsistent CLI OAuth settings.');
  const OAuth = await fetch(`${server}/.well-known/oauth-authorization-server/account/auth`, {
    signal: requestTimeout(),
    redirect: 'error',
  });
  if (!OAuth.ok) throw new Error('The server could not describe its OAuth endpoints.');
  const info = (await OAuth.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  if (
    info.issuer !== issuer ||
    [info.authorization_endpoint, info.token_endpoint].some(
      (endpoint) => new URL(endpoint).origin !== server,
    )
  )
    throw new Error('The server returned OAuth endpoints on another origin.');
  return { authorization: info.authorization_endpoint, token: info.token_endpoint, resource };
}

async function tokens(discovery: Discovery, body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(discovery.token, {
    method: 'POST',
    body: new URLSearchParams({ ...body, client_id: clientId, resource: discovery.resource }),
    signal: requestTimeout(),
    redirect: 'error',
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) throw new LoginRequired();
    throw new Error('The Retainer token request failed. Retry the command.');
  }
  const parsed = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!parsed.access_token || !parsed.refresh_token || !(parsed.expires_in > 0))
    throw new Error('The server omitted the CLI tokens.');
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessExpiresAt: Date.now() + parsed.expires_in * 1000,
  };
}

export class KeyMode extends Error {}

export class LoginRequired extends Error {
  constructor() {
    super('Log in to this Retainer server first.');
  }
}

export async function getTokens(server: string): Promise<Tokens> {
  const saved = (await credentials()).servers[server];
  if (!saved) throw new LoginRequired();
  if (saved.accessExpiresAt > Date.now() + 30_000) return saved;
  return locked(server, () => refreshWhileLocked(server));
}

/** The caller already holds the per-server lock. */
export async function refreshWhileLocked(server: string): Promise<Tokens> {
  const current = (await credentials()).servers[server];
  if (!current) throw new LoginRequired();
  if (current.accessExpiresAt > Date.now() + 30_000) return current;
  const discovery = await discover(server);
  const updated = await tokens(discovery, {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  await updateCredentials((file) => {
    file.servers[server] = { ...file.servers[server], ...updated };
  });
  return updated;
}

function openBrowser(url: string) {
  let command = process.env.BROWSER;
  let args = [url];
  if (!command) {
    if (process.platform === 'darwin') command = 'open';
    else if (process.platform === 'win32') {
      command = 'rundll32.exe';
      args = ['url.dll,FileProtocolHandler', url];
    } else command = 'xdg-open';
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export async function login(server: string): Promise<CliApprovalRequest> {
  const discovered = await discover(server);
  const child = fork(
    fileURLToPath(import.meta.url),
    ['--listen', server, JSON.stringify(discovered)],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    },
  );
  const pending = await new Promise<CliApprovalRequest>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The login listener did not start.'));
    }, 5000);
    child.once('message', (message: Message) => {
      clearTimeout(timeout);
      child.disconnect();
      child.unref();
      if ('approval' in message) resolve(message.approval);
      else reject(new Error(message.error));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('The login listener ended before it was ready.'));
    });
  });
  openBrowser(pending.url);
  return pending;
}

async function listen(server: string, discovery: Discovery) {
  const id = crypto.randomUUID();
  const machine = Array.from(
    hostname()
      .replace(/\p{Cc}/gu, '')
      .trim() || 'this computer',
  )
    .slice(0, 80)
    .join('');
  const state = `${randomBytes(32).toString('base64url')}.${Buffer.from(machine).toString('base64url')}`;
  const verifier = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const status = (value: LoginStatus['status']) =>
    writeJson(loginFile(id), { server, expiresAt, status: value } satisfies LoginStatus);
  let finished = false;
  let redirect = '';
  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const denied = url.searchParams.get('error') === 'access_denied';
    if (
      request.method !== 'GET' ||
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state ||
      finished ||
      (!code && !denied)
    ) {
      response.writeHead(400).end('This is not the callback for this Retainer login.');
      return;
    }
    finished = true;
    clearTimeout(timer);
    try {
      if (denied) {
        await status('denied');
        response.end('Retainer CLI access was denied. You can close this tab.');
      } else {
        const grant = await tokens(discovery, {
          grant_type: 'authorization_code',
          code: code ?? '',
          code_verifier: verifier,
          redirect_uri: redirect,
        });
        await locked(server, () =>
          updateCredentials((file) => {
            file.servers[server] = { ...file.servers[server], ...grant };
            file.lastServer = server;
          }),
        );
        await status('done');
        response.end('Retainer CLI is connected. You can close this tab.');
      }
    } catch {
      await status('failed');
      response
        .writeHead(400)
        .end('Retainer CLI could not sign in. Return to the terminal and try again.');
    } finally {
      http.close();
    }
  });
  const timer = setTimeout(() => {
    finished = true;
    void status('expired')
      .finally(() => http.closeAllConnections())
      .finally(() => http.close());
  }, ttl);
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener address.');
  redirect = `http://127.0.0.1:${address.port}/callback`;
  const authorization = new URL(discovery.authorization);
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    resource: discovery.resource,
    scope: 'read offline_access',
    code_challenge_method: 'S256',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  await status('pending');
  process.send?.({ approval: { id, url: authorization.toString(), expiresAt } } satisfies Message);
}

if (process.argv[2] === '--listen' && process.send) {
  const [, , , server, discovery] = process.argv;
  if (!server || !discovery) process.exit(2);
  try {
    await listen(server, JSON.parse(discovery) as Discovery);
  } catch {
    process.send({ error: 'Could not start the Retainer login listener.' } satisfies Message, () =>
      process.exit(1),
    );
  }
}
