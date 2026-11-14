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
- `pnpm test:docker` runs the Docker tests (extension sandbox, extension and
  file storage in Compose). CI skips them except in a release, so run them
  before pushing a change to `docker/`, the extension runtime or file storage.

## Worktrees

- Make every new worktree inside `.worktrees/` at the repo root, which is
  gitignored: `git worktree add .worktrees/<name> -b <branch> origin/main`.
- Remove your own worktree when its work is merged or dropped
  (`git worktree remove .worktrees/<name>`). Leave other worktrees alone;
  they may belong to another session.

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
- Retainer's core (writes, conflict resolution, search, consolidation) never
  calls a language model or embedding provider. Agents decide what to write;
  the server validates, stores and retrieves. Extensions may call a model
  through the model proxy (`docs/specs/extensions-model-calls.md`).
- No embeddings or semantic search: search is Postgres full-text only.
- Server modules import only from their own layer and those below it
  (`ARCHITECTURE.md` section 8); `pnpm lint` checks this.
- Server code is AGPL-3.0; `shared`, `sdk`, `mcp` and `web` are MIT. Don't
  import server code into the MIT packages.
- TypeScript 7: `types: ["node"]` is set in `tsconfig.base.json` because TS no
  longer includes `@types/*` by default.

## Deployment

- Self-hosting is Docker Compose only (`docker/`, `docs/self-hosting.md`).
  Don't add one-click deploys to cloud providers.
- The hosted service (`retainer.tamloot.cc`) runs on AWS Lambda from the
  private `Tamloot-cc/retainer-cloud` repo: its Terraform, deploy workflow and
  ops guide live there, not here. Its Lambda entry points
  (`packages/server/src/lambda/`) are product code and stay here. Each merge
  to main that changes what ships deploys it once CI passes; docs, tests and
  the plugin don't (`.github/workflows/deploy-hosted.yml`). Only commits on
  main can be deployed.
