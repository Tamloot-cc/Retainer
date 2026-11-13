# PostHog extension v1

Status: proposal, 2026-11-13. Not implemented. Extends
[extensions.md](extensions.md) and runs on the
[hosted Lambda runtime](extensions-lambda.md).

## 1. Decision

Show product usage on people and companies, so an agent preparing a sales or
support conversation knows whether the account actually uses the product.
PostHog already holds that signal.

The extension is a **hosted first-party adapter that pulls aggregates from
PostHog's query API on a schedule**, the same pattern as Tamloot. It is
**read-only toward PostHog**: it never creates, edits or deletes anything in
PostHog, and its API key needs read scopes only. It writes to Retainer like any
other adapter, as assertions under the installation's actor.

It does **not** mirror PostHog events. A product sends thousands of events per
user, and copying them would bury the conversations that make up a record's
timeline. V1 brings in two things:

- **Usage fields** on people and companies: when they signed up and the week
  they were last active.
- **Milestones**: the first time a person does one of a few events the admin
  picks, such as `signed_up` or `upgraded`, logged once per person as an event.

For example, Dana from Acme signs up on 3 March and upgrades on 20 March.
After the next sync, Dana's record shows "Product signup: 2026-03-03" and
"Product last active: week of 2026-03-16", and Dana's timeline has two
milestone events. Acme's record shows the same usage fields for the whole
company, and both milestones appear in its one-hop rollup.

## 2. Scope

In v1:

- PostHog Cloud, US or EU region. One PostHog project per installation, one
  installation per workspace (extensions.md §5).
- A workspace connection with a personal API key. PostHog data belongs to the
  project, not to one member, so member connections (extensions-tamloot.md §2)
  are not needed.
- Usage fields on `person`, and on `company` when the project uses group
  analytics.
- Up to 10 milestone events.
- Matching to existing records only. The extension never creates people or
  companies (`createPeople: "never"`).

Deferred to §8: self-hosted PostHog, writing back to PostHog, cohorts, feature
flags, session replays, PostHog webhooks, and usage counts beyond the last
active week.

## 3. Install and settings

The admin enters these settings in **Extensions → PostHog**:

| Setting               | Level        | Notes                                                                                                          |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| Region                | installation | `us` or `eu`. Selects `https://us.posthog.com` or `https://eu.posthog.com`; no free-form host in v1.           |
| Project ID            | installation | The numeric PostHog project ID.                                                                                |
| Personal API key      | secret       | `secret: true`, `reconnect: true`. Scopes: `project:read`, `query:read`. Limit the key to this one project.    |
| Company group type    | installation | Optional. The PostHog group type that means "company", for example `company` or `organization`.                |
| Company domain source | installation | Required with a group type: the group key, or a named group property, that holds the company's website domain. |
| Milestone events      | installation | 0 to 10 PostHog event names. Exact names, no wildcards and no actions in v1.                                   |

The install preview shows what the admin approves: the contributed fields and
event type (§4), the `integration` actor, read-only access to PostHog, and
this consent line: "Product usage for people and companies already in this
workspace becomes visible to the whole workspace."

**Setup** (`install` trigger, read scope only):

1. `GET /api/projects/:id/` with the key. A 401 or 403 reports `reconnect`.
   A 404 reports a wrong project ID or region.
2. Bind the source account through `/source/verify` (extensions.md §10) as
   `posthog:<region>:<project id>`. The project ID is stable in PostHog and
   never a display name. Replacing the project needs disconnect and setup
   again, as for any source account.
3. If a company group type is set, read `GET /api/projects/:id/groups_types/`
   and check that it exists. A missing type fails setup with a clear message.
4. Check every milestone event name against the project's event definitions.
   An unknown name is a warning, not a failure, because the product may not
   send that event yet.
5. Enqueue the first `sync-usage` and a `sync-milestones` backfill.

Changing the settings goes through the same preview and approval. Changing the
milestone list advances the generation, and the next run backfills the new
events (§5).

## 4. What it writes

Contributed fields, tracked by universal ID (extensions.md §7):

| Object  | Field               | Type | Meaning                                                                      |
| ------- | ------------------- | ---- | ---------------------------------------------------------------------------- |
| person  | Product signup      | date | When PostHog first saw the person: the person's `created_at`.                |
| person  | Product last active | date | Monday (UTC) of the week of the person's latest event, accurate to the week. |
| company | Product signup      | date | When PostHog first saw the group: the group's `created_at`.                  |
| company | Product last active | date | Monday (UTC) of the week of the latest event of any member of the group.     |

**Why a week, not a timestamp.** A daily-precise value would change every day
for every active person, adding an assertion each day and filling the history.
The week changes at most once a week, so a busy person costs about 52
assertions a year. Agents get a recent enough signal: "active this week" or
"last active three months ago". The field label says "week of" in the UI.

Rejected: an `active`/`idle`/`dormant` status. It goes stale silently for a
person who stops using the product, because no event arrives to change it.
A date lets the reader compute recency at read time.

Contributed event type `productMilestone`, with one field: `eventName` (text).
Each milestone is one event:

- source item: `(registration, posthog:<region>:<project>, <event uuid>)`,
  imported through `sync_source_event` with `expectedRevisionId: null`. A
  PostHog event never changes, so the import is create-only and a repeat is
  `unchanged`.
- `channel: "posthog"`, `externalId`: the PostHog event UUID.
- `occurredAt`: the event's timestamp; `title`: "Dana Cohen: upgraded";
  no summary.
- `participants`: the person's email. `about`: the matched company, if any.

