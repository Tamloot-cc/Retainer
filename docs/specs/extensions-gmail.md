# Gmail extension

Implemented for development catalogs. Hosted enablement requires the release
review below.

## Goal

Capture correspondence with People already in Retainer. When Dana emails about a
renewal, the email appears on her Person record and an agent can use it as
context for the next follow-up.

## Install and connect

An admin installs Gmail once per workspace and sets **Days of email history**,
defaulting to 31 whole days. Set it to 0 to start with new messages only. Each
member can connect one Gmail account for themselves in that workspace. Before
requesting Google authorization, show the history limit and ask the mailbox
owner to approve the proposed sharing of qualifying message text with workspace
members and agents that can read the imported Conversations. Record that
approval before any import. Workspace installation approval and the mailbox
owner's consent are separate.

Use the existing **Conversation** event type and its `email` medium. Resolve
Conversation and its medium field by their universal IDs and validate the
current field type and `email` option. Install adds no object types or fields.
If the binding is unavailable at activation or later, explain what is missing
and block imports until it is restored.

Use Nango's managed Gmail OAuth app and its `google-mail` integration. Nango
holds and refreshes Gmail credentials. Retainer keeps the member connection,
consent, job fencing, and durable sync state. Use a dedicated environment and
separate scoped keys for connection management and the read-only Gmail proxy.
Keep both keys server-side. Scheduled jobs call a fixed set of Gmail read
endpoints through Nango. They never receive raw Google credentials or a
project-wide proxy capability.

Retainer starts a short-lived Nango Connect session for the signed-in workspace
member and pending connection attempt. Verify the completed Nango connection
against that attempt, the workspace, the owner, and the configured integration
before binding its ID. A connection ID supplied by the browser or a job is
insufficient to authorize a mailbox. Check the actual Google grant at
activation and whenever it is replaced. Require `gmail.readonly` and reject
other Gmail permissions. Optional Google identity scopes can establish a
stable account subject for reconnect. Retainer should never log credentials,
Gmail response bodies, or connect links.

The Gmail profile email is a display label. Keep progress on same-account
reconnect only when Retainer can verify a stable Google account subject and
binds the replacement grant to that account. A Nango connection ID can survive
reauthorization, so it cannot establish that the Google account stayed the
same. With a Gmail-only grant, a replacement requires an explicit disconnect
and a new connection, with separate mailbox-local identity and sync state.
Fence old jobs with the Retainer connection generation.

## What gets imported

- A new connection takes a fixed lower bound from its connection time and the
  configured history limit. When a Person or email address is added, a
  scheduled targeted import uses the limit in effect at that addition. For an
  existing mailbox, this can look earlier than its initial catch-up. An address
  that predates the connection is covered by the connection's catch-up. At
  zero days, only messages from the relevant connection or address addition
  onward qualify for that import. A limit change affects future imports and
  leaves previously accepted messages and existing scan bounds intact. The
  address's history limit applies to ordinary sync and reconciliation too.
- Evaluate each message independently. At least one address in the top-level
  **From** or **To** headers must resolve to exactly one live Person in the
  workspace. Trim and lowercase for exact comparison. CC and BCC confer no
  eligibility, and Gmail dot or plus aliases are not folded. Skip drafts, spam
  and trash. Retainer must verify eligibility again when committing the
  message, including the target Person for a targeted import. Use existing
  Person IDs and link only the eligible matches. Import creates no People
  or Companies.
- Fetch selected metadata first. Fetch the body only for an eligible message,
  and only persist it after the write-time eligibility check. Capture plain
  text or inert text extracted from HTML, with no remote image loads, markup
  execution, or attachment endpoint calls. Gmail can include inline MIME parts
  in its full-message response. Discard them before storage. Exclude attached
  or otherwise separately structured forwarded messages and omit identifiable quoted history. Text
  pasted into an eligible message can include earlier correspondence. Never
  fetch or copy sibling messages merely because their thread qualifies.
- Show one Conversation for a thread, with the subject, the qualifying
  messages in chronological order, and links to their matched People. Preserve
  per-message timestamps. The latest qualifying message drives the
  Conversation's activity date. Gmail's `internalDate` drives scan windows,
  with the message's original date header preserved separately when valid.
  Break ties deterministically.

## Message identity and Conversation storage

