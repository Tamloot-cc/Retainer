# Releasing

A release publishes five MIT packages to npm and the server's Docker image to
GitHub Container Registry, then creates a GitHub release. The server and the
web app are not published to npm; they ship inside the image.

| Artifact                                 | Where                                   |
| ---------------------------------------- | --------------------------------------- |
| `@retainer/shared`                       | npm                                     |
| `@retainer/extension`                    | npm                                     |
| `@retainer/sdk`                          | npm                                     |
| `@retainer/mcp`                          | npm (`retainer-mcp` binary)             |
| `@retainer/cli`                          | npm (`retainer` binary)                 |
| Server, workers, web app, `retainer-ops` | `ghcr.io/tamloot-cc/retainer:<version>` |

All packages share one version. `.github/workflows/release.yml` does the work;
`scripts/check-release.mjs` refuses a release whose package versions or
changelog disagree with the tag, or that would publish a non-MIT package. Every
workspace package not marked `private` is published.

## One-time setup

1. Create the `retainer` organization on npmjs.com (the `@retainer` scope).
2. npm only lets a package trust a publisher once the package exists, so
   publish each new package's first version by hand (below).
3. Make each package trust the release workflow. No npm token is stored in
   GitHub; the workflow signs in with its own OIDC token:

   ```sh
   npm trust github @retainer/<package> --repo Tamloot-cc/Retainer --file release.yml --allow-publish
   ```

4. After the first image push, make the `retainer` package on GitHub
   Container Registry public if the image should be pullable without login.

## Cut a release

1. Set `version` in each `packages/*/package.json`. The server and the bridge
   read their version from there at runtime.
2. Add a `## <version>` section to `CHANGELOG.md`.
3. Check locally, then merge to `main`:

   ```sh
   pnpm release:check v0.2.0
   pnpm build && node scripts/publish-npm.mjs --dry-run
   docker build -f docker/Dockerfile .
   ```

4. Optionally run the **Release** workflow by hand from the Actions tab. A
   manual run is always a dry run: it runs CI, packs the npm packages and
   builds the multi-architecture image without publishing anything. Only a
   tag push publishes.
5. Tag `main` and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow checks versions, runs the full CI suite, publishes to npm with
provenance and to GHCR (`<version>`, `<major>.<minor>` and `latest`), and
creates the GitHub release with the changelog section as its notes. A version
with a pre-release suffix (`0.2.0-rc.1`) is not tagged `latest` and is marked
as a pre-release.

`scripts/publish-npm.mjs` skips any package whose version is already on npm,
so a workflow that failed after publishing some packages can be re-run. npm
versions cannot be reused, so never re-tag a version with different code. A
pre-release goes to npm's `next` tag instead of `latest`.

## Publish a new package by hand

A package's first version has to come from a person, because npm won't let a
package that doesn't exist yet trust a workflow. Do this for each new package,
then set up trusted publishing for it (one-time setup, step 3).

```sh
pnpm build
cd packages/<package> && pnpm pack --pack-destination /tmp/retainer-npm
npm publish /tmp/retainer-npm/retainer-<package>-<version>.tgz --access public --provenance=false --auth-type=web
```

Run it in a terminal, not through an agent. npm opens a browser to confirm
with your security key, and the link expires within minutes. Ticking "do not
challenge for the next 5 minutes" covers the rest of a batch. Provenance only
works from CI, hence `--provenance=false`.
