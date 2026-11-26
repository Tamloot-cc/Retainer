import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { staticClient } from 'fumadocs-core/search/client/orama-static';

test('the static export uses the docs origin for social images and Markdown', async () => {
  const origin = process.env.RETAINER_DOCS_ORIGIN ?? 'http://localhost:3000';
  for (const slug of ['hosted', 'api/workspace/get-caller']) {
    const html = await readFile(`out/docs/${slug}/index.html`, 'utf8');
    const image = `/og/docs/${slug}/image.png`;
    assert.ok(html.includes(`property="og:image" content="${new URL(image, origin)}"`), slug);
    const markdown = new URL(`/llms.mdx/docs/${slug}.md`, origin);
    assert.ok(html.includes(`type="text/markdown" href="${markdown}"`), slug);
    const png = await readFile(`out${image}`);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

test('the exported index finds onboarding and exact endpoints and supports section filters', async () => {
  const data = await readFile('out/search-index.json');
  const from = `data:application/json;base64,${data.toString('base64')}`;
  const all = staticClient({ from });
  assert.equal((await all.search('self host'))[0]?.url, '/docs/self-hosted');
  assert.equal((await all.search('GET /v1/me'))[0]?.url, '/docs/api/workspace/get-caller');

  const mcp = staticClient({ from, tag: 'mcp' });
  const hits = await mcp.search('describe_schema');
  assert.equal(hits[0]?.url, '/docs/mcp/tool-reference');
  assert.ok(hits.every(({ url }) => url === '/docs/mcp' || url.startsWith('/docs/mcp/')));
});

test('the cross-type event query exports its shared sort fields and event records', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const query = contract.paths['/v1/events/query'].post;
  const { schemas } = contract.components;
  const request = query.requestBody.content['application/json'].schema;
  assert.deepEqual(request.properties.sort.items.properties.field.enum, [
    'occurredAt',
    'channel',
    'externalId',
    'id',
    'createdAt',
    'updatedAt',
  ]);
  assert.equal(
    query.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/EventPage',
  );
  assert.equal(schemas.EventPage.properties.records.items.$ref, '#/components/schemas/EventRecord');
  assert.ok(schemas.EventRecord.required.includes('type'));
  assert.ok(schemas.EventRecord.required.includes('event'));
  const queryObject = contract.paths['/v1/objects/{object}/query'].post;
  assert.deepEqual(queryObject.responses['200'].content['application/json'].schema.anyOf, [
    { $ref: '#/components/schemas/RecordPage' },
    { $ref: '#/components/schemas/EventPage' },
  ]);
  assert.match(queryObject.description, /POST \/v1\/events\/query/);
});

test('event claims require their historical fact status in the OpenAPI contract', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const claims = contract.paths['/v1/events/{id}/claims'].get;
  const { facts } = claims.responses['200'].content['application/json'].schema.properties;
  assert.equal(facts.items.$ref, '#/components/schemas/HistoricalFact');
  const status = contract.components.schemas.HistoricalFact.allOf.find((branch) =>
    branch.required?.includes('status'),
  );
  assert.ok(status, 'historical facts require status');
  assert.deepEqual(status.properties.status.enum, ['current', 'retracted', 'superseded', 'ended']);
});

test('file responses can extend the generated metadata schema with an ID and state', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  assert.notEqual(contract.components.schemas.FileMetadata.additionalProperties, false);
  for (const [path, method] of [
    ['/v1/files/{id}', 'get'],
    ['/v1/files/{id}/finalize', 'post'],
  ]) {
    const response = contract.paths[path][method].responses['200'].content['application/json'];
    assert.equal(response.schema.allOf[0].$ref, '#/components/schemas/FileMetadata');
    assert.ok(response.schema.allOf[1].required.includes('id'));
  }
});

test('the timeline and review queue export typed items', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const { TimelineItem, ReviewQueue, MergeSuggestion, UnresolvedParticipant } =
    contract.components.schemas;
  assert.deepEqual(
    TimelineItem.oneOf.map(({ properties, required }) => {
      assert.ok(required.includes('kind') && required.includes('at'));
      return properties.kind.const;
    }),
    ['event', 'field_change', 'fact'],
  );
  assert.equal(
    ReviewQueue.properties.mergeSuggestions.items.$ref,
    '#/components/schemas/MergeSuggestion',
  );
  assert.equal(
    ReviewQueue.properties.unresolvedParticipants.items.$ref,
    '#/components/schemas/UnresolvedParticipant',
  );
  assert.ok(MergeSuggestion.required.includes('id'));
  assert.ok(UnresolvedParticipant.required.includes('eventId'));
});

test('fact pages identify their target and record deletion requires the cascade IDs', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const { FactsPage, DeleteRecord } = contract.components.schemas;
  const [record, profile] = FactsPage.allOf[0].anyOf;
  assert.deepEqual(record.required, ['record']);
  assert.deepEqual(record.not.required, ['profile']);
  assert.deepEqual(profile.required, ['profile']);
  assert.deepEqual(profile.not.required, ['record']);
  assert.ok(DeleteRecord.required.includes('deletedRecordIds'));
});

test('clearing personal memory uses a signed-in session', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const operation = contract.paths['/v1/records/me/forget'].post;
  assert.deepEqual(operation.security, [{ secureSession: [] }, { localSession: [] }]);
  const webHeader = operation.parameters.find(({ name }) => name === 'X-Retainer-Client');
  assert.ok(webHeader?.required);
  assert.equal(webHeader.schema.const, 'web');
  const workspaceHeader = operation.parameters.find(({ name }) => name === 'X-Retainer-Workspace');
  assert.ok(workspaceHeader?.required);
  assert.equal(workspaceHeader.schema.format, 'uuid');
  assert.equal(
    operation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ClearPersonalMemory',
  );
});

test('event reads and schema history expose their concrete response shapes', async () => {
  const contract = JSON.parse(await readFile('out/openapi.json', 'utf8'));
  const eventRead = contract.paths['/v1/events/{id}'].get;
  assert.equal(
    eventRead.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/EventRead',
  );
  const schemas = contract.components.schemas;
  assert.ok(schemas.EventRead.required.includes('event'));
  const eventLink = contract.paths['/v1/events/{id}/links'].post;
  const linkSchema = eventLink.responses['200'].content['application/json'].schema;
  assert.deepEqual(linkSchema.allOf[0], { $ref: '#/components/schemas/EventRead' });
  assert.ok(linkSchema.allOf[1].required.includes('added'));
  for (const path of [
    '/v1/events/{id}/participants/{participantId}',
    '/v1/events/{id}/about/{recordId}',
  ]) {
    const unlink = contract.paths[path].delete;
    assert.equal(
      unlink.responses['200'].content['application/json'].schema.$ref,
      '#/components/schemas/EventRead',
    );
  }
  assert.equal(
    schemas.SchemaChange.properties.operations.items.$ref,
    '#/components/schemas/SchemaDiffOperation',
  );
  assert.equal(
    schemas.SchemaChange.properties.request.items.$ref,
    '#/components/schemas/SchemaOperation',
  );
});
