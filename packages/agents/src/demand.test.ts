import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demandFromSnapshots } from "@organic-growth/core";
import { estimateDemand } from "./demand.js";

describe("estimateDemand", () => {
  it("rates a ranking move by its distance from page one, with impressions as demand", () => {
    assert.deepEqual(estimateDemand({ kind: "ranking", query: "q", position: 7, impressions: 120 }), { searchDemand: 120, estimatedDifficulty: 35, priced: null });
  });

  it("never rates anything harder than 100", () => {
    assert.equal(estimateDemand({ kind: "ranking", query: "q", position: 40, impressions: 1 }).estimatedDifficulty, 100);
    assert.equal(estimateDemand({ kind: "content_gap", competitorPages: 1_000_000 }).estimatedDifficulty, 100);
  });

  it("reads a competitor's page count as difficulty, with no demand figure to show", () => {
    assert.deepEqual(estimateDemand({ kind: "content_gap", competitorPages: 999 }), { searchDemand: 0, estimatedDifficulty: 75, priced: null });
  });

  it("prefers DataForSEO's volume and difficulty when the query is priced, and says so", () => {
    const demand = demandFromSnapshots([{ keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 7, clicks: 8, impressions: 900 }]);
    assert.deepEqual(estimateDemand({ kind: "ranking", query: "IVF cost Penang", position: 7, impressions: 900 }, demand), { searchDemand: 2400, estimatedDifficulty: 16, priced: "2,400 searches a month, difficulty 16 of 100 (DataForSEO)." });
    assert.deepEqual(estimateDemand({ kind: "snippet", query: "other", impressions: 50 }, demand), { searchDemand: 50, estimatedDifficulty: 10, priced: null });
  });
});
