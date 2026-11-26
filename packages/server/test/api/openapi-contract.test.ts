import { readFileSync } from 'node:fs';
import type { EventDetails, PresentedFact, SavedView } from '@retainer/shared';
import { expect, test } from 'vitest';
import { buildRequestSchemas, requestSchemasFile, requestValidators } from './openapi-requests.js';

type Fields<T> = Record<keyof T, true>;
const responseFields = {
  EventDetails: {
    about: true,
    channel: true,
    content: true,
    externalId: true,
    occurredAt: true,
    participants: true,
    source: true,
    summary: true,
    title: true,
  },
  Fact: {
    content: true,
    id: true,
    kind: true,
    profile: true,
    record: true,
    sources: true,
    status: true,
    validFrom: true,
    validTo: true,
    writtenBy: true,
  },
  SavedView: {
    columns: true,
    createdAt: true,
    createdBy: true,
    dateField: true,
    filter: true,
    groupAggregate: true,
    groupBy: true,
    hiddenGroups: true,
    id: true,
    issues: true,
    kind: true,
    name: true,
    object: true,
    position: true,
    sort: true,
    updatedAt: true,
    updatedBy: true,
    visibility: true,
  },
} satisfies {
  EventDetails: Fields<EventDetails>;
  Fact: Fields<PresentedFact>;
  SavedView: Fields<SavedView>;
};

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

test('the docs request schema snapshot matches the server validators', () => {
  expect(
    JSON.parse(readFileSync(requestSchemasFile, 'utf8')),
    'Regenerate the request schema snapshot using the command in apps/docs/README.md.',
  ).toEqual(buildRequestSchemas());
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

test('event details, facts and saved views document the public response fields', async () => {
  const { contract } = (await import(/* @vite-ignore */ contractUrl)) as {
    contract: PublicContract;
  };
  for (const [name, fields] of Object.entries(responseFields)) {
    expect(Object.keys(contract.components.schemas[name]?.properties ?? {}).sort(), name).toEqual(
      Object.keys(fields).sort(),
    );
  }
  expect(contract.components.schemas.SavedView?.properties.position).toEqual({ type: 'number' });
});
