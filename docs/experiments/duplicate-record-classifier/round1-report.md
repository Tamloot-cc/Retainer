# Duplicate classifier spike — 2026-11-16

**Latest results:** [Round 5 comprehensive report](round5/REPORT.md). All
115 local tests pass, but behavioral experiments exposed a critical context-loss
failure: the legacy gate allowed 7/8 crafted negative pairs after their correcting
source was omitted. The hardened harness now defers incomplete context. Complete
inputs were stable across 184 frozen pairs; actual production URL parity exposed
one remaining shared-provider-root case. There were 362 successful new live calls,
estimated $0.0375. No classifier is deployed. [Visual walkthrough](decisions-explained.html).
Use the hardened Round 5 runtime/safety helpers for future experiments; earlier
runners and results are versioned archives. [Round 4](round4/REPORT.md) ·
[Round 3](round3/REPORT.md) · [Round 2](round2/REPORT.md).

The remainder of this report records **Round 1**, unchanged for comparison.

**Verdict: Decisions is accessible and technically useful. Do not start production implementation from this spike alone.** The synthetic experiment passes the social-host safety check, but retrieval coverage and threshold calibration need more work. No production workers, CRM records, schemas, credentials or deployments were changed.

## Reproduce

Use Python 3, an existing operator-supplied `OPENAI_API_KEY`, and this directory:

```sh
python3 spike.py                         # regenerate fixtures/questions; no network
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 spike.py --live --workers 8      # refuses to overwrite existing evaluations
python3 analyze.py                      # requires local docker-postgres-1 with pg_trgm
```

Keep the previous results before rerunning. The runner reads only the named environment variable; it does not discover credentials. `analyze.py` executes a READ ONLY transaction over inline synthetic JSON in local Postgres; it neither reads nor writes CRM tables. No added dependencies are needed. Python bytecode is ignored.

## Experiment

- 200 labeled synthetic pairs: 50 duplicates and 150 nonduplicates, across 20 case types, ten name variants each. A name-based split was fixed before calls: 140 development pairs (35/105) and 60 heldout pairs (15/45).
- These are **20 hand-authored templates**, not 200 independent realistic cases. Heldout pairs share templates with development pairs. Labels were authored with the fixtures, not independently adjudicated. Neither split supports a real-workspace accuracy claim.
- 720 valid live requests: all 200 pairs with fields and with full context; 40 selected pairs additionally with provenance, history, identity-only question, reversed order, repeat, long input twice, and truncated history. The repeated long inputs deliberately exercise cache reuse. Single/multiple questions use identical identity instructions.
- Question wording and 0.95 publication threshold were fixed before evaluation. The initial run exposed a request-schema bug, repaired without tuning identity instructions. The initial raw results are preserved separately and excluded from corrected quality metrics. Both runs' usage is included below. The later threshold sweep is exploratory; it does not turn the heldout split into a new independent test set.
- `fixtures.json` contains sanitized invented records, dates and registry statements. The Fijoya/Wiz names reproduce the known social-host pattern with `.example` websites; these are not exported real records. Model requests contain no labels or train/test flags.
- History facts have stable `fact_1` references. The evidence choice is `none` or a supplied reference; when there are no facts, omit the evidence-choice question. Publication also checks deterministic full company-profile + website equality, strong profile conflicts, and the independent distinct-entity predicate. It renders a fixed template, never generated prose.

## Actual API and SDK observations

Direct `POST https://api.openai.com/v1/decisions` with `model: "gpt-6-luna"` succeeded. See `results/access-probe.json` for the full request and response. Typed answers echo question names. Choice answers contain `choice`, per-option `probabilities`, and a separate `confidence`. Predicate answers contain `probability`. Usage includes input, cached-input and cache-write counts; observed output usage was zero. Confidence is not used as measured accuracy or as the publication threshold.

The installed Python `openai` **2.38.0** has **no `client.decisions` resource**. This harness uses standard-library HTTP; it does not silently use Responses or another provider. Newer SDK examples exist in the [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions), but a newer SDK was not installed or runtime-tested.

The first batch made 720 attempts: 340 succeeded; 380 returned live HTTP 400 because an evidence question had only the single `none` option. A separate reproduction captured `invalid_request_error`, parameter `questions[1].choices`, code `array_below_min_length`: choices require at least two options. See `results/schema-error-probe.json`. Corrected batch: **720/720 successful, no retries**. No live refusals, timeouts, 429s or 5xx responses occurred.

## Classification and publication

Full context, original pair order, first request only:

| Measure | Development | Heldout | Combined |
| --- | ---: | ---: | ---: |
| Pairs | 140 | 60 | 200 |
| Published true duplicates | 25/35 | 10/15 | 35/50 |
| Published false positives | 0/105 | 0/45 | 0/150 |
| Publication precision | 100% | 100% | 100% |
| Publication recall | 71.4% | 66.7% | 70% |
| Model abstentions | 32/140 | 14/60 | 46/200 (23%) |
| Contradictory positive identity answers | 0 | 1 | 1 |
| Unsupported published explanations | 0 | 0 | 0 |

