import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertMetricPoints, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { loadTrendSignals } from "./trend-signals.js";

describe("loadTrendSignals", () => {
  it("reads 120 days of impressions and prefers Search Console's indexed count over the inspection sample", async () => {
    const db = openSqliteD1();
    const at = "2026-10-01T00:00:00.000Z";
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await upsertMetricPoints(db, "s", [
      { metric: "search_impressions", day: "2026-06-01", value: 5 }, { metric: "search_impressions", day: "2026-09-01", value: 900 },
      { metric: "search_impressions", day: "2026-10-06", value: 300 }, { metric: "search_impressions", day: "2026-10-07", value: 120 }, { metric: "search_impressions", day: "2026-10-08", value: 40 },
      { metric: "pages_indexed", day: "2026-10-08", value: 1500 }, { metric: "pages_not_indexed", day: "2026-10-08", value: 30 }, { metric: "gsc_indexed", day: "2026-09-22", value: 1561 },
    ]);
    const trends = await loadTrendSignals(db, "s", [], "2026-10-09");
    assert.deepEqual(trends.impressions.map((point) => point.day), ["2026-09-01", "2026-10-06"], "June is outside 120 days; Google's last two days are still filling in");
    assert.deepEqual(trends, { ...trends, indexed: [{ day: "2026-09-22", value: 1561 }], indexedSource: "search_console", notIndexed: [], today: "2026-10-09" });
    const sample = await loadTrendSignals(db, "other", [], "2026-10-09");
    assert.deepEqual([sample.indexed, sample.indexedSource], [[], null]);
    await upsertSite(db, { id: "t", name: "y.com", baseUrl: "https://y.com", createdAt: at, updatedAt: at });
    await upsertMetricPoints(db, "t", [{ metric: "pages_indexed", day: "2026-10-08", value: 500 }, { metric: "pages_not_indexed", day: "2026-10-08", value: 20 }]);
    const inspection = await loadTrendSignals(db, "t", [], "2026-10-09");
    assert.deepEqual([inspection.indexedSource, inspection.indexed.length, inspection.notIndexed.length], ["inspection", 1, 1], "the sample, with what Google left out");
  });
});
