import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { loadDocsContract } from '../helpers/docs-contract.js';
import {
  apiSchemasFile,
  buildApiSchemas,
  buildRequestSchemas,
  requestValidators,
} from './openapi-schemas.js';

const db = useTestDatabase();

test('the docs schema snapshot matches the server contracts', () => {
  expect(
    JSON.parse(readFileSync(apiSchemasFile, 'utf8')),
    'Regenerate the API schema snapshot using the command in apps/docs/README.md.',
  ).toEqual(buildApiSchemas());
});

test('the reference uses the generated request schemas and sends valid examples', async () => {
  const contract = await loadDocsContract();
  const operations = Object.values(contract.paths).flatMap((methods) => Object.values(methods));
  const documented = operations.flatMap(({ operationId, requestBody }) =>
    requestBody ? [{ operationId, ...requestBody.content['application/json'] }] : [],
  );
  expect(documented.map(({ operationId }) => operationId).sort()).toEqual(
    Object.keys(requestValidators).sort(),
  );
  const generated = buildRequestSchemas();
  for (const { operationId, schema, example } of documented) {
    const id = operationId as keyof typeof requestValidators;
    expect(schema, operationId).toEqual(generated[id]);
    if (example !== undefined) {
      expect(requestValidators[id].safeParse(example).error?.issues, operationId).toBeUndefined();
    }
  }
});

test('saved views accept fractional positions in the public response schema', async () => {
  const contract = await loadDocsContract();
  expect(contract.components.schemas.SavedView?.properties.position).toEqual({ type: 'number' });
});

test('the documented methods, paths and scopes match the mounted workspace API', async () => {
  const contract = await loadDocsContract();
  const app = startTestApp(db);
  const { keys } = await app.setupWorkspace(
    { name: 'OpenAPI contract' },
    { restricted: { actor: { id: 'docs-contract', type: 'agent' }, scopes: [] } },
  );
  const mounted = new Set(
    app.app.routes.map(({ method, path }) => `${method} ${path.replace(/:\w+/g, '{}')}`),
  );
  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const route = `${method.toUpperCase()} ${path.replace(/\{\w+\}/g, '{}')}`;
      expect(mounted.has(route), route).toBe(true);
      const scope = operation['x-retainer-scope'];
      if (!scope) continue;
      const url = path.replace(/\{\w+\}/g, 'd2c0648c-2994-4f16-bdf1-a0136be6037d');
      const denied = await app.request(url, { key: keys.restricted, method: method.toUpperCase() });
      expect(denied, route).toMatchObject({
        status: 403,
        body: { error: { details: { required: scope } } },
      });
    }
  }
});
