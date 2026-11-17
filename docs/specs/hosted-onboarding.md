# Hosted onboarding

Status: proposal, November 17, 2026. The complete journey below is not yet
implemented or verified in both coding agents.

## Goal

A user gives Codex or Claude Code `https://retainer.tamloot.cc/mcp` and asks
it to connect to Retainer. The agent handles configuration and verification.
The user handles sign-in, workspace choice or creation, and consent. A new
user reaches a working connection without leaving the flow to create a
workspace and starting authorization again.

## User journey

1. The user gives the coding agent the hosted MCP URL and asks to connect.
   The agent follows accessible connection instructions for its client.
2. The agent configures the connection and starts OAuth. An existing working
   connection is reused rather than added again.
3. The browser opens for Retainer sign-in or account creation. A user who is
   already signed in continues to workspace selection.
4. The user chooses an accessible workspace. A user with no workspace can
   name and create one within the connection journey, subject to existing
   workspace creation permissions. Creation returns to the pending consent
   flow with the new workspace selected.
5. The user reviews the app, workspace and permitted actions, then allows
   access or cancels. Creating a workspace does not itself grant access.
6. After approval, the browser clearly tells the user to return to their
   coding agent. The client completes authorization and retains the
   connection for future sessions.
7. The agent calls `describe_schema` through its configured MCP connection,
   confirms the selected workspace, and reports that it is connected. A
   browser success screen alone is not proof of a working agent connection.
8. For an uninitialized workspace, the agent follows `discover_schema`:
   learns the business from available context and sources, asks only for
   missing information, and proposes a schema. It applies the schema after
   the user approves. An initialized workspace skips initial schema setup.

## Requirements

- Both Codex and Claude Code support the journey. The Claude Code plugin
  may provide its connection path; installing chat logging is not required
  to connect to hosted Retainer.
- Connection guidance is available before authentication, so an agent given
  only the MCP URL can find out how to proceed.
- The ordinary hosted path requires no repository clone, Docker, local
  Retainer service, or manually copied API key or OAuth token.
- Sign-in and workspace creation preserve the pending authorization
  request. Existing memberships and roles determine which workspaces and
  actions the user can authorize.
- If the client requires a reload or restart to expose a newly configured
  MCP server, the agent gives the minimum exact next step and resumes
  verification afterward. It does not claim the connection is ready early.
- Cancellation stops authorization and leaves no usable new connection.
  It does not delete a workspace the user already created.
- An expired authorization request offers a clear retry that reuses the
  account and workspace already created. Retrying does not create duplicates.
- A failed connection check identifies the next action without reporting
  success. Later sessions reuse valid credentials; expired or revoked access
  leads to reconnection when needed, rather than repeating workspace setup.

## Current foundation and gaps

The server already exposes MCP OAuth discovery and supports dynamic client
registration, native loopback redirects and refresh tokens. The Claude Code
plugin already declares the hosted MCP endpoint. MCP instructions already
direct agents to inspect the schema and follow `discover_schema`.

The main browser gap is first-time workspace creation: consent currently
links users without a workspace to the app and tells them to connect again.
Workspace creation then opens the workspace instead of resuming consent.
The complete client configuration, authorization and verification journey
still needs to be demonstrated independently in Codex and Claude Code.

Relevant existing code:

- [OAuth discovery](../../packages/server/src/api/app.ts)
- [OAuth configuration](../../packages/server/src/accounts/auth.ts)
- [Consent screen](../../packages/web/src/accounts/oauth.tsx)
- [First workspace creation](../../packages/web/src/accounts/screens.tsx)
- [Claude Code MCP configuration](../../plugins/retainer/.mcp.json)
- [MCP onboarding instructions](../../packages/server/src/mcp/instructions.ts)

## Acceptance

Run the following checks independently in Codex and Claude Code:

| Scenario | Required outcome |
| --- | --- |
| New user, no account or workspace | Signs in, creates one workspace, approves access and successfully reads its schema without restarting onboarding. |
| Existing user with multiple workspaces | Selects a workspace; the agent verifies that exact workspace. |
| New, uninitialized workspace | Agent proposes schema setup and waits for approval before applying it. |
| Initialized workspace | Agent connects without repeating initial schema setup. |
| Cancellation or expired authorization | Clear stop or retry; no unintended grant or duplicate workspace. |
| Client requires reload or restart | User receives the required step; success is reported only after an authenticated MCP call works. |
| Later session or revoked access | Valid connections are reused; revoked access requires reconnection without recreating the workspace. |

Local installation and scheduled daily agent work are outside this spec.
