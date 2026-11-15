# Connect with Tamloot: implementation spec

Status: proposal, 2026-11-15. Not implemented.
Implements [extensions-tamloot-connect-prd.md](extensions-tamloot-connect-prd.md)
on the member connections in
[extensions-tamloot-implementation.md](extensions-tamloot-implementation.md).
Tamloot's side is `docs/superpowers/specs/2026-11-15-connected-apps-design.md`
in the Tamloot repository; its §10 is the contract this spec builds against,
and nothing here changes it. Existing-code references were checked on
`6ae1e7b`. Paths are relative to `packages/server/src` unless a package is
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
3. Create `state` and the verifier: 32 random bytes each, base64url. The
   challenge is the base64url SHA-256 of the verifier.
4. Stage the verifier through `broker.stage` under the manifest's
   `verifierSetting`, bound to the caller and to the connection ID (the
   existing one, or a new UUID for a new connection).
5. Delete the caller's other unconsumed requests for this installation, and
   rows of this workspace that expired more than an hour ago. Insert the
   request. A member has one handshake in progress per installation; starting
   again replaces the earlier one.
6. Return the authorize address: `authorizationEndpoint` with
   `response_type=code`, `client_id`, `redirect_uri`, `state`,
   `code_challenge`, `code_challenge_method=S256`, `scope` when configured,
   and `login_hint` when the request carried one.

`loginHint` is a suggestion that Tamloot shows in its sign-up form. It carries
no authority: the server checks only that it looks like an email and forwards
it. The owner still comes from the credential.

### 4.5 Completing it

`POST /v1/extensions/:id/connections/authorize/complete`, scope `read`, a
person only.

```ts
// request: exactly one of code and error
{ state: string, code?: string, error?: string }
// 200
{ id: string, state: 'connecting' } | { cancelled: true }
```

1. Find the request by `state_hash` in this workspace and installation. It
   must belong to the caller, be unconsumed and unexpired. Anything else is
   `409 authorization_expired`. The answer does not say which check failed.
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
- When the cleanup job reaches a final state (succeeded, failed for good or
  expired), retire the retained secrets at once, in the transaction that
  records the result. A new function `retainer_finish_member_cleanup` does
  it, granted to the role that records job results.
- `retainer_connection_secret_names` already hides retired secrets, so reads
  of a disconnected connection list none.

A hook that declares no secrets behaves exactly as before.

### 4.8 Reads

- `ExtensionConnection` gains `credential` and `hasImportedItems`: whether
  the connection's source account has at least one source item past
  `reserved`. `list` computes it through `source_bindings`.
- `ExtensionInstallation` gains `connectionMethods` for a member
  registration: `['oauth', 'key']`, `['oauth']` or `['key']`, from the
  manifest and §4.1.

### 4.9 Interfaces

- SDK: `authorizeExtensionConnection(id, input)`,
  `completeExtensionAuthorization(id, input)` and, for runs,
  `extensionOAuthClient(id)`.
- MCP stays read-only. `list_extension_connections` shows `credential`.
- New error codes: `oauth_unavailable`, `authorization_expired`,
  `credential_mismatch`.

## 5. Part B: the Tamloot bundle

### 5.1 Contract (`packages/runner/src/tamloot-contract.ts`)

- `apiKey` becomes `required: false`.
- Three new settings, each `type: 'string'`, `level: 'connection'`,
  `secret: true`, `generated: true`, `required: false`: `oauthVerifier`,
  `oauthCode`, `oauthTokens`.
