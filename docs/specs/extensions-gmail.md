# Gmail extension

Status: draft. Scope: v1.

## Goal

Capture correspondence with People already in Retainer. When Dana emails about a
renewal, the email appears on her Person record and an agent can use it as
context for the next follow-up.

## Install and connect

An admin installs Gmail once per workspace and sets **Days of email history**
for the workspace. The proposed default is 31 days. Set it to 0 to start with
new messages only. Each member can connect one Gmail account for themselves in
that workspace. Before requesting read-only Google authorization, Retainer shows
the history limit and explains that matching messages, including their text,
will be shared with workspace members and agents that can read the imported
Conversations.

The extension uses the existing **Conversation** event type and its `email`
medium. The install preview adds no object types or fields. Resolve Conversation
by its stable schema identity so a renamed type still works. If the workspace
has removed Conversation or the `email` option, explain what is missing and
block activation until it is available.

## What gets imported

- When a mailbox connects, import matching correspondence with existing People
  going back up to the configured number of days from the connection date.
  Continue importing new matching messages afterward.
- When a Person or email address is added, the next scheduled sync starts a
  targeted import from connected mailboxes going back up to the same number of
  days from the addition date. This runs even when Gmail has no new mail. Large
  imports may span multiple runs. With a limit of 0, only messages sent or
  received from the addition onward qualify for the new address.
- Changing the limit applies to future history imports. It does not remove
  messages already imported or start an older import on its own.
- Evaluate each message independently. At least one address in **From** or
  **To** must match exactly one existing Person after normalizing the email
  address. A CC-only or BCC-only match does not qualify. Skip drafts. Import does
  not create People or Companies. Keep nonmatching message text out of the
  workspace, including when a later message in the same thread qualifies.
- Group qualifying messages from the same thread into one Conversation. Use
  the subject as the title, preserve message text and original timestamps, and
  link the matched People. Use the latest qualifying message's timestamp for
  the Conversation's activity date. A reply or internal forward must qualify
  on its own before its text appears in Retainer.
- Show one copy when multiple connected mailboxes contribute the same message.
  Retain the mailbox provenance of each contribution. Repeated sync and reconnect
  must not duplicate messages or Conversations. A Gmail thread ID alone is
  insufficient to identify the same thread across mailboxes.

## Sync and disconnect

Use scheduled incremental sync. Recover from a stale Gmail cursor by
reconciling from the connection's import start and applying the same eligibility
rules. Track targeted history imports independently so an incomplete import can
resume without losing progress or importing duplicates. Recheck that the email
address still uniquely matches the Person before importing. A revoked Google
grant stops imports and shows **Needs reconnect**.

Disconnecting stops future imports from that mailbox, including queued work.
Previously imported messages remain in Retainer and can be removed through the
existing record controls. Explain this before connecting and disconnecting.

Google classifies `gmail.readonly` as a restricted scope. Confirm the OAuth
verification and any security assessment required for hosted release early.
[Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

Before implementation, settle how the existing managed-source importer will
represent message text and reconcile contributions from several mailboxes into
one Conversation. Its current source identity and revision rules are documented
in the [extensions spec](extensions.md#10-source-ingestion-edits-and-deletion).

## Deferred

Attachment import, sending, Gmail push notifications, label selection,
per-thread exclusions, domain rules, and finer sharing permissions.
