import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePositions, questionPoints, rankingPoints, searchDayPoints, topQueries } from "./results-points.js";
import { isQuestionQuery } from "./search.js";

describe("results points", () => {
  it("sums rows of the same day, so per-country fetches merge", () => {
    const points = searchDayPoints([
      { day: "2026-10-01", clicks: 2, impressions: 100, positionWeight: 800 },
      { day: "2026-10-01", clicks: 1, impressions: 50, positionWeight: 300 },
    ], "", "@markets");
    assert.deepEqual(points, [
      { metric: "search_clicks@markets", day: "2026-10-01", value: 3 },
      { metric: "search_impressions@markets", day: "2026-10-01", value: 150 },
      { metric: "search_position_weight@markets", day: "2026-10-01", value: 1100 },
    ]);
    assert.equal(searchDayPoints([{ day: "2026-10-01", clicks: 1, impressions: 1, positionWeight: 1 }], "eumon_")[0]!.metric, "eumon_search_clicks");
  });

  it("weights a query's position by impressions across countries", () => {
    assert.deepEqual(
      mergePositions([{ query: "q", position: 2, impressions: 300, clicks: 30 }, { query: "q", position: 10, impressions: 100, clicks: 2 }]),
      [{ query: "q", position: 4, impressions: 400, clicks: 32 }],
    );
  });

  it("counts queries in each bucket and the ones that entered or left it", () => {
    const current = [{ query: "a", position: 2, impressions: 10, clicks: 0 }, { query: "b", position: 8, impressions: 10, clicks: 0 }, { query: "c", position: 30, impressions: 10, clicks: 0 }];
    const previous = [{ query: "a", position: 5, impressions: 10, clicks: 0 }, { query: "d", position: 9, impressions: 10, clicks: 0 }];
    const points = Object.fromEntries(rankingPoints(current, previous, "2026-10-05").map((point) => [point.metric, point.value]));
    assert.equal(points["queries_top3"], 1);
    assert.equal(points["queries_top3.new"], 1, "a moved into the top 3");
    assert.equal(points["queries_top10"], 2);
    assert.equal(points["queries_top10.new"], 1, "b is new; a was already in the top 10");
    assert.equal(points["queries_top10.lost"], 1, "d left");
    assert.equal(points["queries_top100"], 3);
  });

  it("ranks the top queries by clicks, each beside its previous 28 days", () => {
    const current = [
      { query: "dentist kl", clicks: 40, impressions: 900, position: 3.2 },
      { query: "braces price", clicks: 40, impressions: 1200, position: 5 },
      { query: "new query", clicks: 5, impressions: 80, position: 9 },
      { query: "no clicks", clicks: 0, impressions: 50, position: 20 },
    ];
    const previous = [{ query: "dentist kl", clicks: 25, impressions: 700, position: 4.1 }];
    assert.deepEqual(topQueries(current, previous, 3), [
      { query: "braces price", clicks: 40, impressions: 1200, position: 5, before: null },
      { query: "dentist kl", clicks: 40, impressions: 900, position: 3.2, before: { clicks: 25, impressions: 700, position: 4.1 } },
      { query: "new query", clicks: 5, impressions: 80, position: 9, before: null },
    ]);
  });

  it("counts question searches, in English, Malay and Indonesian, and leaves buying searches out", () => {
    for (const query of ["how much does an implant cost", "what is a root canal", "can i get braces at 40", "berapa harga scaling", "bagaimana cara pasang behel", "dentist open sunday?", "klinik gigi di mana"]) {
      assert.ok(isQuestionQuery(query), query);
    }
    for (const query of ["best dentist kl", "dental implant price", "invisalign vs braces", "dentist near me", "klinik gigi terbaik", "isotretinoin side effects"]) {
      assert.ok(!isQuestionQuery(query), query);
    }
    const points = questionPoints([
      { query: "how much are veneers", position: 6, impressions: 300, clicks: 9 },
      { query: "veneers price", position: 4, impressions: 900, clicks: 40 },
      { query: "is teeth whitening safe", position: 12, impressions: 120, clicks: 2 },
    ], "2026-10-04");
    assert.deepEqual(points, [
      { metric: "question_queries", day: "2026-10-04", value: 2 },
      { metric: "question_clicks", day: "2026-10-04", value: 11 },
      { metric: "question_impressions", day: "2026-10-04", value: 420 },
    ]);
  });
});
