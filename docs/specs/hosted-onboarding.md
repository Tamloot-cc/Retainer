# Hosted onboarding

Status: implemented November 17, 2026.

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
3. If schema setup is pending or `describe_schema` reports `initialized: false`,
   the agent follows `discover_schema`. It uses the sources and context it
   already has, asks only for missing information, and proposes the first
   schema or additions to the existing schema. It applies the proposal after
   the user approves it. An initialized workspace skips this step.

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

The setup screen is reserved for workspaces created in the schema pending
state. Existing workspaces with built-in types keep their normal workspace UI
and remain eligible for agent-led schema discovery when `describe_schema`
reports `initialized: false`.

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

## Implementation

The hosted control service provisions the default workspace after checking
for existing access and pending invitations. The web and OAuth entry points
share the same operation and serialize first-workspace creation for the
signed-in person. Accepting an invitation returns to the same signed OAuth
request.

The setup prompt names the workspace and gives each client a separate
connection that is bound to that workspace at consent. It works even if
OAuth opens in a different browser. The ordinary hosted MCP URL gives the
user a choice of accessible workspace. The public connection instructions
are served at `/mcp/setup` and linked from the MCP resource metadata.

New hosted workspaces seed the hidden note type and workspace and personal
memory types. They unlock the full web app only when an applied schema change
creates a visible type. Existing workspaces keep their seeded types and
template support. An account API request that explicitly selects a built-in
template can still create a workspace with that template already applied. In a workspace designed from scratch, templates are
examples and the first proposal contains every type to be applied.

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
| Existing workspace with built-in types and `initialized: false` | The normal workspace UI remains available. The agent can run `discover_schema` and propose additions for the user to approve. |
| Initialized workspace | The agent connects without repeating initial schema setup. |
| Cancellation, expired authorization, or concurrent attempts | No unintended grant or duplicate default workspace. A later attempt can resume with the existing workspace. |
| Client requires reload or restart | The agent gives the required step and verifies the connection before reporting success. |
| Later session or revoked access | A valid connection is reused. Reconnection reuses the workspace and its schema. |

Local verification used Codex CLI 0.169.0 and Claude Code 2.1.326.
Both clients completed OAuth and called `describe_schema` for the intended
workspace through each entry path. The tests used a local Retainer backed
by Postgres, with test sign-in accounts and a stubbed model response for
Claude Code. Browser tests additionally cover invitations, cancellation,
and applying the first schema.

Local installation and scheduled daily agent work are outside this spec.
