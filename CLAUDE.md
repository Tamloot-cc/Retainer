# Retainer

Open-source memory for AI agents that work with CRM data. Optional web app
in `packages/web`, plus a REST API, MCP endpoint and background workers on Postgres. Read
`ARCHITECTURE.md` before changing the data model, the schema engine, or write
rules.

## Commands

- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`
- Postgres for dev: `docker compose -f docker/compose.yml up -d postgres`
  (set `RETAINER_PG_PORT` if 5432 is taken, and match `DATABASE_URL`)
- `pnpm db:generate --name <name>` after editing `packages/server/src/db/schema.ts`;
  `pnpm db:migrate` to apply. Never hand-edit generated migrations.
- Web: `pnpm dev:web` alongside `pnpm dev`; `pnpm build` builds static assets.
- `pnpm test:web` runs Playwright against the built web app and real Postgres
  (`DATABASE_URL` required; fresh cloned database per test).
- `pnpm dev` runs the server with `RETAINER_ROLE=all` from `.env`.

## Testing

See `ARCHITECTURE.md` section 11 for the six test layers.

- Every feature lands with unit tests and, if it touches the database,
  integration tests against real Postgres. Never mock the database.
- Each test file gets its own fresh database cloned from a migrated
  template; never share rows between test files.
- Rules described as serialized, atomic or idempotent need a test that runs
  the competing operations concurrently.

## Rules

- Every write carries an `Actor`, taken from the credential (an API key, a
  person's session or an app's OAuth token), never from the payload.
- `records.data` is keyed by `fields.key`, never by field name.
- `records.data` is derived from `field_assertions`; write assertions, not data.
- All schema changes go through the schema engine; never write to
  `object_types` or `fields` directly.
- Retainer never calls a language model or embedding provider. Agents decide
  what to write; the server validates, stores and retrieves.
- No embeddings or semantic search: search is Postgres full-text only.
- Server modules import only from their own layer and those below it
  (`ARCHITECTURE.md` section 8); `pnpm lint` checks this.
- Server code is AGPL-3.0; `shared`, `sdk`, `mcp` and `web` are MIT. Don't
  import server code into the MIT packages.
- TypeScript 7: `types: ["node"]` is set in `tsconfig.base.json` because TS no
  longer includes `@types/*` by default.
