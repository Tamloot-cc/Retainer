"""Freeze a synthetic workspace and evaluate every retrieved same-object pair."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from itertools import combinations
import json
import os
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT.parent / r) for r in ("round5", "round4", "round2")]
from matrix import assessment, bounded_request, digest
from safety import canonical_request
from engine import retrieve, name_identity
from retrieval import fact_mentions
from runtime import Budget, transport

def workspace():
    rng = random.Random(76119)
    names = Path("/usr/share/dict/propernames").read_text().splitlines()
    records, truth, facts, hard = {}, {}, {}, []
    for family in range(380):
        same = family < 80
        count = 3 if 70 <= family < 80 else 2
        kind = ["company", "person"][family % 2]
        labels = [" ".join(rng.sample(names, 2)) for _ in range(count)]
        shared = f"office{family}@example.invalid"
        mode = (family // 2) % 5
        group = []
        for j, label in enumerate(labels):
            rid = digest(["round7", family, j])[:16]
            group.append(rid)
            record = {"id": rid, "name": label}
            history = []
            if mode == 0 or (not same and mode == 4):
                record["email"] = shared
            if mode == 1 and j:
                record["name"] = labels[0]
            if same and mode == 2 and j:
                history.append({"field":"name","value":labels[0],"status":"superseded","ref":"prior_name"})
            records[rid] = dict(record=record, history=history, kind=kind)
            truth[rid] = group[0] if same else rid
            facts[rid] = []
        for left, right in combinations(group, 2):
            a, b = [records[i]["record"]["name"] for i in (left, right)]
            if same:
                wording = (f"The membership office verified that the files under {a} and {b} carry the same permanent member number.",
                           f"The signed change form lists {a} as the former name and {b} as the current name.",
                           f"The migration ledger maps the entry for {a} to {b} with the same registration number.")
            else:
                hard.append([left, right])
                wording = (f"{a} and {b} share an administrative inbox under a service agreement.",
                           f"The renewal for {a} was countersigned by {b} as a reference.",
                           f"A prior directory listed {a} as another name for {b}. The issuing office withdrew that entry after verifying separate registrations.",
                           f"The office forwarded mail addressed to {a} to the liaison for {b}.")
            if same and mode == 4 and count == 2:
                continue  # evidence-poor positives remain in the denominator
            facts[right].append(dict(text=rng.choice(wording), origin="synthetic_office_file",
                                     ref="s"+digest([left,right])[:12]))
    return dict(records=records, truth=truth, facts=facts, hard=hard)

def build_manifest(w):
    rows = [dict(id=i,workspace="synthetic",object=r["kind"],live=True,name=r["record"]["name"],
                 query_name=name_identity(r["record"]["name"]),record=r["record"],history=r["history"])
            for i,r in w["records"].items()]
    facts = [dict(id=f["ref"],ref=f["ref"],owner=i,workspace="synthetic",content=f["text"],
                  source_live=True,current=True,visible=True) for i,fs in w["facts"].items() for f in fs]
    def pairs(rows):
        return {(r["a"],r["b"]) for r in rows}
    current = pairs(retrieve(rows,"current",cap=100000)["candidates"])
    extended = pairs(retrieve(rows,"history",cap=100000)["candidates"])
    mentions = fact_mentions(rows,facts,cap=500)
    jobs = []
    hard = {tuple(sorted(p)) for p in w["hard"]}
    for a,b in sorted(current | extended | pairs(mentions["candidates"])):
        records = [w["records"][i] for i in (a,b)]
        case = dict(kind=records[0]["kind"],records=[r["record"] for r in records],
                    history=[r["history"] for r in records],facts=w["facts"][a]+w["facts"][b])
        request = canonical_request(bounded_request(case,8192))
        # Each generated confirmation references exactly its two source records.
        refs = ["s"+digest(order)[:12] for order in ([a,b],[b,a])]
        jobs.append(dict(ids=[a,b], baseline=(a,b) in current, duplicate=w["truth"][a]==w["truth"][b],
                         hard=(a,b) in hard, refs=refs,request=request))
    positives = sum(n*(n-1)//2 for n in __import__("collections").Counter(w["truth"].values()).values())
    data=dict(workspace=w,jobs=jobs,positives=positives,hard_negatives=len(hard),
              gates=dict(min_tp=80,max_fp=0,max_unsupported=0), fact_global_deferred=mentions["globally_deferred"])
    return data

def freeze():
    data = build_manifest(workspace())
    assert data["positives"] == 100 and data["hard_negatives"] == 300
    with (ROOT/"manifest.json").open("x") as out:
        json.dump(data,out,ensure_ascii=False,separators=(",",":"))
    print("Frozen",digest(data),len(data["jobs"]),"candidates")

def run():
    m=json.loads((ROOT/"manifest.json").read_text())
    protocol=json.loads((ROOT/"protocol.json").read_text())
    assert digest(m)==protocol["manifest_sha256"]
    key=os.environ["OPENAI_API_KEY"]
    budget=Budget(800,2)
    def evaluate(job):
        return dict(ids=job["ids"], result=transport(job["request"],key,budget))
    with (ROOT/"evaluations.jsonl").open("x") as out, ThreadPoolExecutor(max_workers=6) as workers:
        for row in workers.map(evaluate,m["jobs"]):
            out.write(json.dumps(row)+"\n")
            out.flush()

def report():
    m=json.loads((ROOT/"manifest.json").read_text())
    jobs=m["jobs"]
    for label, group in [("current",[j for j in jobs if j["baseline"]]),("extended",jobs)]:
        print(label,len(group),"positives",sum(j["duplicate"] for j in group),"hard negatives",sum(j["hard"] for j in group))
    path=ROOT/"evaluations.jsonl"
    if path.exists():
        answers={tuple(r["ids"]):r["result"] for r in map(json.loads,path.read_text().splitlines())}
        assert len(answers)==len(jobs)
        tp=fp=unsupported=errors=0
        for job in jobs:
            result=answers[tuple(job["ids"])]
            if not result["ok"]:
                errors+=1
                continue
            verdict=assessment(result["attempts"][-1]["body"],job["request"])
            if verdict["publish"]:
                tp+=job["duplicate"]
                fp+=not job["duplicate"]
                unsupported+=not (job["duplicate"] and verdict["evidence"] in job["refs"])
        print(dict(tp=tp,fp=fp,unsupported=unsupported,errors=errors,passed=tp>=80 and fp==unsupported==errors==0))

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("operation",choices=["freeze","run","report"])
    args=parser.parse_args()
    {"freeze":freeze,"run":run,"report":report}[args.operation]()
