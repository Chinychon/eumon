import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeywordsInput } from "@organic-growth/core";
import { buildOpportunities, gapOpportunities, synthesizeGrowthPlan } from "./index.js";

const keywords: KeywordsInput = {
  site: "x.com", competitors: ["rival.example"], synced: true,
  priced: [{ periodEnd: "2026-10-06", rows: [{ keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 7, clicks: 8, impressions: 900 }] }],
  ranked: [{ domain: "rival.example", periodEnd: "2026-10-09", rows: [
    { keyword: "dj stent di penang", volume: 5400, difficulty: 0, intent: "transactional", position: 15, url: "/prosedur-pasang-dj-stent-di-penang/", traffic: 60 },
    { keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational", position: 10, url: "/gagal-jantung/", traffic: 400 },
    { keyword: "too hard", volume: 9000, difficulty: 70, intent: "commercial", position: 2, url: "/hard", traffic: 900 },
    { keyword: "too small", volume: 40, difficulty: 1, intent: "commercial", position: 1, url: "/small", traffic: 20 },
    { keyword: "ivf cost penang", volume: 2400, difficulty: 16, intent: "commercial", position: 3, url: "/ivf", traffic: 300 },
  ] }],
};

describe("gap opportunities", () => {
  it("turns the biggest reachable gaps into pages to build, commercial intent first", () => {
    const gaps = gapOpportunities([
      { keyword: "dj stent di penang", volume: 5400, difficulty: 0, intent: "transactional", domain: "rival.example", position: 15, url: "/prosedur-pasang-dj-stent-di-penang/" },
      { keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational", domain: "rival.example", position: 10, url: "/gagal-jantung/" },
      { keyword: "too hard", volume: 9000, difficulty: 70, intent: "commercial", domain: "rival.example", position: 2, url: "/hard" },
      { keyword: "too small", volume: 40, difficulty: 1, intent: "commercial", domain: "rival.example", position: 1, url: "/small" },
      { keyword: "rival clinic", volume: 6000, difficulty: 0, intent: "navigational", domain: "rival.example", position: 1, url: "/" },
    ], "s", "a");
    assert.deepEqual(gaps.map((gap) => gap.title), [
      "Rank for “dj stent di penang”: 5,400 searches a month; rival.example ranks 15",
      "Rank for “chf adalah”: 12,100 searches a month; rival.example ranks 10",
    ], "a competitor's own name (navigational) is not a page to build");
    assert.equal(gaps[0]!.intent, "keyword_gap");
    assert.equal(gaps[0]!.searchDemand, 5400);
    assert.equal(gaps[0]!.potentialPage, "https://rival.example/prosedur-pasang-dj-stent-di-penang/");
    assert.ok(gaps[0]!.priorityScore > gaps[1]!.priorityScore, "commercial intent outranks a bigger informational gap");
  });

  it("joins the growth plan with its own copy, and prices striking-distance queries from the lists", () => {
    const bundle = {
      siteId: "s", analysisId: "a", baseUrl: "https://x.com", findings: [], competitors: [], keywords,
      searchMetrics: [{ query: "ivf cost penang", page: "https://x.com/ivf", country: "mys", device: "MOBILE", impressions: 900, clicks: 8, ctr: 0.009, position: 7 }],
    };
    const opportunities = buildOpportunities(bundle);
    const striking = opportunities.find((opportunity) => opportunity.title.includes("ivf cost penang"))!;
    assert.equal(striking.searchDemand, 2400);
    assert.ok(striking.rationale.includes("2,400 searches a month"), striking.rationale);
    assert.ok(opportunities.some((opportunity) => opportunity.intent === "keyword_gap" && opportunity.title.includes("dj stent")), "the gap the site doesn't rank for");
    assert.ok(!opportunities.some((opportunity) => opportunity.intent === "keyword_gap" && opportunity.title.includes("ivf cost penang")), "a keyword the site ranks for is no gap");
    const plan = synthesizeGrowthPlan(bundle);
    const priority = plan.priorities.find((entry) => entry.title.includes("dj stent"))!;
    assert.ok(priority.implementationRequired.includes("landing page"), priority.implementationRequired);
    assert.ok(priority.contentRequired.includes("rival.example"), priority.contentRequired);
  });
});
