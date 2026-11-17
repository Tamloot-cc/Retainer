# Decisions API: duplicate-record classification experiments

[Open the visual walkthrough](decisions-explained.html) for the API introduction,
request/response structures, interactive examples and measured findings.

Five experiment rounds are preserved here, including synthetic inputs, versioned
questions/protocols, raw typed responses, metrics, HTTP failure tests and runnable
harnesses. The classifier remains experimental; no production classifier was
implemented or enabled by this work.

## Results at a glance

| Round | What it tested | Report | Raw results |
| --- | --- | --- | --- |
| 1 | Access, 200 synthetic pairs, context variants, questions, caching and stability | [Report](round1-report.md) | [Typed evaluations](results/evaluations.jsonl), [initial schema errors](results/initial-schema-error-evaluations.jsonl) |
| 2 | Historical retrieval, 80 fresh stories, bounded Team8 company shadow | [Report](round2/REPORT.md) | [Evaluations](round2/results/evaluations.jsonl), [aggregate Team8 results](round2/results/team8-summary.json) |
| 3 | Evidence-aware gates, development-only selection and fresh holdout | [Report](round3/REPORT.md) | [Development](round3/results/development.jsonl), [heldout](round3/results/heldout.jsonl), [aggregate person audit](round3/results/real-audit-summary.json) |
| 4 | Postgres full-text fact-mention retrieval and semantic filtering | [Report](round4/REPORT.md) | [Evaluations](round4/results/evaluations.jsonl) |
| 5 | Comprehensive regression/stress matrix, HTTP failures and production URL parity | [Report](round5/REPORT.md) | [Matrix](round5/results/evaluations.jsonl), [cache probe](round5/results/cache-probe.json), [local tests](round5/results/local-tests.json), [URL probes](round5/results/url-parity.json) |

The main finding: complete-input results were stable, while hiding correcting
evidence caused false positive suggestions. The newest harness defers incomplete
or unknown context by default. Synthetic feasibility is established; accuracy on
independently adjudicated real positive pairs is still unverified.

Raw provider inputs/results committed here are **synthetic only**. Team8 exports
and provider responses from its bounded shadow stay outside the repo; this archive
contains their aggregate summaries and the already-known social-host regression
verdict. Credentials and private workspace fixtures are not included.

Imported from local spike commit `eb62b9e`. All saved result values and raw JSONL
responses are preserved; JSON files follow repository formatting. The relocated
archive passed 117 local tests (115 experiment tests plus two checkout-boundary
checks). Private-export guards and the production URL probe locate the repo
without assuming a machine path or directory depth.

## Reproduce locally

Use Python 3, Node with TypeScript stripping, and local `docker-postgres-1` for
Postgres tests. No new provider calls are needed to inspect the saved results.

```sh
python3 -m unittest discover -s . -p 'test_*.py' -v
python3 -m unittest discover -s round2 -p 'test_*.py' -v
python3 -m unittest discover -s round3 -p 'test_*.py' -v
python3 -m unittest discover -s round4 -p 'test_*.py' -v
python3 -m unittest discover -s round5 -p 'test_*.py' -v
python3 round5/matrix.py
python3 round5/url_parity.py
python3 round5/replay.py
```

The URL replay explicitly pins the production helper to the recorded commit; it
refuses to silently substitute a changed helper. For future live experiments,
use the hardened Round 5 runtime/safety helpers, an existing operator-supplied
`OPENAI_API_KEY` and a fresh result location. Existing results must not be
overwritten. Older runners are versioned archives, not production components.

The linked [feature spec](../../specs/duplicate-record-classifier.md) records
remaining gates and the proposed architecture. API details were checked against
the [official guide](https://developers.openai.com/api/docs/guides/decisions) and
[request/response reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
