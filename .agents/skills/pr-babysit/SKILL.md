---
name: pr-babysit
description: >-
  Open a PR for the finished work in Retainer and stay with it until it's settled. Wait for CI and both review bots (claude-review and Codex) to finish on the head commit. Assess every finding, fix the valid ones, answer the rest, then email the outcome. Web UI changes also get a modern web guidance check and screenshots in the PR. Squash-merge and clean up only with --merge. Use when the user says "PR this", "open a PR and babysit it", "babysit PR #12", or "commit, PR and merge when settled". Not for reviewing someone else's PR.
---

# PR Babysit (Retainer)

Take finished work from "the code is done" to a **settled** PR: CI green on
the head commit, both review bots have reviewed that commit, and every finding
has been answered. This skill doesn't write the feature.

```
$pr-babysit [PR-number] [--merge]
```

- **PR number**: babysit an open PR and skip Phase 1.
- **`--merge`**: squash-merge once settled, then clean up. Merge only when
  the flag or the user's own words ask for it. Without it, the PR stays open.

For docs-only changes, commit directly on `main` and push only when the
user authorizes both actions. Use the PR workflow when requested.

## Phase 1 — Submit

1. Run the web guidance check if the diff touches web UI (below).
2. Review the diff against `main` for duplication and unnecessary
   complexity. Apply simplifications that preserve behavior.
3. Run the checks locally after the edits (see `AGENTS.md`). Run `pnpm lint`,
   `pnpm typecheck`, `pnpm test` with `DATABASE_URL` set, and
   `pnpm test:web` if `packages/web` or the e2e specs changed.
4. Branch off `main` if needed. Stage only files that belong to the work,
   and mention any stray edits you left out. Write the commit subject as a
   plain sentence, the way `git log` does it ("Web: create, delete and merge
   records"), not conventional-commit style. End the commit and the PR body
   with the attribution lines the session gives you.
5. Add screenshots if the PR changes something a user sees (below).
6. Push and run `gh pr create --base main`. The body should say what changed
   and why, and how it was tested.

### Web guidance check

Run it when the diff changes HTML, CSS or TSX in `packages/web`. Skip it for
the server, the database, CI, tests and copy-only edits.

Use the installed `modern-web-guidance` skill when available. For this
pre-PR check, apply the guidance to the existing diff.

1. List the UI patterns and platform features the diff adds or rewrites: a
   dialog, a form with validation, date formatting, an animation, image
   loading.
2. Search each one and read the guides that match:

   ```bash
   DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest search "<2-5 word pattern>"
   DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest retrieve "<id>[,<id>]"
   ```

   Without `DISABLE_TELEMETRY=1` the queries go to Google. Keep queries
   generic: "light dismiss dialog", not "close React record dialog".
3. Fix the places where the diff uses an outdated pattern. For anything that
   isn't Baseline Widely available, follow the guide's fallback rules.

Stay inside the diff. Old patterns in code the PR doesn't touch are not this
PR's job. The guides are plain HTML, CSS and JS, so adapt them to how the app
already works (React, Radix primitives, Tailwind). Where a guide conflicts
with an established repo convention, keep the convention and say so.

Add a `### Modern Web Guidance` section to the PR body listing the guides you
checked and what changed because of them.

### Screenshots

Add them when the diff changes rendered UI in `packages/web`: a screen,
component, layout or style. Skip them for everything else, including
refactors with no visible difference.

**Capture.** Run `pnpm dev` and `pnpm dev:web`, then capture the states the
PR changes with the browser tools or Playwright.

- One screenshot per changed screen or state, cropped to what changed. Add a
  "before" (taken on `main`) only when the difference isn't obvious from the
  "after".
- If colors changed, capture dark mode too. If layout changed, capture a
  phone width too.
- **Seed or demo data only.** The repo is public and these images stay in
  its history. Never capture a real workspace, emails or tokens.
- If the surface can't run here, don't substitute a mock-up. Write
  `Screenshots: not captured — <reason>` in the PR body instead.

**Publish.** GitHub has no API for uploading images to a PR, so the images
ride the PR branch:

1. Add the PNGs under `docs/pr-screenshots/<branch-slug>/` and commit them on
   their own ("Add <what> screenshots for review").
2. Remove them in the very next commit ("Remove the review screenshots").
   The squash-merge then lands no binaries on `main`, and the first commit
   stays reachable through the PR.
3. Link each image by the first commit's SHA, never by branch name (the
   branch is deleted at merge) and never through an outside image host:

   ```markdown
   ![<alt text>](https://raw.githubusercontent.com/Tamloot-cc/Retainer/<sha>/docs/pr-screenshots/<slug>/<file>.png)
   ```

4. Put them in the PR body under `## Screenshots`, each with a one-line
   caption.

Make both commits before the first push, so they cost no extra review round.

**Later pushes.** When a fix changes what a screenshot shows, recapture only
the affected ones and publish them the same way in that push. Post them in a
PR comment with one line on what changed, and update the PR body so it shows
the current UI. A push that changes nothing visible gets no new screenshots.

**Open PR without screenshots.** Add them with the first push you make for
another reason. Don't push only for screenshots on a PR that would otherwise
settle untouched; say in the email that it has none.

## Phase 2 — Babysit

Every push to the PR runs three things:

- **`Lint, typecheck, test`**: the CI job. The `claude` and `claude-fix` jobs
  showing "skipping" is normal.
- **claude-review**: posts one top-level PR comment per push. It is either
  `✅ No correctness issues found.` or a list of findings, sometimes with a
  `🏗️ Design concern` section. Don't reply `@claude fix it`. You make the
  fixes yourself.
- **Codex** (`chatgpt-codex-connector[bot]`): leaves inline review threads,
  or a 👍 reaction on the PR when it found nothing. It may review only when
  the PR opens. If it hasn't reviewed the head commit, comment
  `@codex review`.