- `oauth: { verifierSetting: 'oauthVerifier', codeSetting: 'oauthCode',
  tokenSetting: 'oauthTokens', keySetting: 'apiKey' }`.
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
  codeHash: z.string().length(64), // SHA-256 of the code these tokens came from
  current: session,
  release: z.array(session).max(5), // sessions to give up in Tamloot
});
```

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
2. If nothing is stored, or the stored `codeHash` is not the hash of this
   code: exchange the code. Write the store at once, before any other call:
   the new session as `current`, the new `codeHash`, and the previous
   `current`, if there was one, appended to `release`. If `release` is full,
   drop its oldest entry.
3. If the hash matches, this is a retry, or the `connect` an upgrade or
   re-enable queues. Do not exchange again; continue with the stored session,
   refreshing it if needed (§5.6).
4. `GET /v1/me`, then `verifySource`, then the cursor and backfill, all as
   today.
5. Give up each session in `release` (§5.7) and write the store without the
   ones that are gone. A failure here never fails the connect.

The order in 2 and 5 matters. Tamloot revokes the member's approval when
Retainer gives up its last session, so the new session must exist before the
old one is released.

### 5.6 Access in every other function

`TamlootProvider` takes a credential source in place of a key string.

- Key: the bearer is the key. Nothing changes.
- OAuth: read `oauthTokens`. If `current.expiresAt` is less than 5 minutes
  away, refresh first and write the store at once. Requests go to `apiOrigin`
  when the client names one.
- On a `401` from the API with OAuth: refresh once, write, and repeat the
  request. A second `401`, or a refresh that fails with `invalid_grant`, is
  `provider_unauthorized`.
- `poll` also gives up any sessions left in `release` (§5.7).

No module-level caches: a warm Lambda environment serves other installations
next (extensions-lambda.md §3.2).

### 5.7 Giving up a session, and `disconnect`

To give up one session: `DELETE /v1/access` with its access token. `204` is
done. On `401`, refresh that session once and repeat; a second `401` or
`invalid_grant` means the session is already gone, which is also done. `429`,
a `5xx` or a network error means try again later.

The `disconnect` function reads `oauthTokens`. `409 connection_required`
means a key connection or nothing stored: succeed. Otherwise it gives up
`current` and every entry in `release`, and writes nothing. If any attempt
must be retried it returns `retry`; the platform retries inside the 24-hour
cleanup window.

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

`provider_unauthorized` already deletes the connection's schedules and leaves
its queued jobs to be cancelled at claim, so a revoked connection fails once
and then stops (PRD requirement 4). A `403` with OAuth must not ask the
member to reconnect: reconnecting would not fix it.

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
  `history.replaceState`, loads the saved entry, opens that workspace, calls
  `completeExtensionAuthorization`, deletes the entry and replaces the
  location with `returnPath` plus `tab=connections` and `connect=declined` or
  `connect=failed` when there is something to say.
- `returnPath` is used only if it starts with `/app/`. With no saved entry
  (another tab, or cleared storage) the page says "This page can't finish
  connecting. Open the extension's Connections tab and try again." and links
  to `/app/`.

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

Reconnecting an OAuth connection is the same button, with the connection's
ID and generation. It shows the same inline settings, filled with the current
values. "Disconnect account" and "View your runs" stay. The note under the
card becomes: "Disconnecting keeps imported records in the workspace and
gives up this workspace's access in Tamloot."

Reasons, for an OAuth connection (extend `connectionError`, which takes the
credential and the state):

| State and code                             | Text                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `needs_reconnect`, `provider_unauthorized` | "Retainer's access to this Tamloot account ended. Connect again to resume imports."                    |
| `setup_failed`, `provider_unauthorized`    | "Tamloot didn't finish connecting. Try again."                                                         |
| `source_account_changed`                   | "You approved a different Tamloot account. Connect again with the first one, or disconnect to switch." |
| Anything else                              | Today's texts                                                                                          |

The admin table gains a "Reason" column with the same text, so admins see why
a connection needs reconnecting (PRD requirement 4).

## 7. Measuring success

| PRD measure                                            | How                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Most new connections use Connect with Tamloot          | New `extension_connections` rows by `credential`                                       |
| Under a minute from the click to the first import      | `connected_at − authorization_started_at`; the backfill is published before activation |
| Few reconnects for reasons other than a revoke         | OAuth connections that reached `needs_reconnect`, against Tamloot's count of revokes   |
| Accounts created while connecting, and a first meeting | Tamloot's analytics (its spec §9). Retainer cannot tell a new account from an old one. |

A new operator command prints the first three for the last `n` days, per
registration: `retainer extension connections [--days <n>]`, beside
`model usage` in `operator/commands.ts`. It reads counts and timings only.

## 8. Security

- `state` is 256 random bits, stored only as a hash, single-use, good for 15
  minutes and bound to the member, workspace and installation. A completion
  from another member's session is refused, so a code cannot be planted in
  someone else's connection.
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
  stored tokens; reconnect releases the old session only after the new one
  is stored; `disconnect` releases and tolerates a session that is gone;
  OAuth `403` is `provider_forbidden`; a key connection behaves exactly as
  before; two handler runs in one process share nothing.
- **Web (unit and Playwright):** the button and inline days; the round trip
  through a stub authorize page to "Connecting…"; declined; a missing saved
  entry; the getting-started text; "Needs reconnect" with its reason for the
  member and in the admin table; no OAuth client shows today's tab.

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

Each is believed true and cheap to confirm on staging.

| #   | Assumption                                                                                            | If false                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Supabase accepts a refresh with the parent of the active refresh token and returns the active session | A run that dies between a refresh and its write costs the member a reconnect. Then serialize refreshes behind the server. |
| 2   | The token endpoint accepts HTTP Basic client authentication                                           | Send the client ID and secret in the form body                                                                            |
| 3   | A refresh token is issued for the scope Retainer sends, or for none                                   | Settle `scope` with Tamloot (its §13 item 6)                                                                              |
| 4   | An authorization code outlives the wait for the `connect` job                                         | Start the executor when a `connect` job is queued (extensions-lambda.md §3.3, "optional, later")                          |
| 5   | The hosted executor picks up a `connect` job fast enough for "under a minute"                         | The same fix as 4                                                                                                         |
| 6   | `/v1/extensions/*` and `/app/*` reach the `extensions` and `api` functions without new routes         | Add the routes in `retainer-cloud` first                                                                                  |

## 12. Needed from Tamloot

Setup values only; none changes Tamloot's contract.

- The redirect address registered per environment:
  `https://retainer.tamloot.cc/app/connect/callback`, and the staging and
  local ones.
- The token endpoint and its client authentication method.
- The scope string, if one is needed.
- The staging application and API addresses, for `authorizationEndpoint` and
  `apiOrigin`.
- The project's refresh-token reuse settings (assumption 1).

## 13. Not in this spec

- **The PRD's open question.** This spec keeps the key option on hosted as a
  secondary link. The first success measure compares the two methods, so it
  needs both for the first month. Removing it later is `keyFallback: false`.
- Other providers. Part A is generic, but only Tamloot uses it.
- Moving token handling behind the server (§2).
- Changing what is imported, writing to Tamloot, signing in to Retainer with
  Tamloot.

Known limits:

- If a run dies after Tamloot answers an exchange and before the tokens are
  stored, the code is spent. The connection is `setup_failed`, the member
  connects again, and the unused session stays in Tamloot until the member
  revokes Retainer there.
- If Tamloot is unreachable for the whole 24 hours after a disconnect, the
  session is not given up. Retainer has already deleted its tokens; Tamloot
  keeps listing Retainer until the member revokes it.
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
| 6. Disconnect ends that connection's access    | §4.7, §5.7                               |
| 7. Read-only                                   | §5.7, §8; enforced by Tamloot            |
| 8. Shown by name and address                   | Tamloot; the redirect address in §4.1    |
| 9. Everything else unchanged                   | §5.2, §5.5 step 4                        |
| 10. Self-hosted keeps the key                  | §4.1, §6.2                               |
| 11. Sign up while connecting                   | `loginHint` in §4.4; the rest is Tamloot |
| 12. Nothing imported yet                       | §4.2 `gettingStarted`, §4.8, §6.2        |
| Declining                                      | §4.5 step 2, §6.2                        |
| Success measures                               | §7                                       |
