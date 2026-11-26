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
  Keep the method, path, status codes, and schema aligned with the server handlers
  and `packages/shared/src/api.ts`. The build exports `/openapi.json`.
- Fumadocs builds `/llms.txt`, `/llms-full.txt`, and individual Markdown files
  under `/llms.mdx/`. The **Copy Markdown** and **Open** actions use those files.

## Publishing

The **Docs site** GitHub Actions workflow tests the docs and builds a
`retainer-docs` artifact. Serve the contents at the root of an independent
static origin with directory indexes enabled. The product release uses its
own lockfile and deploy workflow.

Supply `RETAINER_DOCS_ORIGIN` at build time to put absolute production URLs
in link preview metadata. Share images and the search index are generated
during the build.

## Docs MCP

`pnpm dev` serves the public, read-only docs MCP at `/api/mcp/`. For a
production build with the same endpoint, run `pnpm build:server` and
`pnpm start:server`. It exposes the same docs and search index as the static
build, plus the live MCP handler.

The static build can also be served independently. Deploy any live handler on
the docs origin and point clients at its `/api/mcp/` URL. The MCP handler
uses the public docs corpus and requires neither a workspace key nor an AI
model provider.
