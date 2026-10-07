import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpReportShareVersion, dailyLeads, firstMetricDay, getSite, insertConversionEvent, listMetricSeries, publishedPages, recordLandingSession, syncFirstPartyResults, updateSiteGa4Property, upsertMetricPoints, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-07T00:00:00.000Z";

describe("metric ledger", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });

  it("overwrites a point on re-run instead of adding a second one", async () => {
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-01", value: 5 }, { metric: "search_clicks", day: "2026-10-02", value: 7 }]);
    await upsertMetricPoints(db, "s", [{ metric: "search_clicks", day: "2026-10-02", value: 9 }]);
    const series = await listMetricSeries(db, "s", ["search_clicks", "leads"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.search_clicks, [{ day: "2026-10-01", value: 5 }, { day: "2026-10-02", value: 9 }]);
    assert.deepEqual(series.leads, [], "a metric with no points is an empty series");
  });

  it("knows whether a metric was ever written", async () => {
    assert.equal(await firstMetricDay(db, "s", "search_clicks"), "2026-10-01");
    assert.equal(await firstMetricDay(db, "s", "ga4_sessions"), null);
  });

  it("stores the GA4 property and versions the client link", async () => {
    await updateSiteGa4Property(db, "s", "properties/123");
    assert.equal((await getSite(db, "s"))?.ga4Property, "properties/123");
    assert.equal((await getSite(db, "s"))?.reportShareVersion, 1);
    assert.equal(await bumpReportShareVersion(db, "s"), 2);
  });
});

describe("first-party results", async () => {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  const event = (id: string, name: string, at: string, sessionId?: string) =>
    insertConversionEvent(db, { id, siteId: "s", event: name, occurredAt: at, ...(sessionId ? { sessionId } : {}) });
  await event("e1", "whatsapp_click", "2026-10-01T02:00:00Z", "a");
  await event("e2", "form_submit", "2026-10-01T05:00:00Z", "a");      // same session, same day: one lead
  await event("e3", "whatsapp_click", "2026-10-02T01:00:00Z", "a");   // same session, next day: another lead
  await event("e4", "phone_click", "2026-10-01T09:00:00Z");           // no session: counts once
  await event("e5", "page_view", "2026-10-01T09:30:00Z", "b");        // not a contact action
  await recordLandingSession(db, { siteId: "s", sessionId: "a", pageId: "p1" });

  it("counts a session once per day and attributes it to Eumon when it landed on an Eumon page", async () => {
    assert.deepEqual(await dailyLeads(db, "s", "2026-09-01"), [
      { day: "2026-10-01", leads: 2, eumonLeads: 1 },
      { day: "2026-10-02", leads: 1, eumonLeads: 1 },
    ]);
  });

  it("writes the daily points, and a re-run overwrites them", async () => {
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    await syncFirstPartyResults(db, "s", new Date("2026-10-07T04:15:00Z"));
    const series = await listMetricSeries(db, "s", ["leads", "leads_eumon", "published_pages"], "2026-09-01", "2026-10-31");
    assert.deepEqual(series.leads, [{ day: "2026-10-01", value: 2 }, { day: "2026-10-02", value: 1 }]);
    assert.deepEqual(series.leads_eumon, [{ day: "2026-10-01", value: 1 }, { day: "2026-10-02", value: 1 }]);
    assert.deepEqual(series.published_pages, [{ day: "2026-10-07", value: 0 }]);
    assert.deepEqual(await publishedPages(db, "s"), { published: 0, goLive: null });
  });
});
