# Connect with Tamloot: implementation spec

Status: proposal, 2026-11-15, revised the same day after a review of both
products' specs (session lifecycle, cleanup, the `401` contract, the
callback). Not implemented, and nothing in it has been run.
Implements [extensions-tamloot-connect-prd.md](extensions-tamloot-connect-prd.md)
on the member connections in
[extensions-tamloot-implementation.md](extensions-tamloot-implementation.md).
Tamloot's side is `docs/superpowers/specs/2026-11-15-connected-apps-design.md`
in the Tamloot repository; its §10 is the contract this spec builds against.
§12 lists what this spec needs from Tamloot beyond it. Existing-code
references were checked on `6ae1e7b`, and those added in the revision on
`0669340`. Paths are relative to `packages/server/src` unless a package is
named.

## 1. Summary

A member clicks **Connect with Tamloot**, approves Retainer once in Tamloot and
lands back on the Connections tab with a connection that is starting. Retainer
is an OAuth client of Tamloot (authorization code with PKCE). Each connection
holds its own Tamloot session: an access token that lasts about an hour and a
refresh token.

The work has two parts, like member connections had:

- **Part A, the platform (§4).** A member registration can declare that it
  connects by OAuth. The server runs the browser handshake: it creates the
  state and the PKCE verifier, builds the authorize address, and on return
  hands the code to the registration's `connect` function. Nothing in Part A
  names Tamloot.
- **Part B, the Tamloot bundle (§5).** The bundle exchanges the code, keeps
  the tokens fresh, and gives up the session when the member disconnects.

The paste-a-key connection stays as it is. It is the only method where no
OAuth client is configured, which is every self-hosted server.

## 2. Decisions

| Question                                  | Decision                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Who calls Tamloot's token endpoint?       | The bundle, in its job function. The server never calls Tamloot.                                  |
| Who holds the OAuth client secret?        | Operator configuration. A run reads it through one runtime route; it is never stored in Postgres. |
| Where do tokens live?                     | In the secret broker, as one connection secret the bundle writes.                                 |
| What does the server own?                 | State, PKCE, the authorize address, the pending request, and starting `connect`.                  |
| Where does the member land after Tamloot? | On a page of the web app, which posts the code to the API.                                        |
| Can a connection change its method?       | No. Key or OAuth is fixed when the connection is created. To switch, disconnect and connect.      |
| Does the key option stay on hosted?       | Yes, as a secondary link, until the PRD's open question is decided (§13).                         |
| Which OAuth library?                      | None. One URL and two form posts do not need one.                                                 |
| What if access can't be given up?         | Retried for 24 hours, never dropped silently; then a notice, where the member can see it (§6.2).  |
| When is an exchanged session used?        | Only after `verifySource` passes. Until then it is `pending`, and a refused one is released.      |

**Why the bundle exchanges and refreshes.** On the hosted service the
function that holds the secret broker (`extensions`) and the `api` function
sit in subnets with no route to the internet. Only the sign-in function
(`control`) has one, and it has neither the secret broker nor run
credentials. Job functions run outside the VPC with open egress and already
call `api.tamloot.cc`. Doing the token calls there needs no new function, no
NAT and no protocol between functions, and "refresh once on 401" (Tamloot's
contract) happens in the same call that got the 401. The cost is that a
first-party bundle sees the client secret. It already holds each member's
tokens, and the secret alone reads nothing.

Twenty exchanges and refreshes app connections on its server
(`connection-provider-oauth-flow.service.ts`), because its server can reach
the internet. If Retainer later gives a trusted function egress, token
handling can move behind the broker without changing the handshake in §4.

**Why no library.** `@better-auth/core/oauth2` was the earlier candidate. Its
helpers would run either on the server, which cannot reach Tamloot, or inside
the MIT runner bundle, where they bypass the bundle's guarded transport
(timeouts, size caps, `redirect: 'error'`). The API also does not import
Better Auth (ARCHITECTURE.md §9).

## 3. What exists today

Read these first.

| Area               | Where                                                     | What it does                                                                                                   |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Member connections | `extensions/connections.ts`                               | `stage`, `connect`, reconnect, `disconnect`, `list`. The owner comes from the caller, never the payload.       |
| Pending secrets    | `extension-runtime/secrets.ts`, `0103_…_admission.sql`    | A secret is staged encrypted, bound to owner, installation and draft connection, for 15 minutes, then adopted. |
| Generated secrets  | `api/routes/extension-runtime.ts`                         | A run may write a secret declared `generated`, with a revision check (`PUT …/runtime/secrets/:name`).          |
| One run at a time  | `extension_jobs_one_running_connection_uq`                | A connection never has two running jobs.                                                                       |
| Needs reconnect    | `extension-runtime/lifecycle.ts`                          | A job failing with `provider_unauthorized` sets `needs_reconnect` and deletes the connection's schedules.      |
| Disconnect         | `extension-runtime/connections.ts`                        | Fences runs, retires secrets at once, queues the `disconnect` hook for up to 24 hours, without secrets.        |
| Tamloot bundle     | `packages/runner/src/tamloot*.ts`                         | Reads `apiKey`, calls six GET endpoints through `TamlootProvider`.                                             |
| Connections tab    | `packages/web/src/routes/extensions/connections.tsx`      | "Your connection" card, the connect form, and the admin table.                                                 |
| Hosted functions   | `lambda/extensions.ts`, `docs/specs/extensions-lambda.md` | `/v1/extensions` and the broker are served by `extensions`. Job functions have open egress and no database.    |

## 4. Part A: OAuth for member connections

### 4.1 Operator configuration

New setting `RETAINER_EXTENSION_OAUTH_CLIENTS` (`config.ts`): a JSON object
keyed by registration universal ID.

```json
{
  "54326882-cc28-4983-a5fe-cf0298520b68": {
    "clientId": "<client uuid>",
    "clientSecret": "<secret>",
    "authorizationEndpoint": "https://app.tamloot.cc/oauth/start",
    "tokenEndpoint": "https://db.tamloot.cc/auth/v1/oauth/token",
    "apiOrigin": "https://api.tamloot.cc",
    "scope": "email",
    "keyFallback": true
  }
}
```

- `clientId`, `clientSecret`, `authorizationEndpoint` and `tokenEndpoint` are
  required. The token endpoint above is an example; take the real one from
  Tamloot's authorization server metadata (§12).
- `apiOrigin` is optional: where the bundle sends the tokens it gets. Without
  it the bundle uses the origin built into its release. It exists so a staging
  deployment can use Tamloot's staging client and API together.
- `scope` is optional and sent as is. Without it no `scope` parameter is sent.
- `keyFallback` is optional, default `true`. `false` hides and refuses the key
  method for this registration.
- Every address must be `https`. `http` is accepted only for `localhost` and
  `127.0.0.1`, for tests and local work.

These are operator inputs, like the catalog. A workspace cannot set or read
them. `extension-control/configuration.ts` parses the value and fails startup
with the existing redacted configuration error when it is malformed, or names
a registration whose releases declare no `oauth`. Pass the parsed map to the
app as `AppDeps.extensionOAuthClients`.

OAuth is **available** for an installation when its release declares `oauth`
(§4.2), a client is configured for its registration, the secret broker is
configured and `RETAINER_PUBLIC_ORIGIN` is set.

The redirect address is fixed per deployment:
`<RETAINER_PUBLIC_ORIGIN>/app/connect/callback`.

