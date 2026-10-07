import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, resultsView, weekStart, weekly, type ResultsInput } from "./results.js";

const days = (from: string, count: number, value: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => ({ day: addDays(from, index), value: value(index) }));

const base = (overrides: Partial<ResultsInput> = {}): ResultsInput => ({
  today: "2026-10-07", goLive: null, markets: [], series: {}, index: { indexed: 0, notIndexed: 0, unchecked: 0 },
  published: 0, searchConnected: true, ga4Connected: false, ...overrides,
});

describe("results math", () => {
  it("counts days and weeks from Monday", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(weekStart("2026-10-07"), "2026-10-05");
    assert.equal(weekStart("2026-10-05"), "2026-10-05");
    assert.equal(weekStart("2026-10-04"), "2026-09-28");
  });

  it("leaves empty weeks empty and marks weeks after the last complete day as partial", () => {
    const series = [{ day: "2026-09-14", value: 3 }, { day: "2026-09-15", value: 4 }, { day: "2026-10-05", value: 1 }];
    assert.deepEqual(weekly(series, "2026-09-14", "2026-10-07", "2026-10-04"), [
      { week: "2026-09-14", value: 7, partial: false },
      { week: "2026-09-21", value: null, partial: false },
      { week: "2026-09-28", value: null, partial: false },
      { week: "2026-10-05", value: 1, partial: true },
    ]);
  });

  it("compares with the 28 days before go-live, and with the previous 28 days without one", () => {
    const clicks = days("2026-06-01", 128, (index) => (index < 60 ? 1 : 3));
    const live = resultsView(base({ goLive: "2026-07-31", published: 10, series: { search_clicks: clicks } }));
    assert.equal(live.numbers.clicks.current, 84, "28 days ending three days ago, at 3 a day");
    assert.equal(live.numbers.clicks.before, 28, "28 days before go-live, at 1 a day");
    const noGoLive = resultsView(base({ series: { search_clicks: clicks } }));
    assert.equal(noGoLive.goLive, null);
    assert.equal(noGoLive.numbers.clicks.before, null, "nothing reads 'before Eumon' without a go-live");
    assert.equal(noGoLive.numbers.clicks.previous, 84);
  });

  it("derives CTR and position from summed parts, and leaves missing data null", () => {
    const view = resultsView(base({ series: {
      search_clicks: days("2026-09-01", 40, () => 2),
      search_impressions: days("2026-09-01", 40, () => 100),
      search_position_weight: days("2026-09-01", 40, () => 800),
    } }));
    assert.equal(view.search?.ctr.current, 0.02);
    assert.equal(view.search?.position.current, 8);
    assert.equal(view.numbers.leads.current, null, "no lead points is 'collecting', not 0");
    assert.equal(view.numbers.organicSessions, null, "GA4 not connected");
  });
});
