# The `retainer` CLI: spec

Status: **proposed**, 2026-11-23. Nothing here is built. The product owner
decided three things: there will be a command-line tool for admins and
developers, its main users are their AI agents (Claude Code, Codex and
others with a shell), and it is called `retainer`. The operator CLI that has
that name today becomes `retainer-ops` (§8). The rest is a proposal.

## 1. The idea on one page

An admin who works with an agent should be able to say "invite Ben as an
editor", "go through the duplicate suggestions with me" or "install the Gmail
extension" and have the agent do it from the terminal.

Today the agent can't. MCP gives it records, events and facts, but every
decision a person makes is closed to agents on purpose: reviewing duplicates
and pending values, approving schema changes, extensions and routines,
managing people and keys (accounts spec 4.3, routines spec 5.3). Those
decisions happen only in the web app.

The CLI opens them to an agent **while its person is working with it**, and
not otherwise:

1. **`retainer login`** connects the CLI to the person's account through the
   browser, like `gh auth login`. With that login the agent has what an MCP
   connection has: it reads and writes as an agent ("Retainer CLI for Dana"),
   within the person's role. It can also see what is waiting for a decision.
2. **`retainer elevate`** asks the person, in the browser, to let the agent
   decide for them for a short time (30 minutes by default). Within that
   window the agent can make the decisions the person could make, and they
   are recorded as the person's, through the CLI.
3. **A few actions need a click every time**, even while elevated: deleting a
   workspace, creating an API key, making someone an owner, erasing personal
   data (§5.3).

The person and the agent work through the cases together. The agent explains
and recommends, the person decides in the chat, and the agent carries it out.
An agent left running on its own can't decide anything, because elevation
ends by itself and only a person can start it.

The CLI covers what MCP leaves out: people, keys, workspaces, connections,
extensions and decisions. It has no commands for records; agents use MCP for
those (§6.3).

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
they opened the window, it is short) without the clicks. Per-action
confirmation stays only for the few actions that can't be undone (§5.3).

**Prior art.** `gh auth login` (browser login for a CLI), `sudo` and GitHub's
sudo mode (a short window of higher access after a fresh check), and cloud
CLIs that print a link and wait for approval in the browser (`gcloud auth
login --no-launch-browser`, device-code flows).

## 3. Who can do what

Everything is capped by the person's role in the workspace, as everywhere
else (accounts spec 4.3). A viewer who elevates is still a viewer.

| Action                                                                   | Logged in | Elevated | Click each time |
| ------------------------------------------------------------------------ | --------- | -------- | --------------- |
| List workspaces, members, invitations, keys, connections, extensions     | Yes       | Yes      |                 |
| See what is waiting: duplicates, pending values, schema changes, routine versions, extension approvals | Yes | Yes |   |
| Print a workspace's MCP address (pinned address, accounts spec 4.7)          | Yes       | Yes      |                 |
| Propose a schema change, preview an extension, propose a routine         | Yes       | Yes      |                 |
| Non-destructive schema changes                                           | With `schema:write`, as an agent | Yes |   |
| Invite a teammate, revoke an invitation                                  |           | Yes      |                 |
| Change a member's role, remove a member                                  |           | Yes      |                 |
| Make someone an organization owner                                       |           |          | Yes             |
| Create or rename a workspace                                             |           | Yes      |                 |
| Delete a workspace                                                       |           |          | Yes             |
| Merge or dismiss duplicates; accept or reject pending values             |           | Yes      |                 |
| Approve or reject a schema change                                        |           | Yes      |                 |
| Install, configure, upgrade, disable or remove an extension             |           | Yes      |                 |
| Approve, reject, pause or resume a routine version                       |           | Yes      |                 |
| Revoke an API key; disconnect an app                                     |           | Yes      |                 |
| Create an API key                                                        |           |          | Yes             |
| Erase a record's personal data (`forget`), move events                   |           |          | Yes             |

"Logged in" is exactly an MCP connection's power plus reading account
information: the same scopes (`read`, `write`, `schema:write`), the same
agent rules. "Click each time" works whether or not the CLI is elevated.

## 4. Logging in

### 4.1 The flow

`retainer login [--server <url>]`:

1. The CLI starts a listener on `127.0.0.1` on a free port, makes a PKCE
   verifier, and prints one line: the authorization URL. It also tries to
   open the browser. An agent shows the line to its person.
2. The person signs in if needed and sees a consent page: "Connect the
   Retainer CLI. It works as an agent in every workspace you can open, and
   can't make your decisions unless you allow it with `retainer elevate`."
   There is no workspace to pick (§4.3).
