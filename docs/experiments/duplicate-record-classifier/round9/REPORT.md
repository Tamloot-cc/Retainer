# Round 9 — direct questions about each source

Round 8 had 17 retrieved true duplicates labeled insufficient evidence. The
submitted input contained the intended citation for 15. Ten used the custodian
account-move template, four a verified alias, and one a signed amendment. The
remaining two lacked a supporting fact. The account-move wording leaves more
room for an ownership-transfer interpretation than the synthetic label implies.
See uncertainty-audit.json for the individual sources.

We froze fresh entity families and templates before calling Decisions. Both
policies used the same baseline response on every retrieved pair. The candidate
additionally asked one predicate per fact in a second request with the full
shared pair context. It required a source-link probability of at least 0.90,
retained distinctness and completeness checks, and could recover an insufficient
identity label. This tests a combined decision rule. The synthetic workspace
used explicit continuity statements, transfers, billing representatives,
corrected notices and third-entity aliases.

| Policy | True suggestions out of 100 | False suggestions | Unsupported citations |
|---|---:|---:|---:|
| Round 8 policy at 0.50 | 78 | 13 | 13 |
| Per-source predicates at 0.90 | 76 | 0 | 0 |

Retrieval returned 96 true and 303 distinct pairs. All 399 baseline and 396
follow-up calls succeeded. The candidate gained nine true suggestions, seven
previously labeled uncertain, and lost eleven. All eleven had the correct
top-ranked source but fell below the source threshold. Every baseline false
suggestion cited the third-entity distractor. The candidate missed the frozen
80/100 requirement. No suggestions were written.

Next experiment: calibrate the per-source threshold on a separate development
set that includes ambiguous changes of ownership, negations, historical
identifiers and wrong-party aliases. Freeze the selected threshold before
evaluating another workspace. This run uses repeated templates and supplies
no estimate of real-workspace precision.
