import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS, checkList, finding } from "@organic-growth/core";
import { auditTable, pillarScores, type AuditContext } from "./audit.js";

const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  findings: [],
  coverage: { completedUrls: 10, totalUrls: 10, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 0, issues: {}, health: { indexable: 10, unhealthySeo: 2, unhealthyAi: 1, checked: true } },
  hasRepo: false, hasSearch: false, hasLogs: false, hasDataset: false, rendered: false, languages: 1, hasDataForSeo: false, robotsReadable: true, probed: true,
  ...over,
});
const base = { siteId: "s", analysisId: "a", title: "t", summary: "s", evidence: {}, impact: 50 };

describe("auditTable", () => {
  it("lists every check as passed, failed or skipped", () => {
    const rows = auditTable(ctx({ findings: [finding(CHECKS["title.weak"]!, { ...base, pagesAffected: ["u1", "u2"] }), finding(CHECKS["heading.h1_missing"]!, { ...base, pagesAffected: ["u1"] })], coverage: { ...ctx().coverage!, issues: { missingH1: 40 } } }));
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(rows.length, checkList().length);
    assert.deepEqual(by["title.weak"], { id: "title.weak", status: "failed", pages: 2 });
    assert.deepEqual(by["heading.h1_missing"], { id: "heading.h1_missing", status: "failed", pages: 40 }, "coverage counts every page; pagesAffected holds examples");
    assert.deepEqual(by["title.length"], { id: "title.length", status: "passed" });
    assert.deepEqual(by["repo.client_fetch"], { id: "repo.client_fetch", status: "skipped", reason: "a connected repository" });
    assert.deepEqual(by["hreflang.missing"], { id: "hreflang.missing", status: "skipped", reason: "two or more languages" });
    assert.deepEqual(by["search.low_ctr"], { id: "search.low_ctr", status: "skipped", reason: "Search Console" });
  });

  it("counts pages from coverage counters for checks without per-issue counts, and never shows a failed check as 0 pages", () => {
    const coverage = { ...ctx().coverage!, httpErrorUrls: 14, emptyShellUrls: 9, linkGraph: { orphans: { count: 8, examples: [] }, singleInbound: null, brokenLinks: { links: 30, sources: 6, targets: [] }, depth: null } };
    const rows = auditTable(ctx({ coverage, findings: [finding(CHECKS["http.error"]!, base), finding(CHECKS["render.empty_shell"]!, base), finding(CHECKS["links.broken_internal"]!, base), finding(CHECKS["links.orphan"]!, base), finding(CHECKS["robots.googlebot_blocked"]!, base)] }));
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(by["http.error"]!.pages, 14);
    assert.equal(by["render.empty_shell"]!.pages, 9);
    assert.equal(by["links.broken_internal"]!.pages, 6, "the pages carrying broken links");
    assert.equal(by["links.orphan"]!.pages, 8);
    assert.deepEqual(by["robots.googlebot_blocked"], { id: "robots.googlebot_blocked", status: "failed" }, "a site-wide check has no page count");
  });

  it("marks the new crawl checks skipped when the crawl predates the new fields", () => {
    const old = ctx({ coverage: { ...ctx().coverage!, health: { indexable: 10, unhealthySeo: 0, unhealthyAi: 0, checked: false } } });
    const rows = auditTable(old);
    assert.deepEqual(rows.find((row) => row.id === "content.thin"), { id: "content.thin", status: "skipped", reason: "run a full crawl once after deploying" });
    assert.equal(rows.find((row) => row.id === "heading.h1_missing")!.status, "passed", "checks that existed before still run");
  });

  it("skips crawl checks without a full crawl, and probe checks without a probe", () => {
    const rows = auditTable(ctx({ coverage: undefined, probed: false }));
    assert.deepEqual(rows.find((row) => row.id === "security.mixed_content"), { id: "security.mixed_content", status: "skipped", reason: "a full crawl" });
    assert.deepEqual(rows.find((row) => row.id === "security.hsts_missing"), { id: "security.hsts_missing", status: "skipped", reason: "the AI crawler and host probe" });
  });

  it("skips the link checks when the crawl did not record links", () => {
    const rows = auditTable(ctx({ coverage: { ...ctx().coverage!, linkGraph: { orphans: null, singleInbound: null, brokenLinks: null, depth: null } } }));
    for (const id of ["links.orphan", "links.broken_internal", "links.single_inbound", "links.depth"]) {
      assert.deepEqual(rows.find((row) => row.id === id), { id, status: "skipped", reason: "a full crawl with links recorded" });
    }
    assert.equal(auditTable(ctx({ coverage: { ...ctx().coverage!, linkGraph: undefined } })).find((row) => row.id === "links.orphan")!.status, "skipped");
  });

  it("skips the rank checks for a site that tracks no keywords", () => {
    assert.deepEqual(auditTable(ctx()).find((row) => row.id === "rank.fell"), { id: "rank.fell", status: "skipped", reason: "tracked keywords" });
    assert.equal(auditTable(ctx({ hasRanks: true })).find((row) => row.id === "rank.fell")!.status, "passed");
  });

  it("skips the crawler probe when robots.txt was unreadable", () => {
    assert.deepEqual(auditTable(ctx({ robotsReadable: false })).find((row) => row.id === "ai.crawler_refused"), { id: "ai.crawler_refused", status: "skipped", reason: "robots.txt could not be read" });
  });
});

