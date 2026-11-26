#!/usr/bin/env node
// The agent container in Compose (docs/specs/agent.md §13): it starts as
// RETAINER_ROLE=agent without migrating or opening the owner's pool, holds no
// database credential but the mastra role's, answers its health check, and
// reaches the API with the runtime credential. Disposable project; never
// prints credentials. Needs the image built by scripts/test-docker.sh.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = process.cwd();
const project = `retainer-agent-${randomUUID().slice(0, 8)}`;
const temporary = mkdtempSync(resolve(tmpdir(), 'retainer-agent-compose-'));
const freePort = async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((r) => server.close(r));
  return address.port;
};
const port = await freePort();
const pgPort = await freePort();
const environment = {
  ...process.env,
  RETAINER_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  RETAINER_SUPPRESSION_KEY: randomBytes(32).toString('hex'),
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: '',
  RETAINER_AGENT_RUNTIME_SECRET: randomBytes(32).toString('hex'),
  RETAINER_MASTRA_PASSWORD: randomBytes(16).toString('hex'),
  // A key that reaches nothing: this test makes no model call.
  ANTHROPIC_API_KEY: 'sk-ant-compose-test',
};
const override = resolve(temporary, 'ports.yml');
writeFileSync(
  override,
  `services:\n  postgres:\n    ports: !override ["127.0.0.1:${pgPort}:5432"]\n  retainer:\n    image: retainer:agent-review\n    ports: !override ["127.0.0.1:${port}:8787"]\n  agent:\n    image: retainer:agent-review\n`,
  { mode: 0o600 },
);
const base = [
  'compose',
  '-p',
  project,
  '-f',
  resolve(root, 'docker/compose.yml'),
  '-f',
  resolve(root, 'docker/compose.agent.yml'),
  '-f',
  override,
];
const compose = async (...args) =>
  (
    await exec('docker', [...base, ...args], {
      cwd: root,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
/** Runs a small script inside the agent container; its stdout is JSON. */
const inAgent = async (script) =>
  JSON.parse(await compose('exec', '-T', 'agent', 'node', '--input-type=module', '-e', script));

try {
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180');

  // Its only database credential is the mastra role's.
  const env = await inAgent(
    `console.log(JSON.stringify({ keys: Object.keys(process.env), mastra: new URL(process.env.RETAINER_MASTRA_DATABASE_URL).username, role: process.env.RETAINER_ROLE }))`,
  );
  assert.equal(env.role, 'agent');
  assert.equal(env.mastra, 'retainer_mastra');
  assert.ok(!env.keys.includes('DATABASE_URL'), 'the agent has no DATABASE_URL');
  assert.ok(
    !env.keys.some((key) => /^RETAINER_(RUNTIME|CONTROL|OWNER)_DATABASE_URL$/.test(key)),
    'the agent has no other database login',
  );

  // It runs as PID 1 without the migration step.
  const cmdline = await compose('exec', '-T', 'agent', 'cat', '/proc/1/cmdline');
  assert.equal(cmdline.replaceAll('\0', ' ').trim(), 'node dist/index.js');

  // Health, and a stream request: the body is checked before any claim, and
  // a bad stream token is refused by the API through the runtime route.
  const answers = await inAgent(`
    const base = 'http://127.0.0.1:8788';
    const health = (await fetch(base + '/health')).status;
    const id = '${randomUUID()}';
    const post = (body, token) => fetch(base + '/chats/' + id + '/stream', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const bad = await post({ message: { parts: [{ type: 'text', text: 'hi' }] }, messages: [] }, 'x');
    const refused = await post({ message: { parts: [{ type: 'text', text: 'hi' }] } }, 'not-a-token');
    console.log(JSON.stringify({ health, bad: bad.status, refused: refused.status, code: (await refused.json()).code }));
  `);
  assert.equal(answers.health, 200);
  assert.equal(answers.bad, 400);
  // The API's claim route refuses a stream token it never minted.
  assert.equal(answers.refused, 401, `claim answered ${answers.refused}`);
  assert.notEqual(answers.code, 'agent_unavailable', 'the agent reached the API');

  // Its logs carry no credential.
  const logs = await compose('logs', '--no-color', 'agent');
  for (const secret of [
    environment.RETAINER_AGENT_RUNTIME_SECRET,
    environment.RETAINER_MASTRA_PASSWORD,
    environment.ANTHROPIC_API_KEY,
  ]) {
    assert.ok(!logs.includes(secret), 'a credential reached the agent logs');
  }
  console.log('Agent compose test passed.');
} finally {
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
