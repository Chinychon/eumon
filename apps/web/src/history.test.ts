import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangeStatus, CrawlPageResult, Finding } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, insertChange, insertCtaVariant, saveAnalysisReport, saveCrawlBatch, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { DEMO_SITE_ID, seedDemoSite } from "@organic-growth/agents";
import { assembleHistory } from "./history.ts";

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

async function finished(db: D1Like, id: string, completedAt: string, findings: Finding[], crawl: Record<string, number> = {}) {
  await createAnalysis(db, { id, siteId: "s", status: "running", createdAt: completedAt });
  const urls = Object.keys(crawl);
  if (urls.length) {
    await enqueueAnalysisCrawlUrls(db, { analysisId: id, siteId: "s", urls: urls.map((url) => ({ url, routeFamily: "page" })) });
    await saveCrawlBatch(db, { analysisId: id, outcomes: urls.map((url) => ({ url, page: page(url, crawl[url]!) })) });
  }
  await saveAnalysisReport(db, id, { findings }, "done");
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(completedAt, id).run();
}

/** A change for a finding; its PR number is the id's length, so "c1" opens pull request #2. */
const change = (db: D1Like, id: string, findingId: string | undefined, createdAt: string, status: ChangeStatus = "merged") => insertChange(db, {
  id, siteId: "s", analysisId: "a1", findingId, title: `Fix for ${findingId ?? "nothing"}`, reason: "Because.", evidence: {}, filesChanged: ["app/page.tsx"], pagesAffected: [], patch: "",
  status, prUrl: `https://github.com/x/y/pull/${id.length}`, prNumber: id.length, author: "eumon", createdAt,
});

