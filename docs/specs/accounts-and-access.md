# Accounts, organizations and access: spec

Status: **implemented** November 7, 2026, in the three pull requests of section 6.
Proposed November 6, 2026; Better Auth was chosen for login after a throwaway test,
whose results are in section 12. Where building changed the design, the section says
so under "As built". The design is summarized in `ARCHITECTURE.md` 7.3.

This spec turns Retainer from a server an operator runs into a service people
sign up for: they log in, create workspaces, invite colleagues and connect
agents. It amends `ARCHITECTURE.md` section 7 and `FRONTEND.md` section 4 and
adds deployment pieces to [Deploying to AWS](../aws.md).

## 1. Why

### 1.1 What already works

Workspaces are already isolated for many tenants. Every tenant table has
`workspace_id`, row-level security (RLS) applies to every query, tenant foreign
keys include the workspace, and the server runs as `retainer_app`, which owns
nothing and has no `BYPASSRLS`. `deploy/aws` runs the service on Lambda, API
Gateway and RDS. None of that needs redesigning.

### 1.2 What is missing

- **People have no identity.** A person signs in by pasting an API key, and
  the session cookie holds that raw key (`packages/server/src/auth/session.ts`).
  There are no users, and a key is the only credential.
- **Only an operator can create a workspace.** `createWorkspace` needs the
  migration role, and the runtime role cannot insert workspaces. That is right
  for a self-hosted install and blocks self-serve signup.
- **Nobody can share a workspace properly.** Each person needs a key issued by
  an operator. There are no invitations or roles.
- **Some agents cannot connect.** `/mcp` accepts only API keys, so clients that
  only support OAuth, such as connectors in Claude's web app, cannot use it.
- **Tenants are assumed to be trusted.** There is one global throttle and no
  quotas, and every function shares one database login (4.9).

## 2. Scope

**In scope:** users and sessions; organizations; roles at organization and
workspace level; self-serve workspaces; invitations; API keys in the web app;
OAuth for MCP; passkeys; the hardening a public signup needs.

**Out of scope, with the door left open (section 7):** groups, record-level
access, field-level access, a permission service, multi-factor authentication
(4.11), billing. The seam billing will use is in scope (4.10); Stripe itself is
not.

**What does not change:** the workspace stays the security boundary. RLS stays
keyed on `workspace_id`. Records get no organization column. A `Caller` still
has exactly one workspace. Queries never cross workspaces. Retainer still calls
no language model.

**What is open source.** If one team running Retainer on its own server would
need something, it is open. If only someone selling Retainer as a service needs
it, it is not. Every feature in this spec is open. Plans for running the hosted
service, such as costs, support and launch steps, are kept privately. Publishing
cannot be undone, so when unsure, decide first.

## 3. Decisions

| #   | Decision                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Keep the backend and RLS. Clients never talk to the database (3.1).                                                              |
| A2  | People log in through Better Auth, running in our control function: Google and passkeys only. No passwords and no email sign-in. |
| A3  | A session is a second way to build a `Caller`. Everything after `authenticate` is unchanged.                                     |
| A4  | Sessions are Better Auth's: a signed cookie and a raw token in the database. The cookie no longer holds an API key.              |
| A5  | Organizations own workspaces and members. They are hidden in the UI until someone needs them.                                    |
| A6  | Access is RBAC at workspace level (3.2). Roles are named bundles of the existing scopes.                                         |
| A7  | The client names the workspace on each request, and the server checks access each time.                                          |
| A8  | A narrow `retainer_control` role does account work. Nothing reachable from the internet uses the owner role.                     |
| A9  | Only the control function has internet, through a NAT gateway. The api, consolidate and ops functions stay without it (4.6).     |
| A10 | MCP OAuth uses Better Auth's `mcp()` and `cimd()` plugins. Each request rechecks the person's role and consent (4.7).            |
| A11 | No third-party permission service for now, managed or self-hosted (3.3).                                                         |
| A12 | Whole workspaces are the finest thing to hide at launch (3.2).                                                                   |
| A13 | Passkeys ship in the first version. Multi-factor authentication does not (4.11).                                                 |
| A14 | Accounts live in the open repo (AGPL), so self-hosters get login. Billing stays private (4.10).                                  |
| A15 | Signup is open on every install in accounts mode, including self-hosted ones (4.8).                                              |

### 3.1 Why not a Supabase-style design

In that design the browser reaches the database through a generated API, and
RLS with a signed token is the main access check. Retainer's rules cannot live
there: deriving `records.data` from assertions, the schema engine, `forget`
locking, identifier claims and idempotency all need server code. Agents need
MCP, and self-hosters need plain Postgres.

The cost of this design is that RLS here is a second line of defense. It trusts
the `app.workspace_id` the server sets, so it catches a query that forgets to
filter, not a server that picks the wrong workspace. The access check in
`authenticate` is therefore the real gate, and it needs the most tests.

### 3.2 The four questions of access

| Question                   | Enforced by                             | Status           |
| -------------------------- | --------------------------------------- | ---------------- |
| Which workspace's data?    | RLS on `workspace_id`                   | Done             |
| What can you do there?     | Roles mapped to scopes, on each route   | This spec        |
| Which records can you see? | Restrictive RLS (`ARCHITECTURE.md` 7.2) | Not in this spec |
| Which fields can you see?  | Neither fits; avoid                     | Not planned      |

RLS cannot hide fields because values sit in `records.data` as JSONB, and also
in the search index and `field_assertions`. To hide a field from some people,
use a separate object or workspace.

### 3.3 Why no permission service

We looked at SpiceDB, OpenFGA, Auth0 FGA, AuthZed Cloud, WorkOS FGA and Cerbos
(their documentation as read on November 6, 2026). They are good at storing
rules and answering "can X do Y?". For Retainer:

- **At launch they add work.** Workspace roles are a few tables and one lookup.
- **Lists are the hard part.** Retainer's reads are search, filtered queries,
  counts and aggregates. OpenFGA's `ListObjects` defaults to 1,000 results and a
  3-second deadline. SpiceDB suggests its lookup below about 10,000 results, and
  calls its commercial Materialize the most scalable option. Checking results
  page by page does not work for counts and aggregates.
- **Enforcement leaves Postgres.** RLS cannot call a service, so every read path
  would have to remember the check. Section 7.2 of the architecture rejects
  that. SpiceDB's Postgres connector is marked experimental, and it runs
  aggregates and sorting on the client.
- **Two stores can disagree.** A record and its access rule cannot commit in one
  transaction, and `forget` would have to clean both.
