import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contract } from './rest-contract.ts';

test('the public reference has unique operations and all required path parameters', () => {
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(contract.paths ?? {})) {
    for (const method of ['get', 'post', 'patch', 'delete'] as const) {
      const operation = pathItem?.[method];
      if (!operation) continue;

      assert.ok(operation.operationId);
      assert.ok(!operationIds.has(operation.operationId), operation.operationId);
      operationIds.add(operation.operationId);
      const parameters = operation.parameters?.flatMap((param) => {
        if ('$ref' in param || param.in !== 'path') return [];
        assert.equal(param.required, true);
        return [param.name];
      });
      assert.deepEqual(
        parameters,
        [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
      );
      assert.ok(Object.keys(operation.responses ?? {}).some((status) => status.startsWith('2')));
    }
  }
  for (const id of ['get-caller', 'get-schema', 'create-record', 'query-records', 'log-event']) {
    assert.ok(operationIds.has(id), id);
  }
});

test('local OpenAPI references resolve to published components', () => {
  for (const [, section, name] of JSON.stringify(contract).matchAll(
    /"#\/components\/(\w+)\/([\w-]+)"/g,
  )) {
    assert.ok(Object.hasOwn(contract.components ?? {}, section), section);
    const components = (contract.components as Record<string, Record<string, unknown>>)[section];
    assert.ok(Object.hasOwn(components, name), `${section}/${name}`);
  }
});
