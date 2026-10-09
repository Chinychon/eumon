import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataForSeoLocation, fetchKeywordOverview, fetchRankedKeywords } from "./dataforseo.js";

const auth = { login: "me@example.com", password: "secret" };
const envelope = (task: object) => JSON.stringify({ version: "0.1.20260917", status_code: 20000, status_message: "Ok.", cost: 0.0132, tasks_count: 1, tasks_error: 0, tasks: [task] });

// Trimmed from a real answer for medbaycare.com on 2026-10-09.
const rankedTask = {
  status_code: 20000, status_message: "Ok.", cost: 0.0132,
  result: [{ se_type: "google", target: "medbaycare.com", location_code: 2360, language_code: null, total_count: 20, items_count: 2,
    metrics: { organic: { pos_1: 0, pos_2_3: 0, pos_4_10: 0, pos_11_20: 1, count: 20, etv: 28.51 } },
    items: [
      { se_type: "google", keyword_data: { keyword: "mahkota medical centre", keyword_info: { search_volume: 2900, cpc: 0.2, competition: 0.1 }, keyword_properties: { keyword_difficulty: 16 }, search_intent_info: { main_intent: "navigational" } },
        ranked_serp_element: { se_type: "google", serp_item: { type: "organic", rank_group: 21, rank_absolute: 23, relative_url: "/id/hospitals/mahkota-medical-centre", etv: 10.4 } } },
      { se_type: "google", keyword_data: { keyword: "loh guan lye hospital", keyword_info: { search_volume: 2400 }, keyword_properties: { keyword_difficulty: null }, search_intent_info: null },
        ranked_serp_element: { se_type: "google", serp_item: { type: "organic", rank_group: 43, rank_absolute: 45, relative_url: null, etv: null } } },
    ] }],
};

describe("DataForSEO client", () => {
  it("maps a country's numeric code to DataForSEO's location, and knows which countries it doesn't cover", () => {
    assert.equal(dataForSeoLocation(360), 2360);
    assert.equal(dataForSeoLocation(104), null, "Myanmar is not in DataForSEO's list");
  });

  it("asks for a domain's ranked keywords in a country and reads each row", async () => {
    const asked: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { asked.push({ url, init }); return new Response(envelope(rankedTask)); }) as typeof fetch;
    const answer = await fetchRankedKeywords(auth, "medbaycare.com", 2360, fetchFn);
    assert.equal(asked[0]!.url, "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live");
    assert.equal((asked[0]!.init!.headers as Record<string, string>).Authorization, `Basic ${btoa("me@example.com:secret")}`);
    assert.deepEqual(JSON.parse(String(asked[0]!.init!.body)), [{ target: "medbaycare.com", location_code: 2360, limit: 1000, item_types: ["organic"], order_by: ["keyword_data.keyword_info.search_volume,desc"] }], "organic results only: ads are not rankings, and cost per row");
    assert.deepEqual(answer, {
      cost: 0.0132,
      rows: [
        { keyword: "mahkota medical centre", volume: 2900, difficulty: 16, intent: "navigational", position: 21, url: "/id/hospitals/mahkota-medical-centre", traffic: 10.4 },
        { keyword: "loh guan lye hospital", volume: 2400, difficulty: null, intent: null, position: 43, url: "/", traffic: 0 },
      ],
    });
  });

  it("returns no rows for a domain DataForSEO doesn't know, and what the call cost", async () => {
    const fetchFn = (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.012, result: [{ total_count: null, items_count: 0, items: null, metrics: { organic: {} } }] }))) as unknown as typeof fetch;
    assert.deepEqual(await fetchRankedKeywords(auth, "nobody.example", 2360, fetchFn), { rows: [], cost: 0.012 });
  });

  it("prices keywords in a country and language, leaving out the ones DataForSEO doesn't know", async () => {
    const task = { status_code: 20000, status_message: "Ok.", cost: 0.01212, result: [{ se_type: "google", location_code: 2360, language_code: "id", items_count: 1,
      items: [{ se_type: "google", keyword: "chf adalah", keyword_info: { search_volume: 12100, monthly_searches: [{ year: 2026, month: 9, search_volume: 12100 }] }, keyword_properties: { keyword_difficulty: 0 }, search_intent_info: { main_intent: "informational" } }] }] };
    let body = "";
    const fetchFn = (async (_url: string, init?: RequestInit) => { body = String(init?.body); return new Response(envelope(task)); }) as typeof fetch;
    const answer = await fetchKeywordOverview(auth, ["chf adalah", "dj stent di penang"], 2360, "id", fetchFn);
    assert.deepEqual(JSON.parse(body), [{ keywords: ["chf adalah", "dj stent di penang"], location_code: 2360, language_code: "id" }]);
    assert.deepEqual(answer, { rows: [{ keyword: "chf adalah", volume: 12100, difficulty: 0, intent: "informational" }], cost: 0.01212 });
  });

  it("turns an account or task error into a readable failure", async () => {
    const unverified = (async () => new Response(JSON.stringify({ status_code: 40104, status_message: "Please verify your account before using the API.", cost: 0, tasks: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, unverified), /verify your account/);
    const oneTask = (async () => new Response(envelope({ status_code: 40000, status_message: "You can set only one task at a time.", cost: 0, result: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, oneTask), /only one task/);
    const http = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(fetchRankedKeywords(auth, "x.com", 2360, http), /503/);
  });
});
