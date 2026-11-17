# Round 8 — wording and threshold selection

Both workspaces and the selection rule were frozen before collecting answers.
Development and holdout use separate record IDs, name draws and scenario
wording. Both use synthetic templates, including a distracting alias linking
one record to a third entity. The holdout includes 100 true pairs and 300
designed negatives. Retrieval returned 96 positives, all 300 designed
negatives and one incidental negative.

On development, both variants recovered 15/30 positives at 0.50 with no false
suggestions or unsupported citations. At 0.85 the revised wording recovered
11 compared with five for original wording. The predefined selection rule
maximized true suggestions subject to zero false suggestions, unsupported
citations and errors. At the maximum there was a tie and the original wording
won the predefined tie-break. Only that policy ran on holdout.

On holdout, the selected original wording at 0.50 returned 74 true suggestions
and three false suggestions. All three false suggestions cited a real source
that linked just one record to a third entity. Their same-entity probabilities
were 0.51, 0.59 and 0.66. Two pairs shared an email. The remaining 22 retrieved
positives were withheld, including 17 labeled insufficient evidence. The
80/100 recall and zero-false-suggestion gates both failed. All 633 calls
returned valid answers. The paired comparison changes both identity and
citation wording together, so their individual effects remain unknown.

Next test source-to-pair attribution while holding identity wording fixed.
Compare selecting a source alone with verifying the selected source against
the two records in isolation. Include a no-support option and valid historical
identifiers so a record need not be named literally. Freeze and test on
fresh families before proposing enablement.
