# Round 3: the evidence-aware hypothesis did not beat the baseline

2026-11-17. **Do not adopt the more complex publication rule from this experiment.** On the fresh heldout set it tied the simpler 0.90 baseline: 10/12 duplicate pairs allowed when evaluated, 9/12 found and allowed end to end, and zero suggestions among 36 negative pairs. Real duplicate-record validation remains missing. No production behavior changed.

## Question and design

Round 2 correctly labeled all 20 duplicates but allowed only 12 at a 0.90 same-entity cutoff. This round tested whether stronger explicit identity evidence could justify a lower identity-probability floor without introducing false suggestions.

The new, hand-authored corpus contains 24 development stories (8 duplicate/16 negative) and 48 heldout stories (12 duplicate/36 negative). Stories were not expanded into repeated name variants. Fixtures and request hashes for both sets were saved before calls in `results/protocol.json`. The same agent authored the cases, policy and evaluation; this is an unblinded synthetic experiment, not an independent human-adjudicated benchmark.

Only development results were used to select a policy. The selection was persisted in `results/selected-policy.json` before any heldout request. No heldout thresholds, prompts or fixtures were subsequently changed. Prior rounds remain immutable regression evidence, not fresh calibration data.

## What the candidate rule required

The request retains identity, evidence-reference and explicit-distinctness questions and adds an independent predicate: `supported_identity_link`. It asks whether the supplied evidence directly establishes identity, excluding rumors, copied enrichment, third-entity sources, common branding, ownership and unresolved corrections. Questions cannot consume each other’s answers.

Three policies were declared before calls, in strict-to-loose order:

| Candidate | Same-entity floor | Selected-source probability | Supported-identity probability |
| --- | ---: | ---: | ---: |
| Strict | 0.70 | 0.95 | 0.95 |
| Balanced | 0.60 | 0.90 | 0.90 |
| Loose | 0.50 | 0.80 | 0.80 |

Every candidate also requires the `same_entity` label, a validated source reference or a conservatively normalized exact company-profile + website match, explicit-distinctness probability below 0.10, no unresolved full-profile conflict and no omitted context. The exact-identifier route still requires same-entity probability at least 0.90. Source-based and exact-value explanations use fixed templates, never generated prose.

Selection rule: choose the first candidate with at least 80% development publication recall and no false or unsupported suggestions. If none qualifies, select the safe candidate with greatest development recall, strictest tie. This rule deliberately tests feasibility; it does not prove that a qualifying rule should replace a better baseline.

All three candidates allowed 7/8 development duplicates and no negatives, so the strict candidate was selected. The baseline allowed 8/8. One correct selected source had only 0.63 probability, blocking a true duplicate in every candidate. Thus the evidence-aware rule was already more restrictive on development; heldout evaluation tested whether it supplied a compensating safety or generalization benefit.

## Fresh heldout results

Both rules were scored against the **same saved responses**, including the additional predicate, so this is an application-rule comparison. It is not a randomized comparison of question sets or a causal comparison with Round 2’s different cases.

| Heldout measure | Simpler 0.90 baseline | Selected evidence-aware rule |
| --- | ---: | ---: |
| Positive / negative pairs | 12 / 36 | 12 / 36 |
| True suggestions if all pairs evaluated | 10/12 (83.3%) | 10/12 (83.3%) |
| False suggestions | 0/36 | 0/36 |
| Unsupported positive explanations | 0 | 0 |
| Known duplicates retrieved | 10/12 | 10/12 |
| End-to-end true suggestions | 9/12 (75%) | 9/12 (75%) |
| API failures | 0 | 0 |

These counts do not establish production precision or recall. The holdout is small, synthetic and authored by the same agent as the policy. It does not satisfy the spec’s later 100-positive/300-negative evaluation with approved real examples. The proposed 80% end-to-end target was not met even here.

Two important publication misses:

| Case | Identity probability | Correct selected-source probability | Supported-identity predicate | Result |
| --- | ---: | ---: | ---: | --- |
| Continuing legal registration | 0.84 | 0.88 | 1.00 | Baseline rejects identity probability; new rule rejects source probability |
| Name change without structured history | 0.62 | 0.75 | 0.99 | Both reject; retrieval also misses the pair |

The extra probability thresholds moved the cutoff problem rather than resolving it. A selected-source probability is not measured source correctness. The first source above was correct according to the synthetic gold annotation despite falling below 0.95.

A second known positive, an old/new surname pair with no indexed email, phone or historical assertion, passed the publication rule when directly evaluated but was never retrieved. Both retrieval misses were intentionally included to avoid assuming that every useful identity fact is already represented as a structured historical identifier.

The negative stories challenged speculative rebrands, source text about a third company, future proposed transactions, asset sales without legal continuity, shared parent/brand identities, copied or disputed matching profiles, stale claims refuted by primary sources, generic inboxes, jokes and instructions embedded in record text. None produced an allowed suggestion in this run. Gold supporting-reference sets are withheld from model inputs; a correct identity label citing a wrong reference counts as an explanation failure.

