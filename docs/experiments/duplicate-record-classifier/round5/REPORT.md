# Round 5: comprehensive regression, safety and API-boundary experiments

2026-11-17. **The API remained stable on complete inputs, but incomplete context exposed an unsafe publication path in the spike.** The new harness now defers incomplete/unknown context by default. This is not a production classifier implementation or an enablement verdict.

## What ran

| Check | Scope | Result |
| --- | --- | --- |
| Frozen-case rerun | 184 prior pairs: 48 positive/136 negative | 37 positive suggestions, zero negative suggestions; no label/publication changes from saved responses |
| Stability/adversarial variants | 24 fixed cases × 6 variants | No identity-label changes or false suggestions; some positive suggestion eligibility changed |
| Context completeness challenge | 12 new source-conflict stories × 2 budgets | Tight context produced 7 false suggestions among 8 negatives without an omission guard; guard withheld all incomplete cases |
| Live cache/billing probe | 10 artificial-prefix requests | Cache writes/reads observed; changed prefix missed; short prefix did not cache; extra questions cost tokens |
| HTTP-boundary and unit/integration tests | 115 tests across all rounds | All passed, including real local HTTP requests and isolated Postgres tests |
| Production URL behavior | 40 equivalence/non-equivalence pairs against merged helper | 39 passed; shared `accounts.google.com` root still matches |
| Spike/production URL parity | Same 40 pairs | 17 disagreements; old Python prototype is not production-equivalent |
| Output replay with production URL keys | 352 saved matrix responses, 113 distinct URLs | Zero publication changes on the existing matrix |

There were **362 new live Decisions requests**, all successful on their first attempt. Raw synthetic requests/responses and frozen protocols are retained in this directory. No new real CRM data was exported or sent to OpenAI. No production code, database schema or live suggestions changed in this round.

## Fixed matrix, not fresh accuracy validation

`results/protocol.json` froze the matrix and 0.90 classifier threshold before calls. It contains:

- 184 saved case requests from Rounds 2–4, rerun once.
- A hash-selected subset of 8 positive/16 negative cases, each tested with reversed record order, reversed evidence/choice order, reversed question order, two exact repeats and injected instructions in record text.
- 12 new budget-stress stories: four genuine synthetic renames and eight distinct-entity cases with a misleading early identity claim and a later correction. Each was tested with full and tight context.

That is **352 matrix calls**, not 352 independent labeled pairs. Previous holdouts are now regression data and were not used to fit new thresholds. The stress stories were authored to expose context-loss behavior, not estimate its prevalence. They and the earlier corpora remain agent-authored, unblinded synthetic examples. Real positive validation is still unavailable.

## 1. Regression and stability

| Group | Calls | Positive suggestions | Negative suggestions | Label changes | Publication changes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Prior-case rerun | 184 | 37/48 positives | 0/136 negatives | 0 | 0 vs saved results |
| Record reversal | 24 | 6/8 | 0/16 | 0 | 1/24 |
| Evidence/choice reversal | 24 | 5/8 | 0/16 | 0 | 0/24 |
| Question reversal | 24 | 5/8 | 0/16 | 0 | 0/24 |
| Exact repeat 1 | 24 | 5/8 | 0/16 | 0 | 0/24 |
| Exact repeat 2 | 24 | 5/8 | 0/16 | 0 | 0/24 |
| Injected record instructions | 24 | 5/8 | 0/16 | 0 | 4/24 |

The unchanged total for injected inputs hides positive decisions moving in both directions. No negative became a suggestion in these attacks, but the result does not establish prompt-injection immunity. Independent evidence checks and probability thresholds can change eligibility even when the identity label stays stable.

`canonical_request` now provides a deterministic experiment helper: sort distinct record IDs while keeping their histories/provenance aligned, sort source references and restore fixed question/choice ordering. Tests show that all 184 base requests and their record/evidence/question reversals converge to identical canonical requests. This eliminates input-order differences; it does not guarantee identical model output across separate calls. The live matrix intentionally used the original perturbations to measure sensitivity, rather than hiding it through canonicalization.

## 2. Critical finding: omission can hide the fact that invalidates a merge

The stress context contained two sources:

1. An older registrar-style claim that A was renamed B.
2. A larger current source containing the correction: the older notice was a copy error and A/B have different registrations. In positive controls, the second source contained benign office detail and confirmation.

