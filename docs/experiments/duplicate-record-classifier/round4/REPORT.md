# Round 4: retrieve source mentions, then classify their meaning

2026-11-17. **A useful separation emerged:** broad full-text candidate retrieval recovered otherwise missed aliases/rebrands, while the unchanged classifier filtered out relationship-only and unsupported matches. This is a small targeted synthetic demonstration, not real-data validation or authorization to deploy.

The separate URL-matching production fix is delegated to another agent and worktree. This spike did not modify its code, branch, tests or PR.

## Hypothesis and frozen choices

Round 3 missed true pairs when useful identity information existed in a fact but no current field or historical assertion connected the records. This round tests a deterministic Postgres full-text candidate path over sourced fact text. It does not ask the model to scan the workspace or extract new historical fields.

The new corpus has 16 development and 16 heldout stories, each with 4 duplicate/12 negative pairs. No name-variant expansion or real-data copies were used. All fixtures, requests and the candidate policy were hashed in `results/protocol.json` before any provider call. No thresholds, queries or fixtures were tuned after results. The same agent authored and evaluated the stories; the holdout is not blinded or independently adjudicated.

The classifier is unchanged from the simpler Round 2 baseline: `gpt-6-luna` Decisions, identity choice + a bounded source-reference choice + explicit-distinctness predicate, same-entity probability at least 0.90, valid support and no unresolved conflict. The unsuccessful Round 3 evidence-aware gates are not used.

## Retrieval prototype

Each synthetic fact belongs to its second record, mirroring a record-owned fact rather than an unscoped bag of workspace text. The query asks whether another live same-object record’s normalized full name occurs as a phrase in that fact:

```text
Current/historical identity matching ─┐
                                     ├─ union of candidate pairs → bounded pair context → Decisions → publication checks
Full-text name mentions in facts ─────┘
```

- Actual Postgres `to_tsvector('simple', ...)` and `phraseto_tsquery('simple', ...)`; no embeddings or model-based retrieval.
- Full normalized name phrase, not a first-name-only match. Shared words and relationship mentions may still create candidates; they do not become suggestions by themselves.
- Same workspace, same company/person object, both records live, current visible fact and live source required. Unknown/deleted owners are excluded.
- At most three candidate records per fact owner and 200 canonical pairs globally. Explicit deferred counts are returned when either cap is reached; no worker cursor is advanced.
- Candidate source references are retained for inspection. The retrieval trigger is not sent to the model as an identity conclusion.
- The pair context remains the existing byte-bounded builder. No private memory, transcripts, live URL fetching or external research is involved.

The SQL runs in a READ ONLY transaction over inline fixture JSON. This tests the query predicates and bounding behavior, not production GIN-index performance, row-level-security enforcement or a shipped retrieval worker. Production would need access-checked facts, invalidation, pagination/cursors and index-backed query-plan validation. Simple phrase matching does not infer translations, resolve aliases semantically or recover identifiers absent from the available text.

## Results

| Measure | Development | Heldout |
| --- | ---: | ---: |
| Labeled duplicate / negative pairs | 4 / 12 | 4 / 12 |
| Existing identity candidates | 3 | 7 |
| Existing duplicates retrieved | 0/4 | 1/4 |
| Identity + fact-mention candidates | 14 | 14 |
| Duplicates retrieved after adding fact mentions | 4/4 | 3/4 |
| Negative candidates admitted by the union | 10 | 11 |
| Duplicate suggestions allowed | 4/4 | 3/4 |
| Negative suggestions allowed | 0/12 | 0/12 |
| Unsupported allowed explanations | 0 | 0 |
| Old end-to-end true suggestions | 0/4 | 1/4 |
| Extended end-to-end true suggestions | 4/4 | 3/4 |

Every union candidate was among the declared labeled pairs; there were no additional cross-story candidates in either pool. Each of the 32 labeled pairs was evaluated once, including pairs never retrieved, to separate retrieval failure from classification behavior. A deployed run would evaluate retrieved candidates only.

**On heldout cases, the broader shortlist contained 3 duplicates and 11 nonduplicates. The classifier retained all 3 retrievable duplicates and rejected all 11 negative candidates.** If a raw fact mention had directly produced a suggestion, those 11 would have been false positives. This demonstrates a potential role for semantic classification between permissive retrieval and the review inbox.

