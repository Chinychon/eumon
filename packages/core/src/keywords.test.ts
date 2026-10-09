import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demandFromSnapshots, keywordGaps, keywordsView, type KeywordsInput, type PricedKeyword, type RankedKeyword } from "./keywords.js";
import { METRICS, resultsView } from "./results.js";

const priced = (keyword: string, volume: number | null, clicks: number, extra: Partial<PricedKeyword> = {}): PricedKeyword =>
  ({ keyword, volume, difficulty: 20, intent: "commercial", position: 8, clicks, impressions: clicks * 20, ...extra });
const ranked = (keyword: string, volume: number, position: number, extra: Partial<RankedKeyword> = {}): RankedKeyword =>
  ({ keyword, volume, difficulty: 10, intent: "commercial", position, url: `/${keyword.replace(/ /g, "-")}`, traffic: volume / position, ...extra });

const input: KeywordsInput = {
  site: "x.com", competitors: ["rival.example", "other.example"], synced: true,
  priced: [
    { periodEnd: "2026-10-06", rows: [priced("dentist kl", 1900, 40), priced("braces price", 2400, 30)] },
    { periodEnd: "2026-10-06", rows: [priced("dentist kl", 880, 5), priced("invisalign sg", null, 12)] },
  ],
  ranked: [
    { domain: "x.com", periodEnd: "2026-10-09", rows: [ranked("x clinic", 100, 1)] },
    { domain: "rival.example", periodEnd: "2026-10-09", rows: [ranked("veneers price", 3600, 3), ranked("dentist kl", 1900, 2), ranked("x clinic", 100, 9)] },
    { domain: "other.example", periodEnd: "2026-10-09", rows: [ranked("veneers price", 3600, 7), ranked("root canal cost", 590, 4)] },
  ],
};

describe("keyword gaps", () => {
  it("lists competitor keywords the site appears for nowhere, best-placed competitor first, by volume", () => {
    assert.deepEqual(keywordGaps(input).map((gap) => [gap.keyword, gap.domain, gap.position]), [["veneers price", "rival.example", 3], ["root canal cost", "other.example", 4]]);
  });
});

describe("keywordsView", () => {
  const view = keywordsView(input);
  it("keeps one row per keyword across markets, the higher volume, ordered by clicks", () => {
    assert.deepEqual(view.top.map((row) => [row.keyword, row.volume, row.clicks]), [["dentist kl", 1900, 40], ["braces price", 2400, 30], ["invisalign sg", null, 12]]);
  });
  it("dates the card by the newest list", () => {
    assert.equal(view.asOf, "2026-10-09");
    assert.equal(keywordsView({ ...input, priced: [], ranked: [], synced: false }).asOf, null);
  });
  it("knows whether any competitor list has keywords, so an empty gap list isn't mistaken for a clean sweep", () => {
    assert.equal(view.gapsKnown, true);
    assert.equal(keywordsView({ ...input, ranked: [{ domain: "rival.example", periodEnd: "2026-10-09", rows: [] }] }).gapsKnown, false);
  });
});

describe("demandFromSnapshots", () => {
  it("answers a query with its highest volume across markets, and null for an unknown one", () => {
    const demand = demandFromSnapshots(input.priced.flatMap((list) => list.rows));
    assert.deepEqual(demand.lookup("Dentist KL"), { volume: 1900, difficulty: 20, intent: "commercial" });
    assert.equal(demand.lookup("never seen"), null);
  });
});

describe("resultsView keywords", () => {
  it("shares visibility by estimated traffic, you first, and declares the keyword metrics", () => {
    const today = "2026-10-09";
    const view = resultsView({
      today, goLive: null, markets: ["mys"], published: 0, index: { indexed: 0, notIndexed: 0, unchecked: 0 }, searchConnected: true, ga4Connected: false,
      competitors: ["rival.example"], keywords: { ...input, competitors: ["rival.example"] },
      series: { kw_traffic: [{ day: today, value: 100 }], "kw_traffic:rival.example": [{ day: today, value: 300 }], kw_top10: [{ day: today, value: 2 }], "kw_top10:rival.example": [{ day: today, value: 40 }] },
    });
    assert.deepEqual(view.keywords.visibility, [
      { domain: "x.com", traffic: 100, top10: 2, share: 0.25 },
      { domain: "rival.example", traffic: 300, top10: 40, share: 0.75 },
    ]);
    assert.equal(view.keywords.gaps[0]!.keyword, "veneers price");
    for (const metric of ["sync.competitor_keywords", "sync.keyword_volumes", "kw_top10", "kw_traffic"]) assert.ok(METRICS.keywords.includes(metric), metric);
  });
});