At the full 8 KiB context allowance, both sources fit. At a deliberately tight 1,200-byte allowance, the current source was dropped and `omitted.facts` disclosed one omission. Questions were rebuilt from included facts only; the correction did **not** leak through a source-choice description.

| Stress outcome | Full context | Tight context, old baseline | Tight context, omission guard |
| --- | ---: | ---: | ---: |
| True suggestions among 4 positive stories | 1 | 4 | 0 |
| False suggestions among 8 negative stories | 0 | **7** | **0** |
| Unsupported published explanations | 0 | **7** | **0** |

These were hypothetical publication decisions in the local harness, never CRM writes. The tight input gave the model an apparently direct identity claim while hiding its refutation. A probability threshold and a valid source reference cannot repair that missing evidence. The full-context positive controls also show that irrelevant text can reduce eligibility; simply sending more text is not guaranteed to help.

The new `assessment` helper **defaults to deferral when context is omitted, missing an omission state, or has an invalid omission marker**. The legacy unsafe gate remains available only through explicit diagnostic `guard=False` so the failure stays reproducible. The guard sacrifices all four truncated positive controls too. That is a safety tradeoff, not a calibrated recall solution. A future context builder must preserve identity-bearing conflicts and disclose all omissions; the server must independently enforce completeness before publication.

## 3. Safer response validation and HTTP transport

Local diagnostics confirmed issues in the earlier experimental helper:

- Scalar/list JSON could raise an uncaught `AttributeError`.
- A different returned model could be accepted.
- Boolean probabilities and negative usage could pass validation.
- Usage returned alongside a refusal was lost from the saved attempt.

Round 5 uses a new fail-closed transport and validator. Earlier raw results and versioned scripts were not rewritten. This safer runtime is the basis for new experiments, not evidence that a production proxy is implemented.

It validates response/answer containers, named question alignment, answer types, allowed choices and complete distributions, finite numeric probabilities excluding booleans, separate confidence values, expected model identity and consistent nonnegative usage. Refusals and invalid data remain deferred/error outcomes, never `different_entities`. Returned bodies and billed usage are preserved for synthetic diagnostics, including refusals and invalid typed responses; headers/credentials are not logged.

The HTTP tests use a real local `ThreadingHTTPServer` and a fake credential. They exercise request method/path/body/auth shape, 401/400 no-retry behavior, 429, 500/502/503, retry exhaustion, actual socket timeouts, malformed JSON, scalar responses, refusals, model mismatch and unexpected 202 status. Short `Retry-After` delays are parsed; waits are intercepted in tests for speed. Integer or HTTP-date delays beyond the in-run limit defer to a later run rather than retrying too early. Timeouts and uncertain server errors preserve uncertain-charge markers. No such provider failure occurred live in this round.

A locked budget reserves every attempt before dispatch, including retries, with finite call/spend limits and a 15-minute deadline. Ten competing threads could obtain exactly three reservations from a three-attempt budget. Exhausted spend/deadline tests dispatched no request. Reservations are conservative local planning bounds, not provider invoice ceilings or a production workspace usage ledger.

## 4. Production URL parity: use the real comparator