Set the variable on every process that serves `/v1/extensions`: the
`extensions` function on the hosted service, the API container in Compose.

### 4.2 Manifest (`@retainer/extension`, MIT)

Two optional blocks, with no zod defaults, so manifests that omit them keep
their digests.

```ts
oauth: z.strictObject({
  verifierSetting: name, // the PKCE verifier, staged by the server at start
  codeSetting: name,     // the authorization code, staged by the server on return
  tokenSetting: name,    // whatever the bundle stores after the exchange
  keySetting: name.optional(), // a secret a member may paste instead
  revokeUrl: z.url(),          // https; where a member revokes the app (§6.2)
}).optional(),
gettingStarted: z.strictObject({
  text: z.string().min(1).max(300),
  linkLabel: z.string().min(1).max(60),
  url: z.url(), // https only
}).optional(),
```

Validation, in `checkConnections`:

- `oauth` and `gettingStarted` require `connection: 'member'`.
- The verifier, code and token settings are three different settings, each
  `level: 'connection'`, `secret: true` and `generated: true`. `generated`
  already means "never a form input": `MemberConnections.stage` refuses it, so
  only the server can stage handshake material.
- `keySetting`, when present, is a connection-level secret that is not
  generated.
- With `oauth`, no connection-level secret may be `required: true`. The method
  decides which secrets a connection needs (§4.5).
- The `connect` function's `secrets` must list the verifier, code and token
  settings.
- A `disconnect` hook may now declare `secrets`, limited to generated
  connection secrets. Replace the "disconnect hooks cannot request secrets"
  rule with this one. `functionSecrets` returns `fn.secrets ?? []` for a
  disconnect hook; today it always returns `[]`.

### 4.3 Persistence

Generate the structural migration with
`pnpm db:generate --name connection_authorizations`, and a separate custom
migration for the SQL functions in §4.7. Never edit a generated migration.

New table `extension_authorizations`, one row per handshake in progress:

| Column                             | Notes                                                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| `id`, `workspace_id`               | RLS by workspace, like its siblings                               |
| `installation_id`                  | Tenant FK to the installation, cascade                            |
| `connection_id`                    | The existing connection (reconnect) or the draft ID of a new one  |
| `owner_id`                         | The member who started it                                         |
| `state_hash`                       | SHA-256 of the state, hex. Unique with `workspace_id`             |
| `verifier_ref`                     | The pending secret that holds the PKCE verifier                   |
| `settings`                         | The non-secret connection settings chosen at start                |
| `reconnect`, `expected_generation` | Set for a reconnect                                               |
| `created_at`, `expires_at`         | `expires_at` is the verifier's pending-secret expiry (15 minutes) |
| `consumed_at`                      | Set once, by the completion that wins                             |

New columns on `extension_connections`:

- `credential text not null default 'key'`, checked in `('key', 'oauth')`.
- `authorization_started_at timestamptz`: when the member clicked, copied from
  the request. Used for the measure in §7.
- `disconnect_secrets text[] not null default '{}'`: the secrets the reviewed
  disconnect hook declares. Written wherever `disconnect_function_id` is
  written (connect, reconnect, release adoption), for the same reason: the
  lower layer must not import the catalog.
- `release_incomplete_at timestamptz` and `release_notice_dismissed_at
  timestamptz`: set when a cleanup that holds provider credentials did not
  finish (§4.7). They drive the member's notice (§6.2).

### 4.4 Starting an authorization

`POST /v1/extensions/:id/connections/authorize`, scope `read`, a person only
(the existing `human` check).

```ts
// request
{ settings: Record<string, string | boolean | number>,
  connectionId?: string, expectedGeneration?: number, // reconnect
  loginHint?: string }                                // an email, at most 254 characters
// 201
{ authorizationUrl: string, state: string, expiresAt: string }
```

Steps, in `MemberConnections` (new method `authorize`), following `stage`:

1. In a workspace transaction, with the same locks as `connect`
   (`lockForWrite`, the member lock, the installation and queue locks): the
   installation is active, OAuth is available (else `409 oauth_unavailable`),
   and `validateConnectionSettings` passes.
2. New connection: the caller has no live connection (else
   `409 connection_exists`). Reconnect: the connection is the caller's, not
   disconnected (else 404), its `credential` is `oauth` (else
   `409 credential_mismatch`) and `expectedGeneration` matches (else
   `409 stale_plan`).
3. Create the verifier (32 random bytes, base64url; the challenge is its
   base64url SHA-256) and the state:
   `v1.<workspaceId>.<installationId>.<nonce>`, where the nonce is 32 random
   bytes, base64url. The two IDs are routing hints for a callback that
   opens in another tab (§6.1). They are not secret and grant nothing: the
   server stores the SHA-256 of the whole state and accepts it only by
   exact match, after the ordinary membership and owner checks.
4. Stage the verifier through `broker.stage` under the manifest's
   `verifierSetting`, bound to the caller and to the connection ID (the
   existing one, or a new UUID for a new connection).
5. Delete the caller's other unconsumed requests for this installation, and
   rows of this workspace that expired more than an hour ago. Insert the
   request. A member has one handshake in progress per installation;
   starting again replaces the earlier one.
6. Return the authorize address: `authorizationEndpoint` with
   `response_type=code`, `client_id`, `redirect_uri`, `state`,
   `code_challenge`, `code_challenge_method=S256`, `scope` when configured,
   and `login_hint` when the request carried one.

`loginHint` is a suggestion that Tamloot shows in its sign-up form. It carries
no authority: the server checks only that it looks like an email and forwards
it. The owner still comes from the credential.

### 4.5 Completing it

`POST /v1/extensions/:id/connections/authorize/complete`, scope `read`, a
person only. The web app sends it with `X-Retainer-Workspace` set to the
workspace named in the state, through the ordinary session middleware and
its CSRF header check. Nothing about either is relaxed.

```ts
// request: exactly one of code and error
{ state: string, code?: string, error?: string }
// 200
{ id: string, state: 'connecting' } | { cancelled: true }
```

1. Find the request by the SHA-256 of the whole `state` in this workspace
   and installation. It must belong to the caller, be unconsumed and
   unexpired. Anything else is `409 authorization_expired`, including a
   state that does not parse or whose IDs name another workspace or
   installation. The answer does not say which check failed. A caller who
   is not a member of the named workspace gets the middleware's ordinary
   refusal, the same for a workspace that does not exist; so a state, real
   or forged, tells the caller nothing they could not learn without it.
2. With `error`: delete the request and return `{ cancelled: true }`.
3. With `code` (1 to 2,048 characters): stage it through `broker.stage` under
   `codeSetting`, bound to the request's connection ID.
4. Run the existing connect transaction with the request's settings, both
   pending references and `credential: 'oauth'`. Its first statement marks the
   request consumed:
   `update … set consumed_at = now() where id = … and consumed_at is null`.
   No row means another completion won: `409 authorization_expired`, and the
   transaction rolls back. The same transaction copies `created_at` to
   `authorization_started_at`.

`connect` (`extensions/connections.ts`) changes in three places:

- It takes the credential from its caller. The public connect and reconnect
  routes always mean `key`.
- It replaces the "required connection secret missing" loop for a manifest
  with `oauth`. An `oauth` connection needs references for the verifier and
  the code and none for `keySetting`. A `key` connection needs `keySetting`,
  staged or already stored, and no handshake reference. A `key` connect is
  refused with `422 invalid_connection` when OAuth is available and
  `keyFallback` is `false`.
