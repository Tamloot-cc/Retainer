<p><img src="https://raw.githubusercontent.com/Tamloot-cc/Retainer/main/packages/web/public/favicon.svg" alt="Retainer logo" width="80" height="80" /></p>

# Retainer documentation

Retainer is open-source memory for AI agents that work with customer
relationships. Agents read conversations with their own models and write what
matters: typed fields, plain-language facts and a log of events, each
linked to who wrote it and where it came from. Retainer validates, stores,
resolves conflicts and searches. It never calls a language model.

## Guides

| Guide                           | For                                                             |
| ------------------------------- | --------------------------------------------------------------- |
| [Self-hosting](self-hosting.md) | Running the server, workspaces and API keys, configuration      |
| [Deploying to AWS](aws.md)      | Lambda, API Gateway and RDS with Terraform, instead of Docker   |
| [Connecting agents](agents.md)  | MCP over HTTP or stdio, the tools, how an agent should write    |
| [TypeScript SDK](sdk.md)        | `@retainer/sdk`: calling the REST API from your own code        |
| [REST API](rest-api.md)         | Authentication, errors, pagination, idempotency and every route |
| [Releasing](releasing.md)       | How maintainers cut a release                                   |

## Specs

Specs record why a feature works the way it does. For current behavior, read
[ARCHITECTURE.md](../ARCHITECTURE.md) and [FRONTEND.md](../FRONTEND.md), which
hold the design, the data model, the write rules and the web app's design.

| Spec                                                              | Status                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Schema, events and history](specs/schema-events-and-history.md)  | Implemented: event records, collection and polymorphic relations, rollups, record timeline |
| [Conversations and Activity](specs/conversations-and-activity.md) | Implemented: the conversation event type and the Activity screen                           |
| [Comments](specs/comments.md)                                     | Implemented: comments on any record, entity-only event links, the object-or-event rule     |
| [Workspace upgrades](specs/workspace-upgrade.md)                  | Implemented: bringing existing workspaces up to new built-in definitions                   |
| [Accounts and access](specs/accounts-and-access.md)               | Implemented: login with Better Auth, passkeys, organizations, roles, MCP OAuth             |
| [Animated mark](specs/assistant-avatar.md)                        | Implemented: the loading indicator and the assistant avatar's moods                        |

## Research

| Research                                                                     | About                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Retainer and Twenty](research/twenty-comparison.md)                         | How Retainer's schema differs from Twenty's CRM schema                               |
| [Schema expressiveness coverage](research/schema-expressiveness-coverage.md) | How well Retainer models ten CRMs, plus Affinity. Predates PR #26                    |
| [Animated mark playground](research/assistant-avatar-playground.html)        | The page used to design the mark's moods and light-mode colors; open it in a browser |

## Concepts in one minute

- **Workspace**: one tenant. Every API key belongs to exactly one workspace,
  so agents never name a workspace in their calls.
- **Objects and fields**: the schema is data. A workspace starts from a
  template (`sales`, `services`, `clinic`, `real_estate`, `recruiting`,
  `blank`) and agents can propose new fields and objects at runtime.
- **Records** hold typed field values. Each value is the winner among
  _assertions_ from agents and people: people outrank agents, newer
  observations outrank older ones, and an agent that would overwrite a
  person's value leaves a pending assertion for review instead.
- **Events** are records of event types: conversations (meetings, calls,
  emails and chats, told apart by their `medium`), notes and any type the
  workspace adds. Agents log them first, then cite
  them as the `source` of what they write.
- **Facts** are plain-language statements about a record (`remember`), each
  citing the event it came from.
- **Actors**: every write is attributed to the actor of the API key that made
  it (`user`, `agent`, `integration` or `system`), never to anything in the
  request body.
