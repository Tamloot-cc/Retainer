# Hosted onboarding

Status: proposal, November 17, 2026. The complete journey still needs to be
implemented and verified in Codex and Claude Code.

## Goal

A new user can start in the Retainer web app or in their coding agent. Retainer
provides a workspace, the agent handles MCP setup and verification, and the user
signs in and approves access. The agent then helps the user design the workspace's
first schema from the way they work and the data they already have.

## Web app first

1. The user opens Retainer and signs in. If they have an accessible workspace,
   Retainer opens it as usual. If they have a pending invitation and no
   accessible workspace, Retainer gives them the chance to join their team.
2. If the user needs a workspace and can create one, Retainer creates it with
   a default name they can change later. It opens the workspace setup screen.
3. The user clicks **Copy setup prompt** and pastes it into Codex or Claude Code.
   The prompt carries the hosted MCP URL and identifies the exact workspace.
   The agent configures MCP and opens the browser for consent to that workspace.

## Agent first

1. The user gives Codex or Claude Code the hosted MCP URL
   (`https://retainer.tamloot.cc/mcp`), a setup prompt, or the GitHub repo with
   hosted connection instructions. The agent finds the instructions, configures
   MCP, and starts authorization.
2. The browser opens Retainer. The user signs in if needed. Retainer lets them
   choose an accessible workspace, or gives them the chance to accept a pending
   invitation if they have none. If they still need a workspace and can create
   one, Retainer creates it with a default name and selects it for consent.
3. Sign-in, accepting an invitation, and creating a workspace preserve the
   pending authorization request.

## Consent and schema setup

1. The consent screen shows the app, exact workspace, and permitted actions.
   The user approves or cancels. After approval, the browser tells them to
   return to their agent.
2. The agent calls `describe_schema` over its authenticated MCP connection
   and verifies that it reached the intended workspace before reporting success
   or proposing changes. A valid connection can be reused when it reaches
   that workspace.
3. If schema setup is pending, the agent follows `discover_schema`. It uses
   the sources and context it already has, asks only for missing information,
   and proposes the first schema. It applies the schema after the user approves
   it. An initialized workspace skips this step.

## Workspace before schema setup

A new hosted workspace starts with schema setup pending. It can be selected
and authorized over MCP before it has any user-visible record or event types.
The first visible schema reflects the user's approved proposal. Retainer can
set up the internal structures it needs at workspace creation. Before
implementation, check which built-ins are required internally and which can
wait for the approved schema.

The setup screen shows the workspace name, brief instructions, and the
**Copy setup prompt** button. The account menu remains available for switching
workspaces and signing out. The sidebar, records, and workspace settings
appear after the approved schema is applied successfully. If applying the
schema fails, the workspace stays in setup and the user can retry.

## Requirements

- Both Codex and Claude Code support these journeys. The Claude Code plugin
  may provide its connection path. Chat logging is optional.
- Connection instructions are accessible before authentication, including
  when the agent starts with only the MCP URL. Hosted setup requires no repo
  clone, Docker, local Retainer service, or manually copied credentials.
- Existing memberships and roles determine which workspaces a user can
  create or access and which actions they can authorize.
- Cancellation leaves the workspace available and grants no new access.
  Returning later or retrying expired authorization reuses the existing
  account and workspace. Repeated or concurrent attempts create at most one
  default workspace for the same first-time user.
- When a client needs a reload or restart, the agent gives the exact next step
  and resumes verification afterward. If verification fails, the agent gives
  the next action and reports success only after the authenticated call works.
- Later sessions reuse valid access to the intended workspace. Revoked or
  expired access can be renewed without repeating workspace or schema setup.

## Current foundation and gaps

Retainer supports MCP OAuth discovery, dynamic client registration, native
loopback redirects, and refresh tokens. The Claude Code plugin declares the
hosted MCP endpoint. MCP already guides agents toward `discover_schema`.

Today the web app asks the user to name and create their first workspace, and
MCP consent sends a user without a workspace to the app to do that and then
restart authorization. A new workspace has built-in types even when
`describe_schema` reports `initialized: false`. The proposed setup state
needs to distinguish a workspace with no visible schema from that existing
state.

Relevant code:

- [OAuth discovery](../../packages/server/src/api/app.ts)
- [OAuth configuration](../../packages/server/src/accounts/auth.ts)
- [Consent screen](../../packages/web/src/accounts/oauth.tsx)
- [First workspace creation](../../packages/web/src/accounts/screens.tsx)
- [Workspace creation and schema seeding](../../packages/server/src/accounts/people.ts)
- [Claude Code MCP configuration](../../plugins/retainer/.mcp.json)
- [MCP onboarding instructions](../../packages/server/src/mcp/instructions.ts)

## Acceptance

Check both entry paths independently in Codex and Claude Code.

| Scenario | Required outcome |
| --- | --- |
| Web app first, new user | Sign-in creates one workspace and opens the setup screen. The copied prompt leads to consent and MCP verification for that exact workspace. |
| Agent first, new user | Sign-in creates one workspace and resumes consent. The agent verifies access without restarting authorization. |
| Pending invitation | The user can accept the invitation and continue with an accessible team workspace without an automatically created separate workspace. |
| Multiple workspaces or an existing connection | The web handoff keeps the intended workspace. In the agent-first path, the user can select a workspace. The agent verifies the selected workspace before proceeding. |
| Schema setup pending | The setup screen shows no record navigation. The agent proposes a schema from available sources and waits for approval. The full workspace UI appears with the approved types after a successful apply. |
| Initialized workspace | The agent connects without repeating initial schema setup. |
| Cancellation, expired authorization, or concurrent attempts | No unintended grant or duplicate default workspace. A later attempt can resume with the existing workspace. |
| Client requires reload or restart | The agent gives the required step and verifies the connection before reporting success. |
| Later session or revoked access | A valid connection is reused. Reconnection reuses the workspace and its schema. |

Local installation and scheduled daily agent work are outside this spec.
