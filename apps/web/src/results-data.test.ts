import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSite, saveAiAnswerChecks, saveRankChecks, setAiPrompts, saveSnapshot, setTrackedKeywords, saveTopQueriesSnapshot, setSiteCompetitorDomains, setSiteMarkets, upsertMetricPoints, updateSiteGa4Property, updateSiteGscProperty, upsertOAuthCredential, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import type { D1Like } from "@organic-growth/db";
import { loadKeywords } from "./keywords-data.ts";
import { DEMO_SITE_ID } from "@organic-growth/agents";
import { loadResults, resultsPayload } from "./results-data.ts";

describe("results payload", () => {
  it("says Analytics needs a reconnect, and gives the client link no property IDs or site health", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await updateSiteGscProperty(db, "s", "sc-domain:x.com");
    await updateSiteGa4Property(db, "s", "properties/9");
    await upsertOAuthCredential(db, { id: "o", siteId: "s", provider: "google", encryptedBlob: "x", scopes: "webmasters.readonly" });
    const site = (await getSite(db, "s"))!;
    const operator = await resultsPayload(db, site);
    assert.deepEqual(operator.site, { name: "x.com", baseUrl: "https://x.com", searchConnected: true, analytics: "reconnect", signals: { speed: false, authority: false, keywords: false, bing: false } });
    const client = await resultsPayload(db, site, { client: true });
    assert.equal(JSON.stringify(client).includes("properties/9"), false);
    assert.deepEqual(client.results.health, { value: null, day: null });
  });

  it("treats the demo site's Analytics as connected: its numbers are seeded, there is no Google to reconnect", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: DEMO_SITE_ID, name: "Demo", baseUrl: "https://demo-clinic.example", createdAt: at, updatedAt: at });
    await updateSiteGscProperty(db, DEMO_SITE_ID, "sc-domain:demo-clinic.example");
    await updateSiteGa4Property(db, DEMO_SITE_ID, "properties/0");
    const payload = await resultsPayload(db, (await getSite(db, DEMO_SITE_ID))!);
    assert.equal(payload.site.analytics, "connected");
  });

  it("shows the stored top queries for the site's current property", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await updateSiteGscProperty(db, "s", "sc-domain:x.com");
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: at.slice(0, 10), value: 1 }]);
    const rows = [{ query: "q", clicks: 3, impressions: 40, position: 6, before: null }];
    await saveTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: [], periodEnd: "2026-10-04", rows });
    const payload = await resultsPayload(db, (await getSite(db, "s"))!);
    assert.deepEqual(payload.results.search?.topQueries, { periodEnd: "2026-10-04", rows });
  });

  it("loads authority for the site's current competitors, and says which keys are set", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    await upsertMetricPoints(db, "s", [{ metric: "authority:rival.example", day: at.slice(0, 10), value: 1.1 }]);
    const payload = await resultsPayload(db, (await getSite(db, "s"))!, { keys: { googleApiKey: "g" } });
    assert.deepEqual(payload.results.authority.competitors, [{ domain: "rival.example", score: 1.1 }]);
    assert.deepEqual(payload.site.signals, { speed: true, authority: false, keywords: false, bing: false });
  });

  it("reads only the keyword lists for the current property, markets and competitors, under the bare domain", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://www.x.com", createdAt: at, updatedAt: at });
    await updateSiteGscProperty(db, "s", "sc-domain:x.com");
    await setSiteMarkets(db, "s", ["idn"]);
    await setSiteCompetitorDomains(db, "s", ["rival.example"]);
    const rows = [{ keyword: "k", volume: 10, difficulty: 1, intent: null, position: 1, url: "/k", traffic: 5 }];
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "x.com|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|mys", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "gone.example|idn", periodEnd: "2026-10-09", rows });
    await saveSnapshot(db, "s", { kind: "keywords", scope: "sc-domain:x.com|idn", periodEnd: "2026-10-06", rows: [] });
    await saveSnapshot(db, "s", { kind: "keywords", scope: "sc-domain:old.com|idn", periodEnd: "2026-10-06", rows: [] });
    await upsertMetricPoints(db, "s", [{ metric: "sync.competitor_keywords", day: "2026-10-09", value: 2 }]);
    const site = (await getSite(db, "s"))!;
    const keywords = await loadKeywords(db, site, { markets: ["idn"], competitors: ["rival.example"] });
    assert.equal(keywords.site, "x.com");
    assert.equal(keywords.synced, true);
    assert.deepEqual(keywords.ranked.map((list) => list.domain), ["rival.example", "x.com"], "the other market and the removed competitor are left out");
    assert.equal(keywords.priced.length, 1, "the old property's prices are left out");
    const payload = await resultsPayload(db, site, { keys: { dataForSeo: { login: "a", password: "b" } } });
    assert.deepEqual(payload.site.signals, { speed: false, authority: false, keywords: true, bing: false });
    assert.equal(payload.results.keywords.visibility[0]!.domain, "x.com");
  });

  it("loads tracked keywords and their checks into the view", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    const today = at.slice(0, 10);
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await setTrackedKeywords(db, "s", ["kw"]);
    await setSiteMarkets(db, "s", ["mys"]);
    await saveRankChecks(db, "s", [{ keyword: "kw", market: "mys", day: today, position: 4, url: "https://x.com/p", features: [] }]);
    const view = await loadResults(db, (await getSite(db, "s"))!, today);
    assert.deepEqual(view.ranks.rows.map((row) => [row.keyword, row.position]), [["kw", 4]]);
  });

  it("loads tracked questions and their answers into the view", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    const today = at.slice(0, 10);
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://www.x.com", createdAt: at, updatedAt: at });
    await setAiPrompts(db, "s", ["best dentist"]);
    await setSiteMarkets(db, "s", ["mys"]);
    await saveAiAnswerChecks(db, "s", [{ prompt: "best dentist", market: "mys", engine: "chatgpt", day: today, answered: true, mentioned: true, cited: true, citedRank: 1, sources: [{ domain: "x.com", url: "https://x.com/" }], rivals: [], excerpt: "x.com" }]);
    const view = await loadResults(db, (await getSite(db, "s"))!, today);
    assert.deepEqual(view.aiAnswers.rows.map((row) => [row.prompt, row.market, row.cells.chatgpt?.mentioned]), [["best dentist", "mys", true]]);
    assert.deepEqual(view.aiAnswers.topDomains, [{ domain: "x.com", answers: 1, kind: "site" }], "the site is the bare domain");
  });

  it("still loads, with the new sections empty, before the migrations that add their tables are applied", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    const site = (await getSite(db, "s"))!;
    // A deploy goes out on merge; its migrations are applied by hand afterwards.
    const missing = /\b(referring_domains|tracked_keywords|rank_checks|ai_prompts|ai_answer_checks)\b/;
    const unmigrated: D1Like = {
      prepare: (sql: string) => {
        if (missing.test(sql)) throw new Error(`D1_ERROR: no such table (${sql.match(missing)![1]})`);
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
    };
    const results = await loadResults(unmigrated, site);
    assert.equal(results.links.own, null);
  });
});
