"""Paired wording comparison and single-policy, disjoint synthetic holdout."""
import copy
import json
import os
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "round7"))
import benchmark as b
from engine import publication
from safety import complete_context
from runtime import validate

FLOORS = [.5, .6, .7, .8, .85, .9]
SPLITS = {"development": (30, 90), "holdout": (100, 300)}

def make_workspace(split):
    positives, negatives = SPLITS[split]
    rng = random.Random(split + "-round8-v1")
    names = Path("/usr/share/dict/propernames").read_text().splitlines()
    records, truth, facts, hard = {}, {}, {}, []
    for i in range(positives + negatives):
        same = i < positives
        kind = ["person", "company"][i % 2]
        a, c, other = [" ".join(rng.sample(names, 2)) for _ in range(3)]
        left, right = [b.digest([split, i, side])[:16] for side in range(2)]
        if not same:
            hard.append([left, right])
        for rid, name in [(left, a), (right, c)]:
            record = {"id": rid, "name": name}
            if (i // 2) % 3 == 0:
                record["email"] = f"desk{i}@example.invalid"
            records[rid] = dict(record=record, history=[], kind=kind)
            truth[rid] = left if same else rid
            facts[rid] = []
        # Same structure on both labels: one relevant file and one distractor.
        positive = [
            f"The archive indexes {a} and {c} under one permanent identifier; both entries point to the same file.",
            f"The attached certificate for {c} lists {a} in the former-name field.",
            f"An officer reconciled the file for {a} with the file for {c} against the original registration and marked them as duplicate entries.",
        ] if split == "development" else [
            f"The custodian moved the account of {a} to the name {c}. Its original registration remains in force.",
            f"The verified alias field on the master file for {c} lists {a}.",
            f"The signed amendment replaces the registered name {a} with {c}, effective January 1.",
        ]
        negative = [
            f"{a} joined a working group chaired by {c}.",
            f"A spreadsheet described {a} as an alias of {c}. The registrar rejected that mapping after checking their separate files.",
            f"The buyer, {a}, took over a contract previously held by {c}.",
        ] if split == "development" else [
            f"Correspondence for {a} should be sent through the representative for {c}.",
            f"The directory carried a rename notice linking {a} to {c}; the subsequent erratum identifies two independent registrants.",
            f"The agreement between {a} and {c} permits both to use the same trading address.",
        ]
        sources = [(b.digest([left,right]), rng.choice(positive if same else negative)),
                   (b.digest([right,other]), f"The registry lists {other} as the former name of {c}.")]
        for key, text in sources:
            facts[right].append(dict(ref="s"+key[:12], text=text, origin="synthetic_archive"))
        if same and i % 16 == 5:
            facts[right].clear()  # count missing evidence in end-to-end recall
    return dict(records=records, truth=truth, facts=facts, hard=hard)

def request(job, variant):
    q = copy.deepcopy(job["request"])
    if variant == "revised":
        for question in q["questions"]:
            if question["name"] == "identity":
                descriptions = {
                    "same_entity": "The supplied evidence establishes that both records refer to one entity.",
                    "different_entities": "The supplied evidence establishes that the records refer to two distinct entities.",
                    "insufficient_evidence": "The supplied evidence does not resolve whether the records refer to one entity or two.",
                }
                for choice in question["choices"]:
                    choice["description"] = descriptions[choice["value"]]
            elif question["name"] == "identity_evidence":
                question["instructions"] += " Select only a source linking these two specific records to one entity. A source linking one of them to a third entity does not qualify."
    return q

def save(name, value):
    with (ROOT / name).open("x") as out:
        json.dump(value, out, ensure_ascii=False)

def evaluate(split, jobs, variants, key, budget):
    def call(item):
        j, v = item
        q = request(j, v)
        result = b.transport(q, key, budget)
        return dict(ids=j["ids"], variant=v, result=result)
    items = [(j,v) for j in jobs for v in variants]
    random.Random(split).shuffle(items)
    with (ROOT/(split+".jsonl")).open("x") as out, ThreadPoolExecutor(max_workers=8) as pool:
        rows = []
        for row in pool.map(call, items):
            out.write(json.dumps(row)+"\n")
            out.flush()
            rows.append(row)
    return rows

def score(jobs, rows, variant, floor):
    lookup = {tuple(j["ids"]):j for j in jobs}
    tp = fp = unsupported = errors = 0
    for row in rows:
        if row["variant"] != variant:
            continue
        j = lookup[tuple(row["ids"])]
        if not row["result"]["ok"]:
            errors += 1
            continue
        q = request(j,variant)
        verdict = publication(row["result"]["attempts"][-1]["body"], q, validate, floor)
        if complete_context(q) and verdict["publish"]:
            tp += j["duplicate"]
            fp += not j["duplicate"]
            unsupported += not (j["duplicate"] and verdict["evidence"] in j["refs"])
    return dict(variant=variant,floor=floor,tp=tp,fp=fp,unsupported=unsupported,errors=errors)

def main():
    key = os.environ["OPENAI_API_KEY"]
    budget = b.Budget(800,2)
    manifests = {}
    for split, (pos,neg) in SPLITS.items():
        manifest = b.build_manifest(make_workspace(split))
        assert (manifest["positives"],manifest["hard_negatives"]) == (pos,neg)
        save(split+"-manifest.json",manifest)
        manifests[split]=manifest
    save("protocol.json",dict(hashes={k:b.digest(v) for k,v in manifests.items()},
         floors=FLOORS,variants=["original","revised"],selection="Zero FP, unsupported and errors; maximize TP, then prefer higher floor, then original wording. No eligible policy stops experiment.",
         holdout_gate="80+ TP, zero FP, unsupported citations or errors",runner_hash=b.digest(Path(__file__).read_text())))
    jobs=manifests["development"]["jobs"]
    rows=evaluate("development",jobs,["original","revised"],key,budget)
    scores=[score(jobs,rows,v,f) for v in ["original","revised"] for f in FLOORS]
    save("development-scores.json",scores)
    eligible=[s for s in scores if not (s["fp"] or s["unsupported"] or s["errors"])]
    if not eligible:
        print("No eligible policy")
        return
    winner=max(eligible,key=lambda s:(s["tp"],s["floor"],s["variant"]=="original"))
    save("selected.json",winner)
    jobs=manifests["holdout"]["jobs"]
    rows=evaluate("holdout",jobs,[winner["variant"]],key,budget)
    result=score(jobs,rows,winner["variant"],winner["floor"])
    save("holdout-score.json",result)
    print(winner,result)

if __name__=="__main__":
    main()
