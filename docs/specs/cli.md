# The `retainer` CLI: spec

Status: **proposed**, 2026-11-23. Nothing here is built. The product owner
decided these things: there will be a command-line tool for admins and
developers; its main users are their AI agents (Claude Code, Codex and others
with a shell); it is called `retainer`; it logs in through the browser, not
with an API key; and it uses the Better Auth server we already run. The
operator CLI that has that name today becomes `retainer-ops` (§8). The rest
is a proposal, settled after four review rounds by two independent agents
(Claude Code and Codex).

## 1. The idea on one page

An admin who works with an agent should be able to say "invite Ben as an
editor", "go through the duplicate suggestions with me" or "approve the Deals
schema change" and have the agent do it from the terminal.

Today the agent can't. MCP gives it records, events and facts, but every
decision a person makes is closed to agents on purpose: reviewing duplicates
and pending values, approving schema changes, extensions and routines,
managing people and keys (accounts spec 4.3, routines spec 5.3). Those
decisions happen only in the web app.

The CLI opens some of them to an agent **while its person is working with
it**:

1. **`retainer login`** connects the CLI to the person's account through the
   browser, like `gh auth login`. With that login the agent can read, within
   the person's role: members, invitations, keys, connections, extensions,
   routines, and what is waiting for a decision. It writes nothing; records
   stay with MCP.
2. **`retainer elevate`** asks the person, in the browser, to let the agent
   decide for them in one workspace for a short time (30 minutes by default).
   Within that window the agent can make the everyday decisions the person
   could make there, and they are recorded as the person's, through the CLI.
3. **Some actions need a click every time**, even while elevated: those that
   can't be undone, and those whose result keeps working after the window
   ends, such as creating an API key, approving a routine or installing an
   extension (§5.3). Approving a routine and setting up an extension happen
   entirely on the screens the web app already has; the CLI links to them.

The person and the agent work through the cases together. The agent explains
and recommends, the person decides in the chat, and the agent carries it out.
An agent can't start a window on its own, because only the person can approve
one, and every window ends by itself. One limit: an agent that drives the
person's signed-in browser could click Allow itself, unless the person has a
passkey, which every approval then requires (§5.1).

The CLI covers what MCP leaves out: people, keys, workspaces, connections,
extensions and decisions. It has no commands for records; agents use MCP for
those (§6.4).

## 2. Why a CLI, and why this shape

**Why not more MCP tools.** We could add admin tools to MCP behind a "manage
people and keys" consent. But these actions are rare, and every MCP tool
takes room in the agent's context in every session. A CLI costs nothing until
the agent runs `retainer --help`. It also works in any agent with a shell,
and its output can be piped and scripted.

**Why not the web app's session.** A browser session can do everything its
person can, for as long as it lasts. Handing one to an agent would let it
decide anything, at any time, with nothing in the record to show an agent was
involved.

**Why not an API key.** Keys belong to a workspace, not to a person, and are
always agents in accounts mode (`people.createWorkspaceKey`). They can never
make a person's decision or reach `/account` (accounts spec 4.5), and that
rule stays.

**Why elevation, not a confirmation for every decision.** The first draft of
this design asked the person to click Approve in the browser for each
decision. The product owner pointed out that the person and the agent work
through the cases together in the chat: a click per case would only slow
them down. Elevation keeps the decision with the person (they are present,
they opened the window, it is short and covers one workspace) without the
clicks. A click stays for the few actions that can't be undone or that
outlive the window (§5.3).

**Prior art.** `gh auth login` (browser login for a CLI), `sudo` and GitHub's
sudo mode (a short window of higher access after a fresh check), and cloud
CLIs that print a link and wait for approval in the browser (`gcloud auth
login --no-launch-browser`, device-code flows).

## 3. Who can do what

Everything is capped by the person's role, as everywhere else (accounts spec
4.3). A viewer who elevates is still a viewer. "Elevated" means elevated in
the workspace or organization the action is in.

| Action                                                                    | Logged in | Elevated | Click each time |
| ------------------------------------------------------------------------- | --------- | -------- | --------------- |
| List workspaces, members, invitations, keys, connections, extensions      | Yes       | Yes      |                 |
| See what is waiting: duplicates, pending values, schema changes, routine versions, extension approvals | Yes | Yes |   |
| Print a workspace's MCP address (pinned address, accounts spec 4.7)       | Yes       | Yes      |                 |
| Chat with the workspace agent (agent spec §6.7): it reads; it writes as the agent while elevated | Reads | Writes |  |
| Invite a teammate (any role but owner), revoke an invitation              |           | Yes      |                 |
| Change a member's role, remove a member (not to or from owner)            |           | Yes      |                 |
| Create or rename a workspace                                              |           | Yes      |                 |
| Merge or dismiss duplicates; accept or reject pending values              |           | Yes      |                 |
| Approve or reject a schema change                                         |           | Yes      |                 |
| Reject a routine version; pause or resume a routine                       |           | Yes      |                 |
| Disable or remove an extension                                            |           | Yes      |                 |
| Revoke an API key; disconnect an app                                      |           | Yes      |                 |
| Make someone an owner, invite an owner, or change an owner's role         |           |          | Yes             |
| Delete a workspace                                                        |           |          | Yes             |
| Create an API key                                                         |           |          | Yes             |
| Approve a routine version                                                 |           |          | In the web app  |
| Install, upgrade or configure an extension                                |           |          | In the web app  |
| Delete an organization; enable an extension; archive a routine; `forget`; move events | | | Web app only |

