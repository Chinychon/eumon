import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataForSeoLocation, fetchAiAnswer, fetchBacklinkSummary, fetchReferringDomains, fetchKeywordOverview, fetchRankedKeywords, fetchSerp } from "./dataforseo.js";

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

  it("calls each endpoint at its documented URL: `/live` once, before `/advanced` for the SERP API", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => { urls.push(url); return new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.004, result: [{ item_types: [], items: [] }] })); }) as typeof fetch;
    await fetchSerp(auth, { keyword: "x", location: 2458, language: "en", site: "x.com", checkedAt: "2026-10-10", volume: null }, fetchFn);
    await fetchBacklinkSummary(auth, "x.com", fetchFn);
    assert.deepEqual(urls, ["https://api.dataforseo.com/v3/serp/google/organic/live/advanced", "https://api.dataforseo.com/v3/backlinks/summary/live"]);
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
  it("asks each AI engine at its endpoint and reads the answer and its sources", async () => {
    const asked: Array<{ url: string; task: Record<string, unknown> }> = [];
    const results: Record<string, object> = {
      "chat_gpt/llm_scraper": { markdown: "Bright Smile is a good choice.", sources: [{ domain: "www.brightsmile.example", url: "https://www.brightsmile.example/p", title: "t" }, { domain: null, url: "https://wiki.example/a" }] },
      "gemini/llm_scraper": { markdown: null, items: [{ type: "gemini_text", text: "Try Rival." }], sources: [] },
      "google/ai_mode": { items: [{ type: "ai_overview", items: [{ type: "ai_overview_element", markdown: "Clinics: Rival Dental.", references: [{ type: "ai_overview_reference", domain: "rival-dental.example", url: "https://rival-dental.example/x" }] }] }] },
      "perplexity/llm_responses": { items: [{ type: "message", sections: [{ type: "text", text: "Bright Smile [1]", annotations: [{ title: "brightsmile.example", url: "https://brightsmile.example/a" }] }] }] },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push({ url, task: JSON.parse(String(init?.body))[0] });
      const key = Object.keys(results).find((part) => url.includes(part))!;
      return new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.004, result: [results[key]] }));
    }) as typeof fetch;
    const input = { prompt: "best dentist kl", location: 2458, language: "en", countryIso2: "MY" };
    const chatgpt = await fetchAiAnswer(auth, { ...input, engine: "chatgpt" }, fetchFn);
    assert.deepEqual(chatgpt, { text: "Bright Smile is a good choice.", sources: [{ domain: "brightsmile.example", url: "https://www.brightsmile.example/p" }, { domain: "wiki.example", url: "https://wiki.example/a" }], cost: 0.004 });
    assert.equal((await fetchAiAnswer(auth, { ...input, engine: "gemini" }, fetchFn)).text, "Try Rival.");
    assert.deepEqual((await fetchAiAnswer(auth, { ...input, engine: "ai_mode" }, fetchFn)).sources, [{ domain: "rival-dental.example", url: "https://rival-dental.example/x" }]);
    const perplexity = await fetchAiAnswer(auth, { ...input, engine: "perplexity" }, fetchFn);
    assert.deepEqual(perplexity.sources, [{ domain: "brightsmile.example", url: "https://brightsmile.example/a" }]);
    assert.deepEqual(asked.map((call) => call.url), [
      "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
      "https://api.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced",
      "https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced",
      "https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live",
    ]);
    assert.deepEqual(asked[0]!.task, { keyword: "best dentist kl", location_code: 2458, language_code: "en", force_web_search: true });
    assert.deepEqual(asked[3]!.task, { user_prompt: "best dentist kl", model_name: "sonar", max_output_tokens: 2048, web_search_country_iso_code: "MY" });
  });

  it("an answer with nothing in it is an empty answer, not an error; a refused task throws", async () => {
    const empty = (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.004, result: null }))) as unknown as typeof fetch;
    assert.deepEqual(await fetchAiAnswer(auth, { engine: "chatgpt", prompt: "q", location: 2458, language: "en", countryIso2: null }, empty), { text: "", sources: [], cost: 0.004 });
    const refused = (async () => new Response(envelope({ status_code: 40501, status_message: "Invalid Field: 'location_code'.", cost: 0, result: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchAiAnswer(auth, { engine: "gemini", prompt: "q", location: 2458, language: "en", countryIso2: null }, refused), /location_code/);
  });

  it("AI Mode text and sources are not repeated; an empty markdown falls back to the items", async () => {
    const result = { items: [{ type: "ai_overview", markdown: "Top clinics.", references: [{ domain: "a.example", url: "https://a.example/1" }], items: [{ type: "ai_overview_element", markdown: "Top clinics.", references: [{ domain: "a.example", url: "https://a.example/1" }, { domain: "b.example", url: "https://b.example/2" }] }] }] };
    const serve = (body: object) => (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0, result: [body] }))) as unknown as typeof fetch;
    const input = { prompt: "q", location: 2458, language: "en", countryIso2: null };
    const mode = await fetchAiAnswer(auth, { ...input, engine: "ai_mode" }, serve(result));
    assert.equal(mode.text, "Top clinics.");
    assert.deepEqual(mode.sources, [{ domain: "a.example", url: "https://a.example/1" }, { domain: "b.example", url: "https://b.example/2" }]);
    const gemini = await fetchAiAnswer(auth, { ...input, engine: "gemini" }, serve({ markdown: "", items: [{ text: "From items." }], sources: [] }));
    assert.equal(gemini.text, "From items.");
  });

  it("keeps a source's URL only when it is http(s)", async () => {
    const serve = (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0, result: [{ markdown: "x", sources: [
      { domain: "evil.example", url: "javascript:alert(1)" }, { domain: "ok.example", url: "http://ok.example/a" }, { domain: null, url: "data:text/html,hi" },
    ] }] }))) as unknown as typeof fetch;
    const answer = await fetchAiAnswer(auth, { engine: "chatgpt", prompt: "q", location: 2458, language: "en", countryIso2: null }, serve);
    assert.deepEqual(answer.sources, [{ domain: "evil.example", url: "" }, { domain: "ok.example", url: "http://ok.example/a" }]);
  });
});

