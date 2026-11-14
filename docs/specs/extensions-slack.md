# Slack extension

Status: proposal, 2026-11-11. Not implemented. Extends
[extensions.md](extensions.md) and builds on the platform on
`feat/extensions`. Reference: Twenty's Slack app,
`packages/twenty-apps/public/slack` in the Twenty repo.

## 1. Decision

Slack is a **hosted first-party ingestion adapter**: it turns Slack threads in
channels the bot was invited to into `conversation` events. It is read-only. It
does not answer questions, post messages or unfurl links.

Twenty's Slack app is mainly a conversational assistant: an agent that reads and
writes the CRM from a mention. Retainer has no assistant of its own yet (a
workspace agent is planned, extensions-model-calls.md §11), so that part does
not carry over. Agents that want to talk in Slack use Retainer through
MCP from their own runtime.

Slack is also the second real adapter after Granola, and it exercises the paths
Granola barely uses: edits (`message_changed`), deletions (`message_deleted`),
a provider account identity (`team_id`), webhook challenges and high event
volume. Its acceptance tests (§7) double as platform tests.

**Bring your own Slack app in v1.** The workspace admin creates a Slack app
from a manifest shipped with the extension, installs it in their own Slack
workspace and pastes its bot token and signing secret into Retainer. Reasons:

- Hosted extensions cannot run provider OAuth. `oauthClientId` is allowed only
  for standalone apps.
- A Slack app has one Events API request URL. A single Retainer-owned app would
  receive every customer's events on one route and need to route by `team_id`,
  which is in the JSON body. `serverRoute` routes only by a header. With one
  Slack app per installation, each gets its own opaque callback, which the
  platform already supports.
- An app installed only in its own workspace is an internal app. Slack's 2025
  rate limits for non-Marketplace apps (one `conversations.history` call a
  minute, 15 messages per page) apply to commercially distributed apps, not
  internal ones.

A Retainer-owned, OAuth-installed Slack app is §6.

## 2. Connection

**Manifest.** `connection: 'workspace'`, `requestedActor: 'integration'`,
`scopes: ['read', 'write']`, `execution: 'hosted'`, `onSourceDelete: 'keep'`,
`createPeople: 'never'`.

**Settings.**

| Setting                | Type                                | Notes                                                                                                    |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `botToken`             | string, secret, required, reconnect | The `xoxb-` token from **OAuth & Permissions**.                                                          |
| `signingSecret`        | string, secret, reconnect           | From **Basic Information**. Required for the webhook; without it the extension only polls.               |
| `shareInvitedChannels` | boolean, consent, required          | "Everyone in this Retainer workspace can read the threads in every Slack channel the bot is invited to." |
| `createPeople`         | string, options                     | Platform default `never`.                                                                                |
| `backfillDays`         | number, default 30                  | Days of history to import on install, at most 90 (§5).                                                   |

**Slack app manifest.** Shipped as `artifacts/extensions/slack/slack-app-manifest.json`.
Bot scopes, all read-only:

| Scope                                | Used for                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| `channels:read`, `groups:read`       | List the channels the bot is a member of.                     |
| `channels:history`, `groups:history` | Read messages and threads in those channels.                  |
| `users:read`, `users:read.email`     | Resolve authors to names and emails for participant matching. |

Bot events: `message.channels`, `message.groups`. No `im:*` or `mpim:*`
scopes, so direct messages are never visible. The manifest leaves
`event_subscriptions.request_url` out; the admin adds it after install, because
Retainer issues the callback URL only then.

**Identity.** Account-scoped. The setup function calls `auth.test`, checks the
granted scopes in the `x-oauth-scopes` response header, and binds the source
account `T…` (team ID; `E…:T…` on Enterprise Grid) through `/source/verify`. A
token for a different Slack workspace needs a human disconnect and setup again,
like any account replacement (extensions.md §10).

**Privacy.** The bot reads only channels it is invited to. Inviting it is the
per-channel choice; `shareInvitedChannels` is the workspace-wide consent.
Removing the bot from a channel stops new imports and keeps what was imported.
Bot and app messages are imported as text but never become participants.

## 3. Adapter

**Unit: the thread.** A source item is one thread, external ID
`<channel ID>/<thread_ts>`. A top-level message without replies is a thread of
one. Reasons: a thread is what people think of as one conversation; an edit or
deletion anywhere in it becomes a new revision of one event; and the webhook
can name the item from any message event without a lookup. See open question 1
for chatty channels.

