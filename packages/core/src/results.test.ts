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

  it("starts at the first full week, so history never opens on a part-week", () => {
    const series = [{ day: "2026-09-16", value: 2 }, { day: "2026-09-21", value: 5 }];
    assert.deepEqual(weekly(series, "2026-09-16", "2026-09-27", "2026-09-27"), [{ week: "2026-09-21", value: 5, partial: false }]);
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

  it("says the section is scoped to markets only when the market series is the one shown", () => {
    const clicks = days("2026-09-01", 40, () => 2);
    assert.equal(resultsView(base({ markets: ["mys"], series: { search_clicks: clicks } })).search?.scoped, false, "markets set, no market history yet");
    assert.equal(resultsView(base({ markets: ["mys"], series: { search_clicks: clicks, "search_clicks@markets": clicks } })).search?.scoped, true);
  });

  it("adds the top queries, Googlebot fetches, and the day enquiry tracking began", () => {
    const days = (from: string, n: number, value: number) => Array.from({ length: n }, (_, index) => ({ day: addDays(from, index), value }));
    const rows = [{ query: "q", clicks: 3, impressions: 40, position: 6, before: null }];
    const view = resultsView(base({
      series: { search_clicks: days("2026-09-01", 30, 1), googlebot_fetches: days("2026-09-20", 17, 2), leads: days("2026-09-25", 12, 0) },
      topQueries: { periodEnd: "2026-10-04", rows },
    }));
    assert.deepEqual(view.search?.topQueries, { periodEnd: "2026-10-04", rows });
    assert.equal(view.numbers.googlebot.current, 34, "two a day for the 17 days in the last 28");
    assert.equal(view.numbers.leadsSince, "2026-09-25");
    assert.equal(resultsView(base()).numbers.leadsSince, null);
  });

  it("reports AI fetches per engine, referrals per assistant, and leads by source, null before anything is counted", () => {
    const empty = resultsView(base());
    assert.equal(empty.ai.since, null);
    assert.equal(empty.ai.engines[0]!.crawler.current, null);
    assert.equal(empty.ai.leadsBySource, null);
    assert.equal(empty.ai.ga4, null);
    assert.equal(empty.ai.questions, null);
    const view = resultsView(base({ series: {
      ai_fetches: days("2026-09-20", 17, () => 3),
      ai_crawler_fetches: days("2026-09-20", 17, () => 2),
      ai_live_fetches: days("2026-09-20", 17, () => 1),
      "ai_crawler_fetches.openai": days("2026-09-20", 17, () => 2),
      "ai_live_fetches.perplexity": days("2026-09-20", 17, () => 1),
      "ai_referral_visits.chatgpt": [{ day: "2026-10-01", value: 4 }],
      "leads_eumon.ai": [{ day: "2026-10-02", value: 1 }],
      "leads_eumon.search": [{ day: "2026-10-02", value: 3 }],
      question_queries: [{ day: "2026-10-04", value: 12 }],
      question_clicks: [{ day: "2026-10-04", value: 40 }],
      question_impressions: [{ day: "2026-10-04", value: 900 }],
      ai_crawlers_allowed: [{ day: "2026-10-03", value: 14 }],
      ai_crawlers_checked: [{ day: "2026-10-03", value: 18 }],
    } }));
    assert.equal(view.ai.since, "2026-09-20");
    assert.equal(view.ai.engines.find((entry) => entry.engine === "openai")!.crawler.current, 34, "17 days at 2, within the 28 days to yesterday");
    assert.equal(view.ai.engines.find((entry) => entry.engine === "perplexity")!.live.current, 17);
    assert.equal(view.ai.engines.find((entry) => entry.engine === "meta")!.crawler.current, null);
    assert.equal(view.ai.weeks[0]!.week, "2026-09-21", "weeks start at the first full week after counting began");
    assert.equal(view.ai.referrals.byAssistant.find((entry) => entry.assistant === "chatgpt")!.visits, 4);
    assert.deepEqual(view.ai.leadsBySource, { search: 3, ai: 1, other: 0 });
    assert.deepEqual(view.ai.questions, { queries: 12, clicks: 40, impressions: 900, day: "2026-10-04" });
    assert.deepEqual(view.ai.crawlersAllowed, { allowed: 14, checked: 18 });
  });

  it("reports speed per form factor with ratings, lab scores, and authority for current competitors", () => {
    const view = resultsView(base({
      competitors: ["rival.example", "new.example"],
      series: {
        "sync.crux": [{ day: "2026-10-05", value: 6 }],
        "crux_lcp_p75.phone": [{ day: "2026-09-26", value: 7763 }, { day: "2026-10-03", value: 7012 }],
        "crux_lcp_p75.desktop": [{ day: "2026-10-03", value: 2100 }],
        "crux_cls_p75.phone": [{ day: "2026-10-03", value: 0.07 }],
        "lab_score_home.phone": [{ day: "2026-10-05", value: 32 }],
        "lab_score_eumon.phone": [{ day: "2026-10-05", value: 96 }],
        authority: [{ day: "2026-09-28", value: 0.2 }, { day: "2026-10-05", value: 0.25 }],
        "authority:rival.example": [{ day: "2026-10-05", value: 1.14 }],
        "authority:gone.example": [{ day: "2026-10-05", value: 5 }],
      },
    }));
    const lcp = view.speed.metrics.find((entry) => entry.metric === "lcp")!;
    assert.equal(view.speed.measured, true);
    assert.deepEqual(lcp.phone, { p75: 7012, rating: "poor" });
    assert.deepEqual(lcp.desktop, { p75: 2100, rating: "good" });
    assert.deepEqual(lcp.history, [{ day: "2026-09-26", phone: 7763, desktop: null }, { day: "2026-10-03", phone: 7012, desktop: 2100 }]);
    assert.deepEqual(view.speed.metrics.find((entry) => entry.metric === "inp")!.phone, { p75: null, rating: null }, "no INP data on phones");
    assert.deepEqual(view.lab, { phone: { home: 32, eumon: 96 }, desktop: { home: null, eumon: null } });
    assert.deepEqual(view.authority.competitors, [{ domain: "rival.example", score: 1.14 }, { domain: "new.example", score: null }], "removed competitors drop out; new ones wait for the weekly fetch");
    assert.equal(view.authority.site, 0.25);
    assert.equal(view.authority.history.length, 2);
    assert.equal(resultsView(base()).speed.measured, false);
  });
});