Precision is conditional on these synthetic fixtures. Zero false positives among 150 negatives still permits roughly a 2% one-sided 95% upper false-positive bound under an independent sampling assumption; these repeated templates violate that assumption, making real-data uncertainty larger.

The raw classifier called all 50 duplicates `same_entity` and one negative `same_entity` (raw identity precision 50/51, recall 50/50). The shared-phone negative had same-entity probability 0.54 despite explicit separate-company evidence; profile conflict and distinct-entity checks prevented publication. Correct identity labels alone are insufficient.

Explanation correctness was checked against hand-authored source semantics and deterministic identifiers: 35 published full-context explanations had valid support, no invented references, and no unsupported positive rationale. This is a small synthetic check, not an independent human audit. Shared investor/employer/parent relationship text never became positive identity evidence.

| Case type (10 pairs each) | Same-entity labels | Published suggestions | Abstentions |
| --- | ---: | ---: | ---: |
| Exact full profile + website | 10 | 1 | 0 |
| Aliases | 10 | 10 | 0 |
| Hebrew/English names | 10 | 5 | 0 |
| Rebrands | 10 | 10 | 0 |
| Historical person email | 10 | 9 | 0 |
| Distinct social profiles | 0 | 0 | 10 |
| Subsidiary | 0 | 0 | 0 |
| Acquisition | 0 | 0 | 1 |
| Shared phone | 1 | 0 | 0 |
| Shared office | 0 | 0 | 0 |
| Common person name | 0 | 0 | 0 |
| Shared investor | 0 | 0 | 10 |
| Sparse records | 0 | 0 | 10 |
| Stale enrichment | 0 | 0 | 0 |
| Embedded instructions | 0 | 0 | 0 |
| Social root only | 0 | 0 | 10 |
| Meaningful URL query | 0 | 0 | 0 |
| Conflicting sources | 0 | 0 | 5 |
| Shared employer | 0 | 0 | 0 |
| Transliteration collision | 0 | 0 | 0 |

Fijoya/Wiz specifically abstained, with 0.15 same-entity probability in the full-context run; it never published. It was not affirmatively classified as different. All ten embedded-instruction negatives were classified as different with no publication. These attacks are simple text instructions, not an exhaustive adversarial evaluation.

## What context and multiple questions changed

On the same 40-pair subset (10 duplicates, 30 negatives):

| Context | Raw same-entity labels | Published | Average input tokens |
| --- | ---: | ---: | ---: |
| Fields | 3 | 1 | 569.2 |
| Fields + provenance | 3 | 0 | 615.2 |
| + history | 10 | 4 | 825.6 |
| + relationships | 11 | 8 | 830.5 |

History gave the useful identity evidence. Provenance metadata alone did not help here. Relationship context increased published true positives but also yielded the contradictory shared-phone label; a five-case positive subset cannot establish a general benefit from relationships. The variants make one call each, so differences combine context effects and normal sampling variability.

Identity-only versus identity plus evidence/distinctness: **0/40 identity-label changes**. Average billed input was about **396 tokens** for the identity question alone and **831 tokens** for the multi-question configuration on these same pairs. Multiple questions were not free. Publication counts are not a fair single/multi quality comparison because the single-question request cannot return semantic evidence references.

Pair reversal changed **2/40 identity labels** and **4/40 publication decisions**. Identical repeats changed **0/40 labels and 0/40 publication decisions** in this run. Reversed provenance follows the record order. The independent questions did contradict one another on the shared-phone case. Long context (600 repeated irrelevant notes) produced 8/10 published duplicates and zero negatives; removing identity history reduced publication to 1/10 and raised abstentions to 36/40. These are stress probes, not a tested truncation-selection algorithm.

## Threshold sensitivity

Same frozen full-context outputs; support/conflict checks unchanged:

| Same-entity threshold | Development TP/35 | Heldout TP/15 | Published negatives/150 |
| --- | ---: | ---: | ---: |
| 0.85 | 35 | 15 | 0 |
| 0.90 | 32 | 14 | 0 |
| 0.95 | 25 | 10 | 0 |
| 0.98 | 15 | 8 | 0 |

A 0.95 cutoff discarded nine of ten exact-profile-and-website duplicates; their probabilities ranged 0.86–0.95. **Use 0.90 as the next experiment's candidate threshold**, selected from development results, rather than approving 0.85 based on these easy negatives. A new independent challenge set must validate that choice.

## Retrieval coverage is the bigger missing piece

Local Postgres `pg_trgm.similarity` was measured for each labeled pair, with the actual 0.6 name threshold. Two small deterministic identifier comparators were evaluated: current hostname behavior, and a prototype full-URL identity comparator. This is a reconstruction of the retrieval predicates, **not an integration test of `consolidateWorkspace`**, cursor behavior, same-object/tenant constraints, or all cross-pairs. Phone/email fixtures use already normalized simple values. No history-aware retrieval was implemented.