- **It breaks deployment promises.** Self-hosters would run a second server. A
  managed service would need internet from functions that have none, and would
  hold access data outside the AWS account. The open-source product cannot depend
  on our paid account.
- **The hard product questions stay** (7.2).

Wanting "a Zanzibar-style model" is not a reason by itself. Write the rule as a
customer would say it and see whether it fits a fixed number of joins. If it
does, Postgres handles it.

**When to reconsider.** Any one of these, if paying customers need it:

1. Access flows through nesting of any depth, set up by customers.
2. Rules must apply beyond Retainer's Postgres, such as a second product.
3. Keeping `record_access` (7.3) current becomes the main cost.
4. Customers write their own rules and roles.
5. "Who can see this, and why?" can no longer be answered reliably.

Groups, SSO, enterprise customers, more users and single-record sharing do not
qualify. If a trigger fires, prefer a self-hosted Apache-2.0 engine, keep
workspace RLS, and feed `record_access` from its change feed so RLS stays the
enforcer. Prototype against filtered search with counts in a large workspace
first.

### 3.4 Why Better Auth rather than WorkOS

Better Auth is an MIT library that runs in our process and keeps its data in our
Postgres. Self-hosters keep all their account data themselves, and it includes the
OAuth server MCP needs. WorkOS would handle security fixes, enforced MFA and
enterprise SSO, but every install would depend on an outside service.

The cost we accept is upkeep: its project lists 49 security advisories, 4 of them
critical, including several in plugins we use (4.12). The choice can be reversed:
with no passwords there are no hashes to migrate, and everything past the
`Caller` stays the same.

## 4. System design

### 4.1 Two modes

| Mode          | When                                             | People sign in with | Workspaces come from   |
| ------------- | ------------------------------------------------ | ------------------- | ---------------------- |
| Key (default) | Neither setting below                            | A personal API key  | The operator CLI       |
| Accounts      | `RETAINER_AUTH_SECRET` and a Google OAuth client | Google or a passkey | The CLI or the web app |

A self-hosted install that upgrades sees no change unless it sets those values.
Accounts mode needs a Google OAuth client, since Google is how a person first signs
in, so a self-hoster sets up their own in Google Cloud or stays in key mode. Setting
only one of the two is a configuration error, and the server refuses to start rather
than quietly running in key mode. Signup is open in accounts mode (4.8), so a
self-hoster who wants a private install stays in key mode.
In accounts mode `POST /auth/session` returns 404. API keys work for agents in both
modes.

### 4.2 Data model

These tables are not tenant tables. Like `api_keys`, they have RLS enabled, no
policy for the runtime role and no grants to it.

**Owned by Better Auth.** Its `user`, `session`, `account`, `verification`,
`passkey` and `rateLimit` models, named `users`, `sessions`, `auth_accounts`,
`auth_verifications`, `passkeys` and `auth_rate_limits` through its `modelName`
option, since `user` is a reserved word in Postgres. PR 3 adds `jwks` and the
`oauth_*` tables. They are written from its table definitions (`getAuthTables`)
in this schema's style, with snake_case columns and `timestamptz`, then go through
`pnpm db:generate` like any other table. IDs are UUIDs. `users` gains
`disabled_at` as an additional field.

**Ours.**

