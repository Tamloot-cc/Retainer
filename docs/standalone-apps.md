# Connecting a standalone workspace app

Tamloot, forms builders and other reviewed standalone services run their own
code and keep provider credentials and execution state outside Retainer. A
workspace admin first approves a release with `execution: 'standalone'`, its
schema/views and read/write access. The app then connects to that installation.

In accounts mode, register an OAuth client through the authorization server's
metadata and registration endpoint. Explicitly request the protected resource
`https://your-retainer-host/v1` in the registration's `resources` array. Pin the
returned client ID in the operator's reviewed manifest as `oauthClientId`, then
publish and install that release. The ID is included in the review digest and
must remain the same across releases of the registration. Register exact callback
URLs and use authorization code with state and PKCE S256.

Request the same `/v1` resource and explicit `read`, `write` and, when needed,
`offline_access` scopes during authorization and code exchange. The consent page
lets an admin choose an active reviewed installation in a workspace they manage.
It shows the app's actor and requested access. MCP uses a separate `/mcp` audience
and person-bound consent; its tokens cannot be used for the standalone REST flow.

Use the access token as a bearer credential with REST or the SDK:

```ts
import { RetainerClient } from '@retainer/sdk';

const retainer = new RetainerClient({
  baseUrl: 'https://your-retainer-host',
  apiKey: accessToken, // Historical option name; accepts the REST OAuth bearer token.
});
```

Store refresh tokens securely in the standalone service, serialize refresh and
persist rotated tokens. Refresh keeps the original installation generation; a
disable/re-enable, settings or grant change needs a new human connection. The
SDK does not refresh OAuth tokens itself. Recreate its client with the current
access token after refresh. In key mode, an admin creates an installation key
in Extensions, chooses the approved scope subset and copies its shown-once value
into the service instead.

Writes are attributed to the installation's approved integration or agent actor.
They have workspace-wide access within their approved coarse scopes, without
personal memory or people/key administration. Installer membership changes do
not remove the workspace grant. Hard account deletion can remove library refresh
tokens and require another admin's approval. Admins inspect and revoke credentials
in Extensions; revocation drains admitted API writes. Already-issued short-lived
file URLs retain their documented expiry window.

For a forms submission, own a permanent submission ID in the external service,
map it to a Retainer record/event ID and send stable request idempotency keys
on retries. Retainer's request receipts expire; keep the permanent mapping in
the service. For a Tamloot transcript, create an upload intent, PUT the complete
bytes, finalize, then attach the immutable file ID to the ordinary event/record
write. File ownership and the change feed identify the installation.

Ordinary `logEvent` does not replace a changed payload under an existing event ID.
Keep edit/revision policy explicit in the standalone service. Managed-source
attestation, participant matching, source suppression and atomic source revision
imports require a reviewed hosted adapter and its live lease. An OAuth token does
not fabricate that lease or grant the hosted queue/KV/secret broker APIs.

Hosted infrastructure and live provider acceptance are separate launch steps;
local OAuth and fixture tests do not establish deployment or provider access.
