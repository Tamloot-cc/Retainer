import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  apiSchemasFile,
  buildApiSchemas,
  buildRequestSchemas,
  requestValidators,
} from './openapi-schemas.js';

type PublicContract = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId: string;
        requestBody?: { content: { 'application/json': { schema: unknown; example?: unknown } } };
      }
    >
  >;
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};

const contractUrl = new URL('../../../../apps/docs/lib/rest-contract.ts', import.meta.url).href;

test('the docs schema snapshot matches the server contracts', () => {
  expect(
    JSON.parse(readFileSync(apiSchemasFile, 'utf8')),
    'Regenerate the API schema snapshot using the command in apps/docs/README.md.',
  ).toEqual(buildApiSchemas());
});

test('the reference uses the generated request schemas and sends valid examples', async () => {
  const { contract } = (await import(/* @vite-ignore */ contractUrl)) as {
    contract: PublicContract;
  };
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
  const { contract } = (await import(/* @vite-ignore */ contractUrl)) as {
    contract: PublicContract;
  };
  expect(contract.components.schemas.SavedView?.properties.position).toEqual({ type: 'number' });
});
