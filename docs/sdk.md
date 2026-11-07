# TypeScript SDK

`@retainer/sdk` is a typed client for the [REST API](rest-api.md), one method
per route. It runs anywhere `fetch` does (Node 24+, browsers, edge runtimes)
and is MIT-licensed. Response and schema types come from `@retainer/shared`.

```sh
npm install @retainer/sdk
```

The package is not on npm until the first release is published; see
[Releasing](releasing.md).

## Create a client

```ts
import { RetainerClient } from '@retainer/sdk';

const retainer = new RetainerClient({
  baseUrl: 'https://retainer.example',
  apiKey: process.env.RETAINER_API_KEY,
});
```

| Option           | Purpose                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | The server's origin. Required.                                                                                  |
| `apiKey`         | Sent as `Authorization: Bearer <key>`.                                                                          |
| `fetch`          | A custom `fetch`, e.g. for proxies, retries or tests.                                                           |
| `credentials`    | Browser only: `'include'` to authenticate with the web session cookie instead of an API key.                    |
| `workspace`      | Accounts mode, with a session cookie: the workspace ID sent as `X-Retainer-Workspace`. Ignored with an API key. |
| `onUnauthorized` | Called on any 401, e.g. to send a browser back to sign-in.                                                      |

Like MCP, the key decides the workspace and the actor its writes are
attributed to.

## Write what happened

```ts
const acme = await retainer.createRecord('company', { values: { name: 'Acme' } });
const dana = await retainer.upsertRecord('person', {
  match: { emails: 'dana@acme.com' },
  ifMissing: 'create',
  values: { name: 'Dana Levi', emails: 'dana@acme.com' },
});

const call = await retainer.logEvent({
  type: 'conversation', // meetings, calls, emails and chats; see retainer.schema() for others
  channel: 'zoom', // the source system or account, part of the event's identity
  externalId: 'zoom-8812-3390',
  occurredAt: '2026-10-29T14:00:00+02:00',
  title: 'Acme renewal call',
  summary: 'Dana wants to move the renewal to Q1.',
  fields: { medium: 'call' }, // the event type's other fields, by name
  participants: [{ handle: 'dana@acme.com', role: 'customer' }],
  about: [acme.id], // the records it concerns: a company, project, deal or tasks
});

// Cite the call so the value carries its date and provenance.
const update = await retainer.patchRecord(dana.id, {
  values: { jobTitle: 'VP Operations' },
  source: call.id,
});
if (update.fields.jobTitle === 'pending_review') {
  // A person set this field; the new value waits for their review.
}

await retainer.remember(dana.id, {
  text: 'Legal review at Acme usually takes two weeks.',
  source: call.id,
  quote: 'legal usually needs two weeks with these',
});
```

## Read it back

```ts
const hits = await retainer.search({ query: '"renewal" Acme', limit: 10 });
// { records: [...], events: [...], facts: [...] }, each ranked on its own

const pack = await retainer.context(dana.id, { tokenBudget: 1500 });
// pack.record.fields, pack.openTasks, pack.facts, pack.recentEvents, pack.omitted

// How it got there: events, values asserted for its fields and facts, newest first.
const stageHistory = await retainer.timeline(deal.id, { fields: ['stage'], limit: 20 });
// stageHistory.items[0]: { kind: 'field_change', field, value, status, current, actor, source, at }
// next page: retainer.timeline(deal.id, { fields: ['stage'], cursor: stageHistory.nextCursor })

const page = await retainer.queryRecords('company', {
  filter: { updatedAt: { gte: '2026-10-01T00:00:00Z' } },
  sort: [{ field: 'updatedAt', direction: 'desc' }],
  limit: 50,
});
// page.records, page.nextCursor

// Events are records of event types: query a type, linked to a record.
const calls = await retainer.queryRecords('conversation', {
  linked: { record: acme.id },
  filter: { occurredAt: { gte: '2026-10-01T00:00:00Z' } },
  sort: [{ field: 'occurredAt', direction: 'desc' }],
});
// calls.records (each with .event: occurredAt, title, summary, participants, about)

// Events of every type at once, newest first; filter by type, channel and time.
const activity = await retainer.queryEvents({
  linked: { record: acme.id },
  filter: { type: { in: ['conversation', 'payment'] } },
  include: ['relationReferences'],
});
// activity.records[0].type: 'conversation'; .fields.medium: 'call'

// A record's event history, across types, with how each event is attached:
// directly, or rolled up from a record pointing at it (rollUpEvents).
const history = await retainer.recordEvents(acme.id, { limit: 20 });
// history.items[0].via: { kind: 'participant' } | { kind: 'about' } | { kind: 'field', field }
//   | { kind: 'rollup', field, record }
```

