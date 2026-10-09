import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorityDomain, cruxHistoryPoints, fetchAuthority, fetchCruxHistory, fetchLabScore } from "./site-signals.js";

// Recorded from the CrUX History API for medbaycare.com on 2026-10-08 (trimmed), plus a missing week.
const history = {
  record: {
    metrics: {
      largest_contentful_paint: { percentilesTimeseries: { p75s: [7126, "NaN", 7012] } },
      interaction_to_next_paint: { percentilesTimeseries: { p75s: [1271, 1189, null] } },
      cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.09", "0.07", "0.07"] } },
    },
    collectionPeriods: [
      { firstDate: { year: 2026, month: 8, day: 23 }, lastDate: { year: 2026, month: 9, day: 19 } },
      { firstDate: { year: 2026, month: 8, day: 30 }, lastDate: { year: 2026, month: 9, day: 26 } },
      { firstDate: { year: 2026, month: 9, day: 6 }, lastDate: { year: 2026, month: 10, day: 3 } },
    ],
  },
};

describe("site signals clients", () => {
  it("turns CrUX history into one point per week and metric, skipping weeks without data", () => {
    const points = cruxHistoryPoints(history, "phone");
    const lcp = points.filter((point) => point.metric === "crux_lcp_p75.phone");
    assert.deepEqual(lcp, [{ metric: "crux_lcp_p75.phone", day: "2026-09-19", value: 7126 }, { metric: "crux_lcp_p75.phone", day: "2026-10-03", value: 7012 }]);
    assert.equal(points.filter((point) => point.metric === "crux_inp_p75.phone").length, 2);
    assert.deepEqual(points.find((point) => point.metric === "crux_cls_p75.phone" && point.day === "2026-10-03"), { metric: "crux_cls_p75.phone", day: "2026-10-03", value: 0.07 });
  });

  it("asks CrUX for the exact origin and form factor, and reads a 404 as no data", async () => {
    let body: Record<string, unknown> = {};
    const found = (async (_url: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(history)); }) as typeof fetch;
    assert.equal((await fetchCruxHistory("k", "https://www.x.com", "desktop", 40, found)).length, 7);
    assert.deepEqual(body, { origin: "https://www.x.com", formFactor: "DESKTOP", collectionPeriodCount: 40, metrics: ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] });
    const missing = (async () => new Response(JSON.stringify({ error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } }), { status: 404 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchCruxHistory("k", "https://small.example", "phone", 40, missing), []);
    const refused = (async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(fetchCruxHistory("k", "https://x.com", "phone", 2, refused), /API key not valid/);
  });

  it("reads the Lighthouse performance score as 0-100", async () => {
    let asked = "";
    const fetchFn = (async (url: string) => { asked = url; return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.32 } } } })); }) as typeof fetch;
    assert.equal(await fetchLabScore("k", "https://x.com/", "mobile", fetchFn), 32);
    assert.ok(asked.includes("strategy=mobile") && asked.includes("category=performance") && asked.includes(encodeURIComponent("https://x.com/")));
  });

  it("scores authority per domain, skipping domains Open PageRank doesn't know", async () => {
    assert.equal(authorityDomain("https://www.medbaycare.com/"), "medbaycare.com");
    let headers: HeadersInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers;
      return new Response(JSON.stringify({ status_code: 200, response: [
        { status_code: 200, page_rank_decimal: 0.25, domain: "medbaycare.com" },
        { status_code: 404, error: "Domain not found", page_rank_decimal: 0, domain: "nope.example" },
      ] }));
    }) as typeof fetch;
    assert.deepEqual(await fetchAuthority("secret", ["medbaycare.com", "nope.example"], fetchFn), [{ domain: "medbaycare.com", score: 0.25 }]);
    assert.deepEqual(headers, { "API-OPR": "secret" });
  });
});
