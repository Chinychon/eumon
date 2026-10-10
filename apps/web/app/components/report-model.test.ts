import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditCounts, checksFor, doFirst, gapsFirst, pageTypeHealth, pillarOf, resolveLink, servedShare, type Finding, type Report } from "./report-model.ts";

const finding = (title: string, severity: string, impact: number, category = "rendering"): Finding =>
  ({ id: title, category, severity, title, summary: "", organicImpactScore: impact });

describe("report model", () => {
  it("takes the backlog from the opportunities, urgent fixes first, each pointing at the area that explains it", () => {
    const actions = doFirst({
      findings: [finding("No analytics or conversion tracking found", "MEDIUM", 45, "conversion"), finding("Empty prices", "HIGH", 77)],
      opportunities: [
        { title: "Resolve: Empty prices", rationale: "", priorityScore: 59, intent: "technical_enabler" },
        { title: "Push implants", rationale: "", priorityScore: 156, intent: "commercial (query-pattern heuristic)" },
        { title: "Resolve: No analytics or conversion tracking found", rationale: "", priorityScore: 20, intent: "technical_enabler" },
        { title: "Rank for “veneers”", rationale: "", priorityScore: 31, intent: "keyword_gap" },
        { title: "Resolve: A finding from an older run", rationale: "", priorityScore: 10, intent: "technical_enabler" },
        { title: "Publish landing pages from your Dentists data", rationale: "", priorityScore: 5, intent: "unpublished_data" },
      ],
    } as never, 6);
    assert.deepEqual(actions.map((action) => [action.title, action.area]), [
      ["Resolve: Empty prices", "technical"],
      ["Push implants", "search"],
      ["Rank for “veneers”", "keywords"],
      ["Resolve: No analytics or conversion tracking found", "leads"],
      ["Resolve: A finding from an older run", "technical"],
      ["Publish landing pages from your Dentists data", "data"],
    ]);
    assert.equal(doFirst({ findings: [], opportunities: [] }).length, 0);
  });

  it("sends old links to the page that now holds their content", () => {
    assert.deepEqual(resolveLink("overview", "search"), { view: "overview", tab: "search" });
    assert.deepEqual(resolveLink("overview", "leads"), { view: "overview", tab: "enquiries" });
    assert.deepEqual(resolveLink("results", null), { view: "overview", tab: "search" });
    assert.deepEqual(resolveLink("results", "enquiries"), { view: "overview", tab: "enquiries" });
    assert.deepEqual(resolveLink("keywords", null), { view: "overview", tab: "keywords" });
    assert.deepEqual(resolveLink("competitors", null), { view: "overview", tab: "competitors" });
    assert.deepEqual(resolveLink("overview", "technical"), { view: "overview", tab: "technical" });
    assert.deepEqual(resolveLink("connections", null), { view: "setup", tab: null });
  });

  it("measures each problem against the pages it applies to, and skips schema on top-level pages", () => {
    const [prices, page] = pageTypeHealth([
      { family: "page", urls: 13, crawled: 12, emptyShells: 0, errors: 0, noindex: 0, missingStructuredData: 12 },
      { family: "prices", urls: 660, crawled: 660, emptyShells: 140, errors: 0, noindex: 0, missingStructuredData: 0 },
    ]);
    assert.equal(prices!.label, "/prices/");
    assert.deepEqual(prices!.cells[0], { key: "emptyShells", label: "Empty HTML", count: 140, share: 140 / 660, applies: true });
    assert.equal(page!.cells[3]!.applies, false);
    assert.equal(page!.cells[3]!.count, 0);
  });

  it("counts only intact pages as served, and orders gaps by the competitor's lead", () => {
    assert.equal(servedShare({ totalUrls: 100, completedUrls: 98, emptyShellUrls: 8, httpErrorUrls: 2 } as never), 0.88);
    assert.equal(servedShare(null), null);
    const rows = gapsFirst({ rows: [
      { key: "blog", label: "Blog", status: "advantage", you: { pages: 900 }, competitors: [{ domain: "a", pages: 400, examples: [] }] },
      { key: "prices", label: "Prices", status: "shared", you: { pages: 660 }, competitors: [{ domain: "a", pages: 1500, examples: [] }] },
      { key: "reviews", label: "Reviews", status: "gap", you: { pages: 0 }, competitors: [{ domain: "b", pages: 400, examples: [] }] },
    ], competitors: [], insights: [], aiLabels: false } as never);
    assert.deepEqual(rows.map((row) => row.key), ["prices", "reviews", "blog"]);
  });
});

import * as model from "./report-model.ts";

describe("urlPath", () => {
  it("keeps the path and query of a URL and shows the homepage as /", () => {
    assert.equal(model.urlPath("https://x.com/doctors/amy?lang=id"), "/doctors/amy?lang=id");
    assert.equal(model.urlPath("https://x.com"), "/");
  });
});

describe("audit in the report", () => {
  it("derives the pillar from the check id, else from the category for old reports", () => {
    assert.equal(pillarOf({ category: "metadata", checkId: "title.weak" }), "seo");
    assert.equal(pillarOf({ category: "ai_visibility" }), "ai");
    assert.equal(pillarOf({ category: "conversion" }), null);
    assert.equal(pillarOf({ category: "content", checkId: "data.duplicates" }), null);
    assert.equal(pillarOf({ category: "ai_visibility", checkId: "ai.stale" }), "ai");
    assert.equal(pillarOf({ category: "rendering", checkId: "render.empty_shell" }), "seo", "a check in both pillars is explained on the Technical tab");
  });

  const report = {
    findings: [{ id: "f", category: "metadata", severity: "HIGH", title: "t", summary: "s", organicImpactScore: 70, checkId: "title.weak" }],
    audit: {
      seo: { value: 90, indexable: 10, unhealthy: 1 }, ai: { value: null, indexable: 0, unhealthy: 0, reason: "no finished full crawl" },
      checks: [{ id: "title.weak", status: "failed", pages: 1 }, { id: "title.length", status: "passed" }, { id: "ai.stale", status: "skipped", reason: "x" }, { id: "render.empty_shell", status: "passed" }],
    },
  } as unknown as Report;

  it("groups a pillar's checks by class, failed first, with the finding attached", () => {
    const groups = checksFor(report, "seo");
    assert.equal(groups.error[0]!.check.id, "title.weak");
    assert.equal(groups.error[0]!.finding?.id, "f");
    assert.ok(groups.warning.some((row) => row.check.id === "title.length" && row.row.status === "passed"));
    assert.ok(!Object.values(groups).flat().some((row) => row.check.id === "ai.stale"), "AI-only checks are not on the SEO list");
    assert.ok(checksFor(report, "ai").error.some((row) => row.check.id === "render.empty_shell"), "a check in both pillars is on both lists");
  });

  it("counts the checks, and has nothing for an old report", () => {
    assert.deepEqual(auditCounts(report), { checks: 4, passed: 2, failed: 1, skipped: 1 });
    assert.equal(auditCounts({ findings: [] } as unknown as Report), null);
  });
});