The milestone is the **first** occurrence of that event for that person. Later
occurrences are ignored, so a weekly `report_viewed` cannot flood the
timeline. The admin should pick events that happen once or rarely.

Event properties (plan name, price, browser) are not copied in v1. They are
free-form per product, and mapping them is the company enrichment mapping
problem again (extensions-company-enrichment.md §3).

## 5. Sync

Two schedules, both reading PostHog with HogQL through
`POST /api/projects/:id/query/` and paging by a sort key, never by offset:

**`sync-usage`** (schedule, `0 3 * * *` UTC, once a day):

```sql
SELECT p.properties.email AS email,
       p.created_at       AS signup,
       toStartOfWeek(max(e.timestamp), 1) AS lastActiveWeek
FROM events e JOIN persons p ON e.person_id = p.id
WHERE e.timestamp >= now() - INTERVAL 8 DAY
  AND p.properties.email IS NOT NULL
  AND p.id > {cursor}
GROUP BY p.id, email, signup
ORDER BY p.id
LIMIT 1000
```

Only people active in the last 8 days are read: everyone else's last active
week has not changed. The 8-day window covers a missed daily run. After a
longer outage (the KV `lastUsageRun` is older than 8 days), the run widens the
window to cover the gap, up to the full project history.

For each row, the adapter upserts the person with `match: {emails: email}` and
`ifMissing: "fail"`. A `not_found` counts as unmatched, and an ambiguous email
is skipped (extensions-tamloot.md §3 matching rules). The same query grouped by
`$group_<index>` gives company rows. The adapter finds the company with
`query_records` on the primary domain: exactly one match is written, none or
several are counted and skipped.

**`sync-milestones`** (schedule, `15 * * * *`, hourly):

```sql
SELECT argMin(e.uuid, e.timestamp)      AS uuid,
       e.event,
       min(e.timestamp)                 AS at,
       any(p.properties.email)          AS email,
       any(p.properties.name)           AS name,
       any(e.$group_<index>)            AS groupKey
FROM events e JOIN persons p ON e.person_id = p.id
WHERE e.event IN {milestones}
GROUP BY e.person_id, e.event
HAVING at >= {since}
ORDER BY at, uuid
LIMIT 1000
```

`since` is a KV checkpoint saved with the child jobs, as in Tamloot's poll
(extensions-tamloot.md §3). The query subtracts a 2-hour overlap, because
PostHog ingests events late, and the create-only import makes the overlap
safe. A backfill (first install or a newly added milestone event) runs the same
query with `since` at the project's start.

Each milestone row whose email matches exactly one person is imported. A
person without an email, or with an email that matches nobody, is skipped and
counted. If that person is added to Retainer later, the next backfill picks
the milestone up; v1 does not re-scan on its own (open question 2).

**Writes and limits.** Writes go through the normal budget, 60 a minute per
installation (extensions.md §9.2). A project with 5,000 people active in a week
costs at most about 5,000 writes on the day their week changes, about 85
minutes, and close to nothing on other days. This needs the unchanged-write
rule in §6.

**Errors.** 429 and 5xx retry with the platform's backoff and honor
`Retry-After`. A 401 or 403 marks the connection `reconnect`. A query timeout
halves the page size once, then fails the run with a visible diagnostic. The
query text, results and person properties never go into job payloads, logs or
diagnostics: job inputs are cursors only.

## 6. Retainer prerequisites

1. **Unchanged writes are free.** An upsert whose value equals the actor's own
   current claim for that field must write no new assertion. This needs a
   check and a test. If it does not hold today, the adapter reads the current
   value first and skips equal ones, which costs one read per row.
2. **Contributed event types.** Contributing `productMilestone` and importing
   into it through `sync_source_event` needs an end-to-end test, like the
   field contributions in extensions-tamloot.md §4.
3. **Egress.** Add `us.posthog.com` and `eu.posthog.com` to the reviewed
   release's allowed hosts for the hosted runner.
4. The adapter bundle in `packages/runner`, a catalog entry, and acceptance
   tests against a recorded PostHog fixture: setup with good and bad keys,
   usage paging, a missed day, milestone backfill, late events in the overlap,
   unmatched and ambiguous emails, a company with no unique domain match, 429
   handling, disconnect.

`sync_source_event` (extensions.md §10) is already required by Tamloot.
Member connections, files, webhooks and the change feed are not needed.

## 7. Uninstall and erasure

Uninstall keeps the written fields, events and their provenance, as for every
extension. Nothing needs cleaning up in PostHog. Erasing a person in Retainer
suppresses their email (extensions.md §11), so a later sync cannot write them
back. Deleting a person in PostHog does not remove anything from Retainer in
v1; the values stay as the last known state.

## 8. Later

- Self-hosted PostHog with an admin-supplied host, after the egress review
  for customer hosts.
- More usage numbers, such as active days in the last 30, written in bands so
  they change rarely.
- Selected event properties on milestones, using the enrichment mapping flow.
- PostHog actions and cohorts as milestone sources.
- Sending CRM fields to PostHog as person properties. That is a write
  extension with its own review.

## 9. Open questions

1. **Person identity.** v1 matches by the `email` person property only. Some
   products store it under another name. Should the email property name be a
   setting, as the company domain source is?
2. **People added later.** A person created in Retainer after their milestone
   was skipped stays without it until a backfill. Should a weekly backfill run,
   or should a new person trigger a one-person lookup?
3. **Rank.** Usage values are written as `integration`, so an agent's
   different value goes to review. That fits measured data, but confirm the
   fields should not stay `agent`-ranked like enrichment.
