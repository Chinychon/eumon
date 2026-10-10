import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeKeyword, rankCountPoints, ranksView, type RankCheck } from "./ranks.js";

const today = "2026-10-07";
const day = (back: number) => new Date(Date.UTC(2026, 9, 7 - back)).toISOString().slice(0, 10);
const check = (keyword: string, back: number, position: number | null, market = "mys"): RankCheck => ({ keyword, market, day: day(back), position, url: position ? `https://x.com/${keyword}` : null, features: position ? ["ai_overview"] : [] });

describe("ranksView", () => {
  it("one day of checks: positions, no changes, counts", () => {
    const view = ranksView({ tracked: ["a", "b", "c"], markets: ["mys"], checks: [check("a", 0, 2), check("b", 0, 9), check("c", 0, null)], today });
    assert.equal(view.tracked, 3);
    assert.equal(view.checked, 3);
    assert.deepEqual([view.top3, view.top10, view.unranked], [1, 2, 1]);
    assert.equal(view.averagePosition, 5.5);
    assert.equal(view.asOf, today);
    assert.deepEqual(view.rows.map((row) => [row.keyword, row.position, row.change7.kind, row.change30.kind]), [["a", 2, "none", "none"], ["b", 9, "none", "none"], ["c", null, "none", "none"]]);
  });

  it("changes over 7 and 30 days, entered and left, best, and the series", () => {
    const checks = [check("a", 30, 8), check("a", 7, 6), check("a", 0, 3), check("b", 7, null), check("b", 0, 5), check("c", 7, 4), check("c", 0, null)];
    const view = ranksView({ tracked: ["a", "b", "c"], markets: ["mys"], checks, today });
    const a = view.rows.find((row) => row.keyword === "a")!;
    assert.deepEqual(a.change7, { kind: "up", places: 3 });
    assert.deepEqual(a.change30, { kind: "up", places: 5 });
    assert.equal(a.best, 3);
    assert.equal(a.series.length, 3);
    assert.equal(view.rows.find((row) => row.keyword === "b")!.change7.kind, "entered");
    assert.equal(view.rows.find((row) => row.keyword === "c")!.change7.kind, "left");
  });

  it("uses the last check at or before the comparison day when that day was not synced", () => {
    const view = ranksView({ tracked: ["a"], markets: ["mys"], checks: [check("a", 9, 10), check("a", 0, 4)], today });
    assert.deepEqual(view.rows[0]!.change7, { kind: "up", places: 6 });
  });

  it("ignores checks for keywords no longer tracked and markets no longer targeted, sorts ranked first", () => {
    const checks = [check("gone", 0, 1), check("a", 0, null), check("b", 0, 7), check("b", 0, 2, "sgp")];
    const view = ranksView({ tracked: ["a", "b"], markets: ["mys"], checks, today });
    assert.deepEqual(view.rows.map((row) => `${row.keyword}|${row.market}|${row.position}`), ["b|mys|7", "a|mys|null"]);
    assert.equal(view.tracked, 2);
    assert.equal(view.checked, 2);
  });

  it("a tracked keyword never checked is a row with no position and no checks", () => {
    const view = ranksView({ tracked: ["a"], markets: ["mys"], checks: [], today });
    assert.deepEqual(view.rows.map((row) => [row.keyword, row.position, row.series.length]), [["a", null, 0]]);
    assert.equal(view.checked, 0);
    assert.equal(view.asOf, null);
  });
});

describe("normalizeKeyword", () => {
  it("lower-cases and collapses whitespace", () => {
    assert.equal(normalizeKeyword("  Dental   Implants \n"), "dental implants");
  });
});

describe("rankCountPoints", () => {
  it("counts today's checks and sums ranked positions", () => {
    const points = rankCountPoints([check("a", 0, 2), check("b", 0, 9), check("c", 0, null), check("a", 1, 1)], ["a", "b", "c"], ["mys"], today);
    assert.deepEqual(Object.fromEntries(points.map((point) => [point.metric, point.value])), { tracked_checked: 3, tracked_top3: 1, tracked_top10: 2, tracked_unranked: 1, tracked_position_sum: 11 });
    assert.ok(points.every((point) => point.day === today));
  });
});
