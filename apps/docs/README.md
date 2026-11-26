# Retainer docs app

Run from this directory with the repo's Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:3000/docs](http://localhost:3000/docs/). Use `pnpm build` to export
the site to `out/` and `pnpm start` to preview that output.

## Content and reference

- Write public guides under [docs/guides](../../docs/guides) or [docs/mcp](../../docs/mcp)
  and add each page to its section's `meta.json`. To publish a guide from the root of
  `docs/`, list it as `../name` in a section's `meta.json`; that list is the only place
  the app learns which pages exist.
- The REST reference reads the contract in [rest-contract.ts](lib/rest-contract.ts).
  The build exports `/openapi.json`. The request schemas are generated from the
  server's validators and checked by Retainer CI. Keep response schemas aligned
  with the server handlers and `packages/shared/src/api.ts`.
- Fumadocs builds `/llms.txt`, `/llms-full.txt`, and individual Markdown files
  under `/llms.mdx/`. The **Copy Markdown** and **Open** actions use those files.

## Update the API request schemas

After changing a documented validator, regenerate the snapshot from the repository
root after installing and building the main workspace. Commit the snapshot with
the validator change.

```sh
pnpm --filter @retainer/server exec tsx test/api/openapi-requests.ts
pnpm exec biome format --write apps/docs/lib/request-schemas.json
```

## Publishing

Set the GitHub Actions repository variable `RETAINER_DOCS_ORIGIN` to the
public docs origin (for example, `https://docs.example.com`). The **Docs site**
workflow uses it for absolute link preview and Markdown URLs in the
`retainer-docs` artifact. Builds without the variable publish
`retainer-docs-preview` with localhost URLs for local use.

Serve the production artifact at the root of the configured origin with
directory indexes enabled. For builds outside CI, supply
`RETAINER_DOCS_ORIGIN` as an environment variable at build time.

## Docs MCP

`pnpm dev` serves the public, read-only docs MCP at `/api/mcp/`. For a
production build with the same endpoint, run `pnpm build:server` and
`pnpm start:server`. It exposes the same docs and search index as the static
build, plus the live MCP handler.

The static build can also be served independently. Deploy any live handler on
the docs origin and point clients at its `/api/mcp/` URL. The MCP handler
uses the public docs corpus and requires neither a workspace key nor an AI
model provider.
