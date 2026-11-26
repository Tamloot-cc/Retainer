import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

test('Retainer Docs serves read-only MCP tools over Streamable HTTP', {
  timeout: 30_000,
}, async (t) => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('next/dist/bin/next')),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { env: { ...process.env, RETAINER_DOCS_RUNTIME: 'server' }, stdio: 'inherit' },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  let ready = false;
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
    const response = await fetch(`${origin}/docs/`).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, 'the production docs server starts');

  const client = new Client({ name: 'retainer-docs-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp/', origin)));
  assert.equal(client.getServerVersion()?.name, 'retainer-docs');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ['get_page', 'list_pages', 'search']);

  const pages = await client.callTool({ name: 'list_pages', arguments: {} });
  assert.ok(pages.content[0].text.includes('[Connect through MCP](/docs/mcp)'));
  for (const url of [
    '/docs/mcp/',
    '/llms.mdx/docs/mcp.md',
    `${origin}/docs/mcp/#confirm-it-works`,
  ]) {
    const page = await client.callTool({ name: 'get_page', arguments: { url } });
    assert.ok(!page.isError, `could not read ${url}`);
    assert.match(page.content[0].text, /# Connect through MCP/);
  }
  const search = await client.callTool({ name: 'search', arguments: { query: 'GET /v1/me' } });
  assert.equal(JSON.parse(search.content[0].text)[0]?.url, '/docs/api/workspace/get-caller');
});