3. The browser is sent back to the listener, and the CLI exchanges the code
   for an access token and a refresh token. It waits up to 10 minutes, then
   gives up with a clear message.

This is OAuth 2.1 with PKCE and a loopback redirect (RFC 8252), on the OAuth
server we already run (`@better-auth/oauth-provider`, accounts spec 4.7). The
CLI is a first-party public client, `retainer-cli`, registered at startup
like Claude's clients. To check while building: that the provider accepts a
loopback redirect on any port, as RFC 8252 7.3 requires.

**Agents in the cloud.** A loopback redirect only works when the agent runs
on the person's own machine. Agents in a cloud sandbox (Claude Code on the
web, Codex cloud) need a device-code flow (RFC 8628): the CLI prints a short
code and a link, the person approves on any device. Better Auth's
`device-authorization` plugin doesn't fit as it stands: in 1.7.25 it hands
out a Better Auth session (`createSession`, then `access_token:
session.token`), which is the full web session §2 rules out. A device flow
that issues the same token as §4.2 is phase 2 (§10).

### 4.2 The token

- **Audience:** a new resource, `<origin>/cli`, with its own protected
  resource metadata. MCP and extension tokens don't work on the CLI's routes,
  and a CLI token doesn't work on `/mcp`.
- **Lifetime:** access token 1 hour, refresh token 30 days, rotated on use.
- **Where it is shown:** Your account, Connected apps, as "Retainer CLI" with
  the date and the machine's name. Disconnecting it there revokes it and ends
  any elevation.
- **On disk:** in the operating system's keychain when there is one (macOS
  Keychain, libsecret, Windows Credential Manager), otherwise in
  `~/.config/retainer/credentials.json` with mode 0600. `retainer logout`
  revokes the token on the server and deletes it locally.

### 4.3 One login, every workspace

An MCP connection belongs to one workspace. The CLI's login belongs to the
person instead, because admin work crosses workspaces: inviting someone to
the organization, creating a workspace, comparing two workspaces' members.

Each request names its workspace with the `X-Retainer-Workspace` header, as
the web app does. The server checks the person's role in that workspace on
every request, with a new `SECURITY DEFINER` function in the style of
`retainer_token_access`: `retainer_cli_access(subject, client, workspace)`
returns the role only while the consent lasts and the person can open the
workspace.

The CLI picks the workspace from, in order: `--workspace <slug|id>`, the
`RETAINER_WORKSPACE` variable, then the one saved with `retainer use
<workspace>`. That saved choice is a file on the person's machine, which they
can see and change. It is not the hidden server-side pointer that was
rejected for MCP (accounts spec 4.7): nothing on the server remembers it.

### 4.4 Who the writes belong to

Logged in, the caller is an agent:
`{ type: 'agent', id: 'cli:<user ID>', name: 'Retainer CLI for Dana' }`, with
`connectedBy` set to the person, exactly like an MCP connection. Its writes
rank as an agent's, below a person's.

Elevated, decisions are made as the person (§5.2).

## 5. Elevation

### 5.1 Starting and ending it

`retainer elevate [--minutes <n>] [--reason <text>]`:

1. The CLI asks the server for an elevation. The server answers with an ID
   and an approval URL. The CLI prints: "Open <url> to let this agent decide
   for you for 30 minutes."