**Thread → `conversation` event**, imported through `sync_source_event`:

- `channel: "slack"`, `medium: "message"`, `externalId`: the item ID above.
- `occurredAt`: the parent message's `ts`. `title`: `#channel-name:` and the
  first line of the parent, cut at 80 characters.
- `summary`: the thread as Markdown, one line per message:
  `**Name** (HH:MM UTC): text`. User and channel mentions are replaced with
  names, and Slack markup (`<url|label>`, `*bold*`) becomes Markdown. Retainer
  writes no summary of its own. Over 32 KiB, the summary is cut with a note and
  the full thread goes into the `transcript` files field as `text/plain`.
- `participants`: the emails of the human authors (`users.info`), with names.
  Mentions are not participants.
- Contributed fields on `conversation`: `slackPermalink` (link) and
  `slackChannel` (text, filterable: the channel name at import time).
- `revisionOrder: 'opaque'`. Slack has no thread revision number. Every sync
  reads the whole current thread and imports it with `expectedRevisionId`;
  the server's content digest turns an unchanged thread into `unchanged`. A
  `409 source_revision_conflict` means: fetch again and retry.

**Functions.**

| Function       | Trigger                 | Does                                                                                                                                                                              |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`        | install                 | `auth.test`, scope check, bind the team, prepare the `events` callback, start the backfill scan.                                                                                  |
| `cleanup`      | uninstall               | Retire the callback. Nothing to clean up at Slack.                                                                                                                                |
| `verify-event` | route `events`, 5 s     | Check the signature and answer challenges (below).                                                                                                                                |
| `scan`         | job                     | Backfill: page `users.conversations` (bot's channels), then `conversations.history` from `now − backfillDays`; reserve items in batches of 30 and enqueue `sync-thread` for each. |
| `catch-up`     | schedule `*/15 * * * *` | Re-read the last 7 days of `conversations.history` per channel. Enqueue `sync-thread` for every parent whose `latest_reply` or `edited.ts` differs from the copy in KV.           |
| `sync-thread`  | job                     | `conversations.replies` for the thread, render, stage participants, upload the transcript if needed, import.                                                                      |

User lookups go into installation KV with a 24-hour expiry, so a busy channel
costs one `users.info` call per author a day.

**Webhook verifier.** One route, `events`, with headers
`x-slack-signature` and `x-slack-request-timestamp`, `challenge: true`,
`optional: true`.

- Signature: `v0=` + HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the
  signing secret, compared in constant time. A timestamp more than five minutes
  away is rejected.
- `type: url_verification`: return the `challenge` as `text/plain`. Slack sends
  this when the admin pastes the URL, so the callback must exist (pending) from
  `setup` on.
- `type: event_callback`: `deliveryId` = `event_id`; `externalId` =
  `<channel>/<thread_ts ?? ts>`. For `message_changed` the IDs come from
  `message`; for `message_deleted`, from `previous_message` or `deleted_ts`.
- Anything else is rejected. The Slack app subscribes only to message events,
  so this does not happen in normal operation (open question 3).

Slack retries a delivery that gets no 2xx within three seconds, and marks the
header `x-slack-retry-num`. Retries reuse `event_id`, so the receipt dedupe
answers 202 without a second job.

**Deletion.** A thread is `deleted` only on provider evidence: the
`message_deleted` event for the parent of a thread with no remaining replies.
The job then calls `/source-items/:item/unavailable` with
`evidence: 'provider_event'`. A failed lookup (`thread_not_found`) is reported
as `unavailable`, never as `deleted`, because Slack also hides messages for
plan limits and retention policies (§5). With `onSourceDelete: 'keep'` (the
default), the event stays. An admin can choose `retract`.

**Errors.** `invalid_auth`, `token_revoked` or `account_inactive` stop the run
and mark the connection `needs_reconnect`. `not_in_channel` skips the item.
`ratelimited` re-queues the job after `Retry-After`.

## 4. Retainer prerequisites

Already on `feat/extensions`: hosted functions, opaque webhook routes with
challenges, generated and admin-entered secrets, KV, source items and
revisions, `unavailable`/`deleted`, source scans, files, and egress to public
hosts. New work:

1. The adapter in `packages/runner` (`slack.ts`, `slack-provider.ts`) and its
   release bundle and catalog entry in `artifacts/extensions/slack`.
2. The settings page shows the callback URL after install, with a copy button
   and the "paste this into Slack → Event Subscriptions" step.
3. A fake Slack API for integration tests (§7), reached through the egress
   proxy's test exception list.

No platform change is needed for v1. §6 lists the ones the shared app needs.

## 5. A free Slack workspace

A free workspace covers everything in v1:

- Creating an app, installing it to its own workspace, bot tokens, the Events
  API and every scope in §2 are free.
- Free plans show 90 days of history, in the API too. That caps `backfillDays`
  at 90 and is why a missing thread is `unavailable`, not `deleted`. A message
  older than 90 days can disappear from the API without any Slack event.
- Free plans allow 10 apps or integrations.
- Slack Connect (channels shared with another company's Slack) needs a paid
  plan. The case it covers, customers as participants with external emails,
  cannot be tested on free; the fake API covers it.
- The Events API needs a public HTTPS URL. Local Compose needs a tunnel
  (`cloudflared tunnel --url http://localhost:<port>`). Hosted staging needs
  none.

