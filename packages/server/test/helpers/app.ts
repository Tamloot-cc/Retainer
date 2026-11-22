import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Actor } from '@retainer/shared';
import { type AppDeps, createApp } from '../../src/api/app.js';
import { createApiKey } from '../../src/auth/keys.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import type { ApiKeyScope } from '../../src/db/schema.js';
import type { Workspace } from '../../src/db/workspaces.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import type { TestDatabase } from './db.js';

export type TestResponse<T = any> = {
  status: number;
  body: T;
  headers: Headers;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
  headers?: Record<string, string>;
};

/**
 * Builds the Hono app against a test database and calls it in-process, the
 * way layer 3 (API) tests use it. No port is opened. The app runs as the
 * runtime role, as in production, so RLS applies.
 */
export function startTestApp(db: TestDatabase, options: Omit<AppDeps, 'sql'> = {}) {
  const sql = db.connect({ role: RUNTIME_ROLE, max: 20 });
  const app = createApp({ sql, ...options });

  async function request<T = any>(
    path: string,
    options: RequestOptions = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await app.request(path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    } as TestResponse<T>;
  }

  /**
   * Creates a workspace (operator path) and one key per entry, e.g.
   * `{ agent: { actor: 'agent:bot', scopes: ['read', 'write'] } }`.
   */
  async function setupWorkspace<K extends string>(
    options: { name: string; template?: string | null },
    keys: Record<K, { actor: Actor; scopes: ApiKeyScope[] }>,
  ): Promise<{ workspace: Workspace; keys: Record<K, string> }> {
    const workspace = await createWorkspace(db.owner, {
      ...options,
      template: options.template === null ? undefined : (options.template ?? 'starter'),
    });
    const issued = {} as Record<K, string>;
    for (const [name, spec] of Object.entries(keys) as [
      K,
      { actor: Actor; scopes: ApiKeyScope[] },
    ][]) {
      issued[name] = (await createApiKey(db.owner, { workspace: workspace.id, name, ...spec })).key;
    }
    return { workspace, keys: issued };
  }

  /**
   * An MCP client connected to `/mcp` with `key`, speaking Streamable HTTP
   * to the in-process app. Close it with `client.close()`.
   */
  async function mcpClient(key: string): Promise<McpTestClient> {
    const client = new Client({ name: 'retainer-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://retainer.test/mcp'), {
      fetch: inProcessFetch,
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    return Object.assign(client, {
      call: <T = any>(name: string, args?: Record<string, unknown>) =>
        callTool<T>(client, name, args),
    });
  }

  /** A `fetch` that serves any URL from the in-process app, for clients under test. */
  function inProcessFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    return Promise.resolve(app.request(url.toString(), init));
  }

  return { app, sql, request, setupWorkspace, mcpClient, inProcessFetch };
}

/** Calls a tool and parses its JSON text, keeping `isError`. */
export async function callTool<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text?: string }[];
  const text = first?.type === 'text' ? (first.text ?? '') : '';
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { isError: result.isError === true, body, raw: result };
}

export type McpTestClient = Client & {
  call: <T = any>(
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ isError: boolean; body: T; raw: unknown }>;
};

export type TestApp = ReturnType<typeof startTestApp>;
