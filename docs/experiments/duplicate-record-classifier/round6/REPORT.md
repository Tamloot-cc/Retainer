# Round 6 — completeness at the suggestion boundary

This offline replay uses the 352 archived Round 5 synthetic Decisions responses.
The model, questions, probability threshold, and human approval flow stay fixed.
Run `python3 round6/run.py` from the experiment directory to reproduce.

| Experiment | Observation |
| --- | --- |
| Replace the omission marker with 12 invalid variants for each response | All 4,224 assessments deferred without an exception or a publishable explanation. |
| Sweep 104 byte budgets across the 12 stress stories with both source orderings | The builder reported the number of excluded fact references correctly in all 2,496 builds. At least one fact was missing in 1,474 builds. |
| Replace true omission counts with a structurally valid all-zero marker on the 12 truncated stories | Four genuine pairs and seven of eight distinct pairs qualified for a suggestion. |

The experimental gate now requires both known omission counters to be integer
zeros. The false-zero control shows why the server must derive completeness
from its own evidence inventory. This sweep starts with facts already available
to the builder. It cannot detect a skipped database page, missing history, or a
record edit between fetching evidence and presenting the suggestion.

The next accuracy experiment should freeze a new synthetic workspace with at
least 100 duplicate pairs and 300 hard negatives, split by entity family.
Include people, companies, multi-record clusters, and unrelated records sharing
identifiers. Compare the current matcher with extended retrieval and Decisions
on the same workspace. Score every emitted suggestion, including incidental
cross-family pairs, and count unretrieved positives as misses. Record supported
explanations and reviewer workload alongside the rollout thresholds in the spec.
Round 6 reuses model responses and adds no independent accuracy observations.