## Stability

Twelve heldout cases (six positives/six negatives, selected by fixed hashes before results) were reversed and repeated.

- Pair reversal changed **0/12 identity labels** but **1/12 publication outcomes**.
- Identical repeats changed **0/12 labels and 0/12 publication outcomes**.
- The reversal-sensitive case retained the correct label and source reference. Its independent explicit-distinctness probability moved from **0.00 to 0.14**, crossing the 0.10 veto while supported identity remained 1.00.

This is another reason to avoid treating independent questions as a consistent proof system. They can remain in tension even when the identity label is stable.

## Retrieval and context

The existing spike prototype was reused without tuning against heldout results: normalized full identities, retained active/superseded assertion values and actual local-Postgres trigram comparisons. Development produced 20 history-aware candidate pairs, including all 8 duplicates. Heldout produced 36 candidate pairs, including 10/12 duplicates. No history-aware cross-story candidate was found in either pool; all such candidates were among declared labeled pairs. Classification evaluated every labeled pair so retrieval misses stayed visible.

The byte-bounded context builder and deterministic omission markers were unchanged. The new rule defers publication when selected context was omitted; oversized identity fields already defer before calling the provider. These are explicit UTF-8 byte limits, not an implemented exact-token production budget.

## Real-positive validation: still unavailable

The user reported no known Team8 duplicate pair. A bounded read-only audit therefore checked the person object as well as the prior company sample, rather than inventing labels from classifier outputs.

- Verified the existing credential still resolved to Team8 before the query.
- Read **59 person records**, with no next page, using the API’s read-only query route and a cap of 187. Retained only identity fields and the company reference outside the repository; no private-memory endpoint or transcript was read.
- Checked primary names/emails/phones and **four additional email/phone values**. Both primary-only and all-current-identifier retrieval produced **zero candidate pairs**.
- No person context was sent to OpenAI. No additional real-person API history was fetched after this candidate audit.
- **Zero CRM writes, visible suggestions or merges.** Real records and candidate artifacts stay only in `/tmp/retainer-classifier-round3-private` (0700 directory, 0600 files).

This is an unlabeled candidate audit, not a claim that the workspace has no duplicates. The prior 13-company shadow sample also had no known positive pair. Same-record snapshots, duplicated exports and renamed copies of real records were **not** counted as real duplicate-record positives. The model’s own verdict is not independent ground truth.

Only `results/real-audit-summary.json` is retained in the repo, containing aggregate counts. `audit_people.py` reproduces the bounded read/candidate audit; it has no provider calls or CRM write path.

## Operations and verification

- **96 successful live Decisions requests**: 24 development, 48 first heldout requests, 12 reversals and 12 repeats. No live errors or retries occurred.
- **119,701 input tokens**, no cache reads or writes; usage-based cost estimate **$0.01197** at the previously checked Decisions rate of $0.10/M input. Invoice charges were not verified.
- Local request latency: **p50 254 ms / p95 2,017 ms**. Cold/connection effects are included; this is not a provider SLO.
- Per-phase guard: at most 80 evaluations, 160 possible attempts and $0.30 conservative byte-based cost reservation. Existing evaluation files are reused for analysis, never overwritten.
- **18 new tests pass.** They cover evidence/identity/contradiction gates, exact-match route requirements, omitted context, invalid references, refusals, unsupported explanations despite a correct label, failure denominators, frozen hashes, label leakage and additional-email/phone handling. Together with the prior 39 tests, the spike has 57 passing tests.
- No production modules, database schema, extension, model proxy, deployment or human review behavior changed.

## Decision and next useful evidence

**Retain the simpler baseline for future experiments; do not add the evidence-aware gate to production.** The additional question and thresholds did not improve the measured heldout outcome and added another source of order sensitivity. Preserve this result even though it does not confirm the hypothesis.

The useful next inputs are independently adjudicated real duplicate pairs and their before-merge identity evidence, plus hard real negatives. Future explicit human merges can supply candidate positive labels if both pre-merge records and evidence are captured under authorization; dismissals need independent review because not every dismissal proves distinct identity. Keep those labels separate from the model’s judgments.

Before another policy change, obtain such examples and define how historical identity facts enter candidate retrieval when no historical field assertion exists. Do not keep lowering thresholds on the consumed synthetic holdouts. The shipped feature remains blocked by missing validation, not API access or cost.

## Reproduce without provider calls

From this directory:

```sh
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 experiment.py analyze
python3 audit_people.py --private-dir /tmp/retainer-classifier-round3-private
```

A fresh live experiment follows `prepare` → `development` → `heldout`, with an existing operator-supplied `OPENAI_API_KEY`. Development selection must exist before heldout evaluation. Preserve results and the selected policy; never reuse this heldout set as new calibration data. The real audit’s `--fetch` requires an explicit operator env file and a new private directory outside every checkout.
