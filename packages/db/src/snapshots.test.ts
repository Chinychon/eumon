import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getSnapshot, getTopQueriesSnapshot, lastMetricDay, listSnapshots, saveSnapshot, saveTopQueriesSnapshot, upsertMetricPoints, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const now = "2026-10-09T00:00:00.000Z";

describe("snapshots", () => {
  it("keeps one list per kind and scope, replaced by each save", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-01", rows: [{ keyword: "a" }] });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|idn", periodEnd: "2026-10-09", rows: [{ keyword: "b" }] });
    await saveSnapshot(db, "s", { kind: "competitor_keywords", scope: "rival.example|mys", periodEnd: "2026-10-09", rows: [] });
    assert.deepEqual(await getSnapshot(db, "s", "competitor_keywords", "rival.example|idn"), { periodEnd: "2026-10-09", rows: [{ keyword: "b" }] });
    assert.equal(await getSnapshot(db, "s", "keywords", "rival.example|idn"), null, "another kind");
    assert.deepEqual((await listSnapshots(db, "s", "competitor_keywords")).map((entry) => entry.scope), ["rival.example|idn", "rival.example|mys"]);
  });

  it("keeps the latest top-queries list per site, and only for the property and markets it was fetched for", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    const rows = [{ query: "q", clicks: 3, impressions: 40, position: 6, before: null }];
    await saveTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["sgp", "mys"], periodEnd: "2026-10-04", rows });
    await saveTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["mys", "sgp"], periodEnd: "2026-10-05", rows });
    assert.deepEqual(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["mys", "sgp"] }), { periodEnd: "2026-10-05", rows });
    assert.equal(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:other.com", markets: ["mys", "sgp"] }), null, "another property's queries");
    assert.equal(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: [] }), null, "fetched for other markets");
  });

  it("carries the old top-queries table into the store when the migration runs", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await db.prepare("CREATE TABLE search_top_queries (site_id TEXT PRIMARY KEY, property TEXT NOT NULL, markets TEXT NOT NULL, period_end TEXT NOT NULL, rows_json TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
    await db.prepare("INSERT INTO search_top_queries VALUES ('s', 'sc-domain:x.com', 'mys,sgp', '2026-10-04', '[]', ?)").bind(now).run();
    const migration = readFileSync(new URL("../migrations/0016_site_snapshots.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").map((sql) => sql.trim()).filter(Boolean)) await db.prepare(statement).run();
    assert.deepEqual(await getTopQueriesSnapshot(db, "s", { property: "sc-domain:x.com", markets: ["sgp", "mys"] }), { periodEnd: "2026-10-04", rows: [] });
  });

  it("knows the last day a metric was written", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    assert.equal(await lastMetricDay(db, "s", "sync.competitor_keywords"), null);
    await upsertMetricPoints(db, "s", [{ metric: "sync.competitor_keywords", day: "2026-09-01", value: 1 }, { metric: "sync.competitor_keywords", day: "2026-09-29", value: 1 }]);
    assert.equal(await lastMetricDay(db, "s", "sync.competitor_keywords"), "2026-09-29");
  });
});