| Table                  | Columns                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`        | `id`, `name`, `limits` (4.10), `created_at`                                                                                           |
| `organization_members` | `organization_id`, `user_id`, `role` (`owner`, `admin`, `member`), `created_at`                                                       |
| `workspace_members`    | `organization_id`, `workspace_id`, `user_id`, `role` (`admin`, `editor`, `viewer`), `created_at`                                      |
| `invitations`          | `id`, `organization_id`, `email`, `role`, `workspaces` (jsonb), `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at` |

We do not use Better Auth's organization plugin. It stores roles as comma-separated
strings, has no idea of workspaces, and cannot join the single transaction that
creates an organization, workspace and seed (4.5).

Changes to existing tables:

- `workspaces.organization_id`: required, `ON DELETE RESTRICT`, with a unique
  `(organization_id, id)`. Add it nullable, backfill, then make it required.
  Deleting an organization never cascades into workspaces.
- `workspaces.deletion_scheduled_at` (4.5).
- `api_keys.created_by_user`.

`workspace_members` has composite foreign keys to `organization_members` and to
`workspaces (organization_id, id)`. A person can therefore only hold a role in
a workspace of an organization they belong to, and leaving the organization
removes those roles in the same statement.

A person's identity is their Google account, matched by Google's stable subject ID,
not by email. We refuse a sign-in whose address Google has not verified, and
invitations compare against the verified address. Passkeys attach to that user
(4.11).

**Existing data.** The migration creates one `Default` organization and moves
every existing workspace into it. `bootstrap` does the same on a new container
install. `Default` starts with no owner, because neither step knows any person, so
an operator makes the first one with `member add`. Until then its workspaces are
managed through the CLI, and their API keys keep working. The CLI gains `org create`, `org list`, `member add` and `workspace
move`, and `workspace create` gains `--org`, defaulting to `Default`.

### 4.3 Roles

Workspace roles are bundles of the existing scopes. Routes keep calling
`requireScope` and do not change.

| Workspace role | Scopes                                   | In plain words                                                                               |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `viewer`       | `read`                                   | Can see everything in this workspace                                                         |
| `editor`       | `read`, `write`                          | Can also add and change records, comment and review                                          |
| `admin`        | `read`, `write`, `schema:write`, `admin` | Can also change the workspace's structure, erase personal data, and manage people and agents |

Organization roles:

| Organization role | Means                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| `owner`           | `admin` in every workspace; billing; delete the organization; manage owners |
| `admin`           | `admin` in every workspace; create workspaces; invite and remove members    |
| `member`          | Only the workspaces they are added to, with the role set there              |

A person's effective role is `admin` if they are an owner or admin of the
organization, otherwise their `workspace_members` role, otherwise none.

The full table of what each kind of caller can do:

| Action                                | Viewer | Editor | Admin | Agent               |
| ------------------------------------- | ------ | ------ | ----- | ------------------- |
| Read and search                       | Yes    | Yes    | Yes   | With `read`         |
| Write records, events and facts       |        | Yes    | Yes   | With `write`        |
| Write comments                        |        | Yes    | Yes   | Never               |
| Review assertions and merges          |        | Yes    | Yes   | Never               |
| Non-destructive schema changes        |        |        | Yes   | With `schema:write` |
| Destructive schema changes            |        |        | Yes   | Propose only        |
| `forget`, moving events               |        |        | Yes   | Never               |
| Manage API keys and workspace members |        |        | Yes   | Never               |

The human-only rules (`requireUser`, `canApproveDestructive`, the comment rule)
stay as a separate check. A scope is never a person's approval.

The role tables live in `packages/shared`, so the server and the web app read
one definition. A test runs every role against every route.

### 4.4 Authentication

`Caller` gains an optional `userId`. `authenticate` works in this order:

1. **`Authorization` header present:** an API key as today, or an OAuth token (4.7).
   It never falls back to the cookie.
2. **Better Auth session cookie:** requires `X-Retainer-Workspace`. The api
   function verifies the cookie's signature with `RETAINER_AUTH_SECRET`, then calls
   `retainer_session_access(session_token, workspace_id)`.
3. **Key-mode cookie:** as today.

The api function does not import Better Auth, and `pnpm lint` fails if it does
(4.13).

`retainer_session_access` is `SECURITY DEFINER`, fixes its `search_path` and is
granted only to `retainer_app`. It takes the session token, not a user ID, so the
runtime role cannot ask about an arbitrary person. It returns the user and the
effective role.

| Result           | Response                                                     |
| ---------------- | ------------------------------------------------------------ |
| No row           | 401: expired, revoked or unknown session, or a disabled user |
| Row with no role | 404: the workspace's existence is not revealed               |
| Row with a role  | `Caller { workspaceId, actor: user:<id>, scopes, userId }`   |

Access is checked on every request, so removing someone or changing their role
applies at their next request. Cookie-authenticated mutations keep the
`X-Retainer-Client` and Origin checks.

**Session tokens are stored raw (A4).** Better Auth has no option to hash them. A
wrapper that hashed them made sign-out and single-session revocation stop working
without any error, so we do not use one. The signature is the protection: a token
read from the database alone is refused, because a valid cookie also needs the
secret. This has two costs. The api function holds the secret, and it relies on
Better Auth's cookie format, which is not documented. A test using real Better Auth
cookies must fail if an upgrade changes that format. Changing the secret signs
everyone out.

**Why the workspace is per request (A7).** If the session held an "active
workspace", switching in one tab would make another tab write to the wrong
place. The client chooses the workspace and never authorizes it. A bearer
request needs no header, because keys belong to one workspace, and a header
naming a different workspace is refused with a 400.

**Session lifetime.** 30 days, with `deferSessionRefresh` on so that reading a
session writes nothing. The web app refreshes through the control function when it
loads. `disabled_at` and "sign out everywhere" end all sessions.

### 4.5 Workspaces and account routes

Account routes live under `/account`, take a session cookie only, and are never
reachable with an API key. An agent's key can therefore never create a key,
add a member or create a workspace, as `ARCHITECTURE.md` 7.1 requires.

| Route                                                           | Who                                          |
| --------------------------------------------------------------- | -------------------------------------------- |
| `/account/auth/*`: Better Auth's own routes                     | As Better Auth defines them                  |
| `GET /account`: the user, organizations, workspaces, roles      | Signed in                                    |
| `POST /account/workspaces`                                      | Organization owner or admin                  |
| `DELETE /account/workspaces/:id`                                | Organization owner or admin                  |
| `PATCH /account/workspaces/:id`: rename                         | Workspace admin                              |
| `PATCH`, `DELETE /account/organizations/:id`                    | Owner                                        |
| `GET`, `PATCH`, `DELETE /account/organizations/:id/members/...` | Organization owner or admin                  |
| `POST`, `GET`, `DELETE /account/organizations/:id/invitations`  | Organization owner or admin                  |
| `POST /account/invitations/:token/accept`                       | Signed in, verified email                    |
| `GET /account/workspaces/:id/members`                           | Anyone with a role in it                     |
| `PUT`, `DELETE /account/workspaces/:id/members/:userId`         | Workspace admin                              |
| `GET`, `POST`, `DELETE /account/workspaces/:id/keys`            | Workspace admin                              |
| `GET /account/workspaces/:id/connections`                       | All for an admin, their own for others       |
| `DELETE /account/workspaces/:id/connections/:connectionId`      | Workspace admin, or the person who connected |
| `GET`, `DELETE /account/connections/...`: your apps             | Signed in; disconnecting as above            |
| `GET /account/oauth/client`, `POST /account/oauth/consent`      | Signed in, with a role in the workspace      |

**First workspace.** A person with no memberships and no pending invitation
sees "Name your workspace". `POST /account/workspaces` then creates the
organization, owner membership, workspace and seed in one transaction, so there
are no empty organizations and nothing half-created. The person's name comes
from Google.

**One transaction.** `retainer_control` inserts the account rows and the
workspace, then runs `SET LOCAL ROLE retainer_app` and sets `app.workspace_id`
to seed through the schema engine under RLS. The template is optional, and
without one the first agent chooses as today (`ARCHITECTURE.md` 3.1).

**Slugs.** `workspaces.slug` is unique across all customers. A plain `slug_taken`
would reveal another customer's workspace name, so self-serve creation adds a
generated suffix, such as `sales-x7k2`. The CLI keeps exact slugs.

**Invitations.** A token is stored hashed and expires after 7 days. Accepting
requires a verified Google address that matches the invitation, so a forwarded link
is useless to anyone else. Accepting twice is a no-op. At launch the web app offers
"Copy invite link" and Retainer sends no email at all, so it needs no email provider.
Sending invitations by email can be added later.

**Removing a member.** Web access ends at the next request, and so do OAuth tokens
they granted (4.7). Agent keys belong to the workspace and keep working, and the
UI shows who created each one. Past writes keep their actor.

**The last owner.** Once an organization has an owner, it always has one. `Default`
is the only organization that can start without one (4.2). Membership changes lock
the organization row, so two owners removing each other cannot leave none.

**Deleting.** Deleting a workspace sets `deletion_scheduled_at`. Every lookup
then refuses it, the consolidator skips it, and after 7 days a scheduled control
run hard-deletes it, cascading as today. An operator can undo it within those days.
A large delete can outlast the 30 seconds `deploy.sh` waits for stopped functions,
so this run holds the deploy lock (`withPassLock`) as a consolidator pass does, and
the function's timeout allows for it, as consolidate's 300 seconds does.
An organization can be deleted only when it has no workspaces left.

_As built:_ `DELETE /account/workspaces/:id` takes the workspace's name in the body
as confirmation. API keys, sessions, OAuth tokens, the consolidator and invitations
all skip a workspace being deleted, and it no longer counts toward the workspace
quota. EventBridge runs the control function hourly to purge, removing each
workspace in its own statement, and the control function's timeout is now 300
seconds. A container runs the same purge hourly in its `control` or `all` process.
The CLI has `workspace restore` and `workspace purge`, and `workspace list` shows
when a deleted workspace goes for good.

**API keys in the web app** are for agents and integrations only: `read`,
`write` and `schema:write`. The actor is `agent:<slug of the name>` and cannot
be a person. Keys with a `user` actor remain CLI-only.

### 4.6 Deployment shape

```
 People (browser)                      Agents
   │ session cookie                      │ API key or MCP OAuth token
   ▼                                     ▼
 API Gateway
   │                         │ /account, /.well-known/oauth-authorization-server,
   │                         │ /.well-known/openid-configuration
   │                         ▼
   │                      control function ──► NAT ──► Google,
   │                      (Better Auth,                client metadata
   │                       retainer_control)
   │ /v1, /mcp, /app
   ▼
 api function (no internet, no Better Auth, retainer_app + RLS)
   │                         │
   └───► RDS Postgres ◄──────┘
```

- **Why the control function has internet.** Google sign-in and client metadata
  documents both need it, in the same process that writes to the database. Claude
  needs the second (4.7), so a design without internet would not serve it. A NAT
  gateway costs roughly $40 a month with its public IP address.
- **What stays isolated.** The api, consolidate and ops functions keep no route to
  the internet. `docs/aws.md` needs its promise narrowed to those three.
- **Network changes.** Today the VPC has only private subnets and no internet gateway,
  and every function shares those subnets and one security group that allows traffic
  only to the database. `control` needs private subnets of its own that route to the
  NAT gateway, so the others keep no route out, and a public subnet and internet
  gateway for the NAT. It also needs a security group of its own that allows Postgres
  and outbound HTTPS, which the database must accept.
- **Metadata routes.** OAuth clients look for the authorization server's metadata
  at the domain root, with the issuer's path appended
  (`/.well-known/oauth-authorization-server/account/auth`). Those root routes must
  reach the control function.
- **Rate limits on sign-in.** Better Auth counts in memory by default, which does not
  work across Lambda instances. Use its database storage, and set `trustedProxies`
  or `ipAddressHeaders` for API Gateway, since it otherwise trusts a header clients
  can set.
- **Container.** With `RETAINER_ROLE=all` everything runs in one process, including
  Better Auth. `RETAINER_ROLE` gains a `control` value, so self-hosters who want the
  separation run `api` and `control` in separate containers.
- **Deploys.** `deploy.sh` also stops and starts `control`.

The session cookie stays `SameSite=Strict`. Tested in Chrome: a sign-in link opened
from another site still sets it, and the app's own requests then send it. Set this on
the session cookie alone. Google's callback is a redirect from another site, so
Better Auth's OAuth state cookie probably must stay `Lax`, or sign-in will fail. The
test applied `Strict` to all cookies and did not use Google, so check this first.

### 4.7 MCP OAuth

Better Auth's `mcp()` and `cimd()` plugins are the authorization server, with the
JWT plugin signing access tokens. Claude's web app connected through them end to end
(section 12).

- **Registration.** Claude identifies itself with a client metadata document
  (`https://claude.ai/oauth/mcp-oauth-client-metadata`), which the server fetches
  from the internet, using the plugin's fetcher that pins the resolved address.
  Dynamic client registration stays on for other clients, rate limited. Whether
  Claude falls back to it when metadata documents are not offered is unknown.
- **Metadata.** A `401` from `/mcp` names the resource metadata in
  `WWW-Authenticate`. The api function serves that metadata, which is static.
- **Consent.** The authorize URL is opened from another site, so a `SameSite=Strict`
  cookie does not arrive. It redirects to our sign-in page, whose own requests carry
  the cookie and continue to `/app/oauth/consent`. The person picks a workspace there
  through the plugin's `postLogin` step, and `consentReferenceId` ties it to the
  consent. The page must not be framed (`frame-ancestors 'none'`).
- **Tokens.** One-hour JWT access tokens (`at+jwt`, EdDSA) with the workspace as a
  claim, and rotating refresh tokens stored hashed. A rotated refresh token can be
  reused for 30 seconds by default, so that a retry can recover. We keep that.
- **Checking a token with no internet.** JWTs are not stored, and a valid signature
  says nothing about removal. So on every request the api function reads the public
  signing keys through `retainer_token_keys()`, verifies signature, issuer and
  audience, and then calls `retainer_token_access(subject, workspace, client)`, which
  returns the person's role only if their consent still exists.
- **The cap.** The request's scopes are the token's scopes intersected with that
  role's. Downgrading a person, removing them or revoking consent all apply at the
  next request.
- **Actor.** Always an `agent`, so the human-only rules apply. Its ID combines the
  client and the person, and its name reads like "Claude for Dana". In the test it
  used the client alone, which would make everyone's Claude the same actor.

_As built,_ where it differs:

- **The picker is on the consent page, not a `postLogin` step.** Better Auth calls
  `consentReferenceId` with only the person, their session and the scopes, so a
  `postLogin` choice would have to be stored on the session, where two tabs
  connecting to two workspaces would race. Instead the consent page lists the
  person's workspaces and posts the one picked to `POST /account/oauth/consent`,
  which checks the person's access to it (404 otherwise), then runs Better Auth's
  consent with the workspace held in an `AsyncLocalStorage` for that request.
  Outside it, `consentReferenceId` returns a UUID that matches no workspace, so no
  earlier consent is ever reused and every authorization comes through the picker.
  Better Auth's own `/oauth2/consent` and `/oauth2/continue` are closed (404), so
  no consent can be made without a workspace. The guarantees are unchanged.
- **The consent's `reference_id` is a foreign key to `workspaces`**, deleted with
  it, and the access token carries the workspace in a `workspace_id` claim.
- **OAuth tokens work on `/mcp` only**, the resource they are issued for; `/v1`
  and `/account` refuse them.
- **Scopes are capped by the current consent too.** `retainer_token_access` returns
  the consent's scopes, so a token from an earlier connection to the same app and
  workspace never gets more than the person allowed last time.
- **Consenting takes the organization lock**, then checks access, while Better Auth
  writes the consent on its own pool, so a removal or move running at the same
  time either refuses it or finds it and ends it.
- **Removing a member ends their grants:** removing someone from a workspace or an
  organization deletes their consents there and revokes the refresh tokens.
  Re-adding them does not bring the connection back.
- **Connected apps** are the consent rows. Settings, Agents lists them (all for an
  admin, otherwise the person's own), as does Your account, each with Disconnect.
- **`frame-ancestors 'none'` and `X-Frame-Options: DENY` cover all of `/app`**,
  not only the consent page.
- **Claude's metadata document** lists the `jwt-bearer` grant type, which Retainer
  does not offer. Registration accepts it anyway, and only the authorization code
  and refresh token grants work.
- **The authorization server's metadata** is served by the control function at
  `/.well-known/oauth-authorization-server/account/auth`, and API Gateway routes
  that path to it.

### 4.8 Limits

- **Rate.** A per-workspace limit returning `429` with `Retry-After`, in addition
  to the global API Gateway throttle. Start with a counter in an unlogged Postgres
  table, because Postgres is the only dependency. Measure it before launch, and
  move it if it shows up as contention. _As built:_ a fixed one-minute window on
  `/v1` and `/mcp`, one upsert per request, 600 requests a minute by default in
  accounts mode and off in key mode, set with `RETAINER_RATE_LIMIT_PER_MINUTE`
  (`0` turns it off). Checked on the live deployment on November 8, 2026 (section 12).
- **Time.** A statement timeout on the API's connection pool, below the 29-second
  request limit, so that one expensive search cannot hold connections. It is set in
  `createSql`, not with `ALTER ROLE`, because Postgres applies role settings only at
  login. The container logs in as the owner and switches role, so it would not get
  the timeout, while `consolidate` logs in as the same role, may run for 300 seconds,
  and would. With `RETAINER_ROLE=all` the API and the worker share one pool today, so
  the API gets its own. _As built:_ 25 seconds, reported as `503` `timeout`.
- **Signup.** Open on every install in accounts mode: anyone with a verified Google
  account can create their own organization and workspaces, on a self-hosted server
  too. There is no setting to restrict it, and organizations cannot see each other's
  data. A self-hoster who wants a private install stays in key mode (4.1).
- **Quotas.** Limits on workspaces and members per organization (4.10). Self-hosted
  installs have none by default, so nothing caps what people who sign up there use.
  _As built:_ checked under the organization's lock when a workspace is created, an
  invitation is made or accepted, and refused with `409` `limit_reached`. Operators
  set them with `retainer org limit`.

### 4.9 Database credentials

Today every function connects with one login and switches role at connection start.
A hosted service gives each function its own login, with only what it needs.

| Function             | Logs in as         | Direct privileges                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `ops`                | Owner              | Migrations and the operator CLI; only the operator invokes it                 |
| `api`, `consolidate` | `retainer_app`     | As today, with no membership in any other role                                |
| `control`            | `retainer_control` | Account tables, `workspaces`, `api_keys`; can `SET ROLE retainer_app` to seed |

`retainer_control` has no `BYPASSRLS` and no DDL. It holds `retainer_app` with
`INHERIT FALSE, SET TRUE`, and RLS policies of its own on `workspaces` and
`api_keys`. It can still read tenant data by switching role, the same power the
api function has, so its code only does that to seed. Each role gets its own
secret. The test ran Better Auth under such a login and the api function under
`retainer_app` without problems.

The runtime role gets three `SECURITY DEFINER` functions beyond today's two:
`retainer_session_access`, `retainer_token_keys` and `retainer_token_access`.

The container keeps one URL by default, and an optional
`RETAINER_RUNTIME_DATABASE_URL` gives self-hosters the same separation.

### 4.10 The billing seam

`organizations.limits` holds quotas, and null means unlimited, so self-hosted
installs have no limits. Retainer enforces limits and does not know where they
come from. Plans, prices and Stripe code stay out of the open repo.

### 4.11 Sign-in methods, passkeys and MFA

| Method  | Protection                                                                 |
| ------- | -------------------------------------------------------------------------- |
| Passkey | Strongest: resists phishing, and uses the device plus a fingerprint or PIN |
| Google  | As strong as the person's Google account, including its two-step settings  |

**No email sign-in.** Magic links would make an inbox a way into the account, and
they would need an email provider. Without them there is one less route to protect
and one less service to run. The cost is that a person needs a Google account to
join (section 9).

**Passkeys** use `@better-auth/passkey`.

- A person adds one after a first sign-in with Google. Signing up with only a passkey
  stays off, because Google proves the email, and invitations rely on it.
- `userVerification` is `required`, so a device with no fingerprint, face or PIN is
  refused.
- Passkeys are tied to the domain (`rpID`). **Choose the permanent domain before
  anyone registers one**, because changing it breaks them. Do not offer them on the
  API Gateway URL.
- They make no outbound calls and add no need for internet.

**Recovery.** Someone who loses a device signs in with Google and removes the old
passkey. Someone who loses access to Google still has their passkey. Someone who loses
both needs an operator to verify them by hand, so encourage a second passkey.

**Google sign-in stays on after someone adds a passkey.** That keeps recovery simple.
A setting to turn it off can come later if teams ask.

**No MFA at launch.** Better Auth's two-factor plugin only challenges password
sign-ins. Its docs say social and passkey sign-ins "are not gated by 2FA by default",
and its code confirms it, so turning it on would protect nothing here. A passkey
already combines the device and a fingerprint or PIN, and Google applies its own
two-step settings, which we cannot enforce. A team that needs stricter rules can later
get an organization setting such as "passkey only".

MFA does not protect API keys on any provider. Scopes and revocation do.

### 4.12 Keeping Better Auth patched

- Pin exact versions of `better-auth` and every `@better-auth/*` package, which
  must move together.
- Follow its security advisories and update within days. Twelve advisories were
  published on one day, November 3, 2026.
- Load only Google, JWT, passkey, `mcp()` and `cimd()`. SSO and SCIM have
  some of its worst advisories, so add them only when a customer needs them, and lock
  down who can register a provider.
- Never install its `dash()` plugin, which calls Better Auth's own servers.
- Only the control function loads it, which limits what any bug can reach.
- Keep session cookie caching off, since revoked sessions can stay active until a
  cached cookie expires.

### 4.13 Where the code goes

New code follows the server layers in `ARCHITECTURE.md` section 8. `pnpm lint` fails
on a module with no layer, and on a layer table that does not match
`scripts/check-layers.mjs`.

| Code                                               | Module              | Layer      |
| -------------------------------------------------- | ------------------- | ---------- |
| Better Auth and the `/account` routes              | `accounts` (new)    | Interfaces |
| The session and token checks the api function runs | `auth`              | Interfaces |
| New CLI commands                                   | `operator`          | Interfaces |
| Creating an organization, workspace and seed       | `workspaces`        | Admin      |
| The control function's entry point                 | `lambda/control.ts` | Entry      |

Only `accounts` imports `better-auth` or `@better-auth/*`, and only `index.ts` and
`lambda/control.ts` import `accounts`. `api/app.ts` cannot import it, so in a container
`index.ts` mounts `/account` next to the app, loading it only in accounts mode.
`accounts` may import `auth`, but not the reverse.

`check-layers.mjs` enforces this once extended, because today it ignores package imports
and treats `lambda` as a single module. Better Auth's generated tables go in
`db/schema.ts`, the one file `drizzle.config.ts` reads, as plain Drizzle definitions
that import nothing from Better Auth.

## 5. Frontend design

Plain words throughout, per the web app's rule. No screen says "RBAC", "scope",
"OAuth" or "tenant". Errors a person can now see need the same care: the server's
"this API key needs the ... scope" and "send an API key" messages have to make sense
for someone signed in with Google as well as for an agent.

- **Sign in.** "Continue with Google" and "Use a passkey". Key mode keeps today's
  screen.
- **First run.** "Name your workspace", then the existing flow. The word organization
  does not appear.
- **URLs.** `/app/w/<slug>/...` in accounts mode, and `/app/...` as today in key
  mode. The router's base path is computed at startup from the location.
- **Switching workspaces** is a full page load. It clears cached data and needs
  no router or query changes, and a tab stays on its workspace. The switcher
  appears when a person has more than one.
- **Session state.** Inside a workspace, `Session` stays as it is, so scope checks
  and `canMutate` are unchanged. `GET /account` supplies the rest.
- **Requests.** The SDK gains a workspace option and sends `X-Retainer-Workspace`
  with cookie requests, next to the `X-Retainer-Client` header it already sets. The
  Vite dev server also proxies `/account`.
- **Settings** for people, agents and the account (5.1).

The Better Auth browser client with the passkey plugin adds about 16 KB gzipped.

### 5.1 Settings

Settings exist only in accounts mode. Key mode keeps today's app, where keys are
managed with the CLI. Two places hold them: **Settings**, for the workspace you are
in, and **Your account**, for you. Both open from the account menu at the bottom of
the sidebar, next to Developer view and Sign out.

Screens show only what the person can do. A button they could not use is hidden,
not disabled, and the server checks every action again (4.3).

**Settings: `/app/w/<slug>/settings`.** Tabs (`?tab=`), in this order:

| Tab          | Who sees it                                       | What it holds                                         |
| ------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Members      | Everyone in the workspace                         | Who has access, and their roles                       |
| Agents       | Workspace admins                                  | API keys and connected apps                           |
| Workspace    | Workspace admins                                  | Its name, and deleting it                             |
| Organization | Organization owners and admins, once it is needed | The organization's people, invitations and workspaces |

- **Members.** A row per person: name and email from Google, their role in plain
  words, and when they joined. The role is explained with the words in 4.3, such as
  "Editor: can add and change records, comment and review". Organization owners and
  admins show as "Admin in every workspace", set on the Organization tab, not here.
  Pending invitations follow, with who sent each and when it expires.
  - A workspace admin can change a role or remove someone from the workspace, and
    add someone already in the organization.
  - Inviting someone new needs an organization owner or admin: **Invite** asks for an
    email and a role and gives a link to copy (4.5). Others see who to ask.
  - Removing someone says what follows: they lose access at their next request,
    agent keys they created keep working, and their past changes keep their name.
- **Agents.** Two lists, each with a sentence on what it is.
  - **API keys**: name, what it can do ("Read only", "Read and write", "Read, write
    and change structure"), who created it and when. **Create key** asks for a name
    and what it can do, then shows the key once with copyable connection instructions
    for MCP and REST. **Revoke** asks first, and the key stops working at once.
  - **Connected apps**: apps people connected through sign-in, such as "Claude for
    Dana", with the person and the date. **Disconnect** ends the app's access at its
    next request. Arrives with MCP OAuth (PR 3).
- **Workspace.** Rename it. The address keeps its slug, so links and agents keep
  working. **Delete workspace**, for organization owners and admins, asks the person
  to type the workspace's name and explains the 7 days in which an operator can
  undo it (4.5).
- **Organization.** Hidden while the organization has one member and one workspace
  (A5), so most people never see the word.
  - Its name, which owners can change.
  - **People**: everyone in the organization, their organization role (owner, admin
    or member, explained in plain words) and the workspaces each can reach. Owners
    manage owners; owners and admins manage everyone else, and can remove someone
    from the organization, which ends all their workspace roles. The last owner
    cannot be removed or demoted (4.5).
  - **Invitations**: pending ones, to copy again or revoke.
  - **Workspaces**: each with its member count. **New workspace** asks for a name.
  - **Delete organization**, for owners, only once it has no workspaces.

**Your account: `/app/account`.** Outside any workspace, so it works from every one.

- Your name and email, from Google, which you change there.
- **Passkeys**: a list to rename or remove, and **Add a passkey**. After a first
  sign-in, offer it once. Say plainly that Google sign-in still works.
- **Where you have access**: each organization and workspace with your role in it,
  in plain words, so a person can see their own permissions.
- **Connected apps**: the apps you connected, in every workspace, to disconnect.
- **Sign out everywhere**, which ends every session, on every device.

## 6. Implementation order

Three pull requests. Accounts mode stays off until its settings are present, so PR 2
changes nothing for existing installs when it merges.

| PR                   | Contains                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Credentials       | Separate database logins for each function (4.9)                                                                                                                                                |
| 2. Accounts          | Tables and roles, Better Auth with Google, AWS and NAT, sign-in and workspace URLs, self-serve workspaces, members and invitations, API keys in the web app, passkeys, the settings pages (5.1) |
| 3. Agents and launch | MCP OAuth with the workspace picker, rate and quota limits, the statement timeout, scheduled deletion, the sign-in race (9.2)                                                                   |

All three are built and deployed: PR 1 (#36), PR 2 (#38) and PR 3 (#42).

**Why these stay apart.** PR 1 is the only one that changes the live deployment in
every mode, so a problem there should be easy to trace and roll back, and it should
not wait for the rest. PR 3 needs real sign-in underneath it, and it has to be
retested by hand with Claude's web app on a real deployment.

**Working through PR 2.** It is too large to review as a whole, and it is mostly
security code, so:

- Commit each step separately with its tests, so it can be read in order: model,
  sign-in, self-serve, passkeys.
- Start with real Google sign-in on a deployed URL, including the cookie check in 4.6,
  because it is the one sign-in route the test did not cover.
- Run a security review of the whole diff before merging.
- Try passkeys on real devices by hand.

## 7. What can come later

### 7.1 Groups: small

Add `groups`, `group_members` and `workspace_group_roles`. The effective role
becomes the highest of the direct and group roles. Only the lookup changes, and
`Caller` looks the same. SSO can later fill the same tables.

### 7.2 Record-level access: large

The rule is the easy part, and it is the same cost whichever model expresses it.
The hard parts are:

1. **Coverage.** 21 tables carry `workspace_id`, and many hold record data.
2. **Uniqueness leaks.** Creating a person with an email on a hidden record
   reveals or matches that record. `ARCHITECTURE.md` 7.2 already accepts the cost:
   claims become per audience, and sharing a private record becomes a merge.
3. **Shared events.** Whether someone sees a call with one visible and one hidden
   person, and what rollups show, are product decisions.
4. **Agents.** Each needs an audience. The consolidator's merge suggestions can
   pair records a reviewer cannot see.
5. **Performance.** A check on every row touches search, counts and paging.

If this is ever needed, start with a fixed setting of Everything, Team or Owned,
then single-record sharing.

### 7.3 One table for every model

Whatever model comes later, ACL entries, ownership, groups or relationship rules
all write to one `record_access` table, and one restrictive RLS policy reads it. A
record with no restrictions stays visible to everyone in the workspace, so the
change is additive. Keeping the table current becomes the new work.

### 7.4 Keeping the path open

- `Caller` carries `userId`, and actors use a stable UUID, not an email.
- Roles resolve in one function, the only place groups need to touch.
- `ARCHITECTURE.md` 7.2 stays true apart from the three new `SECURITY DEFINER`
  functions (4.9), and a new test fails on any function outside the list.
- No generic permission tables or policy engine until a rule needs one.

## 8. Tests

Grouped by what they prove. In the layers of `ARCHITECTURE.md` section 11, Unit is
layer 1; Database, Concurrent and Credentials are layer 2; API and Contract are layer
3; and Agent is layer 4. Browser tests run as that section describes.

| Layer       | Proves                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Effective role, the role-to-scope tables, slug suffixes, OAuth scope capping, cookie signature checks                                                                                                                                                                                                                                                         |
| Database    | The runtime role cannot read account or Better Auth tables; `retainer_session_access` answers only for its own token; expired and revoked sessions; the composite foreign keys; deleting an organization with workspaces fails                                                                                                                                |
| Concurrent  | Two owners removing each other leave one; two first sign-ins make one user and both sign in; two accepts of one invitation make one membership; two first workspaces make one organization                                                                                                                                                                    |
| API         | Every role against every route; an API key on `/account` is refused; a session with a workspace it cannot access gets 404; a forged cookie and a raw token without its signature get 401; header mismatch on a bearer request gets 400; removal applies at the next request                                                                                   |
| Contract    | Real Better Auth cookies pass the api function's check, so an upgrade that changes the format fails here; no unlisted `SECURITY DEFINER` function exists                                                                                                                                                                                                      |
| Credentials | The runtime login cannot `SET ROLE` to the owner, and `retainer_control` holds no DDL rights                                                                                                                                                                                                                                                                  |
| Agent       | An OAuth client registers both ways, is consented, connects and calls tools; its token ends when the person is removed or the consent is revoked                                                                                                                                                                                                              |
| Browser     | Sign up, name a workspace, invite someone who accepts, each role sees the right buttons and settings tabs, someone removed in settings loses access at their next request, two tabs on two workspaces write to the right ones; passkeys through Chrome's virtual authenticator: add, sign in, replay fails, another site fails, another user cannot remove it |

`pnpm lint` proves that the api function imports no Better Auth (4.13).

Every test except the unit tests uses real Postgres with a fresh cloned database: one
per file, or one per test in the browser. No test needs the internet, so they use a local fake of Google's OAuth endpoints, or create sessions
directly through Better Auth. Choose between those when building.

Real Google sign-in and Claude's web app cannot run in CI. Repeat both by hand on a
deployed install after each Better Auth upgrade that touches OAuth.

## 9. Open questions

1. **People without a Google account.** They cannot sign up, and an invitation only
   works if it goes to the address of the Google account the person signs in with.
   Teams on Microsoft 365 are the likely gap. _Decided November 8, 2026: add
   Microsoft sign-in_, through Better Auth's Microsoft provider, without changing the
   design. It accepts every Microsoft account: work or school accounts (Entra ID) and
   personal ones (Outlook, Hotmail).
2. **Two sign-ins at once.** _Resolved in PR 3._ In the test, two simultaneous first
   sign-ins for one email made one user as they should, but the second person got a
   500. With Google the second got Better Auth's `unable to create user` instead, and
   the web app showed it as an unverified address. Now a sign-in with an ID token
   runs once more and signs in as the person the other made. A Google redirect
   cannot run again, because its code works once, so its tab returns to the sign-in
   page, which says the account was just made in another tab and to sign in again.
   An unverified address has its own `email_not_verified` code. Better Auth's
   adapter runs its multi-step writes in a transaction, so a person and their
   Google link commit together and no sign-in sees one without the other.
3. **Agent write formats.** In the test Claude called `upsert_record` twice, then
   warned that names are `{first, last}` and emails `{primary, additional[]}`. The
   failed call's error was not logged, but the tool descriptions may need to state
   these formats more clearly. _Decided November 8, 2026: state them._
4. **Old personal keys.** Actors like `user:maya` stay separate from new user IDs,
   so a person cannot edit comments written under the old one. _Decided November 8,
   2026: no mapping._ It would only serve backward compatibility.
5. **Departed people's names** stay on past writes through the stored actor.
   `forget` covers records, not actors. Erasing a former employee's name needs a
   decision. _Deferred November 8, 2026._
6. **Viewers and private views.** Creating a view needs `write`, so a viewer cannot
   save a private view. _Decided November 8, 2026: they cannot._
7. **Zero-downtime deploys.** Each deploy gives up to a minute of `503`s because one
   version runs at a time. _Deferred November 8, 2026._

## 10. Acceptance

- A new person signs up, names a workspace and connects an agent, with no operator.
- They add a passkey and sign in with it on the same and on a second device.
- They invite a colleague, who accepts and sees only the workspaces they were
  given, with the right buttons for their role.
- Removing that colleague ends their web access and OAuth tokens at the next
  request, and agent keys keep working.
- No agent credential can create a key, a member or a workspace.
- Claude's web app connects to `/mcp` over OAuth on a deployed AWS install.
- One tenant's traffic spike gets `429`s while others keep working.
- The api function's database login cannot become the owner.
- A self-hosted install that sets nothing behaves exactly as before.

## 11. Documents to update

`ARCHITECTURE.md` 7.3 already holds the design. Update the rest when the work lands:

- `ARCHITECTURE.md`: mark 7.3 as built, and fold it into section 7 and 7.1. Update
  sections 4 and 6.2, which say the control function and MCP OAuth are not built; 7.2
  item 1, on `SECURITY DEFINER` functions and `retainer_app`; the layer table in
  section 8, which `pnpm lint` checks; and the stack in section 9.
- `CLAUDE.md`: "Every write carries an Actor, taken from the API key" becomes "from
  the credential". The comments in `caller.ts` and `packages/shared/src/actor.ts` say
  the same.
- `FRONTEND.md`: sections 1 and 4, and the dev proxy in section 3.
- `docs/aws.md`: the control function, NAT gateway, credentials, the connection budget,
  the narrower "no internet" promise, and the OAuth limit it lists.
- `docs/self-hosting.md`: `RETAINER_AUTH_SECRET`, Google settings,
  `RETAINER_RUNTIME_DATABASE_URL`, the `control` value of `RETAINER_ROLE`, the new CLI
  commands, and that signup is open in accounts mode.
- `docs/rest-api.md`: `/account`, `X-Retainer-Workspace`.
- `docs/sdk.md`: the workspace option for cookie requests.
- `docs/agents.md`: connecting over OAuth.

## 12. Test results

A throwaway test on November 6, 2026 ran Better Auth 1.7.18 against real Postgres 17,
real Retainer routes and MCP tools. It was deleted afterwards. It signed in by magic
link, which was dropped after the test, so it did not cover Google sign-in, now the
only first sign-in; the live deployment did (below). Everything after a session
exists carries over.

| Question                                | Result                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does it fit our stack?                  | Yes: Drizzle with `postgres.js`, TypeScript 7 with the repo's settings, `pnpm db:generate`, and a login limited to its own tables                                                           |
| Can the api function check a session?   | Yes, with no Better Auth import and no access to its tables, running real `/v1/me`, `/v1/schema` and scope checks under RLS                                                                 |
| Are session tokens hashed?              | No (4.4). A raw token without the signature was refused by both Better Auth and the api function                                                                                            |
| Can tokens be checked with no internet? | Yes. No outbound calls for sessions, dynamic registration, OAuth, MCP or passkeys                                                                                                           |
| Does access end immediately?            | Yes, for downgrade, removal and revoked consent, at the next request                                                                                                                        |
| Do real clients work?                   | The official MCP client passed with dynamic registration and metadata documents (fetch stubbed). Claude's web app connected through metadata documents, then read schema and wrote a record |
| Does `SameSite=Strict` work?            | Yes, in Chrome: a sign-in link and an OAuth flow opened from another site both succeeded. Google's callback was not tried (4.6)                                                             |
| Do passkeys work?                       | Yes, in Chrome's virtual authenticator: adding, signing in, replay refused, another site refused, another user refused, lost-device recovery                                                |
| What did it fail?                       | Two simultaneous first sign-ins: one user, but the second gets a 500 (section 9)                                                                                                            |

The server code loads in about 130 ms on a laptop and bundles to 3.3 MB (565 KB
gzipped), so cold starts should not be a concern, though Lambda will be slower.

**On the live deployment**, November 7, 2026, after PR 2 shipped to AWS
(`retainer.tamloot.cc`, real Lambda and API Gateway): Google sign-in worked, so its
OAuth state cookie survives Google's callback. A passkey added on the site signed in
on a laptop and on a phone. The phone used Face ID, so it was a synced passkey, not a
cross-device sign-in. The `Default` organization's first owner was set with
`ops.sh member add`. An invited second account accepted, saw only the workspaces it
was given, and lost access once removed.

**PR 3,** November 7, 2026, in tests against real Postgres with no internet: Claude's
real metadata document registers, the person picks a workspace at consent in the
browser (Playwright), and the token reads and writes over `/mcp`. Removal, a lower
role, a disconnect, a revoked consent and a deleted workspace each end the
connection at the next request. Concurrent tests cover the rate limit, the quotas,
deleting a workspace twice, purge against restore, and simultaneous first sign-ins.

**PR 3 on the live deployment**, November 7, 2026: Claude's web app connected to
`/mcp` over OAuth. It found the server through the 401 and the metadata routes,
identified itself with its metadata document (no dynamic registration), sent the
person through Google sign-in to the consent page, where they picked a workspace,
and then read the schema and wrote a record. Claude Code connected the same way
through its claude.ai connector. On November 8, Claude Code's call answered `200`,
the person clicked Disconnect under Connected apps, and the next call with the
same token, nine seconds later, got `401`.

**Limits on the live deployment**, November 8, 2026:

- **Per-workspace rate limit.** One client called `GET /v1/me` on one workspace at
  15 requests a second, starting just after a minute boundary. 583 calls got `200`;
  with 17 other requests to that workspace in the same window, that made 600. The next
  12 got `429` `rate_limited` with `Retry-After: 21`, then `20`, the seconds left in
  the window. Meanwhile a second workspace, called with its own key every 0.4 seconds,
  got `200` on all 114 calls. After `Retry-After` the first workspace got `200` again.
  The key made for the check was revoked.
- **API Gateway's throttle comes first for a fast client.** An earlier, unpaced run
  at about 28 requests a second got API Gateway's own `429` (`Too Many Requests`, no
  `Retry-After`) after 309 calls, and so did the second workspace. That throttle is
  global by design (25 a second, bursts of 50, `docs/aws.md`), so one tenant above
  25 a second slows every tenant.
- **Better Auth's sign-in rate limit.** Four quick `POST /account/auth/sign-in/social`
  calls with an empty body: the first three got `400` (`body.provider` invalid), the
  fourth `429` with `X-Retry-After: 10`. Eleven seconds later the endpoint answered
  `400` again. That is Better Auth's default for `/sign-in/*`: 3 requests per 10
  seconds for each client address and path, counted in `auth_rate_limits` before the
  body is checked. An empty body creates no user and no OAuth state; the only row it
  leaves is the counter itself.

**Not tested:** `SET LOCAL ROLE` seeding by `retainer_control`; purging a large
workspace within the control function's 300 seconds, deferred until real workspaces
exist. Whether Claude falls back to dynamic registration is not listed: Claude uses
its metadata document, which works, and the fallback cannot be forced from outside.
Simultaneous first sign-ins through Google's real redirect cannot be timed by hand,
and the concurrent test covers the same code.
