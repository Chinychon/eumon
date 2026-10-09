import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateDemand } from "./demand.js";

describe("estimateDemand", () => {
  it("rates a ranking move by its distance from page one, with impressions as demand", () => {
    assert.deepEqual(estimateDemand({ kind: "ranking", position: 7, impressions: 120 }), { searchDemand: 120, estimatedDifficulty: 35 });
  });

  it("never rates anything harder than 100", () => {
    assert.equal(estimateDemand({ kind: "ranking", position: 40, impressions: 1 }).estimatedDifficulty, 100);
    assert.equal(estimateDemand({ kind: "content_gap", competitorPages: 1_000_000 }).estimatedDifficulty, 100);
  });

  it("reads a competitor's page count as difficulty, with no demand figure to show", () => {
    assert.deepEqual(estimateDemand({ kind: "content_gap", competitorPages: 999 }), { searchDemand: 0, estimatedDifficulty: 75 });
  });
});
