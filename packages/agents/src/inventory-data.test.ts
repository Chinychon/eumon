import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, getDataset, saveAnalysisReport, saveCrawlBatch, upsertDataset, upsertRecords, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { datasetInventory, loadInventories } from "./inventory-data.js";

const AT = "2026-10-01T00:00:00.000Z";
const page = (url: string, status: number, text: number): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: text, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot",
});

describe("dataset inventory", () => {
  it("joins the records' pages to the latest crawl and lists every dataset of the site", async () => {
    const db = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
    const fields = [{ key: "name", label: "Name", type: "text" as const, required: true }, { key: "bio_en", label: "Bio (EN)", type: "text" as const }];
    await upsertDataset(db, { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields });
    await upsertRecords(db, [
      { siteId: "s", datasetId: "d", key: "dr-a", data: { name: "Dr A", bio_en: "x" }, sourceUrl: "https://x.com/doctors/dr-a" },
      { siteId: "s", datasetId: "d", key: "dr-b", data: { name: "Dr B" }, sourceUrl: "https://x.com/doctors/dr-b" },
    ], fields);
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: AT });
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: [{ url: "https://x.com/doctors/dr-a", routeFamily: "doctors" }, { url: "https://x.com/doctors/dr-b", routeFamily: "doctors" }] });
    await saveCrawlBatch(db, { analysisId: "a1", outcomes: [{ url: "https://x.com/doctors/dr-a", page: page("https://x.com/doctors/dr-a", 200, 1500) }, { url: "https://x.com/doctors/dr-b", page: page("https://x.com/doctors/dr-b", 200, 60) }] });
    await saveAnalysisReport(db, "a1", { findings: [] }, "done");
    const result = await datasetInventory(db, (await getDataset(db, "d"))!);
    assert.deepEqual(result.pages, { linked: 2, thin: 1, gone: 0, unreached: 0, examples: { thin: ["https://x.com/doctors/dr-b"], gone: [] } });
    assert.equal(result.fields.find((field) => field.key === "bio_en")?.share, 0.5);
    const all = await loadInventories(db, "s");
    assert.deepEqual(all.map((entry) => [entry.dataset.name, entry.dataset.records]), [["Doctors", 2]]);
  });
});
