# Round 2: historical retrieval, fresh cases and Team8 shadow

2026-11-16. **Continue evaluation; do not enable production suggestions.** Historical retrieval fixed the measured candidate misses on the new set. The frozen 0.90 publication rule still recovered only 60% of its duplicates. The bounded Team8 shadow reproduced the social-host problem safely but had no known positive pairs with which to measure real recall.

## What changed

All work is confined to the spike worktree. No production modules, schemas, workers, extension permissions or deployment configuration changed. The runner calls OpenAI Decisions directly with the existing operator credential. Team8 API access used the already-configured credential, verified through `/v1/me` before reading records.

| Component | Round 1 | Round 2 |
| --- | --- | --- |
| New synthetic cases | 20 templates × 10 name variants | 80 separately authored stories: 20 duplicates, 60 negatives |
| Split | Same templates in both groups | Different stories: 40 development + 40 heldout, each 10 positives/30 negatives |
| Pair selection test | Given labeled pair at a time | Candidate generation over a 160-record pool in real Postgres |
| Identity comparison | Hostnames or simple full URL comparison | Conservative full URLs + known tracking removal + normalized names |
| Historical retrieval | Not implemented | Retained active/superseded identity assertions; exclude rejected, retracted and pending assertions |
| Threshold | 0.95; 0.90 explored after seeing results | 0.90 frozen before calls; 0.95 retained as a baseline |
| Explanations | Broad label-based correctness check | Explicit gold supporting-reference sets separate from model inputs |
| Input budget | Serialized request limit | Deterministic 8 KiB shared context + 8 KiB questions; oversized identity fields defer |
| Real data | None | Authorized, read-only Team8 company sample; no CRM writes |

The 80 stories are less repetitive than Round 1, but remain authored synthetic cases. Related ideas appear across splits; this is not an independent human-adjudicated real-world test set. Fixtures and request hashes were frozen in `results/protocol.json` before model calls. Scenario IDs, labels, split names and gold references never enter model inputs. Record IDs are opaque hashes. No questions, thresholds or fixture text were tuned after viewing heldout outputs.

## Candidate generation

`engine.py` computes identity keys in Python, then joins the whole pool in a read-only local-Postgres query using actual `pg_trgm.similarity >= 0.6`. The joins require matching workspace and object, live records, canonical sorted record IDs and entity objects. Matched keys retain their source references, but retrieval triggers are not presented to the model as conclusions.

| Retrieval over 160 records | Hostname baseline | Current full identities | + historical identities |
| --- | ---: | ---: | ---: |
| Total candidate pairs | 328 | 52 | 59 |
| Declared duplicate pairs found | 14/20 | 14/20 | 20/20 |
| Development duplicates found | 8/10 | 8/10 | 10/10 |
| Heldout duplicates found | 6/10 | 6/10 | 10/10 |
| End-to-end true suggestions at 0.90 | 10/20 | 10/20 | 12/20 |

History added seven candidate pairs: six true duplicate pairs and one negative historical-name overlap. This illustrates why historical matching belongs in retrieval and still needs classification. Every candidate from the improved history rule belonged to one of the 80 declared stories; it produced no additional cross-story candidate. The hostname baseline did produce many cross-story pairs. Its total candidate load is measured, but its cross-story classification quality is not claimed: only the 80 declared pairs were sent to the model.

Normalization preserves meaningful paths, case-sensitive paths, query identity parameters and nonstandard ports. It removes known tracking parameters and equivalent root/scheme/www forms, rejects social platform roots as identity keys and rejects embedded URL credentials. It does not change Retainer search/lookup normalization. There is no semantic extraction of aliases from arbitrary prose: historical values must already exist as structured assertions. The fixture histories are synthetic, not evidence that every real rebrand has such assertions.

## Frozen classification and publication results

All 80 pairs were classified, including those not retrieved, so candidate misses and classification misses remain distinguishable.

| At threshold 0.90 | Development | Heldout | Combined |
| --- | ---: | ---: | ---: |
| Duplicates | 10 | 10 | 20 |
| Nonduplicates | 30 | 30 | 60 |
| Raw correct same-entity labels | 10/10 | 10/10 | 20/20 |
| Raw same-entity labels on negatives | 0 | 0 | 0 |
| Allowed true suggestions | 6/10 | 6/10 | 12/20 |
| Allowed false suggestions | 0/30 | 0/30 | 0/60 |
| Unsupported allowed explanations | 0 | 0 | 0 |
| Abstentions across all pairs | 17/40 | 14/40 | 31/80 |
| End-to-end recall with history | 60% | 60% | 60% |

The higher 0.95 baseline allowed only 7/20 duplicates (35%), with zero negative suggestions. **The 0.90 rule improved recall but did not reach the proposed 80% end-to-end launch target.** Zero false suggestions among 60 authored negatives does not establish a production error rate. The sample is also below the spec's later 100-positive/300-negative shadow-evaluation requirement.

All eight missed duplicate suggestions had the correct `same_entity` label but probabilities below 0.90. The heldout misses were:

| Heldout case | Same-entity probability | Identity source selected? |
| --- | ---: | --- |
| Two-step name change | 0.71 | Yes |
| Personal → work email | 0.78 | Yes |
| Bilingual registration | 0.85 | Yes |
| Legal name → trading name | 0.76 | Yes |