**Manual end-to-end run.**

1. Create a free workspace with two accounts (two email addresses). Add one
   email to Retainer as a person.
2. Create the Slack app from the manifest, install it, and copy the bot token
   and signing secret.
3. Install the extension in Retainer, consent, paste both, and copy the
   callback URL into **Event Subscriptions**. Slack must show "Verified".
4. Invite the bot to `#test` and leave it out of `#private-test`.
5. Post a message, reply in a thread, edit a reply, delete a reply, delete a
   one-message thread, and mention a user. Post in `#private-test`.
6. Check: one event per thread; revisions for the edit and deletion; the
   one-message thread is `deleted` in history but kept; the known person is a
   participant and the other account is unmatched; nothing from
   `#private-test`.
7. Stop the tunnel, post and edit, start it again: `catch-up` brings the posts
   in within 15 minutes.
8. Revoke the token in Slack: the connection shows reconnect.

## 6. Later

- **A Retainer-owned Slack app with OAuth.** One app for all hosted customers,
  installed with "Add to Slack". Platform work: OAuth for hosted
  installations, and a `serverRoute` account locator read from a JSON body
  field (`team_id`) after signature verification, instead of a header.
- Direct messages and group DMs, with a per-member connection (the Tamloot
  spec's member connections) so only the member's own DMs are shared.
- Slack Connect: create people from external participants under
  `contacted_first`.
- Posting: an agent-triggered `post-message` function, for example a daily
  digest. It needs `chat:write` and a callable-function trigger, which v1 of
  the platform defers.
- Link previews for Retainer record URLs (`links:read`, `links:write`).

## 7. Tests

**Unit** (`packages/runner/src/slack.test.ts`):

- The verifier against Slack's published signature example; a stale
  timestamp; a modified body; a challenge; every message subtype's item ID.
- Rendering: mentions, links, edits, file shares, bot messages, the 32 KiB cut.

**Integration** (real Postgres, fake Slack API):

- Backfill of 3 channels with 200 threads: one event per thread, no
  duplicates across concurrent page jobs.
- The same `event_id` delivered twice at once: one job.
- Edit and catch-up racing on one thread: one new revision.
- Parent `message_deleted`: `deleted` with `provider_event`. A lookup returning
  `thread_not_found`: `unavailable` only.
- `ratelimited` with `Retry-After`; `token_revoked`; bot removed from a channel.
- Reconnect with a token for another team is refused without a disconnect.
- Uninstall during a backfill: no write commits after disable.

## 8. Open questions

1. **Chatty channels.** A channel used like a chat room produces one event per
   top-level message. Should unthreaded top-level messages be grouped into one
   event per channel per UTC day instead? It cuts noise but makes the item ID
   depend on a date and makes edits resync a whole day.
2. **Default for `onSourceDelete`.** `keep` protects against plan and
   retention deletions. Should a parent deletion still retract, since a person
   deleted it on purpose?
3. **Events about the install, not a thread** (`app_uninstalled`,
   `tokens_revoked`, `member_left_channel`). The verifier must return an item
   ID for every verified delivery, so v1 does not subscribe to them and learns
   about revocation on the next API call. Should the verifier protocol allow a
   verified delivery with no item?