"Logged in" means reading only: a CLI token never has `write` or
`schema:write`. Proposing schema changes and routines, previewing extensions
and writing records stay with MCP. "Click each time" works whether or not the
CLI is elevated. "In the web app" means the CLI returns a link to the
existing screen and the person does the whole thing there (§5.3).

## 4. Logging in

### 4.1 The flow

`retainer login [--server <url>]`:

1. The CLI starts a listener on `127.0.0.1` on a free port in a detached
   process, makes a PKCE verifier and a `state` value, and prints its one JSON
   document at once: `{ "id": …, "url": …, "expiresAt": … }`. It also tries
   to open the browser. An agent shows the URL to its person.
2. The person signs in if needed and sees a consent page: "Connect the
   Retainer CLI on Dana's MacBook. It works as an agent in every workspace you
   can open, and can't make your decisions unless you allow it with
   `retainer elevate`." There is no workspace to pick (§4.3).
3. The browser is sent back to the listener, which checks `state`, exchanges
   the code for tokens, saves them and exits. It gives up after 10 minutes.
4. `retainer wait <id>` blocks until the login finishes, fails or times out
   (§6.2).

This is OAuth 2.1 with PKCE and a loopback redirect (RFC 8252), on the OAuth
server we already run (`@better-auth/oauth-provider`, accounts spec 4.7). The
provider already accepts a loopback redirect on any port for native clients
(`stripLoopbackRedirectPort`), and the onboarding clients rely on it.

**The client.** `retainer-cli` is a fixed, first-party, public native client.
It is created idempotently at startup (not per workspace, unlike the Claude
Code and Codex clients in `accounts/onboarding-clients.ts`). It is the only
client linked to the `/cli` resource in `oauth_client_resources`, `/cli` is
never in `clientRegistrationAllowedResources`, and both the token claims and
`retainer_cli_access` require `azp = 'retainer-cli'`. A dynamically
registered app that calls itself "Retainer CLI" gets nothing.

**Agents in the cloud.** A loopback redirect only works when the agent runs
on the person's own machine. Agents in a cloud sandbox (Claude Code on the
web, Codex cloud) need a device-code flow (RFC 8628): the CLI prints a short
code and a link, the person approves on any device. Better Auth's
`device-authorization` plugin doesn't fit as it stands: in 1.7.25 it hands
out a Better Auth session (`createSession`, then `access_token:
session.token`), which is the full web session §2 rules out. A device flow
that issues the same token as §4.2 is later work (§10).

### 4.2 The login and its token

Each browser-approved login is a row in a new table, `cli_logins`: `id`,
`user_id`, `machine_name`, `created_at`, `revoked_at`. The consent page
creates it, and its ID is the consent's `referenceId`, under a new `cli`
kind in `retainer_oauth_reference`. The login is what everything else hangs
on: elevations, confirmations, Connected apps and disconnecting. Access tokens
come and go every hour and refresh tokens rotate, but the login stays the
same.

- **Audience:** a new resource, `<origin>/cli`, with its own protected
  resource metadata. MCP and extension tokens don't work on the CLI's routes,
  and a CLI token doesn't work on `/mcp`.
- **Claims:** `customAccessTokenClaims` adds a `cli_login` claim for the
  `/cli` audience only. The existing workspace and installation branches are
  unchanged.
- **Lifetime:** access token 1 hour, refresh token 30 days, rotated on use.
  A used refresh token can be reused for 30 seconds, so a retry recovers
  (accounts spec 4.7). Reused later, Better Auth deletes every refresh token
  of that client and person (`invalidateRefreshFamily`), so none of the
  person's CLI logins can refresh and they log in again. Access tokens
  already issued keep working until they expire, within the hour; to cut a
  login off at once, the person disconnects it, which `retainer_cli_access`
  sees on the next request. CLI processes on one machine refresh one at a
  time, under a lock file per server, so two parallel commands don't trip
  this.
- **Where it is shown:** Your account, Connected apps, one row per login:
  "Retainer CLI on Dana's MacBook" with the date. Disconnecting a row sets
  `revoked_at`, revokes that login's refresh tokens and ends its elevations.
- **On disk:** `~/.config/retainer/credentials.json`, mode 0600, one entry per
  server. `retainer logout` calls `DELETE /account/cli/login`, which needs no
  workspace or elevation and in one transaction revokes this login, its
  refresh tokens and its open elevations, and nothing of the person's other
  logins. It then deletes the entry. If the server can't be reached, it
  deletes the entry anyway and says the login is still listed in Your account
  to disconnect there.
- **Disconnecting in Your account:** CLI logins have no workspace, so
  `connections.ts`, which finds consents through their workspace, gets a
  branch for the `cli` reference kind. (An OS keychain is later work, §10.)

