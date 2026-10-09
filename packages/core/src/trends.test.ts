import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlDayRow } from "./server-logs.js";
import { dropFromPeak, googlebotPace, latestAverage, peakAverage } from "./trends.js";

const day = (offset: number, from = "2026-10-01") => new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
/** `values[i]` on day i from 1 Sep 2026. */
const series = (values: number[]) => values.map((value, index) => ({ day: day(index, "2026-09-01"), value }));

describe("latestAverage", () => {
  it("averages the last seven points present, so a missing day is not a zero", () => {
    const points = series([10, 20, 30, 40, 50, 60, 70, 80, 90]).filter((point) => point.day !== "2026-09-07");
    assert.deepEqual(latestAverage(points), { from: "2026-09-02", to: "2026-09-09", average: 370 / 7 }, "20..90 without 70: seven points over eight days");
    assert.equal(latestAverage([]), null);
    assert.deepEqual(latestAverage(series([5, 15]), 7), { from: "2026-09-01", to: "2026-09-02", average: 10 }, "fewer points than the window still average");
  });
});

describe("peakAverage", () => {
  it("finds the highest trailing-week average that ended at least a week before the end, and nothing under the level", () => {
    const values = [...Array(30).fill(1000), ...Array(60).fill(200)];
    const points = series(values);
    const peak = peakAverage(points, 7, 100);
    assert.deepEqual(peak, { from: "2026-09-24", to: "2026-09-30", average: 1000 }, "the last full week at 1,000");
    assert.equal(peakAverage(series(values.map((value) => value / 20)), 7, 100), null, "never reached 100 a day");
    assert.equal(peakAverage(series([1, 1, 1, 1, 1, 1, 1, 500]), 7, 100), null, "a peak inside the last week is not a peak to fall from");
    const late = peakAverage(series([...Array(20).fill(100), ...Array(7).fill(1000)]), 7, 100);
    assert.equal(late?.average, 100, "the week at 1,000 is the latest week, so it can't be the peak fallen from");
  });
});

describe("dropFromPeak", () => {
  it("names the fall from the maximum to the latest value when it is big enough", () => {
    const points = series([1700, 1774, 1561, 1561, 1200]);
    assert.deepEqual(dropFromPeak(points, 0.1, 50), { peakDay: "2026-09-02", peak: 1774, latestDay: "2026-09-05", latest: 1200, share: 0.32 });
    assert.equal(dropFromPeak(series([...Array(10).fill(1774), 1500]), 0.1, 50)?.peakDay, "2026-09-10", "a plateau's last day is when the fall began");
    assert.equal(dropFromPeak(series([1774, 1700]), 0.1, 50), null, "4% is not a fall");
    assert.equal(dropFromPeak(series([100, 60]), 0.1, 50), null, "40 pages is under the count");
    assert.equal(dropFromPeak(series([1000, 1200]), 0.1, 50), null, "a rise");
  });
});

describe("googlebotPace", () => {
  const rows = (days: number, hits: number, bot = "googlebot"): CrawlDayRow[] => Array.from({ length: days }, (_, index) => ({ day: day(-1 - index, "2026-10-09"), bot, family: "doctors", statusClass: "2xx", query: false, hits }));
  it("averages Googlebot's requests over the last 28 days ending yesterday, and needs two weeks of logs", () => {
    assert.deepEqual(googlebotPace([...rows(28, 25), ...rows(28, 400, "bingbot")], "2026-10-09"), { perDay: 25, days: 28 }, "Bingbot doesn't count");
    assert.deepEqual(googlebotPace(rows(14, 10), "2026-10-09"), { perDay: 10, days: 14 });
    assert.equal(googlebotPace(rows(13, 10), "2026-10-09"), null, "thirteen days say nothing");
    assert.equal(googlebotPace(rows(28, 25), "2026-12-09"), null, "logs that stopped two months ago say nothing about today");
    assert.deepEqual(googlebotPace([...rows(40, 20)], "2026-10-09"), { perDay: 20, days: 28 }, "older days fall outside the window");
  });
});
