# PRD: Connect with Tamloot

Status: draft, 2026-11-15. Product requirements only; the design and
implementation are in
[extensions-tamloot-connect.md](extensions-tamloot-connect.md). Tamloot's
side (the approval and a page to see and revoke approved apps) is in
Tamloot's own PRD, `docs/prds/PRD-connected-apps.md` in the Tamloot
repository.

## Problem

To share their Tamloot meetings with a Retainer workspace, a member today has
to leave Retainer, create a read-only API key in Tamloot, copy it, come back
and paste it into the Connect form. It is the slowest step of setting up the
Tamloot extension, it asks people to handle a secret, and anyone who loses or
rotates the key has to repeat it.

## Goal

A member connects their Tamloot account to a workspace with a button and one
approval in Tamloot, without seeing or copying a key. A member who has no
Tamloot account yet creates one along the way.

## Who it is for

Members of a Retainer workspace that has the Tamloot extension installed, on
the hosted service (retainer.tamloot.cc), who record their meetings in
Tamloot or want to start.

## The experience

**Connecting.** On the extension's Connections tab, the member chooses how
many days of history to import and clicks **Connect with Tamloot**. Tamloot
opens and asks them to approve Retainer, or skips that if they approved it
before. The approval shows Retainer's name and its address,
retainer.tamloot.cc, and says Retainer can only read. They land back on the
Connections tab, which shows the connection
starting and then importing, as it does today.

**New to Tamloot.** A member without a Tamloot account clicks the same
button. Tamloot offers to create an account, with Google first and the email
address they use in Retainer suggested, and then shows the approval. Back on
the Connections tab the connection is active but has nothing to import yet,
so the tab says so and shows how to start recording meetings with Tamloot.
If signing up continues in another tab or window of the same browser,
connecting still finishes there. In a browser where they are not signed in
to Retainer, such as an email link opened on a phone, Retainer asks them to
sign in and connect again; the second time Tamloot skips the approval.
Until then Tamloot lists Retainer as approved, without access to anything.

**Declining.** If they deny the approval or close Tamloot, they return to
Retainer with nothing connected and a plain message saying so. They can try
again.

**Staying connected.** The connection keeps working without the member
approving again, for as long as Retainer keeps its access in Tamloot.

**When access stops.** If the member revokes Retainer in Tamloot or deletes
their Tamloot account, imports stop right away in every workspace that member
connected, and each connection shows that it needs to be reconnected.
Reconnecting is the same button; it does not import meetings twice.

**Disconnecting.** Disconnect stops imports at once and keeps the records
already imported, as today. Retainer then asks Tamloot to end that
connection's access, retrying for up to a day if Tamloot can't be reached.
Once none of the member's workspaces hold access, Tamloot stops listing
Retainer. Revoking Retainer in Tamloot always ends it.

**When Retainer can't give up its access.** Rarely, Retainer can't confirm
that its access in Tamloot ended: Tamloot was unreachable for a whole day, or
connecting was interrupted at the moment Tamloot handed over access. Retainer
never claims the access ended when it can't confirm it. It tells the member
on the extension's Connections tab, until they dismiss it, that Retainer may
still have access, and that revoking Retainer in Tamloot's Connected apps
ends it, in every workspace connected to that Tamloot account. Admins see
the same in the connections table. This also covers access from a failed
attempt to connect, such as approving a different Tamloot account: Retainer
tries to give it up right away and keeps trying for a day. Connecting again
does not end that access by itself.

If the extension is uninstalled, the workspace deleted or the member removed,
the member can no longer open that tab, and Retainer does not message them
elsewhere. Tamloot's Connected apps lists Retainer for as long as it has any
access, so that is where the member checks; the uninstall confirmation says
so.

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
   reconnecting does today: a different account is refused, the connection
   is not switched to it, and it needs connecting again with the first
   account or disconnecting. Access to the refused account is never used to
   import; Retainer tries to give it up, as in requirement 13.
