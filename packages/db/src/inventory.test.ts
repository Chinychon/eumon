import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult, Dataset } from "@organic-growth/core";
import {
  createAnalysis, datasetInventoryRows, deleteDataset, deleteStaleRecords, enqueueAnalysisCrawlUrls, getOAuthCredential, listAllRecords, replaceRecords,
  saveCrawlBatch, updateAnalysisStatus, upsertDataset, upsertOAuthCredential, upsertRecords, upsertSite, upsertSource,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const AT = "2026-10-01T00:00:00.000Z";
const fields: Dataset["fields"] = [
  { key: "name", label: "Name", type: "text", required: true }, { key: "photo", label: "Photo", type: "url" }, { key: "url", label: "Page", type: "url" }, { key: "bio_en", label: "Bio (EN)", type: "text" },
];
const dataset: Dataset = { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields };
const page = (url: string, status: number, text: number): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: text, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: "doctors",
});

async function seed() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await upsertDataset(db, dataset);
  await upsertRecords(db, [
    { siteId: "s", datasetId: "d", key: "dr-a", data: { name: "Dr A", photo: "https://cdn.example/a.jpg", bio_en: "x" }, sourceUrl: "https://x.com/doctors/dr-a/" },
    { siteId: "s", datasetId: "d", key: "dr-b", data: { name: "Dr B", photo: "https://cdn.example/b.jpg" }, sourceUrl: "http://www.x.com/doctors/dr-b#bio" },
    { siteId: "s", datasetId: "d", key: "dr-c", data: { name: "Dr C" }, sourceUrl: "https://x.com/doctors/dr-c" },
    { siteId: "s", datasetId: "d", key: "dr-d", data: { name: "Dr D" }, sourceUrl: "https://x.com/doctors/dr-d" },
    { siteId: "s", datasetId: "d", key: "dr-e", data: { name: "Dr E" }, sourceUrl: "https://directory.example/e" },
    { siteId: "s", datasetId: "d", key: "dr-f", data: { name: "Dr F", url: "https://x.com/doctors/dr-f" }, sourceUrl: "https://directory.example/f" },
  ], fields);
  return db;
}

async function crawl(db: ReturnType<typeof openSqliteD1>, id: string, pages: CrawlPageResult[], completed: boolean) {
  await createAnalysis(db, { id, siteId: "s", status: "running", createdAt: completed ? AT : "2026-10-02T00:00:00.000Z" });
  if (!pages.length) return;
  await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "s", urls: pages.map((entry) => ({ url: entry.url, routeFamily: "doctors" })) });
  await saveCrawlBatch(db, { analysisId: id, outcomes: pages.map((entry) => ({ url: entry.url, page: entry })) });
  if (completed) await updateAnalysisStatus(db, id, "completed", { completedAt: AT });
}

describe("datasetInventoryRows", () => {
  it("matches record URLs to the crawl across slashes, fragments, scheme and www; tells gone from unreached; takes the page URL field, not the photo", async () => {
    const db = await seed();
    await crawl(db, "a1", [
      page("https://x.com/doctors/dr-a", 200, 1500), page("https://x.com/doctors/dr-b", 200, 60), page("https://x.com/doctors/dr-c", 404, 0), page("https://x.com/doctors/dr-f", 200, 900),
    ], true);
    const rows = await datasetInventoryRows(db, dataset);
    assert.equal(rows.records, 6);
    assert.deepEqual(rows.fills, { name: 6, photo: 2, url: 1, bio_en: 1 });
    assert.deepEqual(rows.pages, {
      linked: 5, thin: 1, gone: 1, unreached: 1,
      examples: { thin: ["https://x.com/doctors/dr-b"], gone: ["https://x.com/doctors/dr-c"] },
    }, "a, b, c, d and f point at the site; e points elsewhere");
  });

  it("reads the analysis it is given, even while that run is still going, and has no pages for a run without crawl rows", async () => {
    const db = await seed();
    await crawl(db, "a1", [page("https://x.com/doctors/dr-b", 200, 60)], true);
    await crawl(db, "a2", [page("https://x.com/doctors/dr-b", 200, 1500)], false);
    assert.equal((await datasetInventoryRows(db, dataset)).pages?.thin, 1, "the latest finished run by default");
    assert.equal((await datasetInventoryRows(db, dataset, "a2")).pages?.thin, 0, "the running analysis when asked");
    await crawl(db, "a3", [], false);
    assert.equal((await datasetInventoryRows(db, dataset, "a3")).pages, null, "no crawl rows, no page counts");
    const bare = openSqliteD1();
    await upsertSite(bare, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
    await upsertDataset(bare, dataset);
    assert.equal((await datasetInventoryRows(bare, dataset)).pages, null, "no finished analysis at all");
  });
});

describe("replaceRecords and deleteStaleRecords", () => {
  it("writes a source's rows in bulk, replacing what the source said before, and removes what a complete pull no longer has", async () => {
    const db = await seed();
    await upsertSource(db, { id: "src", siteId: "s", datasetId: "d", url: "https://abc.supabase.co", kind: "supabase", urlPattern: "doctors", maxPages: 40, origin: "user", status: "approved", recordCount: 0, createdAt: AT });
    const scope = { siteId: "s", datasetId: "d", sourceId: "src", sourceUrl: "https://abc.supabase.co" };
    const started = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await replaceRecords(db, scope, [{ key: "dr-a", data: { name: "Dr A" } }, { key: "dr-z", data: { name: "Dr Z", bio_en: "New." } }]), 2);
    const records = await listAllRecords(db, "d");
    assert.deepEqual(records.find((record) => record.key === "dr-a")?.data, { name: "Dr A" }, "the table is the authority: a blank bio erases the old one");
    assert.equal(records.find((record) => record.key === "dr-z")?.sourceId, "src");
    await db.prepare("UPDATE data_records SET source_id = 'src', updated_at = ? WHERE record_key = 'dr-b'").bind("2026-09-01T00:00:00.000Z").run();
    assert.equal(await deleteStaleRecords(db, "src", started), 1, "dr-b came from this source once and was not in the pull");
    assert.equal((await listAllRecords(db, "d")).length, 6, "dr-a, dr-z and the records of other sources stay");
  });
});

describe("deleteDataset", () => {
  it("drops the sealed keys of the dataset's Supabase sources", async () => {
    const db = await seed();
    await upsertSource(db, { id: "src", siteId: "s", datasetId: "d", url: "https://abc.supabase.co", kind: "supabase", urlPattern: "doctors", maxPages: 40, origin: "user", status: "approved", recordCount: 0, createdAt: AT });
    await upsertOAuthCredential(db, { id: "o1", siteId: "s", provider: "supabase:src", encryptedBlob: "sealed" });
    await upsertOAuthCredential(db, { id: "o2", siteId: "s", provider: "google", encryptedBlob: "sealed" });
    await deleteDataset(db, "d");
    assert.equal(await getOAuthCredential(db, "s", "supabase:src"), null);
    assert.ok(await getOAuthCredential(db, "s", "google"), "other credentials stay");
  });
});