The development misses were legal abbreviation (0.88), domain migration (0.84), tracking-URL variants (0.64) and renumbered phone (0.84). In two development cases the evidence choice returned `none`, despite a correct identity label. This suggests that semantic-evidence criteria and the global probability cutoff need a new development-only experiment. It does **not** justify lowering the cutoff based on these heldout cases.

Hard negatives included copied matching websites and profiles, expired-domain reuse, asset transfers without legal continuity, distinct registrations under one brand, franchises, reused role mailboxes, rejected aliases and embedded instructions. None produced an allowed suggestion in this run. Reference correctness is scored independently of the overall label: a positive label with the wrong supporting reference fails the explanation check.

## Actual Team8 shadow run

The user's “go ahead” continued the proposed bounded read-only shadow evaluation. The existing configured API key resolved to the Team8 workspace before export. The spike queried company records only, retained name/domain/company-profile fields, read their identity assertion history, and selected a bounded set of identity-related company facts. It did not read private profile memory or fetch external URLs/transcripts.

| Observed real-workspace sample | Result |
| --- | ---: |
| Company records returned | 13; no next page |
| Identity assertion items | 31 |
| Selected identity facts | 2 |
| Truncated assertion/fact pages | 0 |
| Legacy hostname candidates | 1 |
| Current full-identity candidates | 0 |
| History-aware candidates | 0 |
| Legacy regression pairs evaluated | 1 |
| Result | `insufficient_evidence`; no suggestion |
| CRM writes / visible suggestions | 0 / 0 |

The legacy pair was the known **Fijoya/Wiz** regression. Its websites and complete company profiles were inspected as distinct identities; its shared social hostname is not sufficient identity evidence. Full-URL retrieval excluded that pair, and the model also abstained when the pair was evaluated explicitly as a regression probe.

This demonstrates the known real-workspace safety case, not real-data precision or recall. There were no known true duplicate candidates in this bounded company sample. No additional labels were invented from name or URL differences. Missed real duplicates cannot be counted without independently adjudicated examples, and this run does not evaluate people or other company workspaces.

Real records, source text, API responses and the read audit remain only in the private directory `/tmp/retainer-classifier-team8-shadow` (directory 0700, files 0600), outside the repository. This is temporary local evidence and may be cleared by the OS. Only `results/team8-summary.json`, containing aggregate counts and the already-known regression verdict, is retained alongside synthetic results. No real-data fixture is committed. The recorded shadow runner made 54 read-API requests: identity check, company query and four bounded reads per company. Preliminary credential/schema/query probes were additional read-only requests. The query uses the API's read-only POST query route; all other calls were GETs. No suggestion/review/merge endpoint was called.

## Operations and tests

- Synthetic: **80/80 successful requests**, 80 attempts, no retries; p50 **268 ms**, p95 **1,961 ms**. First-connection effects are included; these are not service guarantees.
- Synthetic input: **69,613 tokens**, no cache reads/writes, estimated **$0.00696** at the previously checked $0.10/M Decisions input rate.
- Team8 regression: **1 successful request**, **999 input tokens**, estimated **$0.00010**. Combined new observed usage cost: approximately **$0.00706**, not invoice-verified.
- Run reservation: at most 140 requests/280 attempts for synthetic evaluation, $0.30 conservative reservation; at most 20 pairs/40 attempts and $0.25 for Team8. The measured runs used 80 and 1 request respectively. These remain local planning bounds, not a provider-enforced invoice ceiling.
- **24 new tests passed**, including nine real-Postgres integration tests in a fresh, uniquely named test database, removed after the test file. They cover workspace/object/liveness isolation, event exclusion, historical recovery, pending-assertion exclusion, social-host regression, canonical unique pairs and reporting a capped result set.
- Context tests cover deterministic bounded selection, Hebrew UTF-8 sizing, preserving complete identity fields, deferring oversized identity fields, omitted facts, reference validity, normalization and unsupported explanations even when the identity label is correct.
- The existing **15 Round 1 tests** still pass. Total: **39 tests**.

The context limit is an explicit UTF-8 byte cap, not an exact model-token counter. This intentionally avoids claiming that the proposed 2,048-token production builder has been implemented. No production invalidation/cursor state machine, extension, proxy, concurrency lifecycle or hosted deployment was tested.

## Decision

Keep the integration unimplemented for now. The measured retrieval prototype is promising; the global probability threshold is still the weak point on these harder positive examples. Next, test an evidence-aware publication policy using new **development-only** examples, then obtain a new independently adjudicated holdout containing real positive pairs. Preserve this round's heldout set as an immutable regression set, not a tuning target. Do not change the existing CRM's suggestions based on these results.

## Reproduce

From this directory:

```sh
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 run.py --analyze               # rechecks frozen hashes and recomputes metrics; no model calls
```

Existing evaluation outputs are never overwritten. A fresh live run requires a new results location and an operator-supplied `OPENAI_API_KEY`; preserve the protocol before evaluating. `shadow.py` requires an explicit external private directory and a Retainer env-file path. It hard-checks the expected Team8 workspace and permits only the documented read routes. Do not publish its private outputs.

Files: `cases.py` / `fixtures.json` (synthetic stories), `engine.py` (retrieval/context/policy prototype), `run.py` (frozen evaluation), `shadow.py` (bounded private export/evaluation), `test_engine.py` (unit/integration tests), `results/` (synthetic requests/responses, protocol, metrics and aggregate Team8 summary).