Run the CI watch in the background while you read comments:

```bash
gh pr checks "$pr" --watch --interval 30
```

Every round, read all of these:

- Inline threads, with GraphQL `reviewThreads` (snippet below).
- Top-level comments from `gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments"`.
- Review bodies from `gh api --paginate "repos/{owner}/{repo}/pulls/$pr/reviews"`.
  Check each review's `commit_id`.

Without `--paginate` these return only the first 30 items, which hides the
newest comments on a long PR.

### Triage: a comment is a claim, not an order

- **A real bug in the changed code**: fix it, adding a test where it fits.
- **Pre-existing, not caused by this PR**: reply that it's out of scope.
- **Wrong**: reply with the evidence, such as the guard that handles it or
  the test that covers it.
- **Against a repo rule** (`AGENTS.md`, `ARCHITECTURE.md`): reply citing the
  rule.

Batch each round into one push. Run the relevant tests before pushing, then
reply to every thread, citing the fixing commit, and resolve it. A fix that
writes new web UI gets the web guidance check, and a fix that changes what a
screenshot shows gets new screenshots (see "Later pushes").

```bash
# Set owner, repo, and pr for this pull request. Leave cursor unset for the first page.
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved isOutdated
            comments(first:20) {
              pageInfo { hasNextPage endCursor }
              nodes { databaseId body author { login } }
            }
          }
        }
      }
    }
  }' -f owner="$owner" -f repo="$repo" -F pr="$pr" -F cursor="${cursor:-null}"
gh api "repos/$owner/$repo/pulls/$pr/comments/$comment_id/replies" -f body="Fixed in abc1234"
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id="$thread_id"
```

Pass each thread page's `endCursor` as `cursor` while `hasNextPage` is true.
If a thread's comments span multiple pages, fetch its remaining comments
before replying. Use the comment's `databaseId` for `comment_id` and the
thread's GraphQL `id` for `thread_id`.

For claude-review findings, which have no thread, post one top-level reply
that covers each finding.

For red CI, fix the actual failure. Never skip or loosen a test to get green.

### Settled

All of these must hold for the **current head commit**:

1. Every check passed. "Skipping" is fine. "Pending" is not.
2. The `claude-review` job completed for the head SHA and has a verdict
   comment newer than the last push.
3. Codex has reviewed the head: a review with that `commit_id`, or a 👍
   reaction that came after the push.
4. Every finding has a reply, and every inline thread is resolved.
5. One more quiet poll (about 2 minutes) brings no new comment.

Any push resets conditions 1, 2, 3 and 5.

There's no round cap while each round fixes real findings. Stop and report
the PR as **stalled** if fixes keep producing new findings in the same area,
or if claude-review raises a design concern you agree with. Name the design
question instead of patching on top of it.

## Phase 3 — Merge and clean up (only with `--merge`)

1. Run `gh pr merge "$pr" --squash --delete-branch --match-head-commit "$reviewed_head"`
   with the settled head SHA. If the head moved, review the new head before
   trying again. Releases use `v*` tags. Leave tagging to the release workflow.
2. After CI passes on the merge commit, **Deploy hosted** dispatches
   retainer-cloud's `deploy-aws.yml` with that SHA. Wait for both workflows.
   Match the cloud run to the merge SHA using the requested Retainer commit
   in its logs. The cloud workflow's own head SHA belongs to retainer-cloud.
   Use the comparison and deploy steps to determine what shipped.

   ```bash
   gh run list --commit "$merge_sha" --json workflowName,status,conclusion,url
   gh run list --workflow 'Deploy hosted' --event workflow_run
   gh run list -R Tamloot-cc/retainer-cloud --workflow deploy-aws.yml --event workflow_dispatch
   gh run view "$cloud_run_id" -R Tamloot-cc/retainer-cloud --log |
     grep -E 'Retainer [0-9a-f]{40}|Live:|Ship Retainer:'
   curl -fsS -o /dev/null -w '%{http_code}\n' https://retainer.tamloot.cc/health
   ```

   For **Deploy hosted**, match the Retainer run by its dispatch log if the
   commit filter omits it. Report the cloud run link and its outcome. A
   successful run with `Deployed Retainer` and the merge SHA confirms that
   commit shipped. A successful run with `Ship Retainer: false` reports why
   no code shipped. Report failures and any unverified outcome explicitly.
3. Run `git fetch --prune`. Update the primary checkout with
   `git pull --ff-only` when it is clean and on `main`.
4. Remove this PR's worktree (`git worktree remove`) and its local branch
   (`git branch -D`, since a squash-merge leaves the branch looking
   unmerged).
5. Leave other worktrees and branches alone. They may belong to another
   session.

## Phase 4 — Email the outcome

When the user has authorized the email, send it once using Resend:
`from: "Retainer PR <claude@tamloot.cc>"`, `to: ["maayan@tamloot.cc"]`. Send
both `text` and `html`, and use the idempotency key
`retainer-pr-<PR#>-<YYYY-MM-DDTHHMM>` (UTC).

| Outcome       | Subject                                    |
| ------------- | ------------------------------------------ |
| Merged        | `Retainer PR #N: squash-merged — <title>`   |
| Settled, open | `Retainer PR #N: settled — ready to merge` |
| Stalled       | `Retainer PR #N: stalled — <the blocker>`  |

Start with **In plain words**: two sentences, no jargon, saying what was
missing and what the PR adds. Then include the PR link, each finding and how
it was handled (including any you pushed back on, and why), the final CI
state, whether screenshots are in the PR for a UI change and any reason
they are missing, and the hosted deployment outcome and run link when
applicable. Include what cleanup removed and anything waiting on the user.
