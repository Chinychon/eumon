import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult, Finding, KeyRow } from "@organic-growth/core";
import {
  createAnalysis, enqueueAnalysisCrawlUrls, FINDING_KEYS, getSnapshot, historyRuns, listCompletedAnalyses, listPublications, saveAnalysisReport, saveCrawlBatch,
  updateAnalysisStatus, upsertSite, type D1Like,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const finding = (id: string, title: string, pagesAffected: string[] = []): Finding => ({
  id, siteId: "s", analysisId: "a", category: "metadata", severity: "HIGH", title, summary: "", evidence: {}, organicImpactScore: 50, pagesAffected, createdAt: "2026-09-01T00:00:00.000Z",
});
const page = (url: string, status: number): CrawlPageResult => ({
  url, status, finalUrl: url, hreflang: [], jsonLdCount: 0, contentLength: 1000, isEmptyShell: false, headingOutline: [], internalLinkCount: 0, rawTextLength: 500, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot",
});

async function site(): Promise<D1Like> {
  const db = openSqliteD1();
  const now = "2026-09-01T00:00:00.000Z";
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  return db;
}

/** A run that crawled `crawl` (status per URL) and finished with `findings` at `completedAt`. */
async function finished(db: D1Like, id: string, completedAt: string, findings: Finding[], crawl: Record<string, number> = {}) {
  await createAnalysis(db, { id, siteId: "s", status: "running", createdAt: completedAt });
  const urls = Object.keys(crawl);
  if (urls.length) {
    await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "page" })) });
    await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: page(url, crawl[url]!) })) });
  }
  await saveAnalysisReport(db, id, { findings }, "done");
  // The save stamps the real clock; the test wants its own dates.
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(completedAt, id).run();
}

describe("history key lists", () => {
  it("saves a finished run's key list, flagging the previous run's findings whose pages all vanished in this crawl", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [
      finding("f1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"]),
      finding("f2", "Thin meta descriptions", ["https://x.com/c"]),
      finding("f3", "Weak or missing titles on indexable pages", ["https://x.com/never-crawled"]),
      finding("f4", "Multilingual pages missing hreflang in HTML"),
    ], { "https://x.com/a": 200, "https://x.com/b": 200, "https://x.com/c": 200 });
    await finished(db, "a2", "2026-09-15T00:00:00.000Z", [finding("f5", "Multilingual pages missing hreflang in HTML")], { "https://x.com/a": 404, "https://x.com/c": 200 });
    const first = await getSnapshot<KeyRow>(db, "s", FINDING_KEYS, "a1");
    assert.deepEqual(first?.rows.map((row) => row.id), ["f1", "f2", "f3", "f4"]);
    assert.equal(first?.rows[0]!.key, "metadata|canonical mismatches detected");
    const second = await getSnapshot<KeyRow>(db, "s", FINDING_KEYS, "a2");
    assert.deepEqual(second?.rows.map((row) => [row.id, row.vanished ?? false]), [["f5", false], ["f1", true]],
      "a and b vanished (404, missing); c is still live; never-crawled pages are unknown, not vanished; f4 has no pages");
  });

  it("fills key lists for runs saved before this feature from their reports, and leaves existing lists alone", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions")]);
    await finished(db, "a2", "2026-09-15T00:00:00.000Z", [finding("f2", "Thin meta descriptions"), finding("f3", "Canonical mismatches detected")]);
    await finished(db, "a3", "2026-10-01T00:00:00.000Z", [finding("f4", "Canonical mismatches detected")]);
    // As if a1 and a3 finished before key lists existed.
    await db.prepare("DELETE FROM site_snapshots WHERE kind = ? AND scope IN ('a1', 'a3')").bind(FINDING_KEYS).run();
    await db.prepare("UPDATE site_snapshots SET rows_json = ? WHERE kind = ? AND scope = 'a2'").bind(JSON.stringify([{ id: "kept", key: "metadata|kept", title: "Kept", category: "metadata", severity: "LOW", pages: [] }]), FINDING_KEYS).run();
    const runs = await historyRuns(db, "s");
    assert.deepEqual(runs.map((run) => [run.analysisId, run.completedAt, run.keys.map((row) => row.id)]), [
      ["a1", "2026-09-01T00:00:00.000Z", ["f1"]],
      ["a2", "2026-09-15T00:00:00.000Z", ["kept"]],
      ["a3", "2026-10-01T00:00:00.000Z", ["f4"]],
    ]);
    assert.ok(await getSnapshot(db, "s", FINDING_KEYS, "a1"), "the filled list is saved");
    assert.deepEqual((await historyRuns(db, "s")).map((run) => run.keys.length), [1, 1, 1], "a second call changes nothing");
  });

  it("counts only finished runs with a report, oldest first, within the window", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", []);
    await createAnalysis(db, { id: "stopped", siteId: "s", status: "running", createdAt: "2026-09-02T00:00:00.000Z" });
    await updateAnalysisStatus(db, "stopped", "cancelled");
    await createAnalysis(db, { id: "broken", siteId: "s", status: "running", createdAt: "2026-09-03T00:00:00.000Z" });
    await updateAnalysisStatus(db, "broken", "failed", { error: "boom" });
    await finished(db, "a2", "2026-09-04T00:00:00.000Z", []);
    await finished(db, "a3", "2026-09-05T00:00:00.000Z", []);
    assert.deepEqual((await listCompletedAnalyses(db, "s")).map((run) => run.id), ["a1", "a2", "a3"]);
    assert.deepEqual((await listCompletedAnalyses(db, "s", 2)).map((run) => run.id), ["a2", "a3"], "the window keeps the latest");
  });

  it("groups published pages by day and template, newest day first", async () => {
    const db = await site();
    const at = "2026-09-01T00:00:00.000Z";
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'Doctors', 'doctor', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'Doctors', '{}', 'active', ?, ?)`).bind(at, at).run();
    const insert = (id: string, publishedAt: string | null) => db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, 'x', '', '{}', 1, '[]', ?, ?, ?, ?)`).bind(id, `/doctors/${id}`, id, publishedAt ? "published" : "draft", publishedAt, at, at).run();
    await insert("p1", "2026-09-03T09:00:00.000Z");
    await insert("p2", "2026-09-03T11:00:00.000Z");
    await insert("p3", "2026-09-05T09:00:00.000Z");
    await insert("p4", null);
    assert.deepEqual(await listPublications(db, "s"), [
      { templateId: "t", template: "Doctors", day: "2026-09-05", pages: 1 },
      { templateId: "t", template: "Doctors", day: "2026-09-03", pages: 2 },
    ]);
  });
});
