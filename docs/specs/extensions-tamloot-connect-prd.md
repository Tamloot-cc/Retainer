# PRD: Connect with Tamloot

Status: draft, 2026-11-15. Product requirements only; the design and
implementation come later in a spec. Tamloot's side (the approval and a page
to see and revoke approved apps) is in Tamloot's own PRD,
`docs/prds/PRD-connected-apps.md` in the Tamloot repository.

## Problem

To share their Tamloot meetings with a Retainer workspace, a member today has
to leave Retainer, create a read-only API key in Tamloot, copy it, come back
and paste it into the Connect form. It is the slowest step of setting up the
Tamloot extension, it asks people to handle a secret, and anyone who loses or
rotates the key has to repeat it.

## Goal

A member connects their Tamloot account to a workspace with a button and one
approval in Tamloot, without seeing or copying a key.

## Who it is for

Members of a Retainer workspace that has the Tamloot extension installed, on
the hosted service (retainer.tamloot.cc), who record their meetings in
Tamloot.

## The experience

**Connecting.** On the extension's Connections tab, the member chooses how
many days of history to import and clicks **Connect with Tamloot**. Tamloot
opens and asks them to approve Retainer, or skips that if they approved it
before. The approval shows Retainer's name and its address,
retainer.tamloot.cc, and says Retainer can only read. They land back on the
Connections tab, which shows the connection
starting and then importing, as it does today.

**Declining.** If they deny the approval or close Tamloot, they return to
Retainer with nothing connected and a plain message saying so. They can try
again.

**Staying connected.** The connection keeps working without the member
approving again, for as long as Retainer keeps its access in Tamloot.

**When access stops.** If the member revokes Retainer in Tamloot or deletes
their Tamloot account, imports stop in every workspace that member connected,
and each connection shows that it needs to be reconnected. Reconnecting is the
same button; it does not import meetings twice.

**Disconnecting.** Disconnect stops imports and keeps the records already
imported, as today. It also gives up that connection's access in Tamloot, so
Tamloot stops listing Retainer once none of the member's workspaces use it.

## Requirements

1. A member can connect their own Tamloot account from the Connections tab
   without handling an API key.
2. Each member connects for themselves, per workspace. Connecting one
   workspace does not connect another, and an admin cannot connect on a
   member's behalf.
3. The connection stays active without further approvals until the member,
   or Tamloot, ends Retainer's access.
4. When Tamloot access ends, the member and the workspace admins see
   "Needs reconnect" with a short reason, and imports stop without errors
   piling up.
5. Reconnecting, including with a different Tamloot account, behaves as
   reconnecting does today.
6. Disconnecting ends that connection's access in Tamloot. The member's
   other workspaces keep their connections.
7. Retainer's access is read-only, and Tamloot refuses any change Retainer
   attempts. The extension only reads today, so members notice no
   difference.
8. Tamloot shows Retainer, on its approval and in its list of approved apps,
   under its name and its address, retainer.tamloot.cc, so members can tell
   it apart from any other app that uses the same name.
9. Everything else stays as it is today: what is imported, the workspace
   sharing consent, the create-contacts choice and days of history.
10. Self-hosted Retainer keeps connecting with a read-only API key.

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

## Open question

Once Connect with Tamloot works, does the hosted service keep the
paste-a-key option as a fallback, or remove it?

## Changes from Tamloot's PRD

Changes to Tamloot's PRD that affect this one, newest first. Each names the
Tamloot commit and what changed here.

| Date       | Tamloot commit | Change in Tamloot's PRD                                      | Effect here                                           |
| ---------- | -------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 2026-11-15 | `1cc8cc53e`    | Each workspace has its own access; disconnecting gives it up | Requirement 6 and the Disconnecting paragraph         |
| 2026-11-15 | `d6574e687`    | The list of approved apps shows each app's address           | Requirement 8; the approval names retainer.tamloot.cc |
| 2026-11-15 | `d6574e687`    | Tamloot enforces Retainer's read-only access on its side     | Requirement 7                                         |
| 2026-11-15 | `d0cca4331`    | First version: approving, revoking, Connected apps page      | Revoking stops every workspace the member connected   |
