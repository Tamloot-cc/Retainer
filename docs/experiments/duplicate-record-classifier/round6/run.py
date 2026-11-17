"""Offline safety experiment. Run with python3 round6/run.py."""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "round5"))
from matrix import assessment, bounded_request, stress_case

# Corrupt only the local completeness metadata after receiving a valid answer.
markers = [None, {}, {"facts": 0}, {"history": 0}, {"unexpected": 0}]
for value in [True, "0", -1, 0.0, None, [], {}]:
    markers.append({"facts": value, "history": 0})

counts = Counter()
for line in (ROOT / "round5/results/evaluations.jsonl").read_text().splitlines():
    row = json.loads(line)
    request = row["request"]
    body = row["result"]["attempts"][-1]["body"]
    context = json.loads(request["input"])
    for marker in markers:
        changed = {**context, "omitted": marker}
        result = assessment(body, {**request, "input": json.dumps(changed)})
        assert result["context_deferred"] and not result["publish"] and not result["explanation"]
        counts["invalid_metadata_deferred"] += 1

    if row["id"].startswith("budget-") and row["id"].endswith("/tight"):
        index = int(row["id"].split("/")[0].split("-")[1])
        forged = {**context, "omitted": {"facts": 0, "history": 0}}
        if assessment(body, {**request, "input": json.dumps(forged)})["publish"]:
            counts["false_zero_positive" if index < 4 else "false_zero_negative"] += 1

# Compare actual included source references against an independent count at
# each byte budget. Move the correcting claim between the two sort positions.
for index in range(12):
    for reverse in [False, True]:
        case = stress_case(index, duplicate=index < 4)
        if reverse:
            for fact, ref in zip(case["facts"], ["source_2", "source_1"]):
                fact["ref"] = ref
        expected = {f["ref"] for f in case["facts"]}
        for limit in range(800, 4097, 32):
            context = json.loads(bounded_request(case, limit)["input"])
            included = {f["ref"] for f in context["facts"]}
            assert context["omitted"]["facts"] == len(expected - included)
            counts["builder_checks"] += 1
            counts["builder_incomplete" if expected - included else "builder_complete"] += 1

print(json.dumps(counts, indent=2, sort_keys=True))