- A reconnect with the other credential is `409 credential_mismatch`.

Everything after that is unchanged: the row is `connecting`, the `connect`
function is queued, and a failure there is `setup_failed`.

### 4.6 What a run can read

`GET /v1/extensions/:id/runtime/oauth-client`, a live run only.

```ts
{ clientId: string, clientSecret: string, tokenEndpoint: string,
  redirectUri: string, apiOrigin?: string }
```

It is admitted like a runtime secret read (`admitRun` with purpose
`runtime`), and only for a function whose declared `secrets` include the
release's `tokenSetting`. A `configure` run is refused. The response is sent
with `cache-control: no-store`. Without a configured client it answers
`409 oauth_unavailable`.

The handshake secrets and the token secret are ordinary connection secrets:
the run reads them with `GET …/runtime/secrets/:name` and writes the token
secret with `PUT`, as generated secrets work today.

### 4.7 Disconnect hooks read their secrets

Disconnecting must give up the session in Tamloot, and the token is the only
way to name it. Today `retainer_retire_member_secrets` makes every secret
unreadable at once and `retainer_admit_secret_run` refuses disconnect jobs.

- `retainer_retire_member_secrets`: secrets named in the connection's
  `disconnect_secrets` get `delete_after = disconnected_at + 24 hours`, the
  window in which the cleanup job can run. All others are retired at once, as
  today.
- `retainer_admit_secret_run`: admit a read, never a write, for a job with
  `trigger_kind = 'disconnect'` whose connection is `disconnected` at the
  job's generation and inside its 24 hours, under the same installation
  conditions `admitRun` uses for cleanup (`extension-runtime/admission.ts`).
- When the cleanup job of a **disconnected** connection reaches a final state
  (succeeded, failed for good or expired), retire the retained secrets at
  once, in the transaction that records the result. A new function
  `retainer_finish_member_cleanup` does it, granted to the role that records
  job results. It never runs for the failed-connect cleanup below, which
  retires nothing.
- `retainer_connection_secret_names` already hides retired secrets, so reads
  of a disconnected connection list none.

A hook that declares no secrets behaves exactly as before.

**Every path that disconnects.** All of them call `disconnectConnection`
(`extension-runtime/connections.ts`), which queues the hook. This works
today; the spec documents it and adds tests (§9), it does not redesign it.

- **Member or admin disconnects one connection** (`extensions/connections.ts`).
  The hook is queued and claimed while the connection is `disconnected` and
  inside its 24 hours (`0109`, `retainer_extension_jobs_due`).
- **The member leaves or is removed** (`workspaces/leaving.ts`).
  `disconnectMemberConnections` does the same for each of the member's
  connections.
- **An admin uninstalls the extension** (`extensions/service.ts`). Each
  connection is disconnected first. `retainer_retire_extension_secrets` then
  sets a 24-hour `delete_after`, the same window. The installation stays
  `uninstalling` until every `disconnect` job succeeds (`queue.ts`, then
  `retainer_finish_extension_cleanup`), or until maintenance ends cleanup at
  24 hours.
- **The workspace is deleted** (`extension-runtime/workspace-deletion.ts`).
  The same as uninstall: `0109` still claims `uninstall` and `disconnect`
  jobs for a workspace with `deletion_scheduled_at` set.

`retainer_retire_extension_secrets` sets `delete_after` 24 hours out and does
not shorten the window. The rule to keep, and test: on every path the
retained token secret stays readable by the hook for 24 hours after the
disconnect, and is deleted when the hook finishes or at the deadline.

**Cleanup after a failed connect.** A connect that fails can leave sessions
the bundle holds but no longer wants: one rejected by `verifySource`, or old
ones it could not release yet (§5.5). Ordinary runs stop when the connection
leaves `active`, so the platform runs the hook for them, with input
`{ "keep": "current" }`. This is the only new kind of run, and it reuses the
`disconnect` trigger; no new trigger kind.

- **Queued.** `failInstallation` (`extension-runtime/lifecycle.ts`) queues
  it in the same transaction when it moves an OAuth connection whose
  `disconnect_secrets` is not empty to `setup_failed` (a `connect` job) or
  to `needs_reconnect` (any other job), at the connection's generation after
  the move, with dedupe key `abandoned:<connection>:<generation>`. Nothing
  else queues it, and it never queues itself.
- **Input.** `lifecycleInputSchema` for `disconnect` becomes
  `{ keep?: 'current' }`. Jobs queued today carry `{}`: release everything.
- **Every admission layer** admits it while the connection is
  `setup_failed` or `needs_reconnect` at the job's generation and the job
  is under 24 hours old, and the installation is `active`:
  - `retainer_extension_jobs_due` claims it;
  - `admitRun` (`extension-runtime/admission.ts`) counts it as cleanup:
    `purpose` other than `crm`, no CRM, KV or children, exactly like the
    `disconnect` branch for a disconnected connection;
  - `retainer_admit_secret_run` admits a read, never a write, of the
    secrets the hook declares;
  - the runtime routes a cleanup run already uses (the installation read
    behind `sdk.extension(id)`, and secret reads) admit it through
    `admitRun`, and so does `GET …/runtime/oauth-client` (§4.6), which a
    hook needs to refresh a session before releasing it. The same holds for
    the full hook on a disconnected connection.
- **Never beside a connect.** It takes the connection's one running slot
  (`extension_jobs_one_running_connection_uq`). A reconnect bumps the
  generation, so it is cancelled at claim; the reconnect's own `connect`
  drains the same sessions first (§5.5). A disconnect cancels it and queues
  the full hook.