The [managed source importer](extensions.md#10-source-ingestion-edits-and-deletion)
already fences work by member connection and supports verified account bindings.
It scopes source item IDs by account or by a reviewed global provider namespace.
It replaces the current event on content changes and retracts dependent claims.
Its event summary is also bounded and searchable. Gmail needs durable
per-message evidence and a thread-level Conversation assembled from those
messages. A new reply should leave citations to earlier messages intact.

- Store one immutable body per accepted message in workspace-scoped evidence
  storage, with bounded text reads and one provenance entry per contributing
  mailbox. Use the verified mailbox binding plus Gmail message ID to deduplicate
  replay. A verified same-account reconnect keeps the binding. To identify the same message in several mailboxes,
  require a valid RFC Message-ID and matching normalized message content
  (sender, recipients in To, subject and body). Keep conflicting copies
  separate. BCC and mailbox-local labels are excluded from the comparison.
  Copies with missing or unusable Message-IDs stay mailbox-local.
- Map each account's Gmail thread ID to the workspace Conversation. Join
  cross-mailbox threads when they share a verified duplicate qualifying message.
  Subjects and unverified References alone do not join threads. Threads without
  that overlap may appear separately. If a late duplicate joins previously
  separate threads, keep one visible Conversation and preserve both earlier
  citation paths. Serialize competing contributions and merges so they cannot
  drop messages or create two current Conversations for the same group.
- Reuse the Conversation schema, workspace access checks, connection admission
  and evidence lifecycle. Store body text separately from the event summary so
  aggregate length does not truncate earlier text. Return message evidence to
  authorized record and agent readers. Record removal must suppress reimport.
  Privacy erasure must cover message bodies, retained mailbox provenance and
  staged identity data, including evidence reachable through former thread IDs.

Gmail uses the managed source account, reservations and runtime queue.
The append transaction rechecks the connection fence, message preparation,
window and eligible Person before storing evidence. The Conversation appears
in activity through its latest message. Earlier message event IDs still open
the conversation and remain valid citations. Read message text through
`GET /v1/events/:id/gmail-messages` or `get_gmail_messages`.

## Sync and disconnect

Take a mailbox history baseline before the initial bounded scan. Checkpoint
each enumeration page together with its durable work. Finish the bounded scan,
then drain Gmail history from the captured baseline. Treat history IDs and page
tokens as opaque strings. Advance the mailbox history cursor only after all
pages through that point have durably queued their work. Track unfinished and
failed message imports separately from completed enumeration. A history 404
starts bounded reconciliation with a fresh baseline, then history replay.
Reconciliation covers the original mailbox import window and unfinished
address windows. A message lookup 404 means the message is unavailable to that
mailbox, not that previously imported evidence should be deleted.

The scheduled worker also discovers new address additions when Gmail is idle.
Persist each targeted window independently of the mailbox cursor and resume it
until complete. Gmail search can narrow candidate scans. Verify the exact
millisecond window and eligible address in Retainer. Treat expired credentials
as refreshable; a revoked grant stops imports and shows **Needs reconnect**.

Disconnecting stops future imports from that mailbox, including queued work.
The existing connection fence must drain or refuse in-flight writes.
Previously imported messages remain subject to Retainer's record removal and
privacy erasure controls. Explain this before connection and disconnection.
Disconnect disables the Retainer binding and removes the dedicated Nango
connection. Google-wide revocation can affect other connections to the same
OAuth client, so it is not a per-workspace cleanup step.

Retainer records cleanup work before opening Connect. Starting over or
letting an attempt expire blocks its completion and leaves cleanup in place.
The extension executor checks the exact attempt tags after the Connect window
closes, retries failed deletions, and checks again after 24 hours. A successfully
bound mailbox is excluded from attempt cleanup. Cleanup retains the encoded
member tag and vendor identity through member, installation, or workspace removal.

## Local development

Build the development bundle with `pnpm build` and
`node scripts/build-extension-artifacts.mjs --development`. Use the catalog
and executable mapping in `artifacts/extensions/gmail` with Retainer's
[extension execution setup](../extensions-execution.md). The default
integration ID is `google-mail`. Connect requests
`https://www.googleapis.com/auth/gmail.readonly` for that integration and
rejects a broader Gmail grant.

Set `RETAINER_GMAIL_NANGO_CONTROL_KEY` and `RETAINER_GMAIL_NANGO_PROXY_KEY`
on the Retainer API that serves the extension routes. For local development
both can fall back to `NANGO_API_KEY` in the server environment. The proxy
key needs `environment:proxy`. The control key needs Connect session creation
and connection list, read, credential read and delete permissions. Set
`RETAINER_GMAIL_NANGO_CLEANUP_KEY` on the trusted extension executor before
enabling Gmail. It only needs connection list and delete permissions. The local
executor also accepts `NANGO_API_KEY`. Configure both in the same Nango environment.
Member authorization creates a dedicated tagged connection. To replace a Gmail
grant, disconnect in Retainer and start a new authorization.

## Hosted release gate

Google classifies `gmail.readonly` as restricted. Nango documents that its
managed Gmail app is verified for production. Before enabling real imports,
confirm whether the approved integration covers Retainer's automatic
CRM capture, retention after disconnect, workspace sharing and access by
external agents and their model providers. Confirm what consent and access
controls are required for specific messages. Revise that product scope if
approval requires it. General workspace consent alone does not establish
compliance with Google's Limited Use policy.

- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Workspace user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Nango Gmail integration](https://nango.dev/docs/api-integrations/google-mail)

## Deferred

Attachment import, sending, Gmail push notifications, label selection,
per-thread exclusions, domain rules, and finer sharing permissions beyond
those required for release.
