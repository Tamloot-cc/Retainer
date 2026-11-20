---
name: pr-babysit
argument-hint: "[PR-number] [--merge]"
description: >-
  Open a PR for the finished work in Retainer and stay with it until it's settled. Wait for CI and both review bots (claude-review and Codex) to finish on the head commit. Assess every finding, fix the valid ones, answer the rest, then email the outcome. Web UI changes also get a modern web guidance check and screenshots in the PR. Squash-merge and clean up only with --merge. Use when the user says "PR this", "open a PR and babysit it", "babysit PR #12", or "commit, PR and merge when settled". Not for reviewing someone else's PR.
---

# PR Babysit (Retainer)

Take finished work from "the code is done" to a **settled** PR: CI green on
the head commit, both review bots have reviewed that commit, and every finding
has been answered. This skill doesn't write the feature.

```
/pr-babysit [PR-number] [--merge]
```

- **PR number**: babysit an open PR and skip Phase 1.
- **`--merge`**: squash-merge once settled, then clean up. Merge only when
  the flag or the user's own words ask for it. Without it, the PR stays open.

Docs-only changes don't get a PR: commit them on `main` and push.

## Phase 1 — Submit

Clean the diff before review. Every problem fixed here is a review comment
that never gets written.

1. Run the web guidance check if the diff touches web UI (below).
2. Run the `simplify` skill on the diff against `main` and apply its fixes.
   Skip any that change behavior, and say so.
3. Run the checks locally (see `CLAUDE.md`): `pnpm lint`, `pnpm typecheck`,
   `pnpm test` with `DATABASE_URL` set, and `pnpm test:web` if `packages/web`
   or the e2e specs changed. Steps 1 and 2 leave unreviewed edits, so run
   them after those.
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

The code is already written, so this is a check, not a starting point:

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
gh pr checks <PR> --watch --interval 30
```

Every round, read all of these:

- Inline threads, with GraphQL `reviewThreads` (snippet below).
- Top-level comments: `gh api --paginate repos/{owner}/{repo}/issues/<PR>/comments`.
- Review bodies: `gh api --paginate repos/{owner}/{repo}/pulls/<PR>/reviews`.
  Check each review's `commit_id`.

Without `--paginate` these return only the first 30 items, which hides the
newest comments on a long PR.

### Triage: a comment is a claim, not an order

- **A real bug in the changed code**: fix it, adding a test where it fits.
- **Pre-existing, not caused by this PR**: reply that it's out of scope.
- **Wrong**: reply with the evidence, such as the guard that handles it or
  the test that covers it.
- **Against a repo rule** (`CLAUDE.md`, `ARCHITECTURE.md`): reply citing the
  rule.

Batch each round into one push. Run the relevant tests before pushing, then
reply to every thread, citing the fixing commit, and resolve it. A fix that
writes new web UI gets the web guidance check, and a fix that changes what a
screenshot shows gets new screenshots (see "Later pushes").

```bash
# Threads: id, state, and each comment's databaseId (the comment_id for replies)
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated comments(first:20){nodes{databaseId body author{login}}}}}}}}' -f o=<owner> -f r=<repo> -F n=<PR>
gh api repos/{owner}/{repo}/pulls/<PR>/comments/<comment_id>/replies -f body="Fixed in abc1234: …"
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>
```

If `hasNextPage` is true, fetch the rest with
`reviewThreads(first:100, after:"<endCursor>")`.

For claude-review findings, which have no thread, post one top-level reply
that covers each finding.

For red CI, fix the actual failure. Never skip or loosen a test to get green.

### Settled

All of these must hold for the **current head commit**:

1. Every check passed. "Skipping" is fine. "Pending" is not.
2. claude-review has a verdict comment newer than the last push.
3. Codex has reviewed the head: a review with that `commit_id`, or a 👍
   reaction that came after the push.
4. Every finding has a reply, and every inline thread is resolved.
5. One more quiet poll (about 2 minutes) brings no new comment.

Any push resets conditions 1, 2, 3 and 5.

### Round limit

A round is one push that got reviewed. Codex keeps finding something new on
a large PR: #128 drew 61 findings over 28 rounds, two or three per fix. So
from round 5 on:

- **Fix** P1 findings and real bugs that take a few lines. Fix them in one
  push, with tests, as before.
- **Defer** every other finding (P2s, hardening, edge cases that lose
  nothing). Collect them in one follow-up issue, saying for each why it is
  safe to wait. Reply on each thread with the issue link and resolve it.
- **Don't ask for another Codex round** after that push. Condition 3 then
  holds if Codex reviewed any earlier commit and the last push only fixes
  findings already raised. Conditions 1, 2, 4 and 5 still apply.

Stop earlier and report the PR as **stalled** if fixes keep producing new
findings in the same area, or if claude-review raises a design concern you
agree with. Name the design question instead of patching on top of it.

## Phase 3 — Merge and clean up (only with `--merge`)

1. `gh pr merge <PR> --squash --delete-branch`. Releases run only on `v*`
   tags. Never tag.
2. The merge deploys the hosted service (retainer.tamloot.cc). After CI
   passes on the merge commit, **Deploy hosted** starts retainer-cloud's
   `deploy-aws.yml`. That run compares the merge commit with the live one
   and ships only when what ships changed. Wait for it, then check what it
   did:

   ```bash
   gh run list --commit <merge-sha> --json workflowName,conclusion,url
   gh run list -R Tamloot-cc/retainer-cloud --workflow deploy-aws.yml -L 3
   gh run view <run-id> -R Tamloot-cc/retainer-cloud --log | grep -E 'Live:|Deployed Retainer'
   curl -s -o /dev/null -w '%{http_code}\n' https://retainer.tamloot.cc/health
   ```

   "Deployed Retainer <merge-sha>." means it shipped. A docs-only merge
   ships nothing, which is expected. A failed run is a blocker to report,
   not to fix in Retainer.
3. Sync `main` in the primary checkout with `git pull --ff-only`, then
   `git fetch --prune`.
4. Remove this PR's worktree (`git worktree remove`) and its local branch
   (`git branch -D`, since a squash-merge leaves the branch looking
   unmerged).
5. Leave other worktrees and branches alone. They may belong to another
   session.

## Phase 4 — Email the outcome

Send one email with the Resend `send-email` tool:
`from: "Retainer PR <claude@tamloot.cc>"`, `to: ["maayan@tamloot.cc"]`. Send
both `text` and `html`, and use the idempotency key
`retainer-pr-<PR#>-<YYYY-MM-DDTHHMM>` (UTC).

| Outcome | Subject |
|---------|---------|
| Merged | `Retainer PR #N: squash-merged — <title>` |
| Settled, open | `Retainer PR #N: settled — ready to merge` |
| Stalled | `Retainer PR #N: stalled — <the blocker>` |

Start with **In plain words**: two sentences, no jargon, saying what was
missing and what the PR adds. Then include the PR link, each finding and how
it was handled (including any you pushed back on, and why), the final CI
state, for a UI change whether screenshots are in the PR (or why not), the
deploy (shipped, nothing to ship, or failed, with the run link), what
cleanup removed, and what is waiting on the user.