describe("history", () => {
  it("attributes a resolved finding to the merged change made for it, and the rest to the analysis", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions"), finding("f2", "Canonical mismatches detected", ["https://x.com/a"])], { "https://x.com/a": 200 });
    await change(db, "c1", "f1", "2026-09-05T00:00:00.000Z");
    await change(db, "c2", "f2", "2026-09-20T00:00:00.000Z", "proposed");
    await finished(db, "a2", "2026-09-10T00:00:00.000Z", [], { "https://x.com/a": 200 });
    const history = await assembleHistory(db, "s");
    assert.equal(history.runs, 2);
    assert.equal(history.open, 0);
    assert.deepEqual(history.numbers, { resolved: 2, fixedWithEumon: 1, noLongerApplies: 0, actions: 1 });
    const fixed = history.rows.find((row) => row.kind === "fixed")!;
    assert.equal(fixed.title, "Thin meta descriptions");
    assert.equal(fixed.detail, "Pull request #2: Fix for f1");
    assert.equal(fixed.href, "https://github.com/x/y/pull/2");
    assert.equal(fixed.since, "2026-09-01T00:00:00.000Z");
    assert.equal(fixed.at, "2026-09-10T00:00:00.000Z");
    assert.equal(fixed.category, "metadata");
    const resolved = history.rows.find((row) => row.kind === "resolved")!;
    assert.equal(resolved.title, "Canonical mismatches detected", "a proposed change fixes nothing");
    assert.deepEqual(history.rows.map((row) => row.kind), ["fixed", "resolved", "change"], "newest first; the two resolutions share a date and come before the earlier PR");
  });

  it("credits the change made in each stretch when a problem comes back and is fixed again", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions")]);
    await change(db, "c1", "f1", "2026-09-03T00:00:00.000Z");
    await finished(db, "a2", "2026-09-05T00:00:00.000Z", []);
    await finished(db, "a3", "2026-09-10T00:00:00.000Z", [finding("f2", "Thin meta descriptions")]);
    await change(db, "c2", "f2", "2026-09-12T00:00:00.000Z");
    await finished(db, "a4", "2026-09-15T00:00:00.000Z", []);
    const history = await assembleHistory(db, "s");
    assert.deepEqual(history.rows.filter((row) => row.kind === "fixed" || row.kind === "resolved").map((row) => [row.kind, row.at.slice(0, 10), row.detail]), [
      ["fixed", "2026-09-15", "Pull request #2: Fix for f2"],
      ["fixed", "2026-09-05", "Pull request #2: Fix for f1"],
    ], "each resolution takes the change made within its own stretch");
  });

  it("says a finding no longer applies when its pages vanished, and ignores a change naming an unknown finding", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Canonical mismatches detected", ["https://x.com/a", "https://x.com/b"])], { "https://x.com/a": 200, "https://x.com/b": 200 });
    await change(db, "c1", "finding_from_long_ago", "2026-09-05T00:00:00.000Z");
    await finished(db, "a2", "2026-09-10T00:00:00.000Z", [], { "https://x.com/a": 410 });
    const history = await assembleHistory(db, "s");
    assert.deepEqual(history.numbers, { resolved: 1, fixedWithEumon: 0, noLongerApplies: 1, actions: 1 });
    assert.equal(history.rows[0]!.kind, "vanished");
    assert.equal(history.rows[0]!.detail, "Every page it pointed at is gone or erroring, so it no longer applies.");
  });

  it("lists Eumon's actions newest first: pull requests, page edits with their effect, CTA tests and publications", async () => {
    const db = await site();
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", []);
    await change(db, "c1", undefined, "2026-09-02T00:00:00.000Z", "pr_opened");
    await insertCtaVariant(db, { id: "v1", siteId: "s", label: "Book now", copy: "Book a visit", url: "https://x.com/book", impressions: 0, clicks: 0, active: true, createdAt: "2026-09-03T00:00:00.000Z" });
    const at = "2026-09-01T00:00:00.000Z";
    await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at) VALUES ('d', 's', 'Doctors', 'doctor', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at) VALUES ('t', 's', 'd', 'Doctors', '{}', 'active', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, published_at, created_at, updated_at)
      VALUES ('p1', 's', 't', '/doctors/lee', 'lee', 'Dr Lee', '', '{}', 1, '[]', 'published', '2026-09-04T00:00:00.000Z', ?, ?)`).bind(at, at).run();
    await db.prepare(`INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at) VALUES ('r1', 'p1', 'title', 'Dr Lee', 'Dr Lee, dentist in KL', 'Snippet rewrite', 'owner', '2026-09-05T00:00:00.000Z')`).run();
    const history = await assembleHistory(db, "s");
    assert.equal(history.numbers.actions, 4);
    assert.deepEqual(history.rows.map((row) => [row.kind, row.at.slice(0, 10), row.title]), [
      ["edit", "2026-09-05", "Edited title of /doctors/lee"],
      ["publish", "2026-09-04", "Published 1 page from Doctors"],
      ["cta", "2026-09-03", "Started CTA test: Book now"],
      ["change", "2026-09-02", "Pull request #2: Fix for nothing"],
    ]);
    assert.match(history.rows[0]!.detail, /^Snippet rewrite\. \d+ days after: 0 views and 0 CTA clicks \(0 and 0 before\)\.$/);
    assert.equal(history.rows[0]!.view, "performance");
    assert.equal(history.rows[1]!.view, "pages");
    assert.equal(history.rows[3]!.href, "https://github.com/x/y/pull/2");
  });

  it("has nothing to say with one run, and nothing at all with none", async () => {
    const db = await site();
    assert.deepEqual(await assembleHistory(db, "s"), { runs: 0, open: 0, numbers: { resolved: 0, fixedWithEumon: 0, noLongerApplies: 0, actions: 0 }, rows: [] });
    await finished(db, "a1", "2026-09-01T00:00:00.000Z", [finding("f1", "Thin meta descriptions")]);
    const history = await assembleHistory(db, "s");
    assert.equal(history.runs, 1);
    assert.equal(history.open, 1);
    assert.deepEqual(history.rows, []);
  });

  it("shows the demo site a fix, resolved findings and its publications", async () => {
    const db = openSqliteD1();
    await seedDemoSite(db, Date.now());
    const history = await assembleHistory(db, DEMO_SITE_ID);
    assert.equal(history.runs, 2);
    assert.ok(history.numbers.fixedWithEumon >= 1, `fixed ${history.numbers.fixedWithEumon}`);
    assert.ok(history.numbers.resolved > history.numbers.fixedWithEumon, `resolved ${history.numbers.resolved}`);
    assert.ok(history.rows.some((row) => row.kind === "publish"), "published pages are actions");
    const fixed = history.rows.find((row) => row.kind === "fixed")!;
    assert.match(fixed.detail, /^Pull request #12: /);
  });
});
