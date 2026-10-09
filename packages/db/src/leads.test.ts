import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, dailyLeadOutcomes, getLeadByRef, listLeads, outcomesByPageType, recordLeadClick, updateLead } from "./leads.js";
import { listMetricSeries, syncLeadOutcomes } from "./metrics.js";
import { openSqliteD1 } from "./sqlite.js";

async function site() {
  const db = openSqliteD1();
  const at = "2026-10-01T00:00:00Z";
  await db.prepare("INSERT INTO sites (id, name, base_url, created_at, updated_at) VALUES ('s', 'x', 'https://x.com', ?, ?)").bind(at, at).run();
  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'Treatment guides', '{}', 'active', ?, ?)`).bind(at, at).run();
  await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
    VALUES ('p', 's', 't', '/guides/braces', 'braces', 'x', '', '{}', 1, '[]', 'published', ?, ?, ?)`).bind(at, at, at).run();
  await db.prepare("INSERT INTO page_sessions (site_id, session_id, page_id, first_seen_at, source) VALUES ('s', 'sess_guide_000000001', 'p', ?, 'search')").bind(at).run();
  return db;
}

describe("leads", () => {
  it("starts a lead per code, finds it by code with the page the visitor landed on, and ignores a code seen before", async () => {
    const db = await site();
    await recordLeadClick(db, { id: "l1", siteId: "s", ref: "K7M2Q", sessionId: "sess_guide_000000001", pageUrl: "https://x.com/guides/braces", placement: "hero", at: "2026-10-02T10:00:00Z" });
    await recordLeadClick(db, { id: "l1b", siteId: "s", ref: "K7M2Q", at: "2026-10-02T11:00:00Z" });
    const lead = (await getLeadByRef(db, "s", "K7M2Q"))!;
    assert.deepEqual([lead.id, lead.status, lead.landing], ["l1", "clicked", { path: "/guides/braces", template: "Treatment guides", source: "search" }]);
    assert.equal((await listLeads(db, "s")).length, 1);
  });

  it("fills earlier stages when a later one is reached, clears later ones when moved back, and counts each on its day", async () => {
    const db = await site();
    await recordLeadClick(db, { id: "l1", siteId: "s", ref: "K7M2Q", sessionId: "sess_guide_000000001", at: "2026-10-02T10:00:00Z" });
    await recordLeadClick(db, { id: "l2", siteId: "s", ref: "AB3CD", sessionId: "sess_main_0000000001", at: "2026-10-02T12:00:00Z" });
    await updateLead(db, "s", "l1", { status: "won", value: 2400, at: "2026-10-05T09:00:00Z" });
    let lead = (await getLeadByRef(db, "s", "K7M2Q"))!;
    assert.deepEqual([lead.chatAt, lead.qualifiedAt, lead.wonAt, lead.value], ["2026-10-05T09:00:00Z", "2026-10-05T09:00:00Z", "2026-10-05T09:00:00Z", 2400]);
    await updateLead(db, "s", "l2", { status: "chat", at: "2026-10-02T12:30:00Z" });
    await updateLead(db, "s", "l2", { status: "lost", at: "2026-10-04T08:00:00Z" });
    await createLead(db, { id: "l3", siteId: "s", channel: "phone", at: "2026-10-03T08:00:00Z" });

    assert.deepEqual(await dailyLeadOutcomes(db, "s", "2026-10-01"), [
      { day: "2026-10-02", clicks: 2, chats: 1, qualified: 0, won: 0, revenue: 0 },
      { day: "2026-10-03", clicks: 0, chats: 1, qualified: 0, won: 0, revenue: 0 },
      { day: "2026-10-05", clicks: 0, chats: 1, qualified: 1, won: 1, revenue: 2400 },
    ]);
    assert.deepEqual(await outcomesByPageType(db, "s", "2026-09-01"), [
      { pageType: "Treatment guides", leads: 1, chats: 1, qualified: 1, won: 1, revenue: 2400 },
      { pageType: "Rest of the site", leads: 2, chats: 2, qualified: 0, won: 0, revenue: 0 },
    ]);
    assert.deepEqual((await listLeads(db, "s", { open: true })).map((entry) => entry.id), ["l3"], "customers and lost leads aren't open");

    await syncLeadOutcomes(db, "s", new Date("2026-10-06T00:00:00Z"));
    const before = await listMetricSeries(db, "s", ["customers", "revenue"], "2026-10-01", "2026-10-06");
    assert.deepEqual(before.revenue!.find((point) => point.day === "2026-10-05"), { day: "2026-10-05", value: 2400 });
    // Moved back to a chat: the qualified and won stages are cleared, and the ledger's day returns to 0.
    await updateLead(db, "s", "l1", { status: "chat" });
    lead = (await getLeadByRef(db, "s", "K7M2Q"))!;
    assert.deepEqual([lead.chatAt, lead.qualifiedAt, lead.wonAt], ["2026-10-05T09:00:00Z", null, null]);
    await syncLeadOutcomes(db, "s", new Date("2026-10-06T00:00:00Z"));
    const after = await listMetricSeries(db, "s", ["customers", "revenue"], "2026-10-01", "2026-10-06");
    assert.deepEqual(after.revenue!.find((point) => point.day === "2026-10-05"), { day: "2026-10-05", value: 0 });
    assert.equal(after.customers!.length, 5, "every day from the first lead (Oct 2) to today is a real 0 or more");
  });
});