- **Changes nothing about the connection.** It never releases `current`
  (after a rejected reconnect, that is the member's previous session). It
  writes no secret, so entries it released stay in the store until a later
  run finds them gone and removes them (§5.7: releasing a session that is
  already gone counts as done). Its result never calls `failInstallation`,
  never sets `state`, `health` or `last_error` (the `health='ok'` reset in
  `queue.ts` after a lifecycle job skips it), never retires or deletes a
  secret, and never queues another job. The connection keeps the code and
  status of the failure that queued it, such as `source_account_changed`.
  Its only effect, when it does not succeed, is `release_incomplete_at`
  below.

**When cleanup does not finish.** The transaction that records a job's
result sets `release_incomplete_at = now()` on the connection when:

- a `disconnect` job of a connection with non-empty `disconnect_secrets`
  fails (for good, out of retries, or at the 24-hour deadline); or
- any job of the connection reports `releaseIncomplete: true`. The execution
  result (`@retainer/extension`, `executionResultSchema`) gains this
  optional flag, allowed with any status. A run sets it once, when it first
  finds a session it cannot name (§5.5 steps 2 and 4, §5.7), so a run that
  succeeds can still report one.

A cleanup job cancelled by a reconnect or a disconnect sets nothing: the run
that replaced it carries the same sessions and reports them itself. The
member sees a notice whenever `release_incomplete_at` is later than
`release_notice_dismissed_at` (or nothing was dismissed), so a dismissal
hides what was reported before it and never a later report (§6.2).
Dismissing sets `release_notice_dismissed_at = now()` through
`POST /v1/extensions/:id/connections/:cid/release-notice/dismiss`, the owner
only. Retainer never claims the access ended when it did not.

### 4.8 Reads

- `ExtensionConnection` gains `credential` and `hasImportedItems`: whether
  the connection's source account has at least one source item past
  `reserved`. `list` computes it through `source_bindings`.
- `ExtensionConnection` also gains `releaseIncompleteAt`. `list` already
  returns disconnected connections (all of them to an admin, the caller's
  own otherwise), so the warning is read back from the database, not from
  the browser, and survives the disconnect.
- `ExtensionInstallation` gains `releaseNotice: { connectionId, at } | null`
  for the caller: their most recent connection on this installation whose
  `release_incomplete_at` is later than its `release_notice_dismissed_at`,
  or has no dismissal. It stays until the member dismisses it. It is
  computed from the caller only, so it never shows another member's
  connections.
- `ExtensionInstallation` gains `connectionMethods` for a member
  registration: `['oauth', 'key']`, `['oauth']` or `['key']`, from the
  manifest and §4.1.

### 4.9 Interfaces

- SDK: `authorizeExtensionConnection(id, input)`,
  `completeExtensionAuthorization(id, input)`,
  `dismissReleaseNotice(id, connectionId)` and, for runs,
  `extensionOAuthClient(id)`.
- MCP stays read-only. `list_extension_connections` shows `credential`.
- New error codes: `oauth_unavailable`, `authorization_expired`,
  `credential_mismatch`. New job result codes from the Tamloot bundle:
  `release_backlog`, `exchange_interrupted`, `release_incomplete` (§5), and
  the result flag `releaseIncomplete` (§4.7).

## 5. Part B: the Tamloot bundle

### 5.1 Contract (`packages/runner/src/tamloot-contract.ts`)

- `apiKey` becomes `required: false`.
- Three new settings, each `type: 'string'`, `level: 'connection'`,
  `secret: true`, `generated: true`, `required: false`: `oauthVerifier`,
  `oauthCode`, `oauthTokens`.
- `oauth: { verifierSetting: 'oauthVerifier', codeSetting: 'oauthCode',
  tokenSetting: 'oauthTokens', keySetting: 'apiKey', revokeUrl:
  'https://app.tamloot.cc/dashboard/settings?tab=apps' }`.
- `gettingStarted: { text: 'No meetings to import yet. Record a meeting with
  Tamloot and it shows up here a few minutes after it ends.', linkLabel:
  'Open Tamloot', url: 'https://app.tamloot.cc' }`.
- A new function `disconnect` with trigger `{ kind: 'disconnect' }`,
  `timeoutSeconds: 60` and a new fixed UUID, `TAMLOOT.disconnect`.
- Function secrets: `connect` reads all four; `poll`, `scan` and
  `sync-session` read `apiKey` and `oauthTokens`; `disconnect` reads
  `oauthTokens`.

The release changes settings and adds a function, so it is not a code-only
upgrade: an admin reviews it once (`extensions/auto-upgrade.ts`). The upgrade
runs `connect` again for every connection. Key connections reconnect with
their key.

### 5.2 Which credential a run uses

A run reads the installation once (`sdk.extension(id)`), as today. Its
`secrets` map says which secrets the connection has. `oauthCode` present
means OAuth; otherwise the run uses `apiKey` exactly as today. The method is
fixed per connection (§2), so the two never mix.

### 5.3 The token secret

`oauthTokens` holds one JSON value, parsed with zod on every read:

```ts
const session = z.strictObject({
  accessToken: z.string(), refreshToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
const tokenStore = z.strictObject({
  codeHash: z.string().length(64),        // SHA-256 of the last code this connection was given
  exchange: z.enum(['started', 'done']),  // 'started' is written before the token call
  rejected: z.string().nullable(),        // why verifySource refused the session from codeHash
  current: session.nullable(),            // the verified session runs use
  pending: session.nullable(),            // exchanged, not yet verified; never used to import
  release: z.array(z.strictObject({       // sessions to give up in Tamloot
    session, since: z.iso.datetime({ offset: true }),
    reason: z.enum(['replaced', 'rejected']),
  })).max(4),
});
```

A connection holds at most six sessions: `current`, `pending` and four to
release. Nothing is ever removed from `release` except by releasing it
(§5.7). The cap is kept by refusing new work (§5.5 step 3), never by
dropping an entry.

Every write uses the revision the run read (`expectedRevision`). On
`revision_conflict` the run reads again and uses what is stored; it does not
write over it.

### 5.4 Token calls (`packages/runner/src/tamloot-oauth.ts`, new)

Both are form posts to `tokenEndpoint` with HTTP Basic client
authentication, through the injected transport, with a 20-second timeout,
`redirect: 'error'`, a 64 KiB response cap and no logging of bodies.

- Exchange: `grant_type=authorization_code`, `code`, `redirect_uri`,
  `code_verifier`.
- Refresh: `grant_type=refresh_token`, `refresh_token`.

A response must carry `access_token` and a positive `expires_in`. A refresh
response without `refresh_token` keeps the old one.

### 5.5 `connect`

1. Read the client (`sdk.extensionOAuthClient`), `oauthCode`, `oauthVerifier`
   and `oauthTokens` if stored.
2. **Drain.** If `pending` is from an earlier code, move it to `release`
   (`rejected`). If the store says `exchange: 'started'` for an earlier code
   with no `pending`, an earlier run died during its exchange and Tamloot
   may hold a session Retainer cannot name: set `exchange: 'done'` so it is
   reported only once, and set `releaseIncomplete` on this run's result,
   whatever its status. Give up every entry in `release` (§5.7) and write
   the store without the ones that are gone. Failures here do not fail the
   run.
3. **New code** (nothing stored, or `codeHash` is not this code's hash):
   - If `release` still holds four entries, fail with `release_backlog`
     without exchanging. An unexchanged code creates no session in Tamloot.
     The connection is `setup_failed` and the member tries again later.
   - Write `{ codeHash, exchange: 'started', rejected: null, pending: null }`,
     keeping `current` and `release`. Then exchange. Write the
     session as `pending` with `exchange: 'done'` at once, before any other
     call.
   - If Tamloot answers the exchange with an OAuth error (a `4xx` with an
     `error`, such as `invalid_grant` or `invalid_client`), no session was
     created: write `exchange: 'done'` with no `pending`, then fail as §5.8
     says. `'started'` stays only when the call may have reached Tamloot
     without an answer Retainer read: a timeout, a network error or a
     `5xx`, which retry (step 4).
4. **Same code** (a retry, or the `connect` an upgrade or re-enable queues):
   - `exchange: 'started'`: the run that exchanged died before writing.
     Exchange once more. If the first call never reached Tamloot this
     succeeds; continue at step 5. `invalid_grant` means the code was spent
     and Tamloot may hold a session Retainer cannot name: write
     `exchange: 'done'` with no `pending`, so no later run reports it again,
     and fail with `exchange_interrupted` and `releaseIncomplete`, which the
     server shows the member at once (§4.7).
   - `rejected` set: the session was already refused. Fail with that code.
   - `pending` set: continue at step 5.
   - Otherwise (an upgrade, a re-enable, or a retry after promotion):
     there is no `pending` to verify or promote. Continue with `current`,
     refreshing it if needed (§5.6), and call `verifySource` with it as
     today. A refusal here fails the run and touches no session.
5. **Verify.** `GET /v1/me` and `verifySource` with `pending`.
   - Success: in one write, `pending` becomes `current`, the previous
     `current`, if any, joins `release` as `replaced`, and `pending` is
     cleared.
   - Refused (`source_account_changed`, or any other final failure): in one
     write, `pending` joins `release` as `rejected`, `pending` is cleared
     and `rejected` takes the code. The session is then only in `release`,
     so it can never be promoted or counted twice. `current` is untouched: after a rejected reconnect the member's
     previous session stays where it was. Try to give up the rejected
     session now, then fail with the code. If Tamloot cannot be reached,
     the cleanup in §4.7 retries it.
   - `429`, `5xx` or a network error: `retry`. `pending` is kept.
6. The cursor and backfill, as today.
7. Drain `release` again. A failure here never fails the connect.

Step 3 keeps the bound: with fewer than four entries before the exchange,
either outcome of step 5, or step 2 moving a stale `pending`, adds one, so
`release` never exceeds four.

The order in step 5 matters. Tamloot revokes the member's approval when
Retainer gives up its last session, so the new session is verified and
current before the old one is released.

**The window Retainer cannot close.** Between Tamloot answering an exchange
and the run writing `pending`, only Tamloot knows the session. If the run
dies there, step 4 detects it on the retry, or step 2 on the next connect,
and the member is told (§6.2). Retainer cannot release that session, and if
no later run of the connection ever happens it cannot even tell. Only the
member's revoke in Tamloot ends it, and Tamloot's Connected apps lists
Retainer while it lasts.

### 5.6 Access in every other function

`TamlootProvider` takes a credential source in place of a key string.

- Key: the bearer is the key. Nothing changes.
- OAuth: read `oauthTokens`. If `current.expiresAt` is less than 5 minutes
  away, refresh first and write the store at once. Requests go to `apiOrigin`
  when the client names one.
- On a `401` from the API with OAuth: refresh once, write, and repeat the
  request. A second `401`, or a refresh that fails with `invalid_grant`, is
  `provider_unauthorized`.
- Every run of the connection (`poll`, `scan`, `sync-session`) drains
  `release` before it imports, so an active connection keeps retrying until
  each entry is gone. A failure here does not fail the run.

No module-level caches: a warm Lambda environment serves other installations
next (extensions-lambda.md §3.2).

### 5.7 Giving up a session, and `disconnect`

To give up one session: `DELETE /v1/access` with its access token. `204` is
done. On `401`, refresh that session once and repeat; a second `401` or
`invalid_grant` means Retainer has no access through that session now, which
is also done: Retainer drops its tokens and can do nothing more with it. A
`401` does not mean Tamloot deleted the session (Tamloot §10, "Known limit:
re-approval"; see §13). `429`, a `5xx` or a network error means try again
later.

The `disconnect` function reads `oauthTokens`. `409 connection_required`
means a key connection, or nothing stored, so no exchange ever started:
succeed. Otherwise it gives up `pending`, every entry in `release` and,
unless its input is `{ keep: 'current' }` (§4.7), `current`. It writes
nothing. If any attempt must be retried it returns `retry`; the platform
retries inside the 24-hour cleanup window. It fails with
`release_incomplete` and `releaseIncomplete`, after releasing everything it
can, when it knows of a session it cannot name: the store says
`exchange: 'started'` with no `pending` (a crash no `connect` has reported
yet; the hook cannot write, so a `{ keep: 'current' }` run and a later full
disconnect may both report it, each time a real reason to check), or the
store does not parse. Then, or if the 24 hours run out, the member is told
(§4.7, §6.2). Reported crashes leave nothing for it to report again.

Add `DELETE /v1/access` to the provider's path allowlist. It stays the only
request that is not a GET.

### 5.8 Results

| Where          | Response                   | Result                            | Connection becomes                   |
| -------------- | -------------------------- | --------------------------------- | ------------------------------------ |
| Token endpoint | `invalid_grant`            | `failed`, `provider_unauthorized` | `needs_reconnect`, or `setup_failed` |
| Token endpoint | `invalid_client`, or 401   | `failed`, `oauth_client_rejected` | `degraded`: an operator setup error  |
| Token endpoint | 429, 5xx, timeout, network | `retry`                           | unchanged                            |
| API            | 401 twice (§5.6)           | `failed`, `provider_unauthorized` | `needs_reconnect`                    |
| API, OAuth     | 403                        | `failed`, `provider_forbidden`    | `degraded`: a bug or a setup error   |
| API, key       | 401 or 403                 | `failed`, `provider_unauthorized` | `needs_reconnect`, as today          |
| API            | 429, 5xx                   | `retry` with `Retry-After`        | unchanged, as today                  |
| `connect`      | §5.5 step 3, full release  | `failed`, `release_backlog`       | `setup_failed`                       |
| `connect`      | §5.5 step 4, spent code    | `failed`, `exchange_interrupted`  | `setup_failed`, and the notice       |
| `connect`      | §5.5 step 2, earlier crash | as the run ends, flag reported    | as the run ends, and the notice      |
| `disconnect`   | a session it cannot name   | `failed`, `release_incomplete`    | unchanged (§4.7); the notice         |

`provider_unauthorized` already deletes the connection's schedules and leaves
its queued jobs to be cancelled at claim, so a revoked connection fails once
and then stops (PRD requirement 4). A `403` with OAuth must not ask the
member to reconnect: reconnecting would not fix it.

**This table rests on Tamloot answering `401` for a token it does not
accept.** An API Gateway authorizer that denies a request makes the gateway
answer `403 Forbidden`, which would send a revoked or expired token down the
`403` row: `degraded`, never "Needs reconnect". Tamloot owns the fix, and its
revised spec (PR #2410, `e711a9870`, §5.1–§5.2 and §10) makes it: a rejected
approval token passes the authorizer with a context that carries no
identity, and the application answers `401 invalid_token`; that context can
never become a principal. `401` codes are `invalid_token`, `access_revoked`
or none, all handled by the `401` rows. Retainer does not guess around it:
every OAuth `403`, whatever its `code`, is `provider_forbidden`.
The staging check in §11 (check 7) through the real gateway is a launch
blocker.

## 6. Web (`packages/web`)

### 6.1 The round trip

- **Start.** `MemberConnectionPanel` calls `authorizeExtensionConnection`,
  saves `{ workspaceId, installationId, returnPath, startedAt }` in
  `sessionStorage` under `retainer:connect:<state>`, and navigates to
  `authorizationUrl`. `loginHint` is the signed-in person's email from the
  account session; in key mode it is left out.
- **Return.** A new page at `/app/connect/callback`, handled before the
  workspace router like `/app/oauth/consent` (`main.tsx`). It reads `state`
  and `code` or `error`, removes them from the address bar with
  `history.replaceState`, and reads the workspace and installation IDs from
  the state (§4.4). A state that does not parse goes straight to the generic
  message below. Otherwise it opens that workspace, calls
  `completeExtensionAuthorization`, and replaces the location with that
  installation's Connections tab, plus `connect=declined` or
  `connect=failed` when there is something to say. It needs nothing the
  starting tab saved. A saved entry for this state, if this tab has one, is
  deleted; it is used only for the "never completed" notice below.
- **A different tab.** Signing up for Tamloot may continue in another tab or
  window, for example from an email link, depending on how Tamloot's sign-up
  is configured. Retainer does not depend on that setting: the callback
  works in any tab of a browser signed in to Retainer as the member who
  started.
- **Support boundary: a browser not signed in to Retainer** (an email link
  opened on a phone). The page says "Sign in to Retainer, then open the
  extension's Connections tab and connect again." and links to `/app/`. It
  never posts the code. The code is never exchanged, so no Tamloot session
  is created; the approval in Tamloot stays, and the next attempt skips its
  screen.
- **Signed in as someone else, or not a member of that workspace.** The
  same page as an expired request: "This page can't finish connecting. Open
  the extension's Connections tab and try again." The other person's
  connection is never touched.

### 6.2 The Connections tab

Not connected, when `connectionMethods` includes `oauth`:

- The connection's non-secret settings inline (for Tamloot, "Days of
  history", default 31).
- A primary button **Connect with Tamloot** (`Connect with <name>`).
- When `key` is also offered: a text button "Use an API key instead", which
  opens today's form.

Without `oauth` the tab is exactly as today.

One notice after returning, from the `connect` search parameter or from a
saved entry that never completed:

| Case                                    | Notice                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `connect=declined`                      | "Tamloot isn't connected: the request was declined. You can try again." |
| `connect=failed`                        | "Tamloot isn't connected: connecting took too long. Try again."         |
| A saved entry, no connection, no result | "Tamloot isn't connected. You can try again." Then delete the entry.    |

Connected with OAuth:

| Connection                                 | The card shows                                              |
| ------------------------------------------ | ----------------------------------------------------------- |
| `connecting`                               | "Connecting…", as today                                     |
| `active`, first scan not finished          | "Importing…" and today's scan line                          |
| `active`, scan finished, no imported items | The manifest's `gettingStarted` text and link               |
| `active`, with imported items              | Today's lines                                               |
| `needs_reconnect`                          | "Needs reconnect", the reason, and **Connect with Tamloot** |
| `setup_failed`                             | The reason and **Connect with Tamloot**                     |

For `needs_reconnect` and `setup_failed`, the card adds: "If you don't
connect again, disconnect: imports stay stopped and Retainer gives up its
access in Tamloot, retrying for up to a day. Revoking Retainer in Tamloot
always ends it." Until the member does one or the other, Retainer may still
hold the previous session.

Reconnecting an OAuth connection is the same button, with the connection's
ID and generation. It shows the same inline settings, filled with the current
values. "Disconnect account" and "View your runs" stay. The note under the
card becomes: "Disconnecting stops imports now and keeps imported records in
the workspace. Retainer then gives up this workspace's access in Tamloot,
retrying for up to a day."

When `releaseNotice` is set, the tab shows it above the card, or above the
connect button when the member has no connection, until they dismiss it:

> Retainer couldn't confirm it ended its access in Tamloot. To be sure,
> revoke Retainer in Tamloot: Settings → Connected apps. That disconnects
> every Retainer workspace that uses this Tamloot account.

with a link **Open Connected apps** to
`https://app.tamloot.cc/dashboard/settings?tab=apps` and a **Dismiss**
button. The words are Tamloot's §10, so both products say the same thing.
The link is part of the manifest's OAuth metadata (§4.2, `revokeUrl`), so
Part A names no provider.

The notice lives on the Connections tab, so it reaches a member only while
they can open it. Uninstalling the extension, deleting the workspace or
removing the member takes that away, and Retainer adds no notice outside the
workspace. What the member has instead:

- Tamloot's Connected apps lists Retainer for as long as it has any access,
  so that list is always the place to check.
- The uninstall confirmation (`extensions/detail.tsx`), for an installation
  whose `connectionMethods` include `oauth`, adds: "Retainer will try for up
  to a day to give up each member's access in Tamloot. Members can check
  Tamloot's Connected apps."

This is a stated limit (§13), not a promise.

Reasons, for an OAuth connection (extend `connectionError`, which takes the
credential and the state):

| State and code                             | Text                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `needs_reconnect`, `provider_unauthorized` | "Retainer's access to this Tamloot account ended. Connect again to resume imports."                    |
| `setup_failed`, `provider_unauthorized`    | "Tamloot didn't finish connecting. Try again."                                                         |
| `source_account_changed`                   | "You approved a different Tamloot account. Connect again with the first one, or disconnect to switch." |
| `setup_failed`, `release_backlog`          | "Tamloot couldn't be reached to end an earlier connection. Try again in a few minutes."                |
| `setup_failed`, `exchange_interrupted`     | "Tamloot didn't finish connecting. Try again."                                                         |
| Anything else                              | Today's texts                                                                                          |

The admin table gains a "Reason" column with the same text, so admins see why
a connection needs reconnecting (PRD requirement 4). For a connection with
`releaseIncompleteAt`, disconnected or not, the column says "Tamloot access
may remain. The member can revoke Retainer in Tamloot." Admins see it until
the connection row is deleted with the installation or workspace.

## 7. Measuring success

| PRD measure                                            | How                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Most new connections use Connect with Tamloot          | New `extension_connections` rows by `credential`                                       |
| Under a minute from the click to the first import      | `connected_at − authorization_started_at`; the backfill is published before activation |
| Few reconnects for reasons other than a revoke         | OAuth connections that reached `needs_reconnect`, against Tamloot's count of revokes   |
| Accounts created while connecting, and a first meeting | Tamloot's analytics (its spec §9). Retainer cannot tell a new account from an old one. |

A new operator command prints the first three for the last `n` days, per
registration: `retainer extension connections [--days <n>]`, beside
`model usage` in `operator/commands.ts`. It also prints how many connections
got `release_incomplete_at`, and how many `connect` jobs failed with
`release_backlog` or `exchange_interrupted`, so a leak is counted, not
silent. It reads counts and timings only.

## 8. Security

- `state` is `v1.<workspaceId>.<installationId>.<nonce>` with a 256-bit
  random nonce (§4.4). The whole state is stored only as a hash, single-use,
  good for 15 minutes and bound to the member, workspace and installation. A completion
  from another member's session is refused, so a code cannot be planted in
  someone else's connection.
- The workspace and installation IDs in the state only route the callback.
  The server trusts them for nothing: it matches the hash of the whole state
  after the ordinary membership and owner checks (§4.5). Changing an ID makes
  the hash miss. A forged state reveals nothing a caller could not learn by
  sending that workspace ID in the header today, and the route keeps the
  session's CSRF check.
- The verifier never reaches the browser. The code passes through the
  browser once and is useless without the verifier and the client secret.
- The client secret lives in process configuration. It is not written to
  Postgres, logs, job inputs, KV or diagnostics, and one run-only route
  returns it.
- Tokens are broker secrets under the connection's encryption identity. They
  never appear in reads, KV, job inputs or diagnostics.
- The web app navigates only to the address the server built from operator
  configuration, and returns only to a path under `/app/`.
- The bundle can call six GETs and `DELETE /v1/access`. Tamloot refuses
  anything else for Retainer's client whatever Retainer sends (PRD
  requirement 7).

## 9. Tests

Real Postgres, a fresh database per file, no mocked database.

- **Manifest (unit):** every rule in §4.2; a manifest without `oauth` keeps
  its digest.
- **Authorize and complete (API):** the happy path to `connecting`; each
  refusal in §4.4 and §4.5; another member's state; an expired request; a
  denied request leaves nothing connected; `keyFallback: false` refuses a key
  connect; an agent key cannot start.
- **Concurrency:** two completions of one state at once (one connection, one
  `409`); two starts by one member (the earlier state stops working);
  completion racing the member's removal from the workspace.
- **Broker (database):** a disconnect job reads a retained secret and cannot
  write it; a retained secret is unreadable by any other job; it is gone when
  the cleanup job finishes and after 24 hours; a hook with no secrets retires
  everything at once, as before.
- **Runtime route:** `oauth-client` refuses a non-run caller, a `configure`
  run and a function that does not declare the token secret.
- **Bundle, against HTTP fixtures (`packages/runner`, `test/api/tamloot.test.ts`):**
  exchange then import; a retried `connect` does not exchange twice; refresh
  when close to expiry; `401`, refresh, retry; `invalid_grant` gives
  `needs_reconnect` and no further runs; `5xx` and `429` at the token
  endpoint retry and never mark the connection; a write conflict uses the
  stored tokens; OAuth `403` with any code, or none, is `provider_forbidden`
  and never `needs_reconnect`; a key connection behaves exactly as before;
  two handler runs in one process share nothing.
- **Session lifecycle (bundle fixtures, one test per failure):**
  - The exchanged session is stored as `pending` before `/v1/me` is called;
    nothing is imported with it before `verifySource` passes.
  - Reconnect with the same account: the new session becomes `current` and
    the old one is released only after that write.
  - Reconnect with another account: `verifySource` refuses, `current` is
    still the old session, the new one is in `release` as `rejected`,
    `pending` is empty, its `DELETE /v1/access` is attempted in the same
    run, and the run fails with `source_account_changed`.
  - The same, with `DELETE /v1/access` answering `503`: the entry stays, and
    the queued `{ keep: 'current' }` hook releases it on its next attempt
    without touching `current`.
  - Four entries in `release` that cannot be released: `connect` fails with
    `release_backlog`, makes no token call, and leaves the store unchanged.
  - No path removes an entry from `release` except a `204` or a session that
    is already gone. A property test over random sequences of reconnects,
    rejections and release outcomes: the store never holds more than six
    sessions, and every session ever stored is either released or still
    stored.
  - The run dies after the token endpoint answered and before `pending` is
    written: the retry sees `exchange: 'started'`, exchanges again, gets
    `invalid_grant`, writes `exchange: 'done'` and fails with
    `exchange_interrupted` and `releaseIncomplete`. A later `connect`,
    `poll` or cleanup of that connection reports nothing more for it.
  - The first exchange answered `invalid_grant` or `invalid_client`: the
    store says `exchange: 'done'` with no `pending`, the run fails as §5.8
    says, and neither the `{ keep: 'current' }` cleanup nor the next
    `connect` reports anything.
  - The same crash, then the member connects again with a new code before
    any retry: step 2 reports `releaseIncomplete` on a `connect` that
    succeeds, and the connection is `active` with the notice shown.
  - `disconnect` releases `current`, `pending` and `release`; tolerates a
    session that is gone; fails with `release_incomplete` when the store
    says `exchange: 'started'` with no `pending`, after releasing the rest.
  - After a reported crash and a revoke in Tamloot, the connection goes to
    `needs_reconnect` and its `{ keep: 'current' }` cleanup succeeds
    without reporting again.
  - `poll`, `scan` and `sync-session` drain `release` before importing, and
    still import when the drain fails.
  - An upgrade's `connect` with the same code and no `pending` makes no
    token call, promotes nothing and leaves `release` as it was apart from
    the drain.
  - Entries the `{ keep: 'current' }` hook already released are removed by
    the next `connect` or `poll` without error.
- **Cleanup paths (database and API):**
  - A failed `connect` queues the `{ keep: 'current' }` hook in the same
    transaction. It is claimed while the connection is `setup_failed` and
    the job is under 24 hours old, and not after; it reads the token secret
    and cannot write it; `admitRun`, the installation read and
    `oauth-client` admit it; CRM, KV and children refuse it; a reconnect
    cancels it; a disconnect cancels it and queues the full hook. The same
    for `needs_reconnect`.
  - The `{ keep: 'current' }` hook succeeding leaves the connection's
    `state`, `health`, `last_error` (still `source_account_changed`) and
    generation unchanged, retires no secret and queues nothing. Failing for
    good, or reaching 24 hours, changes the same nothing except
    `release_incomplete_at`, and queues no further cleanup.
  - The full hook on a disconnected connection retires the retained
    secrets when it finishes; the `{ keep: 'current' }` hook never does.
  - Member disconnect, admin disconnect, member removal, uninstall and
    workspace deletion each queue the hook and let it read the token secret
    within 24 hours. For uninstall and deletion, the installation stays
    `uninstalling` until the hook succeeds, the secrets are deleted after
    it, and `retainer_retire_extension_secrets` does not end the hook's read
    early.
  - A hook that fails for good, runs out of retries or reaches 24 hours sets
    `release_incomplete_at`; one that succeeds does not; any result with
    `releaseIncomplete`, succeeded or failed, sets it in the same
    transaction.
  - `releaseNotice` shows only the caller's own connection, dismissing is
    the owner's alone, and it stays until dismissed. A report after a
    dismissal shows it again; the dismissed report does not come back.
- **Completion and the state (API):** completion with the workspace named in
  the state works with nothing else from the starting tab. Each gives the
  same `409 authorization_expired` body: a state whose workspace or
  installation ID was changed, a state with the nonce changed, a state that
  does not parse, another member's state, an expired state, a replayed
  (consumed) state, and a state whose owner has left the workspace. A caller
  who is not a member gets the same refusal for a real and a made-up
  workspace ID. A request without the CSRF header is refused. Two
  completions of one state from two tabs at once: one connection, one
  `409`.
- **Web (unit and Playwright):** the button and inline days; the round trip
  through a stub authorize page to "Connecting…"; declined; the
  getting-started text; "Needs reconnect" with its reason for the member and
  in the admin table; no OAuth client shows today's tab. Also:
  - The stub authorize page returns to the callback in a new page of the
    same browser context, with empty `sessionStorage`: it completes and
    lands on the Connections tab.
  - The callback in a new browser context with no Retainer session: the
    sign-in message, and no completion request is sent.
  - The callback signed in as another member: the generic message, and the
    first member's connection is unchanged.
  - A tampered or malformed state in the address: the generic message.
  - `releaseNotice` shows its text and the `revokeUrl` link, and dismisses.

## 10. Delivery

Two PRs.

1. **Platform.** §4 and §6 with their tests, using a fixture registration.
   Nothing changes for any installed extension, and no manifest uses `oauth`
   yet.
2. **Tamloot.** §5 and §7, the new release metadata, and the documents below.

Then the rollout, with Tamloot's PRs live on the same environment:

1. Tamloot registers the client with the redirect address from §4.1 and
   hands over the client ID and secret through the secret store (its §11).
2. `retainer-cloud` sets `RETAINER_EXTENSION_OAUTH_CLIENTS` on the
   `extensions` function and publishes the new Tamloot release. The release
   adds a `disconnect` function: confirm the hosted executable map and the
   cloud allowlist cover it before the catalog changes.
3. Run Tamloot's acceptance list (its §14) on staging, then on production.

Documents to update in the PR that changes the behavior:
`docs/extensions-execution.md` (the new setting), `docs/specs/extensions.md`
and `extensions-tamloot.md` (OAuth beside the key, the disconnect hook),
`docs/self-hosting.md` (self-hosted servers connect with a key) and
ARCHITECTURE.md where it lists connection secrets.

## 11. Check these first

Each is believed true or is Tamloot's to fix, and each is cheap to check on
staging. None was run for this spec. Rows 7 to 10 go through Tamloot's real
API Gateway with Retainer's staging client, not a fixture.

1. **Refresh recovery.** Supabase accepts a refresh with the parent of the
   active refresh token, outside the reuse interval, and returns the active
   session (its documented exception). Test: refresh, drop the response,
   refresh again with the old token. If not: a run that dies between a
   refresh and its write costs the member a reconnect; then serialize
   refreshes behind the server.
2. **Client authentication.** The token endpoint accepts HTTP Basic. If not:
   send the client ID and secret in the form body.
3. **Scope.** A refresh token is issued for the scope Retainer sends, or for
   none. If not: settle `scope` with Tamloot (its §13 item 6).
4. **Code lifetime.** An authorization code outlives the wait for the
   `connect` job. If not: start the executor when a `connect` job is queued
   (extensions-lambda.md §3.3, "optional, later").
5. **Speed.** The hosted executor picks up a `connect` job fast enough for
   "under a minute". If not: the same fix as 4.
6. **Routes.** `/v1/extensions/*` and `/app/*` reach the right functions
   without new routes. If not: add them in `retainer-cloud` first.
7. **`401` through the gateway.** An expired access token, a token whose
   session was released and a token after a revoke each answer `401`, never
   `403`. A launch blocker: Tamloot fixes its gateway (§5.8), and Retainer
   does not reinterpret `403`.
8. **Token endpoint errors.** A spent code, a used refresh token outside the
   reuse interval, a revoked approval and a wrong client secret each give
   the error §5.8 expects. If not: correct §5.8 before launch.
9. **Concurrent last disconnects.** Two workspaces of one member disconnect
   at the same moment: Tamloot revokes the approval once and stops listing
   Retainer. If not: Tamloot serializes its release per member and client;
   nothing changes in Retainer.
10. **Release racing an unexchanged code.** One workspace releases the
    member's last session while another holds an approved code it has not
    exchanged, one after the other and at the same moment. Tamloot (PR
    #2410, `61de28d45`, its §4.2 and §13 item 7) treats a session as live
    only while the member's approval is not revoked, so a session under a
    revoked approval reads nothing. Supabase's exchange does not check the
    approval, so the exchange itself returns tokens. Expected:
    - One after the other: the exchange returns tokens, the `connect`'s
      `GET /v1/me` answers `401 access_revoked`, the refresh and retry
      answer `401` again, and the connect fails `setup_failed` with
      `provider_unauthorized`. The `pending` session goes to `release`, and
      its release ends at the second `401` (§5.7).
    - At the same moment: either the same as above, or the new session
      existed first, the approval stays and the connection works.
    No Retainer change. A read that succeeds while Tamloot's Connected apps
    does not list Retainer is a Tamloot blocker.
11. **Load and isolation.** Several connections of one member, polling at
    the normal rate, stay inside the shared API throttle, and their sessions
    stay separate. If not: poll OAuth connections less often.

## 12. Needed from Tamloot

Setup values, and the fixes Tamloot owns.

- The redirect address registered per environment:
  `https://retainer.tamloot.cc/app/connect/callback`, and the staging and
  local ones.
- The token endpoint and its client authentication method.
- The scope string, if one is needed.
- The staging application and API addresses, for `authorizationEndpoint` and
  `apiOrigin`.
- The project's refresh-token reuse settings (check 1).
- The fixes in Tamloot PR #2410 (`e711a9870`, `24e412526`, `61de28d45`),
  live on the same environment: `401` for a token it refuses (check 7), its
  release serialized per member and client (check 9), the approval naming
  task contacts by email only, as `GET /v1/tasks` returns them, and the
  Connected apps tab at the `revokeUrl` in §5.1.
- Liveness that requires a non-revoked approval, for check 10.

## 13. Not in this spec

- **The PRD's open question.** This spec keeps the key option on hosted as a
  secondary link. The first success measure compares the two methods, so it
  needs both for the first month. Removing it later is `keyFallback: false`.
- Other providers. Part A is generic, but only Tamloot uses it.
- Moving token handling behind the server (§2).
- Changing what is imported, writing to Tamloot, signing in to Retainer with
  Tamloot.

Known limits. Giving up access in Tamloot is best effort, retried for 24
hours; Retainer never promises it unconditionally.

- **The exchange window.** If a run dies after Tamloot answers an exchange
  and before `pending` is written, Retainer cannot name that session. The
  retry detects it (§5.5 step 4), the connection is `setup_failed` and the
  member sees the notice. The session stays in Tamloot until the member
  revokes Retainer there.
- **Tamloot unreachable for 24 hours.** After a disconnect, sessions not
  given up in 24 hours stay in Tamloot: Retainer deletes its tokens at the
  deadline and shows the member the notice. After a failed connect,
  Retainer keeps its tokens, including the previous `current`: the
  `{ keep: 'current' }` cleanup stops at 24 hours and shows the notice, and
  the member's next reconnect or disconnect gives up what is left.
- **No place to show the notice.** After an uninstall, a workspace deletion
  or the member's removal, the member cannot open the Connections tab. The
  cleanup still runs for 24 hours; if it does not finish, only the operator
  count (§7) records it, and the member's guidance is Tamloot's Connected
  apps (§6.2).
- **A browser not signed in to Retainer** cannot finish connecting (§6.1).
  The member connects again from Retainer.
- **Revoking is per member, not per workspace.** The only way for a member to
  end access Retainer could not give up is to revoke Retainer in Tamloot,
  which ends it in every workspace they connected.
- **Re-approval brings back a stranded session.** A session Retainer gave up
  after a `401` (§5.7), including one from the race in §11 check 10, may
  still exist in Tamloot under the revoked approval. If the member approves
  Retainer again, Tamloot clears the revoke and that session works again,
  though Retainer no longer holds its tokens. It counts as remaining
  access, so the last disconnect may leave Retainer listed in Tamloot's
  Connected apps. Revoking Retainer there ends it. This is Tamloot's
  documented limit (its §10).
- Retainer notices a revoke at its next request, up to 5 minutes later.
  Tamloot refuses reads from the moment of the revoke.

## 14. PRD coverage

| PRD item                                       | Where                                    |
| ---------------------------------------------- | ---------------------------------------- |
| 1. Connect without a key                       | §4.4, §4.5, §6                           |
| 2. Each member, per workspace; no admin proxy  | §4.4 (owner from the credential), §4.3   |
| 3. Stays active without further approvals      | §5.6                                     |
| 4. "Needs reconnect" with a reason, no pile-up | §5.8, §6.2                               |
| 5. Reconnect behaves as today                  | §4.5, §5.5                               |
| 6. Disconnect ends that connection's access    | §4.7, §5.7; limits in §13                |
| 7. Read-only                                   | §5.7, §8; enforced by Tamloot            |
| 8. Shown by name and address                   | Tamloot; the redirect address in §4.1    |
| 9. Everything else unchanged                   | §5.2, §5.5 step 4                        |
| 10. Self-hosted keeps the key                  | §4.1, §6.2                               |
| 11. Sign up while connecting                   | `loginHint` in §4.4, §4.5, §6.1; Tamloot |
| 12. Nothing imported yet                       | §4.2 `gettingStarted`, §4.8, §6.2        |
| 13. Told when access may remain                | §4.7, §5.5, §5.7, §6.2                   |
| Declining                                      | §4.5 step 2, §6.2                        |
| Success measures                               | §7                                       |