2. The approval page, in the web app, shows: the client ("Retainer CLI on
   Dana's MacBook"), when it was connected, how long the window lasts, the
   reason the agent gave, and in plain words what it allows. It has Allow and
   Deny buttons. Only the person the token belongs to can approve; anyone
   else sees "This request is for another account."
3. The CLI polls until the person allows, denies, or 10 minutes pass. On
   Allow it prints when the window ends.

Rules:

- The default window is 30 minutes and the maximum is 60.
- The window belongs to this token. Another CLI login or an MCP connection of
  the same person doesn't inherit it.
- The person approves with a session signed in within the last 12 hours, or
  signs in again first (open question 1).
- `retainer elevate --end` ends it early. So do `retainer logout`,
  disconnecting the CLI in Your account, and losing the role. Your account
  shows an active window with an End now button.
- An elevation can't be started without a person, because approving it needs
  their browser. An unattended agent can ask, but nothing happens until
  someone clicks.
- When the window ends mid-command, the server refuses the next decision
  with `elevation_required` (§6.2) and nothing is half done: each decision is
  its own transaction, as today.

### 5.2 What changes while elevated

The person-only checks (`requireUser`, `canApproveDestructive`,
`adminIdentity` and the `/account` routes) accept an elevated CLI caller as
the person. Concretely, the caller carries a `decider`: the person's user
ID, scopes from their role, and `via: 'Retainer CLI'`. Those checks read the
decider instead of the actor.

**Only decisions change.** Records, events and facts the agent writes while
elevated are still the agent's, ranked as an agent's. Otherwise any value an
agent wrote in that window would outrank later agent writes as if a person
had set it.

**The record says how a decision was made.** `Actor` gets an optional `via`
field, for display only. A decision made while elevated is stored as
`{ type: 'user', id: <user>, name: 'Dana Cohen', via: 'Retainer CLI' }`,
and the web app shows "Dana Cohen, through Retainer CLI" in History, the
review inbox and the routine and extension pages. `via` never changes
precedence or permissions.

### 5.3 Actions that need a click every time

Some actions are dangerous even with the person present, because a
misunderstanding between person and agent can't be undone, or because the
result outlives the window:

- deleting a workspace or an organization;
- making someone an organization owner;
- creating an API key, which keeps working after the window ends;
- `forget`, which erases personal data, and moving events.

For these the server answers `confirmation_required` with a URL to a page
that shows the exact action ("Delete the workspace Dana Support and
everything in it. It can be restored for 7 days"). The CLI prints the URL and
waits, as for elevation. The page requires a recent sign-in, as in §5.1.
Approving it carries out that one action and nothing else; the request is
bound to a hash of the action and its arguments, so the agent can't swap in a
different one.

Elevation and confirmation share one table, `cli_approvals`: `id`, the token
it belongs to, `kind` (`elevation` or `action`), the action and its hash,
`status`, `expires_at`, and who decided and when. Approving uses an atomic
`update … where status = 'pending'`, so two clicks or a click racing the
expiry decide it once.

## 6. The CLI

### 6.1 Commands

```
retainer login [--server <url>]        Connect this machine (§4)
retainer logout
retainer whoami                        Account, server, workspace, elevation time left
retainer elevate [--minutes <n>] [--reason <text>] | --end

retainer workspaces                    The workspaces you can open
retainer use <workspace>               Default workspace for later commands
retainer workspace create <name> [--template <t>]
retainer workspace rename <name>
retainer workspace delete <workspace>  Click each time
retainer mcp-address [<workspace>]     The workspace's pinned MCP address

retainer members
retainer invite <email> --role <viewer|editor|admin> [--org]
retainer invitations | retainer invitation revoke <id>
retainer role <email> <role>
retainer remove <email>

retainer keys | retainer key create <name> --access <…> | retainer key revoke <id>
retainer connections | retainer disconnect <id>

retainer review                        Everything waiting for a decision
retainer review show <id>
retainer duplicates merge <id> | dismiss <id>
retainer pending accept <id> | reject <id>
retainer schema-changes | approve <id> | reject <id>

retainer extensions | extension show <id>
retainer extension install <name> | configure <id> | upgrade <id> | disable <id> | remove <id>
retainer routines | routine approve <id> <version> | reject … | pause <id> | resume <id>
```

The names are a starting point. The rule is one command per decision, named
after what the web app calls it.

### 6.2 Built for agents to read

- **JSON when not in a terminal.** When stdout isn't a TTY, or with `--json`,
  every command prints one JSON document. In a terminal it prints plain
  tables.
- **Never asks a question.** No prompts. A command that needs something
  missing fails and says what to pass.
- **Errors say what to do next.** Each error has a code, a sentence and the
  command that fixes it, for example
  `{"error":"elevation_required","message":"Approving a schema change is your person's decision.","next":"retainer elevate --reason \"approve the Deals schema change\""}`.
- **Exit codes:** 0 done, 1 failed, 2 wrong usage, 3 not logged in, 4 needs
  elevation, 5 waiting for the person timed out.
- **Waiting is visible.** A command that waits for the browser prints the URL
  on its first line, then waits quietly. Agents that run commands with a
  timeout can run it in the background.
- **`--help` is complete** and written for an agent to read: each command
  with its arguments, an example, and whether it needs elevation.

### 6.3 What the CLI leaves to MCP

No commands for records, events, facts, search or memory. Agents already
have MCP for those, with its instructions and guides; a second way to write
records would need its own rules for sources, precedence and review.
Developers who script data work use the REST API or `@retainer/sdk`.

### 6.4 Several servers

`--server <url>` or `RETAINER_URL` picks the server; the default is the one
logged in last. Credentials are stored per server, so a self-hosted server
and retainer.tamloot.cc can both be logged in.

The CLI works only with servers in accounts mode (accounts spec 4.1). A
server in key mode has no people to log in as: `retainer login` there says
so and points to `retainer-ops` (§8).

## 7. The skill

The Claude Code plugin (`plugins/retainer`) gets a skill, `retainer-cli`,
that teaches an agent:

- use MCP for records and the CLI for people, keys, workspaces, extensions
  and decisions;
- before `elevate`, tell the person why and which decisions are coming, and
  pass that as `--reason`;
- go through decisions one at a time: explain the case, recommend, and act
  only on the person's word;
- end the window with `elevate --end` when the review is done;
- never start an elevation in an unattended run.

These are instructions, not guarantees. The guarantee is that elevation
needs the person's click and ends by itself.

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
| The `retainer-cli` client, the `/cli` resource and its metadata | `packages/server/src/accounts/`                       |
| Accepting CLI tokens    | `authenticate` on `/v1` and on the `/account` routes listed in §3                         |
| `decider` and `via`     | `Caller`, `requireUser`, `canApproveDestructive`, `adminIdentity`; `Actor` in `@retainer/shared` |
| `cli_approvals`, `retainer_cli_access` | Migrations; the function is `SECURITY DEFINER` and goes in the reviewed list of `test/db/security.test.ts` |
| Approval pages          | `packages/web`: `/app/cli/approve/<id>`                                                   |
| The skill               | `plugins/retainer/skills/retainer-cli/`                                                    |

The `/account` routes today take a session cookie only (accounts spec 4.5).
This design lets a CLI token reach them too. That is the riskiest change
here, so §11 tests every kind of credential against every one of those
routes.

## 10. Order

**One PR** (fewer, larger PRs): the rename (§8), login and the token (§4),
elevation and confirmations (§5), the CLI's commands (§6), the skill (§7),
the docs.

**Later, when needed:**

- Device-code login, for agents in cloud sandboxes (§4.1).
- CI and scripts: `RETAINER_API_KEY` for the commands an agent's key may run
  (listing, proposing). Keys never make decisions or manage people.
- Publishing: `@retainer/cli` goes to npm with the first release, which is
  on hold (open question 3). Until then it runs from the repo.
- `retainer mcp` in place of `retainer-mcp`, and a `retainer mcp add` that
  runs `claude mcp add` with a workspace's pinned address.

## 11. Tests

Integration tests against real Postgres, as everywhere:

- **Every credential against every route it must not reach.** API keys, MCP
  tokens (base and pinned), extension tokens, run and routine tokens on the
  `/account` routes and the decision routes: all refused, as today. A CLI
  token on `/mcp`: refused.
- **Logged in, not elevated:** every decision route and every route in §3's
  "Elevated" column refused with `elevation_required`; reads and agent
  writes allowed; writes recorded as "Retainer CLI for Dana".
- **Elevated:** each decision allowed and recorded with `via`; record writes
  in the window still the agent's; the person's role still caps everything
  (a viewer who elevates can't approve).
- **Window rules:** ends at its time; `--end`, logout, disconnect and losing
  the role end it; another token of the same person doesn't inherit it;
  another person can't approve it.
- **Confirmations:** each action in §5.3 refused without its own approval
  even when elevated; an approval runs only the action whose hash it carries.
- **Concurrency:** two approvals of the same request, and an approval racing
  its expiry, decide it once.
- **Key mode:** CLI tokens refused; `retainer login` explains why.

The CLI itself gets unit tests for its output contract (§6.2) and an e2e test
with Playwright: log in through the loopback redirect, elevate through the
approval page, approve a schema change, check History shows "through
Retainer CLI".

## 12. Open questions

1. **Fresh sign-in.** Should approving an elevation require a sign-in within
   12 hours, or a passkey or second factor each time when the person has one?
   Proposed: within 12 hours, and a passkey when enrolled.
2. **Window length.** 30 minutes by default and 60 at most?
3. **Publishing.** Ship `@retainer/cli` with the first npm release, which is
   on hold until the product owner asks?
4. **Device-code login in the first PR?** Needed only for agents in cloud
   sandboxes. Proposed: later.
5. **Organization-level commands.** Inviting someone to the organization,
   creating workspaces and changing organization roles act on the
   organization, not a workspace. Is the person's organization role enough,
   with `--org` to pick the organization when they have several?