| Retrieval on the 200 labeled pairs | Current hostname rule | Prototype full URLs |
| --- | ---: | ---: |
| Candidate pairs | 168 | 86 |
| True duplicates retrieved | 38/50 (76%) | 38/50 (76%) |
| Nonduplicates retrieved | 130/150 | 48/150 |
| End-to-end published duplicates at 0.95 | 23/50 (46%) | 23/50 (46%) |

Full URLs remove the Fijoya/Wiz hostname trigger, but other social-profile pairs can still be retrieved by similar names. All ten alias pairs and two rebrands were missed. History-aware candidate generation needs its own real-Postgres integration evaluation before claiming end-to-end launch coverage. The classifier cannot recover those 12 missing pairs.

## Latency, usage, caching and cost

Corrected run, eight HTTP workers, 31.5 seconds wall time, warmed process/network:

- Across all variants: **p50 325 ms / p95 544 ms** per request, excluding thread queue time. Cold access probe: 2,618 ms. These are local observations, not an SLO or provider load test.
- Full-context forward run: development p50/p95 333/532 ms, heldout 299/496 ms.
- Corrected run: **799,740 input tokens**, including **238,136 cached tokens** and **63,710 cache-write tokens**. Full normal inputs had zero cache hits; deliberately padded long inputs produced actual cache hits. Cross-run cache warming affects the long-context measurements.
- At documented standard short-context rates ($0.10/M uncached, $0.01/M cache-read, $0.125/M 30-minute cache-write; Decisions output uncharged), corrected run cost is **estimated $0.0601**, about **$0.0000835/evaluation request** across the mixed variants. Normal full-context requests averaged 829 input tokens, about **$0.0000829/pair**, or **$8.29/100,000 pairs**, before retries/premiums.
- Including the first partially invalid batch and access probe: **1,302,314 observed input tokens**, estimated **$0.1074**. No usage was returned for 400 responses. Account invoice/admin billing was not accessed, so these are usage-based estimates, not verified charges.

Caching requires at least 1,024 shared-input tokens; question content is outside the reusable prefix. Normal small pair contexts do not meet that threshold. Do not pad production inputs merely to obtain cache hits. Pricing and cache behavior references: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [pricing](https://developers.openai.com/api/docs/pricing), checked 2026-11-16.

## Failures and next configuration

All **15 local tests pass**. Simulated HTTP-boundary cases cover 429/500/503 retry, 401 no retry, timeout with uncertain charge and a one-retry limit, malformed JSON, refusal, invalid typed answers/distributions/reference choices, contradictory questions, and publication templates. These inject the `urlopen` boundary; they do not emulate a deployed network proxy. Only invalid-input HTTP 400 happened live. Runtime credentials and provider outages remain separate from a `different_entities` result.

No production configuration is approved. The selected **next shadow-experiment configuration** is:

| Setting | Choice |
| --- | --- |
| Provider/model | Direct OpenAI Decisions, `gpt-6-luna`; no fallback |
| Questions | Identity + independent explicit-distinct predicate; evidence-reference choice only when candidates exist |
| Context | Identity fields first, provenance + sourced history, direct relationships only when relevant; no irrelevant padding |
| Limits | Next context builder: 2,048 shared-input tokens + 768 question tokens, deterministic omission markers; tokenizer enforcement is still to implement/test |
| Threshold | Candidate 0.90 + validated support + no unresolved profile conflict + distinctness probability <0.10 |
| Timeout/retries | 20 seconds/attempt, one retry for 429/5xx/network timeout, no retry for refusal/invalid input; uncertain charges retained |
| Local run budgets | At most 720 evaluations, 1,440 attempts, eight workers, 15 minutes; 32,768 serialized request bytes; $1.25 conservative token reservation per run |
| Next workspace shadow budget | Proposed 200 pairs and $0.25/workspace/run; enforce usage and reserve retries before dispatch; not implemented |
| Model version policy | Record returned model, input digest, questions/policy versions; returned alias is not immutable. No dated snapshot was verified. Re-evaluate the frozen suite on alias changes before publication |

The byte limit and conservative spend preflight were added after the measured run; the largest measured request was 30,595 bytes and the completed runs used fixed finite synthetic inputs. The runner refuses to overwrite outputs and reserves both possible attempts using a one-byte-per-token allowance plus 1,024-token overhead at the documented cache-write rate. This is a planning cap, not an enforceable provider invoice ceiling. It has no production token ledger or workspace authority checks.

**Remaining exit work:** independently varied challenge fixtures (especially near-identical but distinct entities and corrupt identity fields), history-aware retrieval tests, an implemented/token-tested context budget, and a fresh calibration holdout. Real-workspace quality, privacy/authorization, lifecycle concurrency, proxy integration and hosted behavior were not tested. This spike supports continuing evaluation, not enabling recommendations.
