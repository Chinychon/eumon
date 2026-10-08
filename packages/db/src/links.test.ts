import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, getLinkGraph, saveCrawlBatch, updateAnalysisStatus, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const u = (path: string) => `https://x.com${path}`;
const family = (path: string) => (path === "/" ? "home" : path.split("/").length > 2 ? path.split("/")[1]! : "page");

function page(path: string, links: string[]): CrawlPageResult {
  return {
    url: u(path), status: 200, finalUrl: u(path), hreflang: [], jsonLdCount: 0, contentLength: 5000, isEmptyShell: false, headingOutline: [],
    internalLinkCount: links.length, rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", routeFamily: family(path),
    internalLinks: links.map((link) => ({ path: link, family: family(link || "/") })),
  };
}

describe("link graph", async () => {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
  const paths = ["/", "/blog/a", "/blog/b", "/doctors/amy", "/doctors/ben"];
  await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: paths.map((path) => ({ url: u(path), routeFamily: family(path) })) });
  await saveCrawlBatch(db, { analysisId: "a1", outcomes: [
    { url: u("/"), page: page("/", ["/blog/a", "/doctors/amy", "/guides/implants"]) },
    { url: u("/blog/a"), page: page("/blog/a", ["", "/blog/b", "/doctors/amy", "/stale"]) },
    { url: u("/blog/b"), page: page("/blog/b", ["/blog/b"]) },
    { url: u("/doctors/amy"), page: page("/doctors/amy", [""]) },
    { url: u("/doctors/ben"), page: page("/doctors/ben", []) },
  ] });
  // Fetched again, a page's links replace the ones it had.
  await saveCrawlBatch(db, { analysisId: "a1", outcomes: [{ url: u("/blog/a"), page: page("/blog/a", ["", "/blog/b", "/doctors/amy"]) }] });
  await updateAnalysisStatus(db, "a1", "completed", { completedAt: now });

  await db.prepare(`INSERT INTO datasets (id, site_id, name, entity_type, description, fields_json, key_field, page_ideas_json, status, created_at, updated_at)
    VALUES ('d', 's', 'Treatments', 'treatment', '', '[]', 'name', '[]', 'active', ?, ?)`).bind(now, now).run();
  await db.prepare(`INSERT INTO page_templates (id, site_id, dataset_id, name, config_json, status, created_at, updated_at)
    VALUES ('t', 's', 'd', 'Treatment guides', '{}', 'active', ?, ?)`).bind(now, now).run();
  for (const slug of ["implants", "braces"]) {
    await db.prepare(`INSERT INTO generated_pages (id, site_id, template_id, path, group_key, title, description, content_json, quality_score, quality_issues_json, status, created_at, updated_at)
      VALUES (?, 's', 't', ?, ?, ?, '', '{}', 1, '[]', 'published', ?, ?)`).bind(`g_${slug}`, `/guides/${slug}`, slug, slug, now, now).run();
  }

  it("counts links between page types, not within one, from the latest crawl", async () => {
    const graph = await getLinkGraph(db, "s");
    const edge = (source: string, target: string) => graph.edges.find((entry) => entry.source === source && entry.target === target)?.links;
    assert.equal(edge("f:home", "f:blog"), 1);
    assert.equal(edge("f:blog", "f:doctors"), 1);
    assert.equal(edge("f:doctors", "f:home"), 1);
    assert.equal(edge("f:blog", "f:blog"), undefined, "links within a page type are left out");
    assert.deepEqual(graph.nodes.find((node) => node.id === "f:doctors"), { id: "f:doctors", label: "doctors", kind: "site", pages: 2 });
    const stale = await db.prepare("SELECT COUNT(*) AS n FROM page_links WHERE target_path = '/stale'").first<{ n: number }>();
    assert.equal(stale?.n, 0, "the link /blog/a dropped is gone after it was fetched again");
  });

  it("finds pages nothing else links to, ignoring self-links and the homepage", async () => {
    const graph = await getLinkGraph(db, "s");
    assert.deepEqual(graph.orphans, { count: 1, examples: [u("/doctors/ben")] }, "/blog/b only links to itself, but /blog/a links to it");
  });

  it("counts Eumon's pages the site links to, as an edge into their template", async () => {
    const graph = await getLinkGraph(db, "s");
    assert.deepEqual(graph.landingPages, { published: 2, linkedFromSite: 1 });
    assert.equal(graph.edges.find((entry) => entry.target === "t:t")?.source, "f:home");
    assert.deepEqual(graph.nodes.find((node) => node.id === "t:t"), { id: "t:t", label: "Treatment guides", kind: "eumon", pages: 2 });
  });
});

describe("link graph before every page's links are known", async () => {
  it("holds back the orphan count until most of the crawl's pages have their links recorded", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
    const paths = ["/", "/blog/a", "/blog/b", "/doctors/amy", "/doctors/ben"];
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: paths.map((path) => ({ url: u(path), routeFamily: family(path) })) });
    // Crawled before links were kept: four pages have no recorded links.
    const old = (path: string) => { const { internalLinks: _links, ...rest } = page(path, []); return rest; };
    await saveCrawlBatch(db, { analysisId: "a1", outcomes: [
      { url: u("/"), page: page("/", ["/blog/a"]) },
      ...paths.slice(1).map((path) => ({ url: u(path), page: old(path) })),
    ] });
    await updateAnalysisStatus(db, "a1", "completed", { completedAt: now });
    const graph = await getLinkGraph(db, "s");
    assert.equal(graph.orphans, null, "an orphan count from 1 page's links would be wrong");
    assert.deepEqual(graph.linkCoverage, { recorded: 1, pages: 5 });
  });

  it("counts pages whose links were saved before the 'recorded' marker existed", async () => {
    const db = openSqliteD1();
    const now = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
    await createAnalysis(db, { id: "a1", siteId: "s", status: "running", createdAt: now });
    const paths = ["/", "/blog/a"];
    await enqueueAnalysisCrawlUrls(db, { analysisId: "a1", siteId: "s", urls: paths.map((path) => ({ url: u(path), routeFamily: family(path) })) });
    await saveCrawlBatch(db, { analysisId: "a1", outcomes: [{ url: u("/"), page: page("/", ["/blog/a"]) }, { url: u("/blog/a"), page: page("/blog/a", [""]) }] });
    await db.prepare("UPDATE pages SET result_json = json_remove(result_json, '$.linksRecorded')").run();
    await updateAnalysisStatus(db, "a1", "completed", { completedAt: now });
    assert.deepEqual((await getLinkGraph(db, "s")).linkCoverage, { recorded: 2, pages: 2 });
  });
});
