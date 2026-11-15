# PRD: Connect with Tamloot

Status: draft, 2026-11-15. Product requirements only; the design and
implementation come later in a spec.

## Problem

To share their Tamloot meetings with a Retainer workspace, a member today has
to leave Retainer, open Tamloot Settings → API keys, create a read-only key,
copy it, come back and paste it into the Connect form. It is the slowest step
of setting up the Tamloot extension, it asks people to handle a secret, and
anyone who loses or rotates the key has to repeat it.

## Goal

A member connects their Tamloot account to a workspace with a button and one
approval in Tamloot, without seeing or copying a key.

## Who it is for

Members of a Retainer workspace that has the Tamloot extension installed, on
the hosted service (retainer.tamloot.cc), who record their meetings in
Tamloot.

## The experience

**Connecting.** On the extension's Connections tab, the member clicks
**Connect with Tamloot**. They still choose how many days of history to import
first. Tamloot opens, asks them to sign in if they are not, and shows an
approval screen naming Retainer and what it will read: meetings, notes,
participants and tasks, read-only. They click Allow and land back on the
Connections tab, which shows the connection starting and then importing, as
it does today.

**Declining.** If they click Deny or close Tamloot, they return to Retainer
with nothing connected and a plain message saying so. They can try again.

**Staying connected.** The connection keeps working without the member
approving again, for as long as they keep Tamloot's access in place.

**When access stops.** If the member revokes Retainer's access in Tamloot or
deletes their Tamloot account, imports stop
and the connection shows that it needs to be reconnected. Reconnecting is the
same button and approval; it does not import meetings twice.

**Disconnecting.** Disconnect works as today: it stops imports and keeps the
records already imported. It also ends Retainer's access to the member's
Tamloot account.

## Requirements

1. A member can connect their own Tamloot account from the Connections tab
   with one approval in Tamloot, without handling an API key.
2. The approval screen names Retainer and lists what it can read. Access is
   read-only.
3. Each member approves for themselves, per workspace. Connecting one
   workspace does not connect another, and an admin cannot approve on a
   member's behalf.
4. The connection stays active without further approvals until the member or
   Tamloot ends it.
5. When Tamloot access ends, the member and the workspace admins see
   "Needs reconnect" with a short reason, and imports stop without errors
   piling up.
6. Reconnecting, including with a different Tamloot account, behaves as
   reconnecting does today.
7. Disconnecting in Retainer ends Retainer's access to that Tamloot account
   for that connection.
8. Everything else stays as it is today: what is imported, the workspace
   sharing consent, the create-contacts choice and days of history.
9. Self-hosted Retainer keeps connecting with a read-only API key.

## Out of scope

- Connecting other providers this way. This is built for Tamloot first.
- Writing to Tamloot.
- Changing what the extension imports.
- Signing in to Retainer with a Tamloot account.

## Success

- Most new Tamloot connections on the hosted service use Connect with
  Tamloot within a month of release.
- Connecting takes under a minute from the click to the first import
  starting.
- Few connections need reconnecting for reasons other than the member
  revoking access.

## Open questions

1. **Where members revoke in Tamloot.** Tamloot has no page today listing the
   apps a person has approved. Do we add one, or is disconnecting in Retainer
   enough for the first release?
2. **Clinical attestation.** Tamloot asks clinical users to tick an attestation
   before approving Claude or ChatGPT. Should approving Retainer ask the same?
3. **API keys on hosted.** Once Connect with Tamloot works, do we keep the
   paste-a-key option on the hosted service as a fallback, or remove it?
