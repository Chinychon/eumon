import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SearchMetricRow } from "@organic-growth/core";
import { analyzeSearch, findingsFromSearch, searchOpportunities } from "./search.js";

const row = (query: string, page: string, country: string, impressions: number, clicks: number, position: number): SearchMetricRow =>
  ({ query, page, country, device: "MOBILE", impressions, clicks, ctr: clicks / impressions, position });

// The brief's example: Malaysians looking up doctors by name; Indonesian patients (the market) barely visible.
const rows: SearchMetricRow[] = [
  row("dr amy tan", "https://medbay.example/doctors/amy-tan", "mys", 3000, 300, 2),
  row("amy tan cardiologist", "https://medbay.example/doctors/amy-tan", "mys", 1200, 90, 3),
  row("dr ben lim", "https://medbay.example/doctors/ben-lim", "mys", 2500, 240, 2),
  row("biaya ivf malaysia", "https://medbay.example/treatments/ivf", "idn", 400, 4, 12),
  row("ivf cost penang", "https://medbay.example/treatments/ivf", "mys", 900, 8, 7),
  row("best hospital penang", "https://medbay.example/hospitals", "mys", 800, 2, 4),
  row("best hospital penang", "https://medbay.example/hospitals/penang", "mys", 600, 3, 9),
  row("heart surgery penang", "https://medbay.example/treatments/heart", "mys", 500, 4, 8),
  row("heart surgery penang", "https://medbay.example/blog/heart", "mys", 450, 2, 11),
  row("lasik price", "https://medbay.example/treatments/lasik", "mys", 300, 1, 9),
  row("lasik price", "https://medbay.example/blog/lasik", "mys", 280, 2, 12),
  row("medbay", "https://medbay.example/", "mys", 200, 120, 1),
];

describe("analyzeSearch", () => {
  const insights = analyzeSearch(rows, {
    brandTerms: ["medbay"],
    targetMarkets: ["idn"],
    entityKeys: [{ key: "amy-tan", entityType: "doctor" }, { key: "ben-lim", entityType: "doctor" }, { key: "ivf", entityType: "treatment" }],
  });

  it("measures how much visibility comes from the target market", () => {
    assert.ok(insights.targetShare!.impressions < 0.05, String(insights.targetShare!.impressions));
    assert.equal(insights.countries[0]?.name, "Malaysia");
    assert.ok(insights.narrative.includes("Your target market (Indonesia) accounts for 4% of impressions"), insights.narrative);
  });

  it("recognizes searches that name a specific record", () => {
    assert.ok(insights.entityQueries!.share > 0.7, String(insights.entityQueries!.share));
    assert.equal(insights.entityQueries!.byType[0]?.entityType, "doctor");
    assert.equal(insights.entityQueries!.byType[0]?.examples[0], "dr amy tan");
    assert.ok(insights.commercialShare < 0.1);
  });

  it("finds striking-distance queries, skipped snippets, and competing pages", () => {
    assert.ok(insights.strikingDistance.some((entry) => entry.query === "ivf cost penang"));
    assert.equal(insights.strikingDistance.some((entry) => entry.query === "medbay"), false, "branded queries are excluded");
    assert.ok(insights.lowCtrPages.some((page) => page.page.endsWith("/hospitals")), JSON.stringify(insights.lowCtrPages.map((page) => page.page)));
    assert.deepEqual(insights.cannibalized.map((entry) => entry.query).sort(), ["best hospital penang", "heart surgery penang", "lasik price"]);
    assert.ok(insights.commercialGaps.some((entry) => entry.query === "biaya ivf malaysia"), "an Indonesian cost query beyond page one");
  });

  it("turns them into findings and opportunities an analyst would raise", () => {
    const findings = findingsFromSearch(insights, "s", "a");
    const titles = findings.map((finding) => finding.title);
    assert.ok(titles.includes("Most search visibility comes from outside your target market"), titles.join(" | "));
    assert.ok(titles.includes("Search traffic is mostly people looking up a doctor by name"));
    assert.ok(titles.includes("Several pages compete for the same searches"));
    const market = findings.find((finding) => finding.title.startsWith("Most search visibility"))!;
    assert.ok(["CRITICAL", "HIGH"].includes(market.severity), market.severity);
    const opportunities = searchOpportunities(insights, "s", "a");
    assert.ok(opportunities.some((opportunity) => opportunity.title.includes("ivf cost penang")));
    assert.ok(opportunities.some((opportunity) => opportunity.intent === "snippet"));
  });

  it("asks for target markets when none are set", () => {
    const plain = analyzeSearch(rows, { brandTerms: ["medbay"] });
    assert.equal(plain.targetShare, null);
    assert.ok(plain.narrative.includes("of impressions come from Malaysia; set your target markets"), plain.narrative);
    assert.equal(findingsFromSearch(plain, "s", "a").some((finding) => finding.title.startsWith("Most search visibility")), false);
  });
});