### 4.3 One login, every workspace

An MCP connection belongs to one workspace. The CLI's login belongs to the
person instead, because admin work crosses workspaces: inviting someone to
the organization, creating a workspace, comparing two workspaces' members.

Each command acts on one of three targets:

- **The person:** `whoami`, `workspaces`, `review` across workspaces.
- **An organization:** invitations, organization roles, creating a workspace.
  `--org <slug|id>` picks it, and is required when the person manages more
  than one.
- **A workspace:** everything else. `--workspace <slug|id>`, then the
  `RETAINER_WORKSPACE` variable, then the one saved with `retainer use
  <workspace>`. That saved choice is a file on the person's machine, which
  they can see and change. It is not the hidden server-side pointer rejected
  for MCP (accounts spec 4.7): nothing on the server remembers it.

The CLI resolves a slug to an ID and sends the ID in the `X-Retainer-Workspace`
header, as the web app does. Organization routes carry the organization in the
path, as `/account` does today. A selector that disagrees with the route's
target is refused. Every JSON result names the workspace or organization it
acted on, so an agent sees when it acted somewhere else than it meant to.

The server checks the person's role on every request, with a new
`SECURITY DEFINER` function in the style of `retainer_token_access`:
`retainer_cli_access(subject, client, login, workspace)` returns the role
only while the login is not revoked and the person can open the workspace.

A person with no workspace yet creates the first one in the web app, as
today; the CLI's `workspace create` needs an organization to put it in.

### 4.4 Who the caller is

Logged in, the caller is an agent,
`{ type: 'agent', id: 'cli:<login ID>', name: 'Retainer CLI for Dana' }`,
with `connectedBy` set to the person and the scope `read` only. It writes
nothing, so the actor shows only in logs.

The caller also carries `cli = { loginId, elevationId? }`, and a new
`PersonCheck` kind, `cli`, which checks the login through
`retainer_cli_access` wherever `recheckPerson` checks a session or an OAuth
token today. (Without it, `recheckPerson` would treat the CLI caller as an
API key.)

Elevated, decisions are made as the person (§5.2).

## 5. Elevation

### 5.1 Starting and ending it

`retainer elevate [--workspace <w> | --org <o>] [--minutes <n>] [--reason <text>]`:

1. The CLI asks the server for an elevation for that login and that one
   workspace or organization (`POST /account/cli/approvals`). The server
   answers with an ID and an approval URL, and the CLI prints them at once as
   `{ "id", "url", "expiresAt" }`.
