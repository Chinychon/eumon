import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSite, saveSnapshot, saveTopQueriesSnapshot, setSiteCompetitorDomains, setSiteMarkets, upsertMetricPoints, updateSiteGa4Property, updateSiteGscProperty, upsertOAuthCredential, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { loadKeywords } from "./keywords-data.ts";
import { resultsPayload } from "./results-data.ts";

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
    assert.deepEqual(operator.site, { name: "x.com", baseUrl: "https://x.com", searchConnected: true, analytics: "reconnect", signals: { speed: false, authority: false, keywords: false } });
    const client = await resultsPayload(db, site, { client: true });
    assert.equal(JSON.stringify(client).includes("properties/9"), false);
    assert.deepEqual(client.results.health, { value: null, day: null });
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
    assert.deepEqual(payload.site.signals, { speed: true, authority: false, keywords: false });
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
    assert.deepEqual(payload.site.signals, { speed: false, authority: false, keywords: true });
    assert.equal(payload.results.keywords.visibility[0]!.domain, "x.com");
  });
});