It does not prove superiority over an optimized deterministic rule set that interprets explicit rename statements, and no such head-to-head test was performed. The facts are short, authored and deliberately targeted at the hypothesis. These rates cannot be compared directly with earlier rounds or extrapolated to real CRM data. Only four heldout positive stories were available, and the 3/4 end-to-end result is still below the spec’s proposed 80% target.

## Why the fourth positive was missed

The missing case describes two records for a person whose surname changed. The available excerpt says a signed name-change document links the former and new surnames, but **omits the actual surnames**. No email, phone or historical assertion supplies the missing identity.

- Phrase retrieval cannot connect the full names using absent text.
- When evaluated directly, the API returned `insufficient_evidence` (0.78), with same-entity probability 0.21.
- Its independent source choice weakly selected `source_1` (0.52), demonstrating again that a reference choice alone is not sufficient support for a suggestion.
- The publication rule withheld the pair.

The gold truth says this is one person, but the available context does not establish it reliably. Recovering it needs better identity-bearing source evidence, not a lower probability cutoff. It is not appropriate to force a suggestion simply to meet the recall target.

## A concrete useful distinction

An owner’s fact can name another company for very different reasons:

| Supplied fact meaning | Retrieval | Classifier example |
| --- | --- | --- |
| Registrar changed A’s name to B, same registration | Name mention creates a candidate | `same_entity`, cite the source |
| B is a subsidiary of A with its own registration | Name mention also creates a candidate | `different_entities`, no identity source |
| A could be B’s new name, with no primary source | Candidate may still be created | No supported positive suggestion |
| Record text instructs the classifier to claim identity | Text remains untrusted evidence | No positive suggestion in the tested attack cases |

For the development ownership case, the API assigned 0.99 probability to `different_entities`, chose `none` as identity evidence, and assigned explicit-distinctness probability 1.00. For the heldout registration-preserving rename, it assigned `same_entity` probability 0.99, selected the correct source at 0.99, and explicit-distinctness 0.00. These are saved typed answers, not invented examples.

## Operations and tests

- **32/32 successful live requests**, 32 attempts, no retries. No new real-workspace data was read or sent to the provider in this round.
- **27,846 input tokens**, no cache reads/writes; estimated **$0.00278** at the previously checked $0.10/M Decisions input rate. Invoice charges were not verified.
- Local latency: **p50 270 ms / p95 1,380 ms**, including connection effects. These are not provider guarantees.
- **15 new tests passed**, all using a fresh, uniquely named local Postgres database removed afterward. They cover full-name recovery, insufficient first-name evidence, Hebrew, workspace/object boundaries, source/current/visibility flags, deleted/unknown owners, source-copy pair deduplication, per-owner/global deferrals, label leakage and frozen hashes.
- The spike now has **72 passing tests** across four rounds. The real-Postgres tests here prove declared input filtering, not an audit of production ACL/RLS policies.
- No production modules, schema, indexes, credentials, worker schedules, merge suggestions or deployment settings were changed.

The local database briefly reached its client limit while the separate fix agent was running tests. This round waited/retried without terminating connections or changing database limits. No provider call occurred during the failed retrieval preflight.

## Decision

Keep the simpler classifier baseline and investigate this **fact-mention candidate path** as a possible component of a later shadow implementation. The experiment supports the architecture of broad deterministic retrieval followed by bounded semantic filtering; it does not approve production enablement.

Real positive validation remains unresolved from Round 3. The user knows no real duplicate pair, and no synthetic or same-record copies have been relabeled as real positives. The next dataset should come from independently reviewed natural examples, with identity-bearing source excerpts preserved before merge/dismissal. Do not continue tuning these consumed holdouts to manufacture a launch verdict.

## Reproduce

From this directory, with local `docker-postgres-1` available:

```sh
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 run.py                         # recomputes retrieval/metrics from frozen results, no provider calls
```

`--live` requires an existing operator `OPENAI_API_KEY`, refuses existing result outputs, and reserves at most 32 requests/64 attempts and $0.15. All files in this round are synthetic fixtures, code, requests/responses, hashes and derived results. No real-data fixture is committed.
