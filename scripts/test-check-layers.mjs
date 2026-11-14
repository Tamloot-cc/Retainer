// The layer check's model rule (docs/specs/extensions-model-calls.md 3.5):
// Retainer's core never calls a model, so a core module importing the model
// proxy fails `pnpm lint`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A fixture repository with the real layer table and the given server files. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'retainer-layers-'));
  try {
    copyFileSync(join(REPO, 'ARCHITECTURE.md'), join(root, 'ARCHITECTURE.md'));
    mkdirSync(join(root, 'packages/server/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/server/package.json'),
      JSON.stringify({ license: 'AGPL-3.0-only' }),
    );
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, 'packages/server/src', path)), { recursive: true });
      writeFileSync(join(root, 'packages/server/src', path), text);
    }
    return spawnSync(process.execPath, [join(REPO, 'scripts/check-layers.mjs')], {
      env: { ...process.env, RETAINER_LAYER_ROOT: root },
      encoding: 'utf8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const model = { 'model/proxy.ts': 'export const proxy = 1;\n' };

test('a core module importing the model proxy fails', () => {
  const result = check({
    ...model,
    'records/write.ts': "import { proxy } from '../model/proxy.js';\nexport const x = proxy;\n",
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /records\/write\.ts: only api, extension-control, operator, lambda may import model/,
  );
});

test('an interface module that is not allowed fails too', () => {
  const result = check({
    ...model,
    'mcp/tools.ts': "import { proxy } from '../model/proxy.js';\nexport const x = proxy;\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mcp\/tools\.ts: only api/);
});

test('the API and the Lambda entry points may import it', () => {
  const result = check({
    ...model,
    'api/app.ts': "import { proxy } from '../model/proxy.js';\nexport const x = proxy;\n",
    'lambda/model.ts': "import { proxy } from '../model/proxy.js';\nexport const y = proxy;\n",
  });
  assert.equal(result.status, 0, result.stderr);
});
