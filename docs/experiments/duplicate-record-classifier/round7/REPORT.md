# Round 7 — frozen synthetic workspace

770 records across 380 authored entity families share one workspace. Ground
truth has 100 positive pairs (70 two-record families and ten three-record
families) and 300 designed hard negatives. Every other same-object pairing is
also distinct. Names are sampled with a fixed seed. Relationships and evidence
come from repeated templates, so this measures behavior on these scenarios.
The committed manifest is the fixture of record and contains every exact request.

| Retriever | Pairs returned | True duplicates | Designed negatives | Incidental negatives |
| --- | ---: | ---: | ---: | ---: |
| Current identifiers and trigram names | 222 | 40 | 180 | 2 |
| Current + historical identifiers + sourced name mentions | 388 | 86 | 300 | 2 |

Both paths run against inline synthetic rows in local PostgreSQL. The baseline
approximates the worker's matching rules on clean email and name fields, before
its per-run publication caps. This corpus does not exercise phone or URL
matching. Fourteen evidence-poor positives were missed before model evaluation.

The Decisions request uses gpt-6-luna with the same canonical JSON text shared
by all questions. Named choices assess identity and select a supplied evidence
reference, and a separate predicate checks explicit distinctness. The frozen
gate uses the probability assigned to same_entity, verifies the reference,
and defers incomplete context. Provider errors and refusals are counted
separately. Only the local runner evaluates hypothetical suggestion eligibility.

Run `python3 benchmark.py report` to summarize the saved workspace. With an
operator-supplied OPENAI_API_KEY, `python3 benchmark.py run` verifies the
manifest digest and records provider responses. The run has a $2 local planning
bound. Score the saved results with the report command. The pilot criteria are
at least 80 true suggestions, zero false suggestions on all emitted pairs,
and zero unsupported explanations. A clean benchmark also requires every
retrieved pair to receive a valid decision.

## Live Decisions results

All 388 frozen requests returned valid answers on their first attempt (341,224
input tokens). The end-to-end gate failed. The review policy surfaced 12/100
true pairs, zero of the 302 retrieved negatives, and zero unsupported
explanations. Retrieval missed 14 positives. Of the remaining 74 withheld
positives, 66 received the same_entity choice and eight received
insufficient_evidence. All 74 scored below 0.90 on same_entity. These are
synthetic results from repeated patterns. Keep this set for regression. Use a
separate development set to distinguish evidence-quality issues from
probability-threshold effects before freezing a policy for a new holdout.

Raw typed responses are in evaluations.jsonl. Recompute the primary counts with
`python3 benchmark.py report`.
