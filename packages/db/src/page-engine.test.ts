import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeneratedPage, PageTemplate } from "@organic-growth/core";
import { listRecordKeys, listSiteMarkets, setSiteMarkets, upsertSite } from "./index.js";
import { datasetCoverage, defaultPageSettings, deleteTemplate, getPageSettings, listPageRevisions, setTemplatePublication, syncTemplatePages, upsertDataset, upsertPageSettings, upsertRecords, upsertTemplate } from "./page-engine.js";
import { openSqliteD1 } from "./sqlite.js";

describe("datasetCoverage", () => {
  it("counts records and live one-page-per-record pages per dataset", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    const fields = [{ key: "name", label: "Name", type: "text" as const }, { key: "city", label: "City", type: "text" as const }];
    await upsertDataset(db, { id: "ds", siteId: "site", name: "Doctors", entityType: "doctor", description: "", fields, keyField: "name", pageIdeas: [], status: "active", createdAt: now, updatedAt: now });
    await upsertRecords(db, ["amy", "ben", "cat"].map((key) => ({ siteId: "site", datasetId: "ds", key, data: { name: key, city: "Penang" } })), fields);

    const template = (id: string, groupBy: string[]): PageTemplate => ({
      id, siteId: "site", datasetId: "ds", name: id, groupBy, pathPattern: "/d/{name}", titlePattern: "{name}", descriptionPattern: "", h1Pattern: "",
      introPattern: "", itemTitleField: "name", itemFields: ["city"], sortDir: "asc", minRecords: 1, faq: [], status: "active", createdAt: now, updatedAt: now,
    });
    const page = (templateId: string, key: string): GeneratedPage => ({
      id: `page_${templateId}_${key}`, siteId: "site", templateId, path: `/d/${templateId}/${key}`, groupKey: key, groupValues: {}, title: key, description: "",
      h1: key, intro: "", faq: [], recordIds: [], items: [], facts: {}, related: [], qualityScore: 0.8, qualityIssues: [], status: "draft", createdAt: now, updatedAt: now,
    });
    await upsertTemplate(db, template("entity", []));
    await upsertTemplate(db, template("by-city", ["city"]));
    await syncTemplatePages(db, "entity", [page("entity", "amy"), page("entity", "ben")]);
    await syncTemplatePages(db, "by-city", [page("by-city", "penang")]);

    assert.deepEqual(await datasetCoverage(db, "site"), [{ name: "Doctors", entityType: "doctor", records: 3, livePages: 0 }]);
    await setTemplatePublication(db, "entity", true);
    await setTemplatePublication(db, "by-city", true);
    assert.deepEqual(await datasetCoverage(db, "site"), [{ name: "Doctors", entityType: "doctor", records: 3, livePages: 2 }], "grouped pages are not entity pages");
  });
});

describe("page settings", () => {
  it("stores the page language", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    const defaults = defaultPageSettings("site", "X", "https://x.com");
    assert.equal(defaults.language, "en");
    await upsertPageSettings(db, { ...defaults, language: "id" });
    assert.equal((await getPageSettings(db, "site"))?.language, "id");
  });
});

describe("markets and record keys", () => {
  it("stores target countries and lists record keys with their entity type", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await setSiteMarkets(db, "site", ["idn", "mys", "idn"]);
    assert.deepEqual(await listSiteMarkets(db, "site"), ["idn", "mys"]);
    await setSiteMarkets(db, "site", ["idn"]);
    assert.deepEqual(await listSiteMarkets(db, "site"), ["idn"]);
    const fields = [{ key: "name", label: "Name", type: "text" as const }];
    await upsertDataset(db, { id: "ds", siteId: "site", name: "Doctors", entityType: "doctor", description: "", fields, keyField: "name", pageIdeas: [], status: "active", createdAt: now, updatedAt: now });
    await upsertRecords(db, [{ siteId: "site", datasetId: "ds", key: "amy-tan", data: { name: "Amy Tan" } }], fields);
    assert.deepEqual(await listRecordKeys(db, "site"), [{ key: "amy-tan", entityType: "doctor" }]);
  });
});

describe("page revisions", () => {
  it("measures each change over equal windows before and after, in one query, and cascade with their template", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "site", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 'site', 'T', 't', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(now, now).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 'site', 'd', 'T', '{}', 'active', ?, ?)`).bind(now, now).run();
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    for (const id of ["a", "b"]) {
      await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, created_at, updated_at)
        VALUES (?, 'site', 't', ?, ?, 'x', '', '{}', 1, '[]', 'published', ?, ?)`).bind(id, `/${id}`, id, now, now).run();
      // 2 views a day before the change ten days ago, 5 a day since, and one more day outside the window.
      for (let offset = -21; offset < 0; offset++) {
        await db.prepare("INSERT INTO page_metrics_daily (site_id, page_id, day, views, search_clicks) VALUES ('site', ?, ?, ?, 1)").bind(id, day(offset), offset < -10 ? 2 : 5).run();
      }
    }
    await db.prepare("INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at) VALUES ('r1', 'a', 'title', 'Old', 'New', 'CTR', 'eumon', ?)").bind(`${day(-10)}T09:00:00.000Z`).run();
    await db.prepare("INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at) VALUES ('r2', 'b', 'title', 'Old', 'New', 'CTR', 'eumon', ?)").bind(`${day(0)}T09:00:00.000Z`).run();
    const [today, tenDays] = await listPageRevisions(db, "site");
    assert.equal(tenDays!.id, "r1");
    assert.equal(tenDays!.windowDays, 10);
    assert.deepEqual(tenDays!.metricsBefore, { views: 20, ctaClicks: 0, searchClicks: 10, searchImpressions: 0 });
    assert.deepEqual(tenDays!.metricsAfter, { views: 50, ctaClicks: 0, searchClicks: 10, searchImpressions: 0 });
    assert.deepEqual({ id: today!.id, windowDays: today!.windowDays, after: today!.metricsAfter.views }, { id: "r2", windowDays: 0, after: 0 }, "a change made today has no window yet");
    await deleteTemplate(db, "t");
    for (const table of ["generated_pages", "page_revisions", "page_metrics_daily"]) {
      assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n), 0, table);
    }
  });
});
