<p><img src="https://raw.githubusercontent.com/Tamloot-cc/Retainer/main/packages/web/public/favicon.svg" alt="Retainer logo" width="80" height="80" /></p>

# Retainer

Open-source memory for AI agents that work with customer relationships.

Retainer keeps a living record of every person, company and deal a business
works with. Agents read conversations with their own models and write what
matters: typed fields, plain-language facts and a log of events, each
linked to who wrote it and where it came from. Agents read it back through MCP
or a REST API.

The optional web app lets people review agent proposals, browse records with
provenance, edit fields, and retract facts and events.

- **Schema as data**: objects and fields are stored as rows, so a workspace,
  or an agent working in it, can add fields and objects at runtime.
- **Agent-written memory**: Retainer never calls a language model. It
  validates writes, resolves conflicts between agents and people, keeps
  history and makes it searchable.
- **Self-hosted**: one Docker image and Postgres.

Status: 0.1.0, the first release, is not yet published to npm or GitHub
Container Registry; see the [changelog](CHANGELOG.md). Guides
are in [docs/](docs/README.md); the design is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Run it

```sh
docker compose -f docker/compose.yml up --build
curl localhost:8787/health
```

On first boot the server creates a `default` workspace and prints an admin
API key once. Manage workspaces and keys with the operator CLI, which talks
to the database directly:

```sh
docker compose -f docker/compose.yml exec retainer retainer workspace create --name "Acme Clinic" --template clinic
docker compose -f docker/compose.yml exec retainer retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
```

Send the key as `Authorization: Bearer <key>` to the REST API under `/v1`.

To erase a person on request (`POST /v1/records/:id/forget`), set
`RETAINER_SUPPRESSION_KEY` to a long random secret (at least 32 characters)
and keep it stable: erased emails and phones are stored only as an HMAC under
this key, so a new key lets them back in. `openssl rand -hex 32` makes one.
The consolidator runs per workspace every `RETAINER_CONSOLIDATE_INTERVAL_MINUTES`
(default 60).

## Open the web app

The Docker image serves the app at [localhost:8787/app](http://localhost:8787/app/).
Create a separate personal key for each reviewer:

```sh
docker compose -f docker/compose.yml exec retainer retainer key create --workspace acme-clinic \
  --name "Dana (web)" --actor user:dana --scopes read,write,admin
```

Enter that key on the sign-in screen. It is kept in an HTTP-only, same-site
cookie, never browser storage. Use HTTPS outside localhost; Secure cookies
require it. Revoking the API key ends access immediately. Signing out clears
the browser cookie; it does not revoke the key.

For TLS termination at a reverse proxy, set `RETAINER_PUBLIC_ORIGIN` to the
external origin (for example `https://retainer.example`). CSRF checks compare
the browser Origin to this configured value; forwarded headers are not trusted.
The setting also controls the cookie's public host and Secure handling.

Non-user keys can browse read-only. People with a `write` key can create,
delete and merge records and review suggested merges; erasing a person for a
privacy request (`forget`) needs an `admin` key. ⌘K searches records, facts
and events across the workspace.

## Connect an agent

Agents connect over MCP (Streamable HTTP) at `/mcp`, with the same key as a
bearer token. The key decides the workspace and who the agent's writes are
attributed to, so give each agent its own key. For example, in Claude Code:

```sh
claude mcp add --transport http retainer http://localhost:8787/mcp \
  --header "Authorization: Bearer <key>"
```

For clients that only speak stdio, use the `@retainer/mcp` bridge (once it is
published to npm; until then, run it from a checkout as
[Connecting agents](docs/agents.md#over-stdio) describes):

```sh
claude mcp add retainer \
  --env RETAINER_URL=http://localhost:8787 --env RETAINER_API_KEY=<key> \
  -- npx -y @retainer/mcp
```

With a Retainer account, Claude Code users can install the
[Retainer plugin](plugins/retainer/README.md) instead. It signs in over OAuth
and logs what your chats teach Claude about your customers and work:

```
/plugin marketplace add Tamloot-cc/Retainer
/plugin install retainer@retainer
```

Tools: `describe_schema`, `list_templates`, `apply_template`,
`query_records`, `get_record`, `search`, `get_context`, `upsert_record`,
`log_event`, `remember` and `propose_schema_change`. See
[Connecting agents](docs/agents.md) for the workflow an agent should follow,
and [the SDK guide](docs/sdk.md) to call the REST API from code.

## Develop

Requires Node 26 and pnpm 12 (run `npm install -g corepack`, then corepack
picks pnpm from `package.json`).

```sh
pnpm install
cp .env.example .env
docker compose -f docker/compose.yml up -d postgres
pnpm db:migrate
pnpm build
pnpm dev
# In another terminal (Vite proxies REST and auth requests to port 8787):
pnpm dev:web
```

Open [localhost:5173/app](http://localhost:5173/app/). To serve the production
build from the API process locally, set `RETAINER_WEB_DIR` to the absolute
path of `packages/web/dist` in `.env`.

| Command                          | What it does                                                             |
| -------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev:web`                   | Start the frontend dev server                                            |
| `pnpm test:web`                  | Browser tests against the built app and real Postgres                    |
| `pnpm build`                     | Build every package                                                      |
| `pnpm typecheck`                 | Type-check every package                                                 |
| `pnpm test`                      | Run tests (integration tests need Postgres at `DATABASE_URL`)            |
| `pnpm lint`                      | Biome lint and format check                                              |
| `pnpm db:generate --name <name>` | Create a migration from `packages/server/src/db/schema.ts`               |
| `pnpm db:migrate`                | Apply migrations                                                         |
| `pnpm retainer <command>`        | Run the operator CLI against `DATABASE_URL`                              |
| `pnpm release:check [tag]`       | Check versions and changelog before a release ([how](docs/releasing.md)) |

## Packages

| Package            | License  | Contents                                       |
| ------------------ | -------- | ---------------------------------------------- |
| `packages/server`  | AGPL-3.0 | API, MCP endpoint, workers, schema engine      |
| `packages/shared`  | MIT      | Field types, composite value shapes, actors    |
| `packages/sdk`     | MIT      | TypeScript client                              |
| `packages/web`     | MIT      | Optional review and records web app            |
| `packages/mcp`     | MIT      | stdio bridge for MCP clients                   |
| `plugins/retainer` | MIT      | Claude Code plugin: MCP server and CRM logging |

## License

The server is licensed under [AGPL-3.0](LICENSE). The SDK, shared types and
MCP bridge, web app and Claude Code plugin are MIT-licensed; see each package's `LICENSE`.
