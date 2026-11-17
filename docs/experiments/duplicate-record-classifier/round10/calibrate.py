"""Select one source cutoff on development and score one untouched workspace."""
import importlib.util
import json
import os
import random
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("round9", ROOT.parent / "round9/run.py")
r9 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r9)
r8 = r9.previous
b = r9.b
FLOORS = [.50, .55, .60, .65, .70, .75, .80, .85, .90, .95, .99]

def save(filename, data):
    with (ROOT / filename).open("x") as stream:
        json.dump(data, stream, ensure_ascii=False)

def make_manifest(split, positives, negatives):
    seed = "round10-" + split
    rng = random.Random(seed)
    r8.SPLITS[seed] = (positives, negatives)
    workspace = r8.make_workspace(seed)
    records = workspace["records"]
    ids = list(records)
    for index, (left, right) in enumerate(zip(ids[::2], ids[1::2], strict=True)):
        facts = workspace["facts"][right]
        if not facts:
            continue
        a, c = (records[i]["record"]["name"] for i in (left, right))
        tag = f"R-{10000 + index}"
        if split == "development":
            pos = [
                f"The renewal for {c} retains registration {tag} from the file under {a}. No change of holder was recorded.",
                f"The verified identity table identifies {a} as a previous legal name of {c}.",
                f"The clerk consolidated the {a} and {c} files after matching their original enrolment number.",
                f"Name correction on certificate {tag}: replace {a} with {c}. All other holder particulars stand.",
            ]
            neg = [
                f"The renewal went to {c} after {a} assigned its rights. The old file number was retained.",
                f"The directory listed {a} as an alias of {c}; the correction withdrew that claim.",
                f"The application for {a} names {c} as its accountant.",
                f"The payroll reference for {a} and {c} is the same because both use a single administrator.",
            ]
        else:
            pos = [
                f"At the holder's request the registrar reissued {a}'s certificate as {c}. The register shows an uninterrupted holder history.",
                f"Cross-reference on the certified extract for {c}: also registered under the former name {a}.",
                f"The custodian verified the legacy entry for {a} against {c}'s permanent identity number and marked both files as one registrant.",
                f"The amendment for entry {tag} changes the holder's spelling from {a} to {c} without transferring title.",
            ]
            neg = [
                f"Title to {tag} passed from {a} to successor {c}. The certificate number did not change.",
                f"The filing initially called {a} a former name of {c}. A supplemental filing identifies the two as separate parties.",
                f"The intake sheet names {a} as the authorised signatory for {c}.",
                f"The archive cross-references {a} and {c} because of a shared mailing address. Identity verification is pending.",
            ]
        facts[0]["text"] = rng.choice(pos if workspace["truth"][left] == workspace["truth"][right] else neg)
    manifest = b.build_manifest(workspace)
    assert (manifest["positives"], manifest["hard_negatives"]) == (positives, negatives)
    return manifest

def collect(split, jobs, key, budget):
    def evaluate(job):
        base = b.transport(job["request"], key, budget)
        q = r9.source_request(job)
        links = b.transport(q, key, budget) if q["questions"] else None
        return dict(ids=job["ids"], base=base, links=links)

    with (ROOT / f"{split}.jsonl").open("x") as out, ThreadPoolExecutor(max_workers=8) as pool:
        for row in pool.map(evaluate, jobs):
            out.write(json.dumps(row) + "\n")
            out.flush()

def score(manifest, rows, floor):
    tp = fp = unsupported = errors = 0
    for job, row in zip(manifest["jobs"], rows, strict=True):
        assert row["ids"] == job["ids"]
        if not row["base"]["ok"] or (row["links"] and not row["links"]["ok"]):
            errors += 1
            continue
        if not row["links"]:
            continue
        q = job["request"]
        body = row["base"]["attempts"][-1]["body"]
        v = r8.publication(body, q, r8.validate, .5)
        label = r8.validate(body,q)["identity"]["choice"]
        if label == "different_entities" or v["conflict"] or v["distinct"] >= .1 or not r8.complete_context(q):
            continue
        answers = r8.validate(row["links"]["attempts"][-1]["body"], r9.source_request(job))
        facts = json.loads(q["input"])["facts"]
        probability, ref = max((answers[f"link_{i}"]["probability"], f["ref"]) for i,f in enumerate(facts))
        if probability >= floor:
            tp += job["duplicate"]
            fp += not job["duplicate"]
            unsupported += not (job["duplicate"] and ref in job["refs"])
    return dict(floor=floor, tp=tp, fp=fp, unsupported=unsupported, errors=errors)

def read_rows(split):
    return [json.loads(line) for line in (ROOT/f"{split}.jsonl").read_text().splitlines()]

def main():
    key = os.environ["OPENAI_API_KEY"]
    budget = b.Budget(1250, 2)
    dev = make_manifest("development", 40, 120)
    hold = make_manifest("holdout", 100, 300)
    assert set(dev["workspace"]["records"]).isdisjoint(hold["workspace"]["records"])
    save("development-manifest.json", dev)
    save("holdout-manifest.json", hold)
    save("protocol.json", dict(development=b.digest(dev), holdout=b.digest(hold), runner=b.digest(Path(__file__).read_text()),
        floors=FLOORS, selection="Zero false suggestions, unsupported sources and errors; maximize true suggestions then choose highest tied threshold.",
        gate="80/100 true suggestions; zero false suggestions, unsupported sources and errors. Otherwise park."))
    collect("development",dev["jobs"],key,budget)
    rows = read_rows("development")
    scores = [score(dev,rows,f) for f in FLOORS]
    save("development-scores.json", scores)
    valid = [s for s in scores if s["fp"] == s["unsupported"] == s["errors"] == 0]
    if not valid:
        print("No eligible development threshold; park.")
        return
    chosen = max(valid,key=lambda s:(s["tp"],s["floor"]))
    save("selected.json", chosen)
    collect("holdout",hold["jobs"],key,budget)
    result = score(hold,read_rows("holdout"),chosen["floor"])
    save("result.json",result)
    print(chosen,result)

if __name__ == "__main__":
    main()