2. The approval page, in the web app, shows: the login ("Retainer CLI on
   Dana's MacBook"), when it was connected, the workspace or organization,
   how long the window lasts, the reason the agent gave, and in plain words
   what it allows, including "any agent on this machine using this login can
   decide for you here until the window ends." It has Allow and Deny buttons.
   Only the person the login belongs to can approve; anyone else sees "This
   request is for another account."
3. `retainer wait <id>` blocks until the person allows or denies, or 10
   minutes pass, and then prints when the window ends.

Rules:

- The default window is 30 minutes and the maximum is 60.
- A window covers one login and one workspace or organization. Another CLI
  login of the same person, an MCP connection, or another workspace doesn't
  get it. To work in two workspaces, the agent elevates twice.
- **Approving needs a passkey when the person has one**, with user
  verification, every time. Without one, a session signed in within the last
  12 hours, or signing in again first. The agents this CLI serves can often
  drive the person's browser (Claude in Chrome, computer use, Playwright), and
  the person is usually signed in there, so without a passkey such an agent
  could click Allow itself. The approval page says so and links to Your
  account to add a passkey; it never offers to add one inline.
- **The passkey proves this approval, not a sign-in.** Better Auth's passkey
  sign-in always creates a new session and doesn't record that a passkey was
  used, so a recent passkey sign-in proves nothing about this request. The
  approval page instead asks for a WebAuthn assertion whose challenge the
  server derives from the approval's ID and action hash. The decide endpoint
  verifies it against the person's `passkeys` rows with user verification,
  using the WebAuthn library the passkey plugin already uses, consumes the
  challenge with the decision, and creates no session.
- **Adding or removing a passkey needs an existing one**, checked where the
  change is written. Otherwise an agent driving the browser could register a
  virtual authenticator, or delete the person's passkeys so that approval
  falls back to a recent sign-in. Better Auth generates registration options
  and stores the passkey on two separate requests, and deletes on a third, so
  a check on the options request alone could be raced: a registration started
  while the person had none could land after they enrolled one. So:
  - When the person has a passkey, adding another or deleting one needs a
    fresh user-verified assertion from an enrolled passkey, bound to that
    change and used once. Deleting the last one needs an assertion from it.
  - A trigger on the `passkey` table enforces it when the row is inserted or
    deleted: it locks the person's `users` row, counts their passkeys, and
    refuses the change unless the person has none (for an insert) or a
    matching unused authorization exists, which it consumes. A registration
    started with no passkeys must start again if one was added meanwhile.
  - Since no passkey can be removed without an assertion from one, the
    person's passkeys never drop to zero without them, so an approval can't be
    pushed into the recent-sign-in fallback that way.

  Your account lists passkeys with the date each was added. A person who has
  lost every passkey asks an operator, who clears them with `retainer-ops user
  passkeys clear <email>`.
- **The window belongs to the login, not to one agent.** While it is open,
  anything on that machine that uses that login can decide in that workspace,
  such as a second agent session. That is why the window is short, covers one
  workspace, shows in Your account with an End now button, and is ended by
  the skill when the work is done.
- `retainer elevate --end` ends it early (`POST
  /account/cli/approvals/:id/end`). So do `retainer logout`, disconnecting the
  login in Your account, and losing the role in that workspace or
  organization: `setWorkspaceRole`, `removeFromWorkspace` and their
  organization counterparts end the person's open elevations for that target
  in the same transaction, so a removal followed by a re-invite doesn't bring
  a window back. An organization change that removes the person's effective
  role in a workspace ends that workspace's windows too.
- **Checked inside each decision, after its locks.** A new
  `recheckElevation(tx, binding)` runs in the decision's own transaction,
  after the decision has taken all its own locks (record, assertion, schema,
  organization) and before its first change. Checking earlier, right after
  `admitCaller`, would let a decision pass, wait on a lock while the window
  expires, and then go ahead; and its hold on the approval row would make
  `--end` wait behind it. It reads the `cli_approvals` row `FOR SHARE` and
  compares `expires_at` with the current time. Ending a window updates that
  row, so it either finishes before a decision's check, which then refuses
  with `elevation_required`, or waits for a decision that already passed its
  check to commit. A decision waiting on its own locks when the window ends
  is therefore refused. The `/account` services take a `person`, not a
  `Caller`, so their decision routes pass the person with
  `{ loginId, elevationId, via }`. Schema approval (`schema-engine/engine.ts`)
  takes its schema locks without `admitCaller`, so it gets the binding too.
  The route middleware only sets the identity; it never decides that the
  window is open. Nothing is half done: each decision is its own transaction.

### 5.2 What changes while elevated

Only the **decision routes** listed in §9.1 change. On those, an elevated
CLI request runs as the person: the caller's actor is
`{ type: 'user', id: <user>, name: 'Dana Cohen', via: 'Retainer CLI' }`,
`userId` is set, and its scopes come from the person's current role in that
workspace, including `admin`. The existing checks (`requireScope`,
`requireUser`, `canApproveDestructive`, `adminIdentity`) then work unchanged,
because they see the person. On every other route the caller stays the agent
of §4.4, elevated or not.

**Records stay with MCP.** The CLI writes no records, events or facts,
elevated or not, so no agent value can be ranked as a person's because it was
written during a window.

**One exception: the workspace agent's chat** (agent spec §6.7). `retainer
agent chat` opens a chat with the workspace agent. Logged in, the agent can
search, read records, read the person's `me` memory and search the web;
while this login is elevated in that workspace it may also write records,
log events, remember facts and call extension `read` tools, within the
person's role. Its writes are the chat agent's (`retainer-agent:<person>`,
agent spec §7.1), never the person's, so an elevation never makes a model's
value rank as a person's. Access follows the credential that mints each turn:
a stream token minted from the CLI carries the login and its elevation, and
each write re-checks that window in its own transaction
(`recheckElevation`, §5.1), so a window that ends mid-turn stops the next
write. The chat agent never reaches a decision route, elevated or not.

**Duplicates are decided by suggestion.** `POST /v1/records/:id/merge`
merges any two records with field values the caller chooses, which is a
record write, not a review decision. The CLI instead gets
`POST /v1/review/merges/:id/merge`: it resolves the pending suggestion's pair
in the merge transaction, refuses one that is no longer pending, and takes no
field values but requires `keep`, which of the pair's two records survives
(the pair is stored in sorted order, so neither is "first"). The merge keeps
the values the merge rules pick. Choosing
values field by field stays in the web app.

**Routine resume keeps the existing approval.** It approves nothing new,
and the approval stands even when its approver has since lost admin (#229).
When the routine paused for a repair, `resume` refuses with
`approval_required` for every caller, CLI or not, and the CLI shows the
link to the routine's review screen (§5.3).

**The record says how a decision was made.** `Actor` gets an optional `via`
field, for display only, added to `actorSchema` explicitly (it is a
`z.object`, which strips unknown keys). The web app shows "Dana Cohen,
through Retainer CLI" in History, the review inbox and the routine and
extension pages. `via` never changes precedence or permissions.

### 5.3 Actions that need a click every time

Some actions need the person's own click even when the person is present:

- **Can't be undone:** deleting a workspace.
- **Outlives the window:** creating an API key; making someone an owner,
  inviting someone as owner, or changing an owner's role; approving a routine
  version, which then runs as an agent indefinitely; installing, upgrading or
  configuring an extension, which grants it access.

Deleting an organization, enabling an extension, archiving a routine,
`forget` and moving events stay in the web app (and, for moving events, MCP
as today); the CLI has no command for them.

There are two kinds.

**Done in the web app:** approving a routine version, and installing,
upgrading or configuring an extension. These already have their own review
screens: the routine version diff, and the extension's two-step install and
configure plan (`extensions-configure.md`), which build the plan from what the
person enters and commit it themselves. The command makes no request to the
server's decision routes: it prints `{ "url" }`, a deep link to that screen,
and exits 6. The person does the whole thing there, as themselves (no `via`),
under the screen's own rules, as in the web app today; the CLI adds no new
way in. Afterwards the agent reads the result with `retainer routines` or
`retainer extension show`. Routines spec 5.3 ("agents cannot approve") stays
true.

**Approved, then resent** (`action`): creating an API key, deleting a
workspace, and owner changes and owner invitations. The server answers these
with `confirmation_required` and `{ "id", "url", "expiresAt" }`, which the
CLI prints at once, as for elevation. A small page shows the exact action
("Delete the workspace Dana Support and everything in it. It can be restored
for 7 days"). Approving needs a passkey or a recent sign-in, exactly as in
§5.1. The click marks the request approved, and the action runs when the CLI
asks again:

1. The CLI resends the same request with `--approval <id>`.
2. In one transaction, after the action's own locks, the server checks that
   the request is approved and unused, that it belongs to this login, that
   the action and its arguments hash to what was approved, that it hasn't
   expired (10 minutes after approval), that the login isn't revoked, and
   that the person still has the role. It then marks the request used and
   runs the action as the person, `via` Retainer CLI.
3. The result comes back in that response. A new API key's secret is shown
   once and never stored. The key's ID (not the secret) is saved on the
   approval, so if the response is lost, `retainer wait <id>` names the key
   to revoke before creating another.

Elevations and actions share one table, `cli_approvals`: `id`,
`login_id`, `kind` (`elevation` or `action`), the workspace or
organization, the action and its hash, the result's ID, `status` (`pending`, `approved`, `denied`, `used`, `ended`, `expired`),
`expires_at`, and who decided and when. Every change of status is one
conditional update that also checks `expires_at` against the current time, so
two clicks, a click racing the expiry, or two retries decide it once.

## 6. The CLI

### 6.1 Commands

```
retainer login [--server <url>]        Connect this machine (§4); returns at once
retainer wait <id>                     Wait for a login, an elevation or an approval
retainer logout
retainer whoami                        Account, server, workspace, elevations and time left
retainer elevate [--workspace <w> | --org <o>] [--minutes <n>] [--reason <text>] | --end

retainer workspaces                    The workspaces you can open
retainer use <workspace>               Default workspace for later commands
retainer workspace create <name> [--org <o>] [--template <t>]
retainer workspace rename <name>
retainer workspace delete <workspace>  Click each time
retainer mcp-address [<workspace>]     The workspace's pinned MCP address

retainer members
retainer invite <email> [--org <o>] [--org-role <member|admin|owner>] [--workspace <w> --role <viewer|editor|admin>]…
retainer invitations | retainer invitation revoke <id>
retainer role <email> --workspace <w> <viewer|editor|admin> | --org <o> <member|admin|owner>
retainer remove <email>

retainer keys | retainer key create <name> --access <…> | retainer key revoke <id>
retainer connections | retainer disconnect <id>

retainer review                        Everything waiting for a decision
retainer review show <id>
retainer duplicates merge <suggestion> --keep <record> | dismiss <suggestion>
retainer pending accept <id> | reject <id>
retainer schema-changes | approve <id> | reject <id>

retainer extensions | extension show <id>
retainer extension install <name> | configure <id> | upgrade <id>   In the web app
retainer extension disable <id> | remove <id>
retainer routines | routine approve <id> <version>                  In the web app
retainer routine reject <id> <version> | pause <id> | resume <id>

retainer agent chat [<chat>] [--message <text>]   Chat with the workspace agent (agent spec §6.7)
```

`agent chat` opens a new chat, or continues `<chat>`, and renders the
agent's stream in the terminal: reasoning dimmed, tool calls and results as
short lines. In a terminal it reads one message per line; Ctrl-C stops the
running turn and Ctrl-D leaves. `--message` sends one message and exits,
`0` when the turn completed; with `--json` it prints each stream chunk as a
JSON line, then the chat's ID and how the turn ended.

Commands that need a click (`action`) accept `--approval <id>` to finish
once it is given. Commands done in the web app return only the link; the
agent checks the result afterwards with a read command. An owner role or owner invitation
needs a click; other roles need elevation in the organization or workspace. The names are a starting point. The rule is one command per decision,
named after what the web app calls it.

### 6.2 Built for agents to read

- **One JSON document on stdout.** When stdout isn't a TTY, or with `--json`,
  every command prints exactly one JSON document. In a terminal it prints
  plain tables.
- **Nothing blocks except `wait`.** `login`, `elevate` and every
  `confirmation_required` answer return at once with
  `{ "id", "url", "expiresAt" }` and exit code 6. The agent shows the URL to
  its person and then runs `retainer wait <id>`, which exits 0 when allowed
  or done, 7 when denied and 5 when it timed out. A command that links to an
  existing web screen returns `{ "url" }` alone, also with exit code 6; the
  agent asks the person to say when they're done, then checks with a read
  command. Agent shells often show output only when a command exits, so a
  URL printed by a command that then waits would never reach the person.
- **Never asks a question.** No prompts. A command that needs something
  missing fails and says what to pass.
- **Errors say what to do next.** Each error has a code, a sentence and the
  command that fixes it, for example
  `{"error":"elevation_required","message":"Approving a schema change is your person's decision.","next":"retainer elevate --workspace sales --reason \"approve the Deals schema change\""}`.
  The `next` command names the target the action needs: `--org` for
  invitations and organization roles, `--workspace` for the rest.
- **Exit codes:** 0 done, 1 failed, 2 wrong usage, 3 not logged in, 4 needs
  elevation, 5 waiting timed out, 6 waiting for the person (URL returned),
  7 the person denied.
- **`--help` is complete** and written for an agent to read: each command
  with its arguments, an example, its target (person, organization or
  workspace), and whether it needs elevation or a click.

### 6.3 Several servers

`--server <url>` or `RETAINER_URL` picks the server; the default is the one
logged in last. Credentials are stored per server, so a self-hosted server
and retainer.tamloot.cc can both be logged in.

The CLI works only with servers in accounts mode (accounts spec 4.1). A
server in key mode has no people to log in as: `retainer login` there says
so and points to `retainer-ops` (§8).

### 6.4 What the CLI leaves to MCP

No commands for records, events, facts, search or memory. Agents already
have MCP for those, with its instructions and guides; a second way to write
records would need its own rules for sources, precedence and review.
Developers who script data work use the REST API or `@retainer/sdk`.

## 7. The skill

The Claude Code plugin (`plugins/retainer`) gets a skill, `retainer-cli`,
that teaches an agent:

- use MCP for records and the CLI for people, keys, workspaces, extensions
  and decisions;
- pass `--workspace` (or set `RETAINER_WORKSPACE`) for each session rather
  than relying on `retainer use`, since other sessions share that file;
- when a command returns a URL, show it to the person and wait for them to
  say they're done; then run `retainer wait <id>` if it returned an `id`, or
  otherwise read the result (`retainer routines`, `retainer extension show`);
- before `elevate`, tell the person why and which decisions are coming, and
  pass that as `--reason`;
- go through decisions one at a time: explain the case, recommend, and act
  only on the person's word;
- end the window with `elevate --end` when the review is done;
- never start an elevation in an unattended run, and never open or click an
  approval URL itself.

These are instructions, not guarantees. The guarantees are that every window
ends by itself, and that with a passkey only the person can approve a window
or a confirmation. Without a passkey, an agent that drives the person's
signed-in browser could approve one itself (§5.1).

## 8. Renaming the operator CLI to `retainer-ops`

The command that talks to the database directly (ARCHITECTURE 7.1,
`packages/server/src/cli.ts`) is renamed `retainer-ops`. The subcommands
don't change.

**Why two commands, not one.** The operator CLI needs the database's owner
credentials and imports server code, which is AGPL. The new CLI talks only to
the HTTP API and is MIT, like the SDK, and MIT packages never import server
code (`CLAUDE.md`). They also serve different people: whoever runs the
server, and whoever uses a workspace.

**No compatibility alias.** Retainer has no users yet, so `retainer` doesn't
stay as a second name for the operator CLI. Any script that uses it changes
with this rename.

What changes:

| Where                                     | Change                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `packages/server/package.json`            | `bin`: `retainer-ops` → `./dist/cli.js`                             |
| Root `package.json`                       | Script `retainer` becomes `retainer-ops`                            |
| `docker/Dockerfile`                       | The wrapper is installed as `/usr/local/bin/retainer-ops`; comment |
| `packages/server/src/operator/commands.ts` | Usage text and the hint that names `retainer member add`           |
| `README.md`, `ARCHITECTURE.md` 7.1, `docs/self-hosting.md`, `docs/agents.md`, `docs/rest-api.md`, `docs/extensions-execution.md`, `FRONTEND.md`, `local-testing.txt`, `artifacts/mcp/retainer-mcp.html` | Command examples |
| Specs that mention operator commands      | Left as written: they record decisions at the time                 |
| retainer-cloud `infra/aws/ops.sh`         | Works unchanged: it sends the subcommands to the ops function, not the command name. Its comment and `docs/aws.md` say "operator CLI (`retainer-ops`)" |

`retainer-mcp`, the stdio bridge in `@retainer/mcp`, keeps its name. It could
become `retainer mcp` later (§10).

## 9. Where the code goes

| Part                    | Where                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| The CLI                 | New package `packages/cli`, `@retainer/cli`, MIT, `bin: retainer`, built on `@retainer/sdk` |
| Account and decision calls | `@retainer/sdk`, so scripts can use them too                                           |
| The `retainer-cli` client, the `/cli` resource, its metadata, `cli_logins` | `packages/server/src/accounts/`                   |
| The `cli` reference kind and `cli_login` claim | `retainer_oauth_reference`, `customAccessTokenClaims` in `accounts/auth.ts`        |
| Accepting CLI tokens    | `authenticate` takes a list of OAuth audiences and picks by the token's `aud`; a separate middleware admits CLI tokens to the routes in §9.1 only |
| Decision identity and `via` | The decision-route middleware sets the identity (§9.1); `Actor` and `actorSchema` in `@retainer/shared` |
| `Caller.cli`, the `cli` `PersonCheck`, `recheckElevation` | `auth/`, `memory/profiles.ts` (`recheckPerson`), and called in each decision service and `people.*` function (§5.1) |
| Passkey step-up and the add/remove guard | A migration for the `passkey` trigger; `packages/server/src/accounts/` (control function), with `@simplewebauthn/server` as a direct dependency of `@retainer/server`, pinned to the version the passkey plugin uses |
| `retainer-ops user passkeys clear` | `packages/server/src/operator/` |
| `cli_approvals`, `retainer_cli_access` | Migrations; the function is `SECURITY DEFINER` and goes in the reviewed list of `test/db/security.test.ts` |
| Approval pages          | `packages/web`: `/app/cli/approve/<id>`; deep links to the existing routine and extension review screens |
| The skill               | `plugins/retainer/skills/retainer-cli/`                                                    |

### 9.1 The routes a CLI token reaches

Default deny: a CLI token reaches only the routes below, by method and path.
`signedIn` on `/account` is not widened; a separate middleware admits CLI
tokens to the listed `/account` routes and refuses them everywhere else.

**Lifecycle (the CLI token, its own login only).** `POST
/account/cli/approvals` (start an elevation), `GET /account/cli/approvals/:id`
(status, for `wait`), `POST /account/cli/approvals/:id/end`, and `DELETE
/account/cli/login` (logout). The row's
`login_id` must match the token's `cli_login`; another login of the same
person gets 404. The browser's `POST /account/cli/approvals/:id/decide` is
cookie-only, with the web app's CSRF header, and never accepts a CLI token.

**Chats with the workspace agent.** `GET` and `POST /v1/agent/chats`, `GET`
and `DELETE /v1/agent/chats/:id`, and `POST /v1/agent/chats/:id/token` and
`/cancel` ([agent.md](agent.md) §6.7). The chat's agent acts as
`retainer-agent:<user>` within the person's role, never as the person; it
writes only while the login is elevated in that workspace, checked at each
write, and it reaches no decision route.

**Logged in (as the agent, `read` only).**

- `/account`: `GET /account`, `GET /account/organizations/:id`, the
  organization's invitation list, `GET /account/workspaces/:id/members`,
  `GET /account/workspaces/:id/keys`, `GET /account/workspaces/:id/connections`,
  `GET /account/connections`.
- `/v1`: `GET /review`, `GET /assertions/:id`, `GET /schema`,
  `GET /schema/changes`, `GET /schema/changes/:id`, `GET /extensions`,
  `GET /extensions/:id`, `GET /extensions/catalog`, `GET /routines`,
  `GET /routines/:id`, and the record reads `review show` needs to explain a
  case (`GET /records/:id`, `GET /records/:id/assertions`).
- The workspace agent's chats (agent spec §6.1), the person's own only:
  `POST /v1/agent/chats`, `GET /v1/agent/chats`, `GET /v1/agent/chats/:id`,
  `POST /v1/agent/chats/:id/token`, `POST /v1/agent/chats/:id/cancel`,
  `DELETE /v1/agent/chats/:id`. The stream token minted here carries the
  login and its elevation; the agent writes, as the chat agent, only while
  that elevation is open (§5.2).

**Decision routes (as the person, when elevated in that workspace or
organization).**

| Decision                         | Route                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| Accept or reject a pending value | `POST /v1/assertions/:id/accept`, `…/reject`                           |
| Merge or dismiss a duplicate     | `POST /v1/review/merges/:id/merge` (new, §5.2), `POST /v1/review/merges/:id/dismiss` |
| Approve or reject a schema change | `POST /v1/schema/changes/:id/approve`, `…/reject`                     |
| Reject, pause, resume a routine  | `POST /v1/routines/:id/versions/:version/reject`, `…/:id/pause`, `…/:id/resume` |
| Disable or remove an extension   | `POST /v1/extensions/:id/disable`, `…/uninstall`                       |
| Workspaces                       | `POST /account/workspaces`, `PATCH /account/workspaces/:id`            |
| Members                          | `PUT`, `DELETE /account/workspaces/:id/members/:userId`; `PATCH`, `DELETE /account/organizations/:id/members/:userId` (not to or from owner) |
| Invitations                      | `POST /account/organizations/:id/invitations` (not as owner), `DELETE …/invitations/:invitationId` |
| Keys and connections             | `DELETE /account/workspaces/:id/keys/:keyId`, `DELETE /account/workspaces/:id/connections/:connectionId`, `DELETE /account/connections/:connectionId` |

**With an approval** (`action`, §5.3), as the person:
`DELETE /account/workspaces/:id`, `POST /account/workspaces/:id/keys`, and
the member and invitation routes above when they grant or remove the owner
role.

**Never**, elevated or not, including everything not listed above:
`/account/auth/*`, `/account/oauth/*` (consent and the client lookup),
`POST /account/invitations/:token/accept`, `DELETE` and `PATCH
/account/organizations/:id`, anything that changes sign-in methods or
passkeys or deletes the person's account, the browser's decide endpoint,
`POST /v1/records/:id/merge`,
routine version approval, the extension commit routes (`POST /v1/extensions`,
`…/:id/upgrade`, `…/:id/configure`, `…/:id/access`, `…/:id/turn-on`,
`…/:id/enable`), routine `archive`, `forget`, event moves, and every `/v1`
write not in the decision table.

This list is the riskiest part of the change, so §11 tests every kind of
credential against every one of these routes.

## 10. Order

**One PR** (fewer, larger PRs): the rename (§8), login and the token (§4),
elevation and confirmations (§5), the CLI's commands (§6), the skill (§7),
the docs, and the spec changes this one makes to accounts spec 4.3 and 4.5.

**Later, when needed:**

- Device-code login, for agents in cloud sandboxes (§4.1).
- Storing credentials in the OS keychain.
- CI and scripts: `RETAINER_API_KEY` for the commands an agent's key may run
  (listing, proposing). Keys never make decisions or manage people.
- `retainer mcp` in place of `retainer-mcp`, and a `retainer mcp add` that
  runs `claude mcp add` with a workspace's pinned address.

## 11. Tests

Integration tests against real Postgres, as everywhere:

- **Every credential against every route in §9.1.** Accounts-mode API keys,
  MCP tokens (base and pinned), extension tokens, run and routine tokens on
  the `/account` routes and the decision routes: refused, as today. A CLI
  token on `/mcp`, on any route not in §9.1, and on every "Never" route,
  elevated or not: refused. Operator-created user admin keys keep the access
  they have today (routine approval, `adminIdentity`).
- **Logged in, not elevated:** every decision route refused with
  `elevation_required`; the listed reads allowed; an unlisted `/v1` write
  that an agent key with `write` could make (a saved view, a record) refused.
- **Elevated:** each decision allowed and recorded with `via`; the person's
  role still caps everything (a viewer who elevates can't approve); a window
  in one workspace allows nothing in another; a workspace window allows no
  organization action; resuming a routine paused for a repair returns
  `approval_required` and approves nothing; schema approval rechecks the
  window after its schema locks.
- **Window rules:** ends at its time; `--end`, logout, disconnect and losing
  the role end it, and getting the role back doesn't revive it; another login
  of the same person doesn't get it and can't poll or end it; another person
  can't approve it; a decision waiting on a lock when the window ends is
  refused.
- **Passkeys:** with a passkey enrolled, approval with only a fresh session,
  with an assertion for another approval, or with a reused assertion fails;
  registering or deleting a passkey without an assertion from an existing
  one fails, so an ordinary session can't bring enrollment to zero and then
  approve with the fallback; a registration started with no passkeys can't
  commit once another passkey has been added; approving creates no session.
- **Confirmations:** each `action` in §5.3 refused without its approval even
  when elevated; an approval runs only the action whose hash it carries,
  once, and only for its own login; an expired approval, a revoked login and
  a lost role refuse it; owner invitations need one; after a lost response,
  status names the created key. Routine approval and extension
  install, upgrade and configure return only a link and change nothing.
- **Merge by suggestion:** the CLI token can't call `POST
  /v1/records/:id/merge`; `review/merges/:id/merge` merges only that
  suggestion's pending pair, takes no field values, refuses a `keep` outside
  the pair, and refuses one already decided.
- **Logout:** works with no workspace and no elevation, ends this login's
  elevations, and leaves a second login working.
- **Concurrency:** two approvals of the same request, an approval racing its
  expiry, two retries of one confirmed action, and `--end` racing a decision
  each decide once.
- **Login identity:** two logins of the same person are two rows; disconnecting
  one leaves the other working; a dynamically registered client can't get a
  `/cli` token.
- **Existing grants unchanged:** MCP tokens (base and pinned) and
  installation tokens issue, refresh and work as before, with consents and
  keys created before the migration. This protects the experimental hosted
  workspaces.
- **Key mode:** CLI tokens refused; `retainer login` explains why.
- **The agent's chat (agent spec §6.7):** a CLI login reaches the
  `/v1/agent/chats` routes for its own chats only. A chat turn minted from
  it writes only while the login is elevated in that workspace; a window
  that ends mid-turn refuses the next write with `elevation_required`; the
  chat agent is refused on every decision route; its writes carry the actor
  `retainer-agent:<person>`.

The CLI itself gets unit tests for its output contract (§6.2), run with a
runner that buffers output until exit, and an e2e test with Playwright: log
in through the loopback redirect, elevate through the approval page, approve
a schema change, check History shows "through Retainer CLI".

## 12. Decided

The product owner answered the open questions on 2026-11-23:

1. **Window length.** 30 minutes by default and 60 at most.
2. **Publishing.** `@retainer/cli` is published to npm.
3. **Device-code login.** Later, not in the first PR (§10).
