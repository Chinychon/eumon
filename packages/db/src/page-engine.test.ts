import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeneratedPage, PageTemplate } from "@organic-growth/core";
import { upsertSite } from "./index.js";
import { datasetCoverage, defaultPageSettings, getPageSettings, setTemplatePublication, syncTemplatePages, upsertDataset, upsertPageSettings, upsertRecords, upsertTemplate } from "./page-engine.js";
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
