# Migration compatibility (advisory)

On PRs changing `packages/server/drizzle/**`, the **Migration compatibility**
workflow runs the base commit's server integration tests twice on Postgres 18:
first on its own schema (the control), then on a fresh database migrated by the
base and the PR. Each test file still gets its own clone. Only the PR's
`test/global-setup.ts` adapter is copied into the base checkout, to support base
versions predating `RETAINER_TEST_TEMPLATE`; product code, dependencies, config
and test bodies come from the base SHA. Both checkouts install their own lockfile.
A companion reporter captures unhandled runner errors that Vitest’s JSON report
omits. The ordinary CI workflow continues testing the PR's code independently.

`RETAINER_TEST_TEMPLATE` is a database name on the `DATABASE_URL` server. Global
setup checks that it exists, supplies it to the clone helper, and neither migrates
nor drops it. The caller owns its lifecycle and must close connections before
cloning. Without the variable the existing test behavior is unchanged.

## Reading the result

Open the PR's **Advisory migration compatibility** job summary:

- **not breaking**: the selected old tests passed on the new schema.
- **breaking**: old tests passed on the base schema but failed on the PR schema.
  The summary names the failing old tests; the artifact has their failure messages.
  Tests intentionally changed or deleted in the PR still run from the base.
- **error**: setup, migrations, the control run, test runner or cleanup failed;
  compatibility is unknown. A missing/cancelled run is also unknown, never safe.

Breaking returns exit code zero. Infrastructure errors return nonzero, with
job-level `continue-on-error`; this advisory workflow must not be configured as a
required branch-protection check. There are no labels, PR comments or write-token
requirements, so fork PRs get the same summary and artifact. Non-migration PRs do
not run the workflow.

The fixed artifact **migration-compatibility** contains `verdict.json` (schema
version `1`, `verdict`, `baseSha`, `headSha`, `excluded`, `failingTests`, optional
`error`) and the full Vitest JSON reports. Verdict strings are exactly `breaking`,
`not breaking`, and `error`. Consumers must select the latest completed run for
the exact PR head **and base SHA**, validate both SHAs in the artifact, and treat
missing/expired results as unknown. Artifacts expire after 30 days. For example:

```sh
gh run list --workflow migration-compatibility.yml --event pull_request \
  --commit "$HEAD_SHA" --json databaseId,status,conclusion
# Select the latest completed run; do not infer compatibility from conclusion.
gh run download "$RUN_ID" --name migration-compatibility --dir "$RESULT_DIR"
jq '{baseSha, headSha, verdict, failingTests}' "$RESULT_DIR/verdict.json"
```

## Scope and limits

This is evidence from the server integration tests, only in the **old code on new
schema** direction. It does not prove safety for untested queries, production
data, migration backfills, new-code/old-schema operation, browser behavior or
mixed-version concurrency. A differential test failure can also be a flake;
inspect the named failures before using the verdict to plan downtime.

Four files are excluded because they explicitly invoke migrations or rewrite
historical data: `db/accounts-upgrade`, `db/search-rebuild`, `db/logins`, and
`lambda/handlers` (all under `packages/server/test`, ending `.test.ts`). Their
ordinary CI coverage is unchanged. Keep the exclusion list in the runner up to
date when adding tests that bypass the template or invoke migrations.

Workspace built-in-definition upgrades are **not included**. The migrated
template is empty; workspaces are created later by old test fixtures. Calling
`upgradeWorkspaces` before these tests would upgrade nothing. Meaningful coverage
needs old populated fixtures, a PR-code upgrade between fixture creation and old
reads, and dedicated compatibility assertions; that is beyond the small template
hook. Definition-only changes also do not trigger this migration-only workflow.

## Local run

Use a disposable base checkout with its dependencies installed and `pnpm build`
completed. In the current checkout, install dependencies and run
`pnpm --filter @retainer/shared build` first. The runner replaces the base checkout’s
global setup adapter. From `packages/server`:

```sh
DATABASE_URL=postgres://retainer:retainer@localhost:55432/retainer \
  pnpm exec tsx test/compatibility/run.ts /absolute/path/to/base /tmp/compat-result
RESULT_DIR=/tmp/compat-result node ../../scripts/migration-compatibility-summary.mjs
```

The database role must be able to create/drop databases, as in the normal tests.
No deployment commands are called.
