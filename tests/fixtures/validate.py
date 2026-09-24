"""Validate fixture data only; never evaluate candidate source."""
import json
import math
from pathlib import Path


def reject_constant(value):
    raise ValueError(f"Non-JSON constant: {value}")


root = Path(__file__).resolve().parent
data = {
    path.name: json.loads(path.read_text(), parse_constant=reject_constant)
    for path in sorted(root.glob("*.json"))
}
assert len(data) == 5
assert all(item["fixtureVersion"] == 1 for item in data.values())
cases = data["merge-intervals.json"]["cases"]
names = {case["name"] for case in cases}
assert len(cases) == len(names) == 23
for case in cases:
    assert len(case["args"]) == 1
    assert case["assertInputUnchanged"] is True
    previous_end = None
    for interval in case["expected"]:
        assert len(interval) == 2
        assert all(type(number) in (int, float) and math.isfinite(number) for number in interval)
        start, end = interval
        assert start <= end
        assert previous_end is None or previous_end < start
        previous_end = end
weak = data["weak-self-tests.json"]
assert set(weak["independentFailureCases"]) <= names
assert isinstance(weak["source"], str)
assert len(weak["selfTests"]) == 2
special = data["merge-intervals-nonfinite.json"]["cases"]
assert len({case["name"] for case in special}) == 3
for case in special:
    replacement = case["replaceInsideRunner"]
    assert replacement["number"] in ("NaN", "Infinity", "-Infinity")
    target = case["args"]
    for index in replacement["path"]:
        target = target[index]
    assert type(target) in (int, float) and math.isfinite(target)
    assert case["expected"] == []
scenarios = data["agent-scenarios.json"]["scenarios"]
assert len({scenario["id"] for scenario in scenarios}) == 3
sentinel = data["context-sentinel.json"]
assert sentinel["sentinel"] not in sentinel["currentRelevantText"]
assert sentinel["archiveRecipe"]["minimumArchiveBytes"] > 96 * 1024
print("PASS: 5 JSON fixtures; 23 merge cases; 3 nonfinite descriptions; source NOT EXECUTED")
