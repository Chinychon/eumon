import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Opportunity, RankCheck, SearchMetricRow } from "@organic-growth/core";
import { findingsFromRanks, rankOpportunities, type RankSignals } from "./rank-findings.js";

const today = "2026-10-07";
const day = (back: number) => new Date(Date.UTC(2026, 9, 7 - back)).toISOString().slice(0, 10);
const series = (keyword: string, positions: Array<number | null>, market = "mys"): RankCheck[] =>
  positions.map((position, index) => ({ keyword, market, day: day(positions.length - 1 - index), position, url: position ? `https://x.com/${position <= 5 ? "a" : "b"}` : null, features: position && position > 8 ? ["ai_overview"] : [] }));
const signals = (checks: RankCheck[], tracked = ["kw"]): RankSignals => ({ tracked, markets: ["mys"], checks, today });
const run = (checks: RankCheck[], tracked?: string[]) => findingsFromRanks({ siteId: "s", analysisId: "a", ranks: signals(checks, tracked) });

describe("findingsFromRanks", () => {
  it("a fall of five or more places from a 30-day best of 20 or better, with the day and the pages then and now", () => {
    const findings = run(series("kw", [4, 4, 4, 5, 7, 9, 10, 10]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, `“kw” fell from 4 to 10 in Malaysia since ${day(4)}`);
    assert.equal(findings[0]!.category, "search");
    assert.match(findings[0]!.summary, /\/a .*\/b/s);
    assert.match(findings[0]!.summary, /AI Overview/);
    assert.equal(findings[0]!.organicImpactScore, 35 + 2 * 6);
  });

  it("dropping out of the ten after holding a position seven days or more", () => {
    const findings = run(series("kw", [2, 2, 2, 2, 2, 2, 2, 3, null, null]));
    assert.equal(findings[0]!.title, `“kw” dropped out of the top 10 in Malaysia since ${day(1)}`);
    assert.equal(findings[0]!.organicImpactScore, Math.min(80, 35 + 2 * 9 + 15));
  });

  it("a stable series, a small fall, a fall from a weak best, a short hold before leaving, and a single check give nothing", () => {
    assert.equal(run(series("kw", [5, 5, 5, 5])).length, 0);
    assert.equal(run(series("kw", [5, 5, 5, 9])).length, 0);
    assert.equal(run(series("kw", [null, null, 10, 10, 10, 10, 10, 10, 10, 10])).length, 0, "no fall: the best is 10, now 10");
    assert.equal(run(series("kw", [3, 3, null])).length, 0, "held only two days");
    assert.equal(run(series("kw", [3])).length, 0);
  });

  it("keeps a drop-out while the keyword is still out: forty days after leaving, having held 2 for twenty days", () => {
    const findings = run(series("kw", [...Array<number>(20).fill(2), ...Array<null>(41).fill(null)]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, `“kw” dropped out of the top 10 in Malaysia since ${day(40)}`);
  });

  it("keeps a fall while the keyword is still down: from 3 to 9 forty days ago and still 9", () => {
    const findings = run(series("kw", [...Array<number>(20).fill(3), ...Array<number>(41).fill(9)]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, `“kw” fell from 3 to 9 in Malaysia since ${day(40)}`);
  });

  it("a fall that recovered to within four places of its best gives nothing", () => {
    assert.equal(run(series("kw", [...Array<number>(20).fill(3), ...Array<number>(20).fill(9), ...Array<number>(10).fill(7)])).length, 0);
  });

  it("no finding for an untracked keyword; at most five, biggest falls first", () => {
    assert.equal(run(series("gone", [1, 1, 1, 9]), ["kw"]).length, 0);
    const many = Array.from({ length: 7 }, (_, index) => series(`k${index}`, [1, 1, 1, 2 + index + 5]));
    const findings = findingsFromRanks({ siteId: "s", analysisId: "a", ranks: signals(many.flat(), many.map((_, index) => `k${index}`)) });
    assert.equal(findings.length, 5);
    assert.ok(findings[0]!.organicImpactScore >= findings[4]!.organicImpactScore);
  });
});

describe("rankOpportunities", () => {
  const row = (query: string, position: number, impressions = 300): SearchMetricRow => ({ query, page: "https://x.com/p", country: "mys", device: "desktop", impressions, clicks: 5, ctr: 0.02, position });
  const existing = (query: string): Opportunity => ({ id: "o", siteId: "s", analysisId: "a", title: `Move “${query}” onto the first results (now position 12.0)`, searchDemand: 1, intent: "x", competitorStrength: 0, estimatedDifficulty: 1, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 1, priorityScore: 1, rationale: "" });

  it("a tracked keyword not in the ten with a Search Console average of 30 or better, unless an opportunity already names it", () => {
    const ranks = signals(series("kw", [null, null]));
    const made = rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 14)], existing: [] });
    assert.equal(made.length, 1);
    assert.match(made[0]!.title, /“kw”/);
    assert.equal(made[0]!.currentRank, 14);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 14)], existing: [existing("kw")] }).length, 0);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks, searchMetrics: [row("kw", 44)], existing: [] }).length, 0);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks: signals(series("kw", [null, 7])), searchMetrics: [row("kw", 14)], existing: [] }).length, 0, "ranked today");
  });
  it("keeps markets apart: rows and opportunities are per market", () => {
    const two = { tracked: ["kw"], markets: ["mys", "sgp"], today, checks: [...series("kw", [null, null], "mys"), ...series("kw", [null, null], "sgp")] };
    const sgp = { ...row("kw", 12), country: "sgp" };
    const one = rankOpportunities({ siteId: "s", analysisId: "a", ranks: two, searchMetrics: [sgp], existing: [] });
    assert.equal(one.length, 1);
    assert.match(one[0]!.title, /Singapore/);
    assert.equal(rankOpportunities({ siteId: "s", analysisId: "a", ranks: two, searchMetrics: [row("kw", 14), sgp], existing: [] }).length, 2);
  });
});