describe("referring domains", () => {
  const item = (extra: object) => ({ domain_from: "a.example", url_from: "https://a.example/p", url_to: "https://x.com/", anchor: "x", dofollow: true, first_seen: "2026-09-14 08:12:00 +00:00", last_seen: "2026-10-01 00:00:00 +00:00", is_lost: false, is_broken: false, domain_from_rank: 40, backlink_spam_score: 3, ...extra });
  const ask = async (items: object[] | null) => {
    const asked: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { asked.push({ url, body: String(init?.body) }); return new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.02, result: [{ items }] })); }) as typeof fetch;
    return { asked, answer: await fetchReferringDomains(auth, "x.com", fetchFn) };
  };

  it("asks for one strongest link per domain and maps each item", async () => {
    const { asked, answer } = await ask([item({ domain_from: "www.a.example", anchor: null, backlink_spam_score: null, domain_from_rank: null, is_lost: true })]);
    assert.equal(asked[0]!.url, "https://api.dataforseo.com/v3/backlinks/backlinks/live");
    assert.deepEqual(JSON.parse(asked[0]!.body), [{ target: "x.com", mode: "one_per_domain", backlinks_status_type: "all", include_subdomains: true, exclude_internal_backlinks: true, order_by: ["domain_from_rank,desc"], limit: 1000 }]);
    assert.deepEqual(answer, { cost: 0.02, rows: [{ domain: "a.example", urlFrom: "https://a.example/p", urlTo: "https://x.com/", anchor: "", dofollow: true, firstSeen: "2026-09-14", lastSeen: "2026-10-01", lost: true, broken: false, rank: 0, spamScore: null }] });
  });

  it("non-http linking pages are dropped, rows without a domain skipped, and an empty result gives no rows", async () => {
    assert.deepEqual((await ask([item({ url_from: "javascript:alert(1)" }), item({ domain_from: null })])).answer.rows.map((row) => row.urlFrom), [""]);
    assert.deepEqual((await ask(null)).answer.rows, []);
  });

  it("clips anchors to 200 characters and addresses to 500", async () => {
    const [row] = (await ask([item({ anchor: "a".repeat(300), url_from: `https://a.example/${"p".repeat(600)}`, url_to: `https://x.com/${"q".repeat(600)}` })])).answer.rows;
    assert.deepEqual([row!.anchor.length, row!.urlFrom.length, row!.urlTo.length], [200, 500, 500]);
  });

  it("keeps the first row when www.a.example and a.example are the same domain", async () => {
    const rows = (await ask([item({ domain_from: "www.a.example", domain_from_rank: 50 }), item({ domain_from: "a.example", domain_from_rank: 10 })])).answer.rows;
    assert.deepEqual(rows.map((row) => [row.domain, row.rank]), [["a.example", 50]]);
  });
});