A filter maps field names to a value (equality) or to operators, and nests
with `and`, `or` and `not`: `{ or: [{ stage: 'won' }, { amount: { gte: 10000 } }] }`.
Operators are `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `contains` and
`isNull`, depending on the field type, and `containsAny`, `containsAll` and
`isEmpty` for a many-to-many relation (`filterOperatorsFor` in
`@retainer/shared`). Only fields with `isFilterable` in `retainer.schema()` can
be filtered or sorted; the error for any other field lists the allowed ones.

`search` takes Postgres `websearch_to_tsquery` syntax: quoted phrases, `OR`,
and `-word` to exclude. Each word also matches longer words that start with
it ("Dan" finds "Dana"), exact matches rank first, and accents are ignored.

## Comments

People write comments on any record, entity or event. Only a client whose key
has a `user` actor can add one; any other gets a 403 `RetainerApiError`. Agents
and integrations read them. A comment is never evidence, so nothing cites one.

```ts
const comment = await retainer.addComment(acme.id, { body: 'Loop in legal early.' }, retryKey);
const { items, total, nextCursor } = await retainer.listComments(acme.id);
await retainer.editComment(comment.id, { body: 'Loop in legal first.' }); // its author
await retainer.deleteComment(comment.id); // its author, or a user with admin
```

## Moving events to another type

`moveEvents` changes the type of logged events in place, keeping their IDs,
`channel` and `externalId`, participants, `about` records, and the claims and
facts that cite them. It needs a `user` key with the `admin` scope; with
`dryRun: true` it needs only `schema:write`, reports exactly what would
happen and changes nothing.

```ts
const plan = await retainer.moveEvents({
  from: 'meeting',
  to: 'conversation',
  defaults: { medium: 'meeting' }, // for moved events with no medium
  dryRun: true,
});
// plan.eventIds, plan.fields ([{ from, to, events }]), plan.defaults

await retainer.moveEvents({ from: 'meeting', to: 'conversation', defaults: { medium: 'meeting' } });
```

Without `events`, every live event of `from` moves, all or nothing; pass
`events: [id]` to move one. Fields map by name, and `fields: { agenda: 'topic' }`
maps one named differently. If the target has no field for some values, it
throws `unmapped_fields` with `details.fields` listing them; list a field in
`drop` to delete its values instead.

## Review, merge and forget

These need a key with a `user` actor.

```ts
const inbox = await retainer.review({ limit: 20 });
await retainer.decideAssertion(inbox.pendingAssertions[0].id, 'accept');

const [a, b] = inbox.mergeSuggestions[0].recordIds;
await retainer.mergeRecords(a, { recordId: b }, 'merge-' + b); // b now reads as a
await retainer.dismissMergeSuggestion(inbox.mergeSuggestions[1].id);

// Privacy request: irreversible, needs the admin scope.
const { counts, reviewCandidates } = await retainer.forget(personId);
```

## Errors

A failed request throws `RetainerApiError` with the HTTP `status`, a stable
`code` and optional `details`:

```ts
import { RetainerApiError } from '@retainer/sdk';

try {
  await retainer.patchRecord(id, { values, expectedUpdatedAt });
} catch (error) {
  if (error instanceof RetainerApiError && error.code === 'stale_write') {
    // Someone changed the record since you read it: re-read and retry.
  }
  throw error;
}
```

The client does not retry by itself. A workspace over its
[rate limit](rest-api.md#rate-limits) gets a 429 `rate_limited`, whose
`details.retryAfter` is the number of seconds to wait; a query stopped by the
server's statement timeout gets a 503 `timeout`.

## Idempotency and cancellation

`createRecord`, `remember` and `mergeRecords` take an optional idempotency key
as their last argument. A retry with the same key returns the original result;
reusing a key with a different payload fails. Read methods take an
`AbortSignal`, as their last argument or as `signal` in their options.
