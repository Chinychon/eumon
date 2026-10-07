import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePositions, rankingPoints, searchDayPoints } from "./results-points.js";

describe("results points", () => {
  it("sums rows of the same day, so per-country fetches merge", () => {
    const points = searchDayPoints([
      { day: "2026-10-01", clicks: 2, impressions: 100, positionWeight: 800 },
      { day: "2026-10-01", clicks: 1, impressions: 50, positionWeight: 300 },
    ], "", "@markets");
    assert.deepEqual(points, [
      { metric: "search_clicks@markets", day: "2026-10-01", value: 3 },
      { metric: "search_impressions@markets", day: "2026-10-01", value: 150 },
      { metric: "search_position_weight@markets", day: "2026-10-01", value: 1100 },
    ]);
    assert.equal(searchDayPoints([{ day: "2026-10-01", clicks: 1, impressions: 1, positionWeight: 1 }], "eumon_")[0]!.metric, "eumon_search_clicks");
  });

  it("weights a query's position by impressions across countries", () => {
    assert.deepEqual(mergePositions([{ query: "q", position: 2, impressions: 300 }, { query: "q", position: 10, impressions: 100 }]), [{ query: "q", position: 4, impressions: 400 }]);
  });

  it("counts queries in each bucket and the ones that entered or left it", () => {
    const current = [{ query: "a", position: 2, impressions: 10 }, { query: "b", position: 8, impressions: 10 }, { query: "c", position: 30, impressions: 10 }];
    const previous = [{ query: "a", position: 5, impressions: 10 }, { query: "d", position: 9, impressions: 10 }];
    const points = Object.fromEntries(rankingPoints(current, previous, "2026-10-05").map((point) => [point.metric, point.value]));
    assert.equal(points["queries_top3"], 1);
    assert.equal(points["queries_top3.new"], 1, "a moved into the top 3");
    assert.equal(points["queries_top10"], 2);
    assert.equal(points["queries_top10.new"], 1, "b is new; a was already in the top 10");
    assert.equal(points["queries_top10.lost"], 1, "d left");
    assert.equal(points["queries_top100"], 3);
  });
});
