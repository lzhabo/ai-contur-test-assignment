export function mergeIntervals(intervals: number[][]): number[][] {
  if (!Array.isArray(intervals)) return [];

  for (const interval of intervals) {
    if (
      !Array.isArray(interval) ||
      interval.length !== 2 ||
      typeof interval[0] !== "number" ||
      typeof interval[1] !== "number" ||
      !Number.isFinite(interval[0]) ||
      !Number.isFinite(interval[1]) ||
      interval[0] > interval[1]
    ) return [];
  }

  const sorted = intervals.map(([start, end]) => [start, end]);
  sorted.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  const merged: number[][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}