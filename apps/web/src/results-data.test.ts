import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSite, updateSiteGa4Property, updateSiteGscProperty, upsertOAuthCredential, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { resultsPayload } from "./results-data.ts";

describe("results payload", () => {
  it("says Analytics needs a reconnect, and gives the client link no property IDs or site health", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await updateSiteGscProperty(db, "s", "sc-domain:x.com");
    await updateSiteGa4Property(db, "s", "properties/9");
    await upsertOAuthCredential(db, { id: "o", siteId: "s", provider: "google_search_console", encryptedBlob: "x", scopes: "webmasters.readonly" });
    const site = (await getSite(db, "s"))!;
    const operator = await resultsPayload(db, site);
    assert.deepEqual(operator.site, { name: "x.com", baseUrl: "https://x.com", searchConnected: true, analytics: "reconnect" });
    const client = await resultsPayload(db, site, { client: true });
    assert.equal(JSON.stringify(client).includes("properties/9"), false);
    assert.deepEqual(client.results.health, { value: null, day: null });
  });
});