describe("pillarScores", () => {
  it("scores each pillar from the coverage's unhealthy counts", () => {
    assert.deepEqual(pillarScores(ctx()), { seo: { value: 80, indexable: 10, unhealthy: 2 }, ai: { value: 90, indexable: 10, unhealthy: 1 } });
  });

  it("is null without the new fields or a full crawl, with the reason", () => {
    const old = ctx({ coverage: { ...ctx().coverage!, health: { indexable: 10, unhealthySeo: 0, unhealthyAi: 0, checked: false } } });
    assert.deepEqual(pillarScores(old).seo, { value: null, indexable: 10, unhealthy: 0, reason: "run a full crawl once after deploying" });
    assert.deepEqual(pillarScores(ctx({ coverage: undefined })).ai, { value: null, indexable: 0, unhealthy: 0, reason: "no finished full crawl" });
  });

  it("is zero when a site-wide error of the pillar stands, and says which", () => {
    const blocked = finding(CHECKS["robots.googlebot_blocked"]!, { ...base, title: "robots.txt blocks Googlebot from the entire site", severity: "CRITICAL" });
    const scores = pillarScores(ctx({ findings: [blocked] }));
    assert.deepEqual(scores.seo, { value: 0, indexable: 10, unhealthy: 2, reason: "robots.txt blocks Googlebot from the entire site" });
    assert.equal(scores.ai.value, 90, "an SEO error does not zero the AI score");
  });

  it("zeroes the SEO score only for problems that stop indexing", () => {
    for (const id of ["server.soft_404_probe", "robots.foreign_sitemap", "server.http_not_redirected"]) {
      assert.equal(pillarScores(ctx({ findings: [finding(CHECKS[id]!, base)] })).seo.value, 80, id);
    }
    assert.equal(pillarScores(ctx({ findings: [finding(CHECKS["indexing.homepage_noindex"]!, base)] })).seo.value, 0);
  });

  it("does not zero the AI score for deliberate robots.txt blocks or an unreadable robots.txt", () => {
    const blocks = finding(CHECKS["robots.ai_blocked"]!, { ...base, severity: "INFORMATIONAL" });
    assert.equal(pillarScores(ctx({ findings: [blocks], robotsReadable: false })).ai.value, 90);
  });

  it("zeroes the AI score only when every search crawler robots.txt allows is refused", () => {
    const refused = finding(CHECKS["ai.crawler_refused"]!, { ...base, title: "The firewall refuses PerplexityBot", impact: 75 });
    const probe = (refusedOai: number) => [
      { agent: "PerplexityBot", search: true, allowedByRobots: true, fetched: 2, refused: 2, challenge: true },
      { agent: "OAI-SearchBot", search: true, allowedByRobots: true, fetched: 2, refused: refusedOai, challenge: false },
      { agent: "GPTBot", search: false, allowedByRobots: true, fetched: 2, refused: 0, challenge: false },
    ];
    assert.equal(pillarScores(ctx({ findings: [refused], probe: probe(0) })).ai.value, 90);
    assert.deepEqual(pillarScores(ctx({ findings: [refused], probe: probe(2) })).ai, { value: 0, indexable: 10, unhealthy: 1, reason: "The firewall refuses PerplexityBot" });
  });
});
