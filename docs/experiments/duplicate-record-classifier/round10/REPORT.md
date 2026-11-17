# Round 10 — final source-cutoff calibration

We froze two synthetic workspaces, the Round 9 questions and decision rule,
eleven candidate source cutoffs, and the stopping rule before the first call.
The scorer reproduced Round 9 at 0.90. Only the per-source cutoff varied.
Selection required zero false suggestions, unsupported citations and errors,
then maximized genuine suggestions, breaking ties toward the higher cutoff.

| Stage | Genuine pairs | Retrieved genuine | Retrieved distinct | True suggestions | False suggestions | Unsupported citations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 40 | 38 | 120 | 29 | 0 | 0 |
| Holdout | 100 | 96 | 303 | 89 | 2 | 2 |

Development selected 0.50, saved before holdout calls. The holdout cleared
80% end-to-end coverage and failed both zero-error criteria. Both false
suggestions cited a third entity's former name. Their source probabilities
were 0.53 and 0.78. The facts about the actual pair described a shared mailing
address or transfer to a successor. The same two suggestions account for both
unsupported citations. Both stages returned valid answers for every candidate.

These are synthetic, templated workspaces with fresh identities and different
primary-source wording across splits. The false suggestions are counterexamples
to the proposed review policy. The observed rates do not estimate live CRM
performance. The original stopping rule produced a park decision.

## Subsequent product decision

After reviewing the cost of a false suggestion in a human-reviewed queue, we
recommended a limited opt-in pilot in the owner’s workspace. The holdout score
and failed experimental gate stand as recorded. Keep the 0.50 source cutoff
frozen and show exact evidence beside both records. The pilot would measure
review time and outcomes and sample withheld pairs. It has not started.

The manifests, protocol, development scores, selected policy, raw provider
responses and holdout score are saved alongside the runner. Recompute the
holdout score offline from this directory with:

```sh
python3 -c 'import calibrate as c,json;print(c.score(json.load(open("holdout-manifest.json")),c.read_rows("holdout"),json.load(open("selected.json"))["floor"]))'
```