6. Disconnecting stops imports at once and asks Tamloot to end that
   connection's access, retrying for up to a day; if that fails, requirement
   13 applies. The member's other workspaces keep their connections.
7. Retainer's access is read-only, and Tamloot refuses any change Retainer
   attempts. The extension only reads today, so members notice no
   difference.
8. Tamloot shows Retainer, on its approval and in its list of approved apps,
   under its name and its address, retainer.tamloot.cc, so members can tell
   it apart from any other app that uses the same name.
9. Everything else stays as it is today: what is imported, the workspace
   sharing consent, the create-contacts choice and days of history.
10. Self-hosted Retainer keeps connecting with a read-only API key.
11. A member with no Tamloot account can create one from Connect with Tamloot
    and finish connecting in the same flow.
12. A connection with nothing imported yet shows how to start recording in
    Tamloot, so it does not look stuck or broken.
13. When Retainer can't confirm it gave up access it no longer uses, it tells
    the member on the Connections tab while they can still open it, and
    points them to revoke Retainer in Tamloot, warning that this ends
    Retainer's access in every workspace. Retainer never drops access it
    holds without trying to give it up and counting a failure.

## Out of scope

- Connecting other providers this way. This is built for Tamloot first.
- Writing to Tamloot.
- Changing what the extension imports.
- Signing in to Retainer with a Tamloot account.
- Creating a Tamloot account for a member without them seeing Tamloot.

## Success

- Most new Tamloot connections on the hosted service use Connect with
  Tamloot within a month of release.
- Connecting takes under a minute from the click to the first import
  starting.
- Few connections need reconnecting for reasons other than the member
  revoking access.
- We know how many members create their Tamloot account while connecting,
  and most of them record a first meeting.

## Open question

Once Connect with Tamloot works, does the hosted service keep the
paste-a-key option as a fallback, or remove it?

## Changes from Tamloot's PRD

Changes to Tamloot's PRD that affect this one, newest first. Each names the
Tamloot commit and what changed here. Commits from Tamloot PR #2410 are cited
before it merges; its squash commit will differ.

| Date       | Tamloot commit | Change in Tamloot's PRD                                                | Effect here                                                             |
| ---------- | -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2026-11-15 | `e711a9870`    | The approval names each task's contact by email only, as the API does  | Requirement 9 holds: tasks stay linked to their person's email          |
| 2026-11-15 | `e711a9870`    | Access may remain if release fails; a revoke ends it everywhere        | Disconnecting; When Retainer can't give up its access; requirement 13   |
| 2026-11-15 | `e9a472de6`    | Someone with no Tamloot account signs up while connecting              | New to Tamloot paragraph; requirements 11 and 12                        |
| 2026-11-15 | `250ef8191`    | Retainer reads each task's contact and email, shown on the approval    | Requirement 9 holds: tasks stay linked to their person                  |
| 2026-11-15 | `49b974f7c`    | Revoking cuts an app off at once, including access it already had      | When access stops: imports stop right away                              |
| 2026-11-15 | `49b974f7c`    | Retainer reads only what it imports: no contact search, no transcripts | Requirement 9 holds; importing more needs Tamloot's PRD to change first |
| 2026-11-15 | `45d901102`    | The approval must work where Retainer reads Tamloot today              | Requirement 9 rests on it: imports stay the same                        |
| 2026-11-15 | `1cc8cc53e`    | Each workspace has its own access; disconnecting gives it up           | Requirement 6 and the Disconnecting paragraph                           |
| 2026-11-15 | `d6574e687`    | The list of approved apps shows each app's address                     | Requirement 8; the approval names retainer.tamloot.cc                   |
| 2026-11-15 | `d6574e687`    | Tamloot enforces Retainer's read-only access on its side               | Requirement 7                                                           |
| 2026-11-15 | `d0cca4331`    | First version: approving, revoking, Connected apps page                | Revoking stops every workspace the member connected                     |
