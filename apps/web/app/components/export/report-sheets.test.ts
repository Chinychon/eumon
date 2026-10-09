import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, resultsView, type ResultsInput } from "@organic-growth/core";
import { aiSheets, fixSheets, keywordSheets, pick, proofSheets } from "./report-sheets.ts";

const today = "2026-10-07";
const input = (series: ResultsInput["series"] = {}): ResultsInput => ({
  today, goLive: "2026-08-01", markets: [], series, index: { indexed: 4, notIndexed: 1, unchecked: 0 }, published: 5, searchConnected: true, ga4Connected: false,
});
const days = (count: number, value: number) => Array.from({ length: count }, (_, index) => ({ day: addDays(today, -count + index), value }));

describe("report sheets", () => {
  it("exports the proof as weekly clicks and the key numbers against before Eumon", () => {
    const [weeks, numbers] = proofSheets(resultsView(input({ search_clicks: days(120, 10) })));
    assert.deepEqual(weeks!.columns, ["Week starting", "Whole site", "Eumon pages", "Partial week"]);
    assert.ok(weeks!.rows.some((row) => row[1] === 70), "a full week of 10 clicks a day");
    assert.deepEqual(numbers!.rows[0], ["Google clicks", 280, 280, 280]);
  });

  it("keeps numbers as numbers", () => {
    const results = resultsView(input({ ai_fetches: days(10, 3), ai_crawler_fetches: days(10, 2), "ai_crawler_fetches.openai": days(10, 2) }));
    const fetches = pick(aiSheets(results), "AI fetches by company")[0]!;
    assert.deepEqual(fetches.rows[0], ["OpenAI", 20, null, null, null]);
  });

  it("filters findings by area, and names the site in its own visibility row", () => {
    const report = { findings: [
      { id: "1", category: "rendering", severity: "HIGH", title: "Empty HTML", summary: "s", organicImpactScore: 77 },
      { id: "2", category: "search", severity: "MEDIUM", title: "Skipped", summary: "s", organicImpactScore: 55 },
    ] } as unknown as Parameters<typeof fixSheets>[0];
    assert.deepEqual(fixSheets(report, (category) => category === "search")[0]!.rows.map((row) => row[1]), ["Skipped"]);
    const visibility = pick(keywordSheets({ asOf: null, synced: true, gapsKnown: false, top: [], gaps: [], visibility: [{ domain: "", traffic: 10, top10: 2, share: 0.25 }] }, "x.com"), "Share of visibility")[0]!;
    assert.deepEqual(visibility.rows[0], ["x.com", 10, 0.25, 2]);
  });
});
