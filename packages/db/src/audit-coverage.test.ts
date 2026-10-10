import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlPageResult } from "@organic-growth/core";
import { createAnalysis, enqueueAnalysisCrawlUrls, getCrawlCoverage, linkGraphIssues, saveCrawlBatch, upsertSite } from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

const u = (path: string) => `https://x.com${path}`;
const family = (path: string) => (path === "/" ? "home" : path.split("/").filter(Boolean).length > 1 ? path.split("/")[1]! : "page");
/** A page as a crawl from before the content signals saw it. */
const legacy = (path: string, overrides: Partial<CrawlPageResult> = {}): CrawlPageResult => ({
  url: u(path), status: 200, finalUrl: u(path), title: `A good title for the ${path} page on x.com`, description: `A description of ${path} that is long enough to count as one.`,
  hreflang: [], jsonLdCount: 1, contentLength: 5000, isEmptyShell: false, headingOutline: ["h1:A"], internalLinkCount: 5,
  rawTextLength: 3000, renderedTextLength: 0, renderDelta: 0, fetchMode: "googlebot", h1Count: 1, noindex: false, jsonLdTypes: ["WebPage"], invalidJsonLd: 0,
  canonicalMismatch: false, locale: "default", routeFamily: family(path), ...overrides,
});
/** A page as the current crawler saves it: the always-written content fields are present. */
const current = (path: string, overrides: Partial<CrawlPageResult> = {}): CrawlPageResult => legacy(path, {
  viewport: true, lang: "en", words: 400, leadWords: 40, images: 2, landmarks: 3, listsOrTables: true, articleLike: false, author: false, entitySchema: false, ...overrides,
});

async function site(pages: CrawlPageResult[], links: Array<[string, string]> = []) {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: now, updatedAt: now });
  await createAnalysis(db, { id: "an1", siteId: "s", status: "running", createdAt: now });
  await enqueueAnalysisCrawlUrls(db, { analysisId: "an1", siteId: "s", urls: pages.map((page) => ({ url: page.url, routeFamily: page.routeFamily ?? "page" })) });
  // Links are recorded only when the test gives some, as a crawl from before link tracking would have none.
  const linked = links.length ? pages.map((page) => ({ ...page, internalLinks: links.filter(([from]) => u(from) === page.url).map(([, to]) => ({ path: to === "/" ? "" : to, family: family(to) })) })) : pages;
  await saveCrawlBatch(db, { analysisId: "an1", outcomes: linked.map((page) => ({ url: page.url, page })) });
  return db;
}

describe("audit coverage", () => {
  it("counts the new issues and the unhealthy pages per pillar, treating absent fields as not checked", async () => {
    const db = await site([
      current("/a"),
      current("/b", { mixedContent: 2, redirectHops: 2, finalUrl: u("/b-final") }),
      current("/c", { snippetBlocked: true }),
      current("/d", { noindex: true }),
      legacy("/e"),
      legacy("/f", { status: 500, title: undefined }),
      current("/doctors/g", { words: 80, articleLike: true, modified: "2020-01-01", lang: undefined, viewport: false, title: "Dr G" }),
    ]);
    const c = await getCrawlCoverage(db, "an1");
    assert.equal(c.issues?.mixedContent, 1);
    assert.equal(c.issues?.redirectChain, 1);
    assert.equal(c.issues?.redirected, 0, "a chain is not counted as a single redirect");
    assert.equal(c.issues?.snippetBlocked, 1);
    assert.equal(c.issues?.thinContent, 1);
    assert.equal(c.issues?.stale, 1);
    assert.equal(c.issues?.noAuthor, 1);
    assert.equal(c.issues?.langMissing, 1, "the legacy rows are not counted");
    assert.equal(c.issues?.viewportMissing, 1, "the legacy rows are not counted");
    assert.equal(c.issues?.titleLength, 1, "Dr G is under 30 characters; legacy titles are not checked");
    assert.deepEqual(c.issueExamples?.snippetBlocked, [{ url: u("/c") }]);
    // indexable: a, b (a chain stays in), c, e, f, g; unhealthy SEO: b (mixed content, chain), f (500), g (weak title); AI: c (snippet), f
    assert.deepEqual(c.health, { indexable: 6, unhealthySeo: 3, unhealthyAi: 2, checked: true });
  });

  it("says the health is unchecked when no row carries the new fields", async () => {
    const c = await getCrawlCoverage(await site([legacy("/e"), legacy("/doctors/x")]), "an1");
    assert.equal(c.health?.checked, false);
    assert.equal(c.issues?.thinContent, 0);
    assert.equal(c.issues?.viewportMissing, 0);
  });

  it("groups duplicate descriptions", async () => {
    const c = await getCrawlCoverage(await site([current("/a", { description: "Same words on every page of the site here." }), current("/b", { description: "Same words on every page of the site here." }), current("/c")]), "an1");
    assert.equal(c.issues?.duplicateDescription, 2);
    assert.equal(c.duplicateDescriptionGroups?.[0]?.count, 2);
  });
});

describe("link graph", () => {
  const pages = ["/", "/a", "/b", "/c", "/d", "/orphan"].map((path) => current(path)).concat(legacy("/gone", { status: 404, title: "Not found" }));
  const links: Array<[string, string]> = [["/", "/a"], ["/a", "/b"], ["/b", "/c"], ["/c", "/d"], ["/a", "/gone"]];

  it("finds orphans, single-inbound pages, broken links and deep pages", async () => {
    const r = await linkGraphIssues(await site(pages, links), "s", "an1");
    assert.deepEqual(r.orphans, { count: 1, examples: [u("/orphan")] });
    assert.equal(r.singleInbound?.count, 4, "a, b, c and d each have one link in");
    assert.deepEqual(r.brokenLinks, { links: 1, sources: 1, targets: [{ path: "/gone", status: 404, from: 1 }] });
    assert.deepEqual(r.depth, { deep: 1, examples: [u("/d")] });
  });

  it("skips the depth query on a large link table", async () => {
    const r = await linkGraphIssues(await site(pages, links), "s", "an1", { maxLinkRows: 3 });
    assert.equal(r.depth?.skipped, "The link map has more than 3 rows; depth is not computed.");
  });

  it("reports nothing when the crawl recorded no links", async () => {
    assert.deepEqual(await linkGraphIssues(await site(pages), "s", "an1"), { orphans: null, singleInbound: null, brokenLinks: null, depth: null });
  });

  it("is part of the coverage", async () => {
    const c = await getCrawlCoverage(await site(pages, links), "an1");
    assert.equal(c.linkGraph?.orphans?.count, 1);
  });
});
