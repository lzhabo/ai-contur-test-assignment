"""Проверяет данные fixtures без выполнения исходного кода функции."""
import json
import math
from pathlib import Path


def reject_constant(value):
    """Отклоняет NaN и Infinity, которые не входят в формат JSON."""
    raise ValueError(f"Non-JSON constant: {value}")


root = Path(__file__).resolve().parent
data = {
    path.name: json.loads(path.read_text(), parse_constant=reject_constant)
    for path in sorted(root.glob("*.json"))
}
assert set(data) == {"merge-intervals.json", "weak-self-tests.json"}
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
print("PASS: 2 JSON fixtures; 23 independent merge cases; 2 self-tests; source NOT EXECUTED")