PR [#115](https://github.com/Tamloot-cc/Retainer/pull/115) was separately authorized, squash-merged and cleaned up by its agent. The classifier work did not merge it. This round imported the actual `duplicateUrlKey` from main with Node’s TypeScript stripping and verified the source matched pinned commit `c4b979677187aa1df290a3ff28adb9a920b043ff` before testing. It did not change that source file.

Forty behavior pairs covered schemes/root equivalence, protocol-relative inputs, host/path case, LinkedIn optional slashes, meaningful query values and encodings, fragments, default/nondefault ports, tracking keys, generic service roots, credentials, whitespace and non-HTTP URLs.

- **Production: 39/40 intended behaviors passed.** Remaining failure: `https://accounts.google.com` and its trailing-slash form both produce `accounts.google.com/`. That shared login-provider root should not identify a CRM entity. It is absent from the explicit shared-host set. This is a reproducible remaining provider-root case, not an observed live CRM incident.
- **Old spike prototype: 24/40 intended behaviors passed.** It produced ten incorrect false matches and six missed equivalences on this edge suite.
- There were **17 production/prototype disagreements**. The prototype dropped fragments, rewrote meaningful query encodings, applied some tracking rules too broadly, omitted several service roots and mishandled protocol-relative/default-port/profile-slash cases.

The earlier Python helper must not be treated as production-equivalent. Replaying all 352 saved matrix responses with the actual production keys for their 113 distinct URLs changed **zero publication decisions** on those recorded inputs. That preserves the existing measured figures for these fixtures; it does not validate the prototype on new URL forms.

The remaining `accounts.google.com` production case was recorded, not silently fixed during an experiment-only task. A narrow follow-up can add the known login-provider host and a consolidator regression test. More generally, any fixed service-host list has coverage limits.

## 5. Live caching and multi-question billing

Ten separate probe calls used an **artificially padded synthetic shared prefix**, with one or three questions. Their outputs were never eligible for publication. The artificial prefix exceeds the normal small-pair context budget solely to test the API cache surface; production inputs should not be padded for discounts.

| Probe | Input tokens | Cached tokens | Cache-write tokens |
| --- | ---: | ---: | ---: |
| Long prefix, first single-question call | 2,793 | 0 | 2,563 |
| Same long prefix and question | 2,793 | 2,563 | 0 |
| Same input, three questions | 3,299 | 2,563 | 0 |
| Repeated three-question call | 3,299 | 2,563 | 0 |
| Changed shared prefix, first call | 2,796 | 0 | 2,566 |
| Repeated changed prefix | 2,796 | 2,566 | 0 |
| Short prefix, first/repeat | 368 each | 0 | 0 |

Shared input cached across changed questions, but question content still added **506 input tokens** in this example. A changed prefix caused a cache miss/write; repeated short contexts did not cache. Thus repeated context and extra questions are not free. Cache-read/write counters are already part of input usage and were not added twice.

## 6. Counts, cost and verification limits

- **352 matrix + 10 cache calls = 362 successful live calls**, 362 attempts, no live retry/refusal/rate-limit/timeout/provider-error events.
- Matrix latency: **p50 214 ms / p95 278 ms**. These are local observations, not a service guarantee.
- Total observed input: **387,136 tokens**, including **15,381 cached** and **5,129 cache-write** tokens.
- Estimated cost: **$0.03746**, using the previously checked short-context rates ($0.10/M uncached, $0.01/M cache-read, $0.125/M cache-write; Decisions output uncharged). Invoice/regional charges were not verified.
- **115 local tests passed**: 15 Round 1, 24 Round 2, 18 Round 3, 15 Round 4 and 43 new Round 5 tests. Suites run in separate Python processes; Postgres test files create/drop their own databases.
- The 40 URL behavior probes are reported separately: one production behavior failed its intended expectation. Passing unit tests do not erase that finding or the unsafe legacy truncation results.
- PR #115’s final head passed its checks before merge. The merged commit’s main CI and hosted deployment workflow also completed successfully. This round did not run a write-based hosted duplicate-matching smoke test.

Still unverified: accuracy on independently adjudicated real positive pairs, the advertised maximum model context boundary, real provider outage/refusal/rate-limit behavior, invoice reconciliation, production assessment publication/invalidation races and a deployed model-proxy/extension path. Those features are not implemented by the spike.

## Decision

Keep the classifier experimental. The complete-input regression and fact-retrieval results support continued evaluation, but **publication must fail closed on incomplete context**, and future experiments must use production-consistent URL comparison. Canonicalize inputs rather than choosing favorable answers from permutations. Preserve all failed examples as regression evidence.

Real labeled positives remain the main evidence gap; the user knows none, and the bounded Team8 audits found no candidate pair to label. Do not manufacture positives from copied/same-record views, treat model outputs as ground truth, or tune against consumed holdouts. A future shadow implementation needs authorized natural examples, complete identity evidence and the safety gates above before any visible suggestion can be enabled.

## Reproduce

```sh
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 matrix.py                 # recompute from saved responses; no provider calls
python3 url_parity.py             # actual pinned main helper, read-only
python3 replay.py                 # replay with production URL keys
```

`matrix.py --live` and `cache_probe.py` require an existing operator key and refuse existing outputs. Frozen requests/results are synthetic only. The cache probe is separately versioned and cannot publish. See `results/local-tests.json`, `analysis.json`, `url-parity.json`, `normalization-replay.json`, `legacy-parser-comparison.json` and `cache-analysis.json` for machine-readable evidence.
